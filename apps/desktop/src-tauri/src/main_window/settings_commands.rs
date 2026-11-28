use super::home_status;
#[cfg(feature = "one-clotr")]
use crate::one_clotr::{browser_host_registration, one_clotr_protocol};
use crate::app_setup::start_with_windows;
use crate::check_my_files::scan_commands::full_scan_view;
use crate::saved_data::store_file;
use crate::tray::tray_menu::{retell_tray, set_paused_all_and_notify};
use crate::tray::tray_words;
use crate::warning_card::card_window::act;
use crate::warning_card::typing_check_host::blind_names;
use crate::{lock, only, Clotr};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

// ---------- The main window's commands (capabilities/main.json) ----------

/// The saved settings, to the two pages that follow them: the card and the main window.
pub(crate) fn tell_settings(app: &AppHandle, clotr: &Clotr) {
    let settings = lock(&clotr.store).settings();
    let _ = app.emit_to("card", "settings", settings.clone());
    let _ = app.emit_to("main", "settings", settings);
}

/// Now, in milliseconds since the epoch.
pub(crate) fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ---------- A timed pause, and Home's status ----------

/// A timed pause's deadline, taken once its hour is up: true for exactly one caller, which then lifts the pause in
/// the store, the brain and the tray together (set_paused_all_and_notify), never in the store alone.
fn take_expired_pause(paused_until: &Mutex<Option<i64>>, now: i64) -> bool {
    let mut until = lock(paused_until);
    if matches!(*until, Some(deadline) if now >= deadline) {
        *until = None;
        true
    } else {
        false
    }
}

/// A timed pause lifts itself once its hour is up, the moment Home or the flyout next asks Clotr for its state (the
/// one-shot timer in pause_for_hour does the same the moment it wakes; this is the fallback if the PC was asleep).
/// Lifted the way the timer lifts it, so the brain checks again and the tray says so, not just the saved flag.
fn expire_pause(app: &AppHandle, clotr: &Clotr) {
    if take_expired_pause(&clotr.paused_until, now_ms()) {
        set_paused_all_and_notify(app, false);
    }
}

/// Home's status (home_status.rs), given whether Clotr is paused right now: the one place that turns the Clotr struct's
/// own bits (running, worth_a_look) plus the store's paused flag into the word Home, the flyout and the tray agree
/// on.
fn current_status(clotr: &Clotr, paused: bool) -> home_status::Status {
    home_status::status(home_status::StatusInput {
        watching: clotr.running.load(Ordering::SeqCst),
        paused,
        worth_a_look: clotr.worth_a_look.load(Ordering::SeqCst),
    })
}

// ---------- The versions "Report a problem" names ----------

/// The version the Store listing and this build agree on (tauri.conf.json's own, which Cargo.toml mirrors):
/// Cargo sets this at compile time, so there's no second read that could ever drift from it.
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Windows' own "ProductName" plus "DisplayVersion" (e.g. "Windows 11 Pro, 23H2"), pure so a build without a
/// display version, or without either, is still worded sensibly -- the registry read itself is windows_version_string.
fn format_windows_version(product: Option<String>, display: Option<String>) -> String {
    let product = product.unwrap_or_else(|| "Windows".to_string());
    match display {
        Some(version) if !version.is_empty() => format!("{product}, {version}"),
        _ => product,
    }
}

/// Read straight from the registry, the same place Windows' own Settings app reads "About" from, so "Report a
/// problem" names the same Windows a person would read there. A read that fails just leaves the word that
/// didn't come back out, never a guess.
fn windows_version_string() -> String {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    fn read(name: &str) -> Option<String> {
        let key: Vec<u16> = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let mut buf = vec![0u16; 256];
        let mut size = (buf.len() * 2) as u32;
        let got = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                PCWSTR(key.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr() as *mut _),
                Some(&mut size),
            )
        };
        if got.is_err() {
            return None;
        }
        let len = (size as usize / 2).saturating_sub(1).min(buf.len());
        let value = String::from_utf16_lossy(&buf[..len]);
        (!value.is_empty()).then_some(value)
    }
    format_windows_version(read("ProductName"), read("DisplayVersion"))
}

// ---------- What the main window and the flyout see ----------

/// Everything the main window draws from, in one value: the settings, History's events and scans, the apps,
/// Home's status and the versions "Report a problem" names.
pub(crate) fn settings_view(clotr: &Clotr) -> Value {
    let store = lock(&clotr.store);
    let covered: Vec<&str> = clotr.covered_apps(&store).iter().map(|app| app.id.as_str()).collect();
    // Every app on the list, each marked covered or not, so Protection can say "Not installed" for the rest.
    let apps: Vec<Value> = clotr
        .apps
        .iter()
        .map(|app| {
            let is_covered = covered.contains(&app.id.as_str());
            json!({ "id": app.id, "name": app.name, "covered": is_covered })
        })
        .collect();
    let paused = store.paused_all();
    let unmatched_maker = lock(&clotr.unmatched_maker)
        .as_ref()
        .map(|(file, maker)| json!({ "file": file, "maker": maker }));
    json!({
        "settings": store.settings(),
        "events": store.events(),
        "scans": store.scans(),
        "fullScan": full_scan_view(&store),
        "apps": apps,
        "locale": clotr.locale,
        "paused": paused,
        "status": current_status(clotr, paused).as_str(),
        "pausedUntil": *lock(&clotr.paused_until),
        "startupTaskState": start_with_windows::state().as_str(),
        "startLine": clotr.start_line,
        "scanExcluded": store.exclusions_view(),
        "accuracy": store.accuracy_answers(),
        "unmatchedMaker": unmatched_maker,
        "typingBlind": blind_names(clotr),
        "appVersion": app_version(),
        "osVersion": windows_version_string(),
    })
}

#[tauri::command]
pub(crate) async fn settings_hello(window: WebviewWindow, clotr: State<'_, Arc<Clotr>>) -> Result<Value, String> {
    only(&window, "main")?;
    expire_pause(window.app_handle(), &clotr);
    Ok(settings_view(&clotr))
}

/// The flyout's own narrow hello: the status and how many AI apps are checked, never the apps' names or any
/// history (the main window's settings_hello carries that, for the main window alone).
#[tauri::command]
pub(crate) async fn flyout_hello(window: WebviewWindow, clotr: State<'_, Arc<Clotr>>) -> Result<Value, String> {
    only(&window, "flyout")?;
    expire_pause(window.app_handle(), &clotr);
    let store = lock(&clotr.store);
    let paused = store.paused_all();
    let covered = clotr.covered_apps(&store);
    let checked = covered.iter().filter(|app| !store.app_paused(&app.id)).count();
    let language = store.language();
    Ok(json!({
        "locale": tray_words::effective_locale(language.as_deref(), &clotr.locale),
        "look": store.settings().get("look").and_then(Value::as_str).unwrap_or("system"),
        "status": current_status(&clotr, paused).as_str(),
        "checked": checked,
        "covered": covered.len(),
        "paused": paused,
        // Only a timed pause (this flyout's own button) has a when; Home's plain "Turn it back on" doesn't --
        // the flyout still says "Resume now" either way, just without the "until" words.
        "pausedUntil": *lock(&clotr.paused_until),
        "typingBlind": blind_names(&clotr),
    }))
}

// ---------- One Clotr, built only with its feature ----------

#[tauri::command]
#[cfg(feature = "one-clotr")]
pub(crate) async fn one_clotr_status(window: WebviewWindow) -> Result<Value, String> {
    only(&window, "main")?;
    Ok(one_clotr_protocol::connection_status())
}

#[tauri::command]
#[cfg(feature = "one-clotr")]
pub(crate) async fn one_clotr_consent(window: WebviewWindow, accepted: bool) -> Result<Value, String> {
    only(&window, "main")?;
    one_clotr_protocol::set_consent(accepted);
    if accepted {
        browser_host_registration::register_for_current_user();
    }
    Ok(one_clotr_protocol::connection_status())
}

#[tauri::command]
#[cfg(feature = "one-clotr")]
pub(crate) async fn one_clotr_disconnect(window: WebviewWindow) -> Result<Value, String> {
    only(&window, "main")?;
    one_clotr_protocol::disconnect();
    browser_host_registration::unregister_for_current_user();
    Ok(one_clotr_protocol::connection_status())
}

// ---------- Saving settings ----------

/// The saved pause and typing check, handed to the brain, and whatever it says to do now, done.
pub(crate) fn apply_pause(app: &AppHandle, clotr: &Arc<Clotr>) {
    let (paused, apps) = {
        let store = lock(&clotr.store);
        (store.paused_all(), clotr.paused_apps(&store))
    };
    let todo = lock(&clotr.brain).set_paused(paused, apps);
    act(app, clotr, todo);
    let typing = lock(&clotr.store).typing_check();
    let todo = lock(&clotr.brain).set_typing(typing);
    act(app, clotr, todo);
}

#[tauri::command]
pub(crate) async fn save_settings(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    app: AppHandle,
    mut settings: Value,
) -> Result<Value, String> {
    only(&window, "main")?;
    // Settings asked Windows to start Clotr with it or not; what actually happens is what gets stored, since
    // Task Manager or a policy can hold the task off no matter what was asked (start_with_windows::request's own doc).
    if let Some(ask) = settings.get("startWithWindows").and_then(Value::as_bool) {
        let real = start_with_windows::request(ask).enabled();
        settings["startWithWindows"] = json!(real);
    }
    lock(&clotr.store)
        .save_settings(&settings, store_file::From::Settings)
        .map_err(|_| "not-saved".to_string())?;
    apply_pause(&app, &clotr);
    tell_settings(&app, &clotr);
    // Settings' Language may have just changed, and the tray has no page of its own to follow it.
    retell_tray(&app, &clotr);
    Ok(settings_view(&clotr))
}

#[tauri::command]
pub(crate) async fn import_settings(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    app: AppHandle,
    settings: Value,
) -> Result<Value, String> {
    only(&window, "main")?;
    let before = lock(&clotr.store).settings();
    lock(&clotr.store)
        .save_settings(&settings, store_file::From::MoveFile)
        .map_err(|_| "not-saved".to_string())?;
    let after = lock(&clotr.store).settings();
    apply_pause(&app, &clotr);
    tell_settings(&app, &clotr);
    // Settings' Language may have just changed, and the tray has no page of its own to follow it.
    retell_tray(&app, &clotr);
    let mut view = settings_view(&clotr);
    // What the move file actually changed, in counts and names, for the settings page's own success message.
    if let Some(fields) = view.as_object_mut() {
        fields.insert("brought".into(), store_file::brought_summary(&before, &after));
    }
    Ok(view)
}

// ---------- History, ignored files and accuracy answers ----------

#[tauri::command]
pub(crate) async fn clear_history(window: WebviewWindow, clotr: State<'_, Arc<Clotr>>) -> Result<Value, String> {
    only(&window, "main")?;
    lock(&clotr.store).clear_history().map_err(|_| "not-saved".to_string())?;
    Ok(settings_view(&clotr))
}

/// *Show them again*, in Settings: clears the whole ignored list, so every file a scan was ever told to skip
/// gets counted the next time.
#[tauri::command]
pub(crate) async fn clear_scan_ignored(window: WebviewWindow, clotr: State<'_, Arc<Clotr>>) -> Result<Value, String> {
    only(&window, "main")?;
    lock(&clotr.store)
        .clear_scan_ignored()
        .map_err(|_| "not-saved".to_string())?;
    Ok(settings_view(&clotr))
}

/// *Was this right?* on a file in Results or the workbench: never the file, its name, its place or the
/// value, only the kind of detail and which of the four place tiers it was in.
#[tauri::command]
pub(crate) async fn accuracy_answer(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    kind: String,
    tier: String,
    yes: bool,
) -> Result<Value, String> {
    only(&window, "main")?;
    lock(&clotr.store)
        .record_accuracy_answer(&kind, &tier, yes)
        .map_err(|_| "not-saved".to_string())?;
    Ok(settings_view(&clotr))
}

/// Settings' own *Clear* beside Accuracy answers.
#[tauri::command]
pub(crate) async fn clear_accuracy_answers(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
) -> Result<Value, String> {
    only(&window, "main")?;
    lock(&clotr.store)
        .clear_accuracy_answers()
        .map_err(|_| "not-saved".to_string())?;
    Ok(settings_view(&clotr))
}

// ---------- Pause and Tourniquet, from the main window ----------

/// "Turn it back on" (Home's paused state). A plain, indefinite pause: it clears any timed pause from the
/// tray's "Pause for an hour" so the two never fight over when to lift.
#[tauri::command]
pub(crate) async fn set_paused(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    app: AppHandle,
    on: bool,
) -> Result<Value, String> {
    only(&window, "main")?;
    *lock(&clotr.paused_until) = None;
    set_paused_all_and_notify(&app, on);
    Ok(settings_view(&clotr))
}

/// Protection's own Tourniquet switch: a chosen preset or "Off", from the main window alone. Always the fresh
/// view back, the same as `save_settings`, so the switch and anything it holds firmly redraw together.
#[tauri::command]
pub(crate) async fn set_tourniquet(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    tourniquet: Value,
) -> Result<Value, String> {
    only(&window, "main")?;
    lock(&clotr.store)
        .set_tourniquet(&tourniquet)
        .map_err(|_| "not-saved".to_string())?;
    Ok(settings_view(&clotr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_windows_version_combines_product_and_display_falling_back_when_either_is_missing() {
        assert_eq!(
            format_windows_version(Some("Windows 11 Pro".to_string()), Some("23H2".to_string())),
            "Windows 11 Pro, 23H2"
        );
        assert_eq!(
            format_windows_version(Some("Windows 11 Pro".to_string()), None),
            "Windows 11 Pro"
        );
        assert_eq!(format_windows_version(None, Some("23H2".to_string())), "Windows, 23H2");
        assert_eq!(format_windows_version(None, None), "Windows");
    }

    /// A timed pause past its hour is handed over exactly once, so the one caller that takes it lifts the pause in
    /// the store, the brain and the tray together. It used to clear only the store's flag, leaving the brain paused
    /// while Home and the flyout said Clotr was on.
    #[test]
    fn a_timed_pause_past_its_hour_is_handed_over_once_to_be_lifted_everywhere() {
        let until = Mutex::new(Some(1_000));
        assert!(!take_expired_pause(&until, 999), "not before its hour");
        assert_eq!(*lock(&until), Some(1_000));
        assert!(take_expired_pause(&until, 1_000));
        assert_eq!(*lock(&until), None);
        assert!(!take_expired_pause(&until, 2_000), "once only");
        assert!(
            !take_expired_pause(&Mutex::new(None), 2_000),
            "an indefinite pause never lifts itself"
        );
    }
}
