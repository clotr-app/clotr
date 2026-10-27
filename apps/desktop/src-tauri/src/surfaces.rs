//! Which surface is in front: a place outside any AI app where a command just pasted is about to run. The Run box
//! is matched the same way `apps.rs` matches an AI app -- never a window class alone, since plenty of ordinary
//! dialogs share the Run box's own class, but the class plus who owns it. A terminal is matched by its program
//! alone (`apps.rs`'s own list and `find`, reused on `apps/terminal-apps.json`), and only when the clipboard's own
//! owner (`clip.rs`'s `owner_exe`) is a known browser -- a terminal is an everyday tool, so the card only shows when
//! what's about to be pasted there was just copied from a web page, the shape a ClickFix-style lure takes.

use crate::apps;
use std::path::PathBuf;
use std::sync::OnceLock;

/// What Windows says about the window in front, read the same way `apps.rs`'s `Program` is.
pub struct Window<'a> {
    pub class: &'a str,
    pub owner_exe: &'a str,
    pub package_family: Option<&'a str>,
}

const TERMINAL_LIST: &str = "terminal-apps.json";
static TERMINAL_DATA: OnceLock<String> = OnceLock::new();

/// Where the terminal list is: beside clotr.exe. The Store package ships it there, and build.rs copies it beside
/// every local build too. No source-tree path is baked in, since that would put the build machine's folders into the
/// published program.
fn terminal_list_paths() -> Vec<PathBuf> {
    #[allow(unused_mut)]
    let mut paths: Vec<PathBuf> = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(TERMINAL_LIST)))
        .into_iter()
        .collect();
    // Unit tests run from target\<profile>\deps, beside no list; only test builds read the source copy.
    #[cfg(test)]
    paths.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../terminal-apps.json"));
    paths
}

/// The first readable list, or an empty one. A missing or damaged file must never stop Clotr from starting: without it
/// the command check just doesn't recognise terminal windows, and everything else keeps working.
fn read_terminal_list(paths: &[PathBuf]) -> String {
    for path in paths {
        if let Ok(text) = std::fs::read_to_string(path) {
            if serde_json::from_str::<serde_json::Value>(&text).is_ok() {
                return text;
            }
        }
    }
    eprintln!("[Clotr] terminal list not found; the command check won't recognise terminal windows");
    EMPTY_TERMINAL_LIST.to_string()
}

const EMPTY_TERMINAL_LIST: &str = r#"{"apps":[],"runBoxOwnerExe":""}"#;

fn terminal_data() -> &'static str {
    TERMINAL_DATA.get_or_init(|| read_terminal_list(&terminal_list_paths()))
}

/// The terminals Clotr watches. Reuses `apps.rs`'s own list shape and parser: a terminal is matched the same way an
/// AI app is, file name plus package or publisher.
pub fn built_in_terminals() -> Vec<apps::AiApp> {
    // The unit tests check the shipped file; a damaged copy on someone's PC means no terminals, never a crash.
    apps::parse(terminal_data()).unwrap_or_default()
}

/// Browsers Clotr recognizes as the clipboard's owner, to gate the terminal check (section 2's table). File name
/// only: this never claims to identify a specific browser, only that a copy came from one of the ordinary ones
/// people use, so a wrong guess here only changes whether a card shows, not what Clotr reads.
const KNOWN_BROWSERS: &[&str] = &[
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "vivaldi.exe",
];

fn file_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or("").to_ascii_lowercase()
}

fn copied_in_a_browser(clipboard_owner_exe: Option<&str>) -> bool {
    clipboard_owner_exe.is_some_and(|exe| KNOWN_BROWSERS.iter().any(|b| file_name(exe) == *b))
}

/// The surface's kind ("run", "terminal"; a browser's file box joins in a later build), or `None` when the window
/// in front isn't one Clotr watches. `terminals` is `built_in_terminals()` in production, a fixture list in tests.
/// `signer` is asked only when a terminal's file name matched and the entry names a publisher, and only once the
/// clipboard's owner has already settled whether the gate is even open.
pub fn find(
    window: &Window,
    terminals: &[apps::AiApp],
    clipboard_owner_exe: Option<&str>,
    signer: &mut dyn FnMut() -> Option<String>,
) -> Option<&'static str> {
    let owner = run_box_owner_exe();
    if window.class == "#32770" && !owner.is_empty() && file_name(window.owner_exe) == owner {
        return Some("run");
    }
    if copied_in_a_browser(clipboard_owner_exe) {
        let program = apps::Program {
            exe_path: window.owner_exe,
            package_family: window.package_family,
        };
        if apps::find(terminals, &program, signer).is_some() {
            return Some("terminal");
        }
    }
    None
}

fn run_box_owner_exe() -> &'static str {
    static OWNER_EXE: OnceLock<String> = OnceLock::new();
    OWNER_EXE.get_or_init(|| {
        // An empty name matches no window, so a list without it just leaves the Run box unwatched.
        serde_json::from_str::<serde_json::Value>(terminal_data())
            .ok()
            .and_then(|list| list["runBoxOwnerExe"].as_str().map(str::to_ascii_lowercase))
            .unwrap_or_default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_box(owner_exe: &str) -> Window<'_> {
        Window {
            class: "#32770",
            owner_exe,
            package_family: None,
        }
    }

    fn test_terminals() -> Vec<apps::AiApp> {
        apps::parse(
            r#"{"apps":[
                {"id":"cmd","name":"Command Prompt","windows":[{"exe":"cmd.exe","publisher":"Microsoft Windows"}]},
                {"id":"wt","name":"Windows Terminal","windows":[{"exe":"WindowsTerminal.exe","packageFamily":"Microsoft.WindowsTerminal_8wekyb3d8bbwe"}]}
            ]}"#,
        )
        .unwrap()
    }

    fn no_signer() -> impl FnMut() -> Option<String> {
        || None
    }

    #[test]
    fn the_run_box_is_a_surface() {
        let w = run_box(r"C:\Windows\explorer.exe");
        assert_eq!(find(&w, &[], None, &mut no_signer()), Some("run"));
    }

    #[test]
    fn the_match_is_case_insensitive_in_the_file_name() {
        let w = run_box(r"C:\Windows\EXPLORER.EXE");
        assert_eq!(find(&w, &[], None, &mut no_signer()), Some("run"));
    }

    #[test]
    fn another_32770_dialog_not_owned_by_explorer_is_never_a_surface() {
        let w = run_box(r"C:\Program Files\Notepad++\notepad++.exe");
        assert_eq!(find(&w, &[], None, &mut no_signer()), None);
    }

    #[test]
    fn explorers_own_other_windows_are_never_a_surface() {
        let w = Window {
            class: "CabinetWClass",
            owner_exe: r"C:\Windows\explorer.exe",
            package_family: None,
        };
        assert_eq!(find(&w, &[], None, &mut no_signer()), None);
    }

    #[test]
    fn a_blank_window_is_never_a_surface() {
        let w = Window {
            class: "",
            owner_exe: "",
            package_family: None,
        };
        assert_eq!(find(&w, &[], None, &mut no_signer()), None);
    }

    fn terminal_window(owner_exe: &'static str, package_family: Option<&'static str>) -> Window<'static> {
        Window {
            class: "whatever this terminal's own window class is",
            owner_exe,
            package_family,
        }
    }

    #[test]
    fn a_terminal_checks_only_when_the_clipboard_was_last_copied_in_a_browser() {
        let w = terminal_window(r"C:\Windows\System32\cmd.exe", None);
        let mut signer = || Some("Microsoft Windows".to_string());
        assert_eq!(
            find(&w, &test_terminals(), Some(r"C:\...\chrome.exe"), &mut signer),
            Some("terminal")
        );
    }

    #[test]
    fn a_terminal_stays_quiet_when_the_clipboard_owner_is_a_code_editor() {
        let w = terminal_window(r"C:\Windows\System32\cmd.exe", None);
        let mut signer = || Some("Microsoft Windows".to_string());
        assert_eq!(find(&w, &test_terminals(), Some(r"C:\...\Code.exe"), &mut signer), None);
    }

    #[test]
    fn a_terminal_stays_quiet_when_nothing_was_ever_copied() {
        let w = terminal_window(r"C:\Windows\System32\cmd.exe", None);
        let mut signer = || Some("Microsoft Windows".to_string());
        assert_eq!(find(&w, &test_terminals(), None, &mut signer), None);
    }

    #[test]
    fn a_store_terminal_matches_by_its_package_without_asking_for_a_signature() {
        let w = terminal_window(
            r"C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.2.0_x64__8wekyb3d8bbwe\WindowsTerminal.exe",
            Some("Microsoft.WindowsTerminal_8wekyb3d8bbwe"),
        );
        let mut asked = false;
        let mut signer = || {
            asked = true;
            None
        };
        assert_eq!(
            find(&w, &test_terminals(), Some(r"C:\...\msedge.exe"), &mut signer),
            Some("terminal")
        );
        assert!(!asked, "the package settles it without reading the file's signature");
    }

    #[test]
    fn a_program_not_on_the_terminal_list_is_never_a_surface_even_copied_from_a_browser() {
        let w = terminal_window(r"C:\Program Files\Notepad++\notepad++.exe", None);
        let mut signer = || Some("Notepad++ team".to_string());
        assert_eq!(
            find(&w, &test_terminals(), Some(r"C:\...\firefox.exe"), &mut signer),
            None
        );
    }

    #[test]
    fn the_built_in_terminal_list_reads_and_names_the_shells_and_windows_terminal() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../terminal-apps.json");
        let data = read_terminal_list(&[path]);
        let terminals = apps::parse(&data).unwrap();
        let ids: Vec<String> = terminals.into_iter().map(|a| a.id).collect();
        assert_eq!(ids, ["cmd", "powershell", "pwsh", "windows-terminal"]);
        assert_eq!(run_box_owner_exe_from(&data), "explorer.exe");
    }

    // A build run from outside the package (the Newest work launcher's) once found no list beside clotr.exe and
    // panicked at start, so Clotr never opened. A missing or damaged list now means no terminals, never a crash.
    #[test]
    fn a_missing_or_damaged_terminal_list_falls_back_instead_of_crashing() {
        let dir = std::env::temp_dir().join(format!("clotr-terminal-list-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("nowhere.json");
        let damaged = dir.join("damaged.json");
        std::fs::write(&damaged, "{ not json").unwrap();
        let data = read_terminal_list(&[missing, damaged.clone()]);
        assert!(apps::parse(&data).unwrap().is_empty());
        assert_eq!(run_box_owner_exe_from(&data), "");
        let real = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../terminal-apps.json");
        let data = read_terminal_list(&[damaged, real]);
        assert_eq!(
            run_box_owner_exe_from(&data),
            "explorer.exe",
            "the next readable path is used"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    fn run_box_owner_exe_from(data: &str) -> String {
        let list: serde_json::Value = serde_json::from_str(data).unwrap();
        list["runBoxOwnerExe"].as_str().unwrap().to_ascii_lowercase()
    }
}
