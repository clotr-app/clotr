//! Extension check's readers: which browser extensions on this PC can reach the AI sites, read only, from each
//! browser's own files. No permission needed on Windows: everything here is already readable by the signed-in
//! user who's running Clotr.
//!
//! Rust only walks and reads; the shared `extcheck-core.js` (loaded into the scan worker) decides each
//! extension's reach and whether it's worth a look, from the records this module hands it. The record shape is
//! `extcheck-core.js`'s own (its header comment): `{ id, name, browser, profile, enabled, installType, hosts,
//! scripts, warnings, self }`. On Windows `scripts` comes straight from each extension's own manifest (the browser
//! extension can't see that for other extensions, so it leans on `warnings` instead); Windows has no such API, so
//! `warnings` stays empty here.
//!
//! **Opens only:** a Chromium profile's `Preferences` and `Secure Preferences`, an extension's own `manifest.json`
//! and its `_locales/<lang>/messages.json`; Firefox's `profiles.ini` and a profile's `extensions.json`, plus (only
//! when an add-on sits unpacked on disk rather than inside a signed `.xpi`) its `manifest.json`. Never a browser's
//! history, cookies, saved passwords or anything else in a profile — the file list a test in this module checks.
//! Read only, never written: nothing here changes a byte of a browser's own files.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// Every file this module opens is funnelled through here so a test can prove the list stays exactly what's
/// promised above. Outside tests this is a thin, free wrapper.
fn note_opened(_path: &Path) {
    #[cfg(test)]
    OPENED.with(|o| o.borrow_mut().push(_path.to_path_buf()));
}

fn read_bytes(path: &Path) -> Option<Vec<u8>> {
    note_opened(path);
    fs::read(path).ok()
}

fn read_text(path: &Path) -> Option<String> {
    note_opened(path);
    fs::read_to_string(path).ok()
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&read_bytes(path)?).ok()
}

/// The record shape `extcheck-core.js` expects, filled in from what Windows can read from disk instead of asked
/// through `chrome.management`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRecord {
    pub id: String,
    pub name: String,
    pub browser: String,
    pub profile: String,
    pub enabled: bool,
    pub install_type: String,
    pub hosts: Vec<String>,
    pub scripts: Vec<String>,
    pub warnings: Vec<String>,
    #[serde(rename = "self")]
    pub self_: bool,
}

/// Clotr's own published ids, so Extension check recognizes itself the way the browser extension does with
/// `chrome.runtime.id`: the Chrome Web Store's item, Edge Add-ons' item (`storesersions.json`)
/// and the Firefox add-on id every Firefox build carries (`tools/package.js`, `browser_specific_settings.gecko`). An
/// unpacked Chromium install gets a different id on every machine and isn't recognized here — a missed "This is
/// Clotr" label, never a wrong one.
const CLOTR_IDS: &[&str] = &[
    "gkgpgejhhmmhklaghdnbjbalkmpjnmab",
    "hbangnmofjeaieaeamlncpcfmhbclbkj",
    "clotr@billiambash",
];

fn is_clotr(id: &str) -> bool {
    CLOTR_IDS.iter().any(|c| c.eq_ignore_ascii_case(id))
}

fn str_vec(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn sorted_unique(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v.dedup();
    v
}

/// A `manifest.json`'s declared content-script match patterns (5.2's `scripts`), flattened across every
/// `content_scripts` entry.
fn content_script_matches(manifest: &Value) -> Vec<String> {
    let Some(scripts) = manifest.get("content_scripts").and_then(Value::as_array) else {
        return Vec::new();
    };
    scripts.iter().flat_map(|s| str_vec(s.get("matches"))).collect()
}

/// Themes and legacy packaged apps aren't extensions (5.2: "Only `type: "extension"` is listed"); a theme's
/// manifest carries a `theme` key, an app's an `app` key, neither of which an extension's does.
fn is_theme_or_app(manifest: &Value) -> bool {
    manifest.get("theme").is_some() || manifest.get("app").is_some()
}

/// A locale folder's name as browsers write them ("en", "pt_BR", "es_419"): letters, digits, `_` and `-`, short.
/// Anything else (a `..`, a slash, a drive letter) would turn the lookup below into a path outside the extension.
fn is_locale_name(locale: &str) -> bool {
    (1..=16).contains(&locale.len()) && locale.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A manifest's `name`, resolved through `_locales/<default_locale>/messages.json` when it's a `__MSG_x__`
/// placeholder (`ext_dir` is the extension's own folder, where `_locales` lives next to the manifest).
fn resolve_name(manifest: &Value, ext_dir: &Path) -> Option<String> {
    let raw = manifest.get("name").and_then(Value::as_str)?;
    let Some(key) = raw.strip_prefix("__MSG_").and_then(|s| s.strip_suffix("__")) else {
        return Some(raw.to_string());
    };
    let locale = manifest.get("default_locale").and_then(Value::as_str).unwrap_or("en");
    if !is_locale_name(locale) {
        return Some(raw.to_string());
    }
    let resolved = read_json(&ext_dir.join("_locales").join(locale).join("messages.json")).and_then(|messages| {
        messages
            .get(key)
            .and_then(|m| m.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    Some(resolved.unwrap_or_else(|| raw.to_string()))
}

// ---------- Chromium (Chrome, Edge, Brave, Vivaldi, Opera) ----------

pub struct BrowserRoot {
    pub browser: &'static str,
    pub user_data: PathBuf,
}

/// Where each Chromium browser keeps its profiles. Opera is the one odd one out: it keeps `User Data` under the
/// roaming profile (`%APPDATA%`), not the local one every other Chromium browser uses.
fn chromium_roots(local_app_data: &Path, roaming_app_data: &Path) -> Vec<BrowserRoot> {
    let candidates: &[(&str, PathBuf)] = &[
        ("Chrome", local_app_data.join("Google").join("Chrome").join("User Data")),
        ("Edge", local_app_data.join("Microsoft").join("Edge").join("User Data")),
        (
            "Brave",
            local_app_data
                .join("BraveSoftware")
                .join("Brave-Browser")
                .join("User Data"),
        ),
        ("Vivaldi", local_app_data.join("Vivaldi").join("User Data")),
        ("Opera", roaming_app_data.join("Opera Software").join("Opera Stable")),
    ];
    candidates
        .iter()
        .filter(|(_, p)| p.is_dir())
        .map(|(browser, user_data)| BrowserRoot {
            browser,
            user_data: user_data.clone(),
        })
        .collect()
}

/// `Default` plus every `Profile N` folder Chromium made for another person signed into the same Windows account.
fn chromium_profiles(user_data: &Path) -> Vec<String> {
    let mut profiles = Vec::new();
    if user_data.join("Default").is_dir() {
        profiles.push("Default".to_string());
    }
    if let Ok(entries) = fs::read_dir(user_data) {
        let mut extra: Vec<String> = entries
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("Profile "))
            .collect();
        extra.sort();
        profiles.extend(extra);
    }
    profiles
}

/// `extensions.settings` from `Preferences`, overlaid by the same key in `Secure Preferences` when it's there too
/// (Secure Preferences is the one some Chromium versions actually keep this tree in, so it wins when both have an
/// entry for the same id).
fn extensions_settings(profile_dir: &Path) -> HashMap<String, Value> {
    let mut out = HashMap::new();
    for file in ["Preferences", "Secure Preferences"] {
        let Some(prefs) = read_json(&profile_dir.join(file)) else {
            continue;
        };
        let Some(settings) = prefs
            .get("extensions")
            .and_then(|e| e.get("settings"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        for (id, value) in settings {
            out.insert(id.clone(), value.clone());
        }
    }
    out
}

/// Chromium's `Location` enum, in the order it's written to `extensions.settings.<id>.location`
/// (`extensions/common/mojom/manifest.mojom`). Only the distinction Extension check needs: installed from outside
/// a store (a registry sideload, a trick malware has used before) or not.
fn install_type_from_location(location: i64) -> &'static str {
    match location {
        4 => "development",      // UNPACKED: "Load unpacked"
        2 | 3 | 6 => "sideload", // EXTERNAL_PREF, EXTERNAL_REGISTRY, EXTERNAL_PREF_DOWNLOAD
        7 | 9 => "admin",        // EXTERNAL_POLICY_DOWNLOAD, EXTERNAL_POLICY
        5 | 10 => "other",       // COMPONENT, EXTERNAL_COMPONENT
        _ => "normal",           // INTERNAL, and anything this module doesn't recognize
    }
}

fn enabled_of(settings: &Value) -> bool {
    settings
        .get("state")
        .and_then(Value::as_i64)
        .map(|s| s != 0)
        .unwrap_or(true)
}

fn install_type_of(settings: &Value) -> String {
    let location = settings.get("location").and_then(Value::as_i64).unwrap_or(1);
    install_type_from_location(location).to_string()
}

fn permission_hosts(perm: Option<&Value>) -> Vec<String> {
    let mut hosts = str_vec(perm.and_then(|p| p.get("explicit_host")));
    hosts.extend(str_vec(perm.and_then(|p| p.get("scriptable_host"))));
    sorted_unique(hosts)
}

/// The host access granted right now ("granted permissions", "active permissions" and, when the person set
/// "On click" or "On specific sites", "runtime granted permissions"): the withheld set when withholding is on,
/// the full active set otherwise. Taking the wider of `explicit_host`/`scriptable_host` here is the conservative
/// read: missing a host an extension can actually reach would be the kind of miss Clotr exists to avoid.
fn granted_hosts(settings: &Value) -> Vec<String> {
    let withholding = settings
        .get("withholding_permissions")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if withholding {
        permission_hosts(settings.get("runtime_granted_permissions"))
    } else {
        permission_hosts(settings.get("active_permissions"))
    }
}

/// The extension's own folder under `Extensions/<id>/<version>/`, picked by whichever version folder actually has
/// a `manifest.json` (an extension mid-update can briefly have more than one version folder on disk).
fn extension_dir_for(user_data: &Path, profile: &str, id: &str) -> Option<PathBuf> {
    let base = user_data.join(profile).join("Extensions").join(id);
    let mut versions: Vec<PathBuf> = fs::read_dir(&base)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    versions.sort();
    versions.into_iter().find(|v| v.join("manifest.json").is_file())
}

fn chromium_extensions(root: &BrowserRoot, profile: &str) -> Vec<ExtensionRecord> {
    let profile_dir = root.user_data.join(profile);
    let settings = extensions_settings(&profile_dir);
    let mut out = Vec::new();
    for (id, s) in &settings {
        // Fail soft: nothing to read on disk means nothing to show, never a guess.
        let Some(ext_dir) = extension_dir_for(&root.user_data, profile, id) else {
            continue;
        };
        let Some(manifest) = read_json(&ext_dir.join("manifest.json")) else {
            continue;
        };
        if is_theme_or_app(&manifest) {
            continue;
        }
        let name = resolve_name(&manifest, &ext_dir).unwrap_or_else(|| id.clone());
        out.push(ExtensionRecord {
            id: id.clone(),
            name,
            browser: root.browser.to_string(),
            profile: profile.to_string(),
            enabled: enabled_of(s),
            install_type: install_type_of(s),
            hosts: granted_hosts(s),
            scripts: content_script_matches(&manifest),
            warnings: Vec::new(),
            self_: is_clotr(id),
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

// ---------- Firefox ----------

/// `profiles.ini`'s own format: a handful of `[ProfileN]` sections, `Name=`, `Path=` (relative to the Firefox
/// folder unless `IsRelative=0`) and `Default=`. No crate for this: it's a dozen lines of `Key=Value`, never
/// nested, never quoted.
fn firefox_profiles(roaming_app_data: &Path) -> Vec<(String, PathBuf)> {
    let root = roaming_app_data.join("Mozilla").join("Firefox");
    let Some(ini) = read_text(&root.join("profiles.ini")) else {
        return Vec::new();
    };

    let mut profiles = Vec::new();
    let mut in_profile = false;
    let mut name: Option<String> = None;
    let mut path: Option<String> = None;
    let mut is_relative = true;

    let mut flush = |name: &mut Option<String>, path: &mut Option<String>, is_relative: bool| {
        if let (Some(n), Some(p)) = (name.take(), path.take()) {
            let dir = if is_relative { root.join(&p) } else { PathBuf::from(&p) };
            profiles.push((n, dir));
        }
    };

    for line in ini.lines() {
        let line = line.trim();
        if let Some(section) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            flush(&mut name, &mut path, is_relative);
            in_profile = section.starts_with("Profile");
            is_relative = true;
            continue;
        }
        if !in_profile {
            continue;
        }
        if let Some(v) = line.strip_prefix("Name=") {
            name = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("Path=") {
            path = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("IsRelative=") {
            is_relative = v.trim() != "0";
        }
    }
    flush(&mut name, &mut path, is_relative);
    profiles
}

fn firefox_extensions(profile_name: &str, profile_dir: &Path) -> Vec<ExtensionRecord> {
    let Some(data) = read_json(&profile_dir.join("extensions.json")) else {
        return Vec::new();
    };
    let Some(addons) = data.get("addons").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for addon in addons {
        if addon.get("type").and_then(Value::as_str) != Some("extension") {
            continue;
        }
        let Some(id) = addon.get("id").and_then(Value::as_str) else {
            continue;
        };

        let enabled = addon.get("active").and_then(Value::as_bool).unwrap_or(true);
        // Firefox's own name for a sideload: installed by something other than the browser itself (an installer's
        // registry entry, an enterprise policy file) — the same story as Chromium's EXTERNAL_REGISTRY.
        let foreign = addon.get("foreignInstall").and_then(Value::as_bool).unwrap_or(false);
        let install_type = if foreign { "sideload" } else { "normal" }.to_string();
        let hosts = sorted_unique(str_vec(addon.get("userPermissions").and_then(|p| p.get("origins"))));

        // A packed `.xpi` is a zip this module doesn't open; an unpacked add-on (a temporary load, a policy
        // pointing at a folder) sits as a plain directory and its manifest can be read like any other.
        let unpacked_manifest = addon
            .get("path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .and_then(|dir| read_json(&dir.join("manifest.json")).map(|m| (dir, m)));

        let mut name = addon
            .get("defaultLocale")
            .and_then(|d| d.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut scripts = Vec::new();
        if let Some((dir, manifest)) = &unpacked_manifest {
            if name.is_none() {
                name = resolve_name(manifest, dir);
            }
            scripts = content_script_matches(manifest);
        }

        out.push(ExtensionRecord {
            id: id.to_string(),
            name: name.unwrap_or_else(|| id.to_string()),
            browser: "Firefox".to_string(),
            profile: profile_name.to_string(),
            enabled,
            install_type,
            hosts,
            scripts,
            warnings: Vec::new(),
            self_: is_clotr(id),
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

// ---------- Every browser on this PC ----------

/// Every installed extension Extension check can see, in every Chromium browser and Firefox, read only from their
/// own files. The scan worker hands this to `extcheck-core.js`'s `checkExtensions()`; nothing here decides reach
/// or worth-a-look on its own.
pub fn check_all() -> Vec<ExtensionRecord> {
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let roaming = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    check_all_in(&local, &roaming)
}

/// `check_all()`'s own work, over any two folders shaped like `%LOCALAPPDATA%`/`%APPDATA%`, so a test can point it
/// at a fixture profile tree and get a deterministic result instead of reading whatever's really installed.
pub fn check_all_in(local: &Path, roaming: &Path) -> Vec<ExtensionRecord> {
    let mut out = Vec::new();
    for root in chromium_roots(local, roaming) {
        for profile in chromium_profiles(&root.user_data) {
            out.extend(chromium_extensions(&root, &profile));
        }
        out.sort_by(|a, b| {
            (a.browser.clone(), a.profile.clone(), a.id.clone()).cmp(&(
                b.browser.clone(),
                b.profile.clone(),
                b.id.clone(),
            ))
        });
    }
    for (profile_name, profile_dir) in firefox_profiles(roaming) {
        if profile_dir.is_dir() {
            out.extend(firefox_extensions(&profile_name, &profile_dir));
        }
    }
    out
}

#[cfg(test)]
thread_local! {
    static OPENED: std::cell::RefCell<Vec<PathBuf>> = std::cell::RefCell::new(Vec::new());
}

#[cfg(test)]
fn take_opened() -> Vec<PathBuf> {
    OPENED.with(|o| o.borrow_mut().drain(..).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TestTempDir(PathBuf);

    impl TestTempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("clotr-extcheck-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl std::ops::Deref for TestTempDir {
        type Target = Path;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl AsRef<Path> for TestTempDir {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir(name: &str) -> TestTempDir {
        TestTempDir::new(name)
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    // ---------- Pure functions ----------

    #[test]
    fn clotr_is_recognized_by_its_chrome_edge_and_firefox_ids_only() {
        assert!(is_clotr("gkgpgejhhmmhklaghdnbjbalkmpjnmab"));
        assert!(is_clotr("HBANGNMOFJEAIEAEAMLNCPCFMHBCLBKJ"));
        assert!(is_clotr("clotr@billiambash"));
        assert!(!is_clotr("clotr@someone-else"));
        assert!(!is_clotr(""));
    }

    #[test]
    fn locations_outside_a_store_read_as_sideload_and_internal_reads_as_normal() {
        assert_eq!(install_type_from_location(1), "normal");
        assert_eq!(install_type_from_location(2), "sideload");
        assert_eq!(install_type_from_location(3), "sideload");
        assert_eq!(install_type_from_location(6), "sideload");
        assert_eq!(install_type_from_location(4), "development");
        assert_eq!(install_type_from_location(9), "admin");
        assert_eq!(install_type_from_location(99), "normal");
    }

    #[test]
    fn a_message_placeholder_name_resolves_through_locales() {
        let dir = temp_dir("name");
        write(
            &dir.join("_locales/en/messages.json"),
            r#"{"appName":{"message":"Clotr Helper"}}"#,
        );
        let manifest: Value = serde_json::from_str(r#"{"name":"__MSG_appName__","default_locale":"en"}"#).unwrap();
        assert_eq!(resolve_name(&manifest, &dir), Some("Clotr Helper".to_string()));

        let plain: Value = serde_json::from_str(r#"{"name":"Plain Name"}"#).unwrap();
        assert_eq!(resolve_name(&plain, &dir), Some("Plain Name".to_string()));
    }

    #[test]
    fn temp_dir_guard_removes_the_folder_when_dropped() {
        let path;
        {
            let dir = temp_dir("drop-check");
            path = dir.0.clone();
            assert!(path.is_dir());
        }
        assert!(!path.exists(), "test temp folder survived its guard");
    }

    // `default_locale` comes from the extension's own manifest: a locale is a short name like "en" or "pt_BR",
    // never a path. One shaped like "..\..\elsewhere" or "C:\elsewhere" must not send the name lookup outside the
    // extension's folder, which would break this module's own promise about the files it opens.
    #[test]
    fn a_default_locale_shaped_like_a_path_never_leaves_the_extensions_folder() {
        let root = temp_dir("locale-path");
        let ext = root.join("ext");
        fs::create_dir_all(&ext).unwrap();
        write(&root.join("elsewhere/messages.json"), r#"{"appName":{"message":"Read From Outside"}}"#);
        let outside = root.join("elsewhere").to_string_lossy().into_owned();
        for locale in ["../../elsewhere", "..\\..\\elsewhere", outside.as_str()] {
            let manifest = serde_json::json!({ "name": "__MSG_appName__", "default_locale": locale });
            take_opened();
            assert_eq!(
                resolve_name(&manifest, &ext),
                Some("__MSG_appName__".to_string()),
                "{locale}: falls back to the raw name"
            );
            assert!(
                take_opened().iter().all(|p| p.starts_with(&ext)),
                "{locale}: nothing opened outside the extension's own folder"
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_theme_or_a_packaged_app_is_not_an_extension() {
        let theme: Value = serde_json::from_str(r#"{"name":"A theme","theme":{}}"#).unwrap();
        let app: Value = serde_json::from_str(r#"{"name":"An app","app":{}}"#).unwrap();
        let extension: Value = serde_json::from_str(r#"{"name":"An extension"}"#).unwrap();
        assert!(is_theme_or_app(&theme));
        assert!(is_theme_or_app(&app));
        assert!(!is_theme_or_app(&extension));
    }

    // ---------- Chromium fixtures ----------

    /// A made-up `Default` profile: one plain extension that can read ChatGPT, one sideloaded one that's off, a
    /// theme (never listed) and three files Extension check must never open.
    fn chromium_fixture(suffix: &str) -> TestTempDir {
        let root = temp_dir(&format!("chromium-{suffix}"));
        let profile = root.join("Default");

        write(
            &profile.join("Preferences"),
            r#"{"extensions":{"settings":{
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{"state":1,"location":1,"withholding_permissions":false,
                    "active_permissions":{"explicit_host":["https://chat.openai.com/*"],"scriptable_host":[]}},
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":{"state":0,"location":3,"withholding_permissions":false,
                    "active_permissions":{"explicit_host":[],"scriptable_host":[]}},
                "cccccccccccccccccccccccccccccccc":{"state":1,"location":1,"withholding_permissions":false,
                    "active_permissions":{"explicit_host":[],"scriptable_host":[]}}
            }}}"#,
        );

        write(
            &profile.join("Extensions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1.0_0/manifest.json"),
            r#"{"name":"__MSG_appName__","default_locale":"en",
                "content_scripts":[{"matches":["https://chat.openai.com/*"]}]}"#,
        );
        write(
            &profile.join("Extensions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1.0_0/_locales/en/messages.json"),
            r#"{"appName":{"message":"Reads ChatGPT"}}"#,
        );
        write(
            &profile.join("Extensions/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/2.0_0/manifest.json"),
            r#"{"name":"Installed From Outside A Store"}"#,
        );
        write(
            &profile.join("Extensions/cccccccccccccccccccccccccccccccc/1.0_0/manifest.json"),
            r#"{"name":"A Theme","theme":{}}"#,
        );

        // Never opened: a test that proves it (below) fails loudly if this module ever reads them.
        write(&profile.join("History"), "not json, and not Clotr's to read");
        write(&profile.join("Login Data"), "not json, and not Clotr's to read");
        write(&profile.join("Cookies"), "not json, and not Clotr's to read");

        root
    }

    #[test]
    fn chromium_extensions_reads_the_installed_list_and_resolves_names() {
        let root = chromium_fixture("resolve");
        take_opened();
        let records = chromium_extensions(
            &BrowserRoot {
                browser: "Brave",
                user_data: root.0.clone(),
            },
            "Default",
        );

        assert_eq!(records.len(), 2, "the theme is never listed as an extension");

        let reads_chatgpt = records
            .iter()
            .find(|r| r.id == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .unwrap();
        assert_eq!(reads_chatgpt.name, "Reads ChatGPT");
        assert_eq!(reads_chatgpt.browser, "Brave");
        assert_eq!(reads_chatgpt.profile, "Default");
        assert!(reads_chatgpt.enabled);
        assert_eq!(reads_chatgpt.install_type, "normal");
        assert_eq!(reads_chatgpt.hosts, vec!["https://chat.openai.com/*"]);
        assert_eq!(reads_chatgpt.scripts, vec!["https://chat.openai.com/*"]);
        assert!(!reads_chatgpt.self_);

        let sideloaded = records
            .iter()
            .find(|r| r.id == "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
            .unwrap();
        assert_eq!(sideloaded.name, "Installed From Outside A Store");
        assert!(!sideloaded.enabled, "state 0 means off");
        assert_eq!(sideloaded.install_type, "sideload");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn chromium_extensions_opens_exactly_the_files_it_promises_to() {
        let root = chromium_fixture("files");
        take_opened();
        chromium_extensions(
            &BrowserRoot {
                browser: "Brave",
                user_data: root.0.clone(),
            },
            "Default",
        );
        let opened = take_opened();

        for forbidden in ["History", "Login Data", "Cookies"] {
            assert!(
                !opened.iter().any(|p| p.ends_with(forbidden)),
                "{forbidden} must never be opened"
            );
        }
        let names: Vec<String> = opened
            .iter()
            .map(|p| p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        assert!(names.contains(&"Default/Preferences".to_string()));
        assert!(names.contains(&"Default/Secure Preferences".to_string()));
        assert!(names.contains(&"Default/Extensions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1.0_0/manifest.json".to_string()));
        assert!(names.contains(
            &"Default/Extensions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1.0_0/_locales/en/messages.json".to_string()
        ));
        assert_eq!(names.len(), opened.len(), "no duplicate bookkeeping");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_withheld_extension_is_read_by_its_runtime_grant_only() {
        let root = temp_dir("withheld");
        let profile = root.join("Default");
        write(
            &profile.join("Preferences"),
            r#"{"extensions":{"settings":{
                "dddddddddddddddddddddddddddddddd":{"state":1,"location":1,"withholding_permissions":true,
                    "active_permissions":{"explicit_host":["<all_urls>"],"scriptable_host":[]},
                    "runtime_granted_permissions":{"explicit_host":["https://claude.ai/*"],"scriptable_host":[]}}
            }}}"#,
        );
        write(
            &profile.join("Extensions/dddddddddddddddddddddddddddddddd/1.0_0/manifest.json"),
            r#"{"name":"On Specific Sites"}"#,
        );

        let records = chromium_extensions(
            &BrowserRoot {
                browser: "Chrome",
                user_data: root.0.clone(),
            },
            "Default",
        );
        assert_eq!(
            records[0].hosts,
            vec!["https://claude.ai/*"],
            "the withheld set, not the full grant"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clotr_recognizes_its_own_published_id() {
        let root = temp_dir("self");
        let profile = root.join("Default");
        write(
            &profile.join("Preferences"),
            r#"{"extensions":{"settings":{
                "gkgpgejhhmmhklaghdnbjbalkmpjnmab":{"state":1,"location":1,"withholding_permissions":false,
                    "active_permissions":{"explicit_host":[],"scriptable_host":[]}}
            }}}"#,
        );
        write(
            &profile.join("Extensions/gkgpgejhhmmhklaghdnbjbalkmpjnmab/1.0_0/manifest.json"),
            r#"{"name":"Clotr"}"#,
        );
        let records = chromium_extensions(
            &BrowserRoot {
                browser: "Chrome",
                user_data: root.0.clone(),
            },
            "Default",
        );
        assert!(records[0].self_);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn chromium_profiles_lists_default_and_every_profile_folder_in_order() {
        let root = temp_dir("profiles");
        fs::create_dir_all(root.join("Default")).unwrap();
        fs::create_dir_all(root.join("Profile 2")).unwrap();
        fs::create_dir_all(root.join("Profile 1")).unwrap();
        fs::create_dir_all(root.join("Crashpad")).unwrap(); // not a profile; must be left out
        assert_eq!(chromium_profiles(&root), vec!["Default", "Profile 1", "Profile 2"]);
        let _ = fs::remove_dir_all(&root);
    }

    // ---------- Firefox fixtures ----------

    fn firefox_fixture(suffix: &str) -> TestTempDir {
        let root = temp_dir(&format!("firefox-{suffix}"));
        write(
            &root.join("Mozilla/Firefox/profiles.ini"),
            "[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abcd.default-release\nDefault=1\n",
        );
        let profile = root.join("Mozilla/Firefox/Profiles/abcd.default-release");
        write(
            &profile.join("extensions.json"),
            r#"{"addons":[
                {"id":"reads-claude@example.com","type":"extension","active":true,"foreignInstall":false,
                    "defaultLocale":{"name":"Reads Claude"},
                    "userPermissions":{"origins":["https://claude.ai/*"]}},
                {"id":"sideloaded@example.com","type":"extension","active":true,"foreignInstall":true,
                    "userPermissions":{"origins":["<all_urls>"]}},
                {"id":"a-theme@example.com","type":"theme","active":true}
            ]}"#,
        );
        root
    }

    #[test]
    fn firefox_profiles_reads_profiles_ini() {
        let root = firefox_fixture("ini");
        let profiles = firefox_profiles(&root);
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].0, "default-release");
        assert!(
            profiles[0].1.ends_with("Profiles/abcd.default-release")
                || profiles[0].1.ends_with("Profiles\\abcd.default-release")
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn firefox_extensions_reads_the_installed_list_and_skips_themes() {
        let root = firefox_fixture("list");
        let profile_dir = root.join("Mozilla/Firefox/Profiles/abcd.default-release");
        let records = firefox_extensions("default-release", &profile_dir);

        assert_eq!(records.len(), 2, "the theme is never listed");
        let reads_claude = records.iter().find(|r| r.id == "reads-claude@example.com").unwrap();
        assert_eq!(reads_claude.name, "Reads Claude");
        assert_eq!(reads_claude.hosts, vec!["https://claude.ai/*"]);
        assert_eq!(reads_claude.install_type, "normal");

        let sideloaded = records.iter().find(|r| r.id == "sideloaded@example.com").unwrap();
        assert_eq!(sideloaded.install_type, "sideload");
        assert_eq!(
            sideloaded.name, "sideloaded@example.com",
            "no cached name falls back to the id"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unpacked_firefox_addon_gets_its_name_and_scripts_from_its_own_manifest() {
        let root = temp_dir("firefox-unpacked");
        let addon_dir = root.join("addon");
        write(
            &addon_dir.join("manifest.json"),
            r#"{"name":"Unpacked Thing","content_scripts":[{"matches":["*://*/*"]}]}"#,
        );
        let profile = root.join("profile");
        write(
            &profile.join("extensions.json"),
            &format!(
                r#"{{"addons":[{{"id":"unpacked@example.com","type":"extension","active":true,
                    "path":{:?},"userPermissions":{{"origins":[]}}}}]}}"#,
                addon_dir.to_string_lossy()
            ),
        );
        let records = firefox_extensions("default", &profile);
        assert_eq!(records[0].name, "Unpacked Thing");
        assert_eq!(records[0].scripts, vec!["*://*/*"]);
        let _ = fs::remove_dir_all(&root);
    }
}
