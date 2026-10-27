//! The never-read guarantee: three independent proofs that Clotr for Windows never watches every keystroke, every
//! raw input event, every notification, or another window's pixels or text (outside the one message box the
//! typing check reads, in the AI app in front) -- the same shape as `no_network.rs`'s proof that it never gains a
//! network call, so a change that slips past one layer still trips another:
//!
//! 1. The built `clotr.exe`'s own import table (a function call reaches in, whatever the source looks like).
//! 2. `Cargo.toml`'s declared `windows` crate features (a capability turned on before any function is even called).
//! 3. The source (`TextPattern`/`ValuePattern`/`GetCurrentPattern`/`CurrentName` outside `paste.rs` and
//!    `typing.rs`, and a read of a box's text anywhere but `typing.rs`, which asks `IsPassword` before every look
//!    and every read) and the packaging manifest's capabilities.
//!
//! Layer 2 never lists `Win32_UI_Input`: the `windows` crate's own feature tree makes
//! `Win32_UI_Input_KeyboardAndMouse` (which `watch.rs` already turns on for the card's keyboard shortcut) imply it,
//! so a literal check would fail on Clotr's own legitimate hotkey.
//!
//! Layer 1 never lists `GetAsyncKeyState`, `RegisterRawInputDevices` or `GetRawInputData` either, for a sharper
//! reason found by actually running this check against the built app: the windowing library underneath every
//! Tauri window already imports all three for its own mouse and drag handling, so they sit in the import table
//! whether or not Clotr's own code ever calls them -- the check could never pass, and a real future call to one
//! would look identical to the harmless baseline already there. Layer 3's source scan catches these instead: it
//! reads Clotr's own files, where the dependency's calls don't appear.

use object::read::pe::{PeFile32, PeFile64};
use object::{NameOrOrdinal, Object};
use std::path::{Path, PathBuf};

// ---------- Layer 1: the built binary's import table ----------

/// A keyboard hook or a read of another window's pixels -- named by function, since both live in user32.dll
/// beside functions Clotr does use. (Raw input and `GetAsyncKeyState` are checked in layer 3 instead; see the
/// module doc.)
const NEVER_READ_IMPORTS: &[&str] = &["SetWindowsHookExA", "SetWindowsHookExW", "PrintWindow"];

fn built_binary() -> Option<PathBuf> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target");
    for profile in ["release", "debug"] {
        let p = base.join(profile).join("clotr.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

struct Hit {
    library: String,
    name: String,
}

/// Every imported (library, function) pair that matches `NEVER_READ_IMPORTS`, through `object`'s own PE parsing --
/// the same approach `no_network.rs` uses for its own import list.
fn never_read_imports(data: &[u8]) -> Vec<Hit> {
    fn scan<'a, Pe: object::read::pe::ImageNtHeaders>(
        file: &object::read::pe::PeFile<'a, Pe, &'a [u8]>,
    ) -> Vec<Hit> {
        file.imports()
            .expect("a well-formed import table")
            .filter_map(Result::ok)
            .filter_map(|import| {
                let library = String::from_utf8_lossy(import.library()).to_lowercase();
                let name = match import.name() {
                    NameOrOrdinal::Name(n) => String::from_utf8_lossy(n).to_string(),
                    NameOrOrdinal::Ordinal(n) => format!("#{n}"),
                };
                NEVER_READ_IMPORTS
                    .contains(&name.as_str())
                    .then(|| Hit { library: library.clone(), name: name.clone() })
            })
            .collect()
    }
    if let Ok(file) = PeFile64::parse(data) {
        return scan(&file);
    }
    if let Ok(file) = PeFile32::parse(data) {
        return scan(&file);
    }
    panic!("clotr.exe isn't a PE32 or PE32+ file this check can read");
}

#[test]
fn clotr_exe_imports_no_keyboard_hook_or_other_windows_pixels_function() {
    let Some(path) = built_binary() else {
        eprintln!("[Clotr] no built clotr.exe found (run cargo build first) -- the never-read import check was skipped");
        return;
    };
    let data = std::fs::read(&path).unwrap_or_else(|e| panic!("couldn't read {}: {e}", path.display()));
    let hits = never_read_imports(&data);
    assert!(
        hits.is_empty(),
        "clotr.exe imports a function the never-read guarantee rules out: {}",
        hits.iter().map(|h| format!("{} ({})", h.name, h.library)).collect::<Vec<_>>().join(", ")
    );
}

/// The scanner itself, proven against a real Windows binary known to import one of the flagged names -- the
/// On-Screen Keyboard, present on every Windows install, hooks the keyboard with `SetWindowsHookExW` -- so a silent
/// change to the scan (a typo in a name, a parsing path that stops matching) fails loudly instead of the real check
/// just going quiet.
#[test]
fn the_import_scan_itself_catches_a_real_hit() {
    let system32 = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let path = system32.join("System32").join("osk.exe");
    if !path.is_file() {
        eprintln!("[Clotr] osk.exe not found on this computer -- the never-read scan's own proof was skipped");
        return;
    }
    let data = std::fs::read(&path).unwrap();
    let hits = never_read_imports(&data);
    assert!(!hits.is_empty(), "{} was expected to import a flagged function", path.display());
}

// ---------- Layer 2: the windows crate's declared feature tree ----------

/// Features that would turn on screen capture or a notification listener, whatever function names end up calling
/// them; named exactly as the `windows` crate spells them.
const NEVER_READ_FEATURES: &[&str] = &["Graphics_Capture", "UI_Notifications_Management", "Win32_Graphics_Dxgi"];

/// The `windows` crate's own feature strings as `Cargo.toml` lists them (both `[dependencies]` and
/// `[dev-dependencies]` carry their own `windows = { ... features = [...] }` block), read as text rather than a
/// full TOML parse -- the shape is a single flat array per block, so a plain scan can't be fooled the way a
/// careless string search could with a format that allows nesting.
fn declared_windows_features(cargo_toml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = cargo_toml;
    while let Some(start) = rest.find("windows = {") {
        let after = &rest[start..];
        let Some(open) = after.find('[') else { break };
        let Some(close) = after[open..].find(']') else { break };
        let list = &after[open + 1..open + close];
        for part in list.split(',') {
            let f = part.trim().trim_matches('"').trim();
            if !f.is_empty() {
                out.push(f.to_string());
            }
        }
        rest = &after[open + close..];
    }
    out
}

fn never_read_features(cargo_toml: &str) -> Vec<String> {
    declared_windows_features(cargo_toml)
        .into_iter()
        .filter(|f| NEVER_READ_FEATURES.contains(&f.as_str()))
        .collect()
}

#[test]
fn cargo_toml_never_turns_on_screen_capture_or_a_notification_listener_feature() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let text = std::fs::read_to_string(&path).unwrap();
    let hits = never_read_features(&text);
    assert!(
        hits.is_empty(),
        "Cargo.toml turns on a windows crate feature the never-read guarantee rules out: {}",
        hits.join(", ")
    );
}

#[test]
fn the_feature_scan_itself_catches_a_planted_feature() {
    let planted = r#"
[dependencies]
windows = { version = "0.62", features = [
  "Win32_Foundation",
  "Win32_Graphics_Dxgi",
] }
"#;
    assert_eq!(never_read_features(planted), vec!["Win32_Graphics_Dxgi".to_string()]);
    let clean = r#"
[dependencies]
windows = { version = "0.62", features = [
  "Win32_Foundation",
  "Win32_UI_Input_KeyboardAndMouse",
] }
"#;
    assert!(
        never_read_features(clean).is_empty(),
        "the legitimate hotkey feature must never be flagged on its own"
    );
}

// ---------- Layer 3: the source and the packaging manifest ----------

const UI_AUTOMATION_TEXT_TOKENS: &[&str] = &["TextPattern", "ValuePattern", "GetCurrentPattern", "CurrentName"];

/// Polling or raw-input calls that would watch a keystroke or a mouse move without a hook -- forbidden everywhere
/// in src/, paste.rs included: see the module doc for why layer 1 can't cover these two.
const INPUT_WATCHING_TOKENS: &[&str] = &["GetAsyncKeyState", "RegisterRawInputDevices", "GetRawInputData"];

/// The two places allowed to touch UI Automation's text patterns: `paste.rs` only to read which control has the
/// keyboard (its id, never its text or value), for `card.rs`'s focus-matching in `brain.rs`, and `typing.rs`, the
/// typing check.
const ALLOWED_FILES: &[&str] = &["paste.rs", "typing.rs"];

/// Reading a box's text or value, or asking for the pattern that does: `typing.rs` alone, paste.rs included.
const BOX_READ_TOKENS: &[&str] = &["GetText(", "CurrentValue(", "DocumentRange(", "UIA_TextPatternId", "UIA_ValuePatternId"];

/// The one file allowed to read a box.
const BOX_READER: &str = "typing.rs";

fn source_hits(src_dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(src_dir).expect("src dir reads").filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        for token in INPUT_WATCHING_TOKENS {
            if text.contains(token) {
                out.push(format!("{name}: {token}"));
            }
        }
        if !ALLOWED_FILES.contains(&name.as_str()) {
            for token in UI_AUTOMATION_TEXT_TOKENS {
                if text.contains(token) {
                    out.push(format!("{name}: {token}"));
                }
            }
        }
        if name != BOX_READER {
            for token in BOX_READ_TOKENS {
                if text.contains(token) {
                    out.push(format!("{name}: {token}"));
                }
            }
        }
    }
    out
}

fn manifest_hits(manifest: &str) -> Vec<String> {
    let mut out = Vec::new();
    if manifest.contains("userNotificationListener") {
        out.push("userNotificationListener".to_string());
    }
    for line in manifest.lines() {
        if line.contains("graphicsCapture") {
            out.push(line.trim().to_string());
        }
    }
    out
}

/// The calls that ask a box for a pattern or read it.
const PATTERN_OR_READ: &[&str] = &["GetCurrentPattern", "GetText(", "CurrentValue(", "DocumentRange("];

/// Every function in `source` that asks for a pattern or reads a box without first asking `IsPassword`, by name.
/// Functions are split at each `fn ` that starts a line, which is how rustfmt lays out every one in typing.rs.
fn password_not_first(source: &str) -> (Vec<String>, usize) {
    let mut late = Vec::new();
    let mut readers = 0;
    let starts: Vec<usize> = source
        .match_indices("fn ")
        .map(|(i, _)| i)
        .filter(|&i| {
            let line = &source[source[..i].rfind('\n').map_or(0, |n| n + 1)..i];
            line.trim().is_empty() || line.trim() == "pub" || line.trim() == "pub(crate)" || line.trim() == "unsafe"
        })
        .collect();
    for (k, &start) in starts.iter().enumerate() {
        let body = &source[start..starts.get(k + 1).copied().unwrap_or(source.len())];
        let Some(first) = PATTERN_OR_READ.iter().filter_map(|t| body.find(t)).min() else {
            continue;
        };
        readers += 1;
        if body.find("CurrentIsPassword").is_none_or(|p| p > first) {
            let name = body[3..].split(['(', '<']).next().unwrap_or("?").to_string();
            late.push(name);
        }
    }
    (late, readers)
}

#[test]
fn the_typing_check_asks_is_password_before_every_look_and_every_read() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src").join(BOX_READER);
    let text = std::fs::read_to_string(path).expect("typing.rs reads");
    let (late, readers) = password_not_first(&text);
    assert!(readers >= 2, "typing.rs should have its look and its read, found {readers}");
    assert!(late.is_empty(), "typing.rs asks for a pattern or reads before IsPassword in: {}", late.join(", "));
}

#[test]
fn the_password_order_scan_itself_catches_a_read_before_is_password() {
    let planted = "fn good(el: &E) {\n    let p = el.CurrentIsPassword();\n    let t = el.GetCurrentPatternAs(1);\n}\n\
                   fn bad(el: &E) {\n    let t = r.GetText(5);\n    let p = el.CurrentIsPassword();\n}\n\
                   fn worse(el: &E) {\n    let v = v.CurrentValue();\n}\n";
    let (late, readers) = password_not_first(planted);
    assert_eq!(readers, 3);
    assert_eq!(late, vec!["bad".to_string(), "worse".to_string()]);
}

#[test]
fn the_source_never_watches_input_or_reads_another_windows_text_outside_paste_and_typing() {
    let src_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let hits = source_hits(&src_dir);
    assert!(
        hits.is_empty(),
        "a source file calls an input-watching function, or reads UI Automation text or value content outside \
         paste.rs and typing.rs: {}",
        hits.join(", ")
    );
}

#[test]
fn the_source_scan_itself_catches_planted_calls() {
    let dir = std::env::temp_dir().join(format!("clotr-never-read-src-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("sneaky.rs"), "fn f() { let _ = TextPattern; }\n").unwrap();
    // paste.rs is allowed to use a text pattern, but never an input-watching call -- both halves of the rule are
    // proven in one planted file.
    // paste.rs may use a text pattern but never read a box with one; typing.rs may read a box.
    std::fs::write(
        dir.join("paste.rs"),
        "fn f() { let _ = TextPattern; let _ = GetAsyncKeyState; let _ = r.GetText(5); }\n",
    )
    .unwrap();
    std::fs::write(dir.join("typing.rs"), "fn f() { let _ = TextPattern; let _ = r.GetText(5); }\n").unwrap();
    let hits = source_hits(&dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(hits.len(), 3, "{hits:?}");
    assert!(hits.iter().any(|h| h.contains("sneaky.rs") && h.contains("TextPattern")));
    assert!(hits.iter().any(|h| h.contains("paste.rs") && h.contains("GetAsyncKeyState")));
    assert!(hits.iter().any(|h| h.contains("paste.rs") && h.contains("GetText(")));
    assert!(!hits.iter().any(|h| h.contains("paste.rs") && h.contains("TextPattern")));
    assert!(!hits.iter().any(|h| h.contains("typing.rs")));
}

#[test]
fn the_packaging_manifest_never_declares_a_notification_listener_or_graphics_capture_capability() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("msix").join("AppxManifest.xml");
    let Ok(text) = std::fs::read_to_string(&path) else {
        eprintln!("[Clotr] msix/AppxManifest.xml not found -- the manifest check was skipped");
        return;
    };
    let hits = manifest_hits(&text);
    assert!(
        hits.is_empty(),
        "AppxManifest.xml declares a capability the never-read guarantee rules out: {}",
        hits.join(", ")
    );
}

#[test]
fn the_manifest_scan_itself_catches_a_planted_capability() {
    let planted = r#"<Capabilities><uap:Capability Name="userNotificationListener" /></Capabilities>"#;
    assert_eq!(manifest_hits(planted), vec!["userNotificationListener".to_string()]);
    let planted_capture = r#"<rescap:Capability Name="graphicsCaptureProgrammatic" />"#;
    assert_eq!(manifest_hits(planted_capture).len(), 1);
}
