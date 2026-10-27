//! Start Clotr with Windows: the MSIX manifest's own `windows.startupTask` (TaskId "ClotrStartup"), read and
//! flipped through `Windows.ApplicationModel.StartupTask`. That WinRT class only resolves once the running
//! binary has a package identity (an MSIX install, Store or sideloaded). The unpackaged build has none, so it uses
//! the per-user Run key instead (`HKCUSoftwareMicrosoftWindowsCurrentVersionRun`, value "Clotr"), which
//! starts this same exe with `--startup` at sign-in; turning it off removes the value. Task Manager's Startup tab
//! switches a Run entry off by marking it in `StartupApprovedRun`, and that mark is read back as "disabled by user".
//!
//! No consent dialog is shown for a packaged desktop app's StartupTask (unlike a pure UWP app), so toggling it
//! from Settings is a plain, immediate request; Windows itself is still the final word, through Task Manager's
//! Startup tab or an administrator's policy, which is why the result is read back after every request instead
//! of trusted from the click alone.

use std::cell::Cell;
use windows::ApplicationModel::Activation::ActivationKind;
use windows::ApplicationModel::{AppInstance, StartupTask, StartupTaskState};
use windows::core::HSTRING;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};

const TASK_ID: &str = "ClotrStartup";

// RPC_E_CHANGED_MODE: COM is already up on this thread, just not opened by this call -- still fine, since
// StartupTask's WinRT class is declared Agile (works from either apartment kind).
const RPC_E_CHANGED_MODE: i32 = 0x8001_0106_u32 as i32;

/// COM is per-thread, and Tauri's async commands can land on any thread in its pool, so this opens an apartment
/// on whichever thread asks the first time it asks, then leaves it open (Clotr never calls `CoUninitialize`,
/// the thread lives for the rest of the process anyway).
fn ensure_com() {
    thread_local! {
        static DONE: Cell<bool> = const { Cell::new(false) };
    }
    DONE.with(|done| {
        if !done.get() {
            // SAFETY: a plain per-thread COM init, called at most once per thread, never paired with an
            // unmatched CoUninitialize.
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if hr.is_ok() || hr.0 == 1 || hr.0 == RPC_E_CHANGED_MODE {
                done.set(true);
            }
        }
    });
}

/// The one shape Settings and the Rust side agree on, named the way a person reads it rather than the WinRT enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Enabled,
    Disabled,
    DisabledByUser,
    DisabledByPolicy,
    /// No package identity (the unpackaged try build) or the WinRT call failed for any other reason.
    Unsupported,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Enabled => "enabled",
            State::Disabled => "disabled",
            State::DisabledByUser => "disabled-by-user",
            State::DisabledByPolicy => "disabled-by-policy",
            State::Unsupported => "unsupported",
        }
    }

    pub fn enabled(self) -> bool {
        self == State::Enabled
    }
}

fn from_winrt(s: StartupTaskState) -> State {
    match s {
        StartupTaskState::Disabled => State::Disabled,
        StartupTaskState::DisabledByUser => State::DisabledByUser,
        StartupTaskState::Enabled => State::Enabled,
        StartupTaskState::DisabledByPolicy => State::DisabledByPolicy,
        _ => State::Unsupported,
    }
}

fn task() -> windows::core::Result<StartupTask> {
    ensure_com();
    StartupTask::GetAsync(&HSTRING::from(TASK_ID))?.join()
}

fn packaged_state() -> State {
    task().and_then(|t| t.State()).map(from_winrt).unwrap_or(State::Unsupported)
}

/// Reads the real state without asking Windows to change anything, for Settings to draw on every open: the MSIX
/// task when there is one, the Run key otherwise.
pub fn state() -> State {
    match packaged_state() {
        State::Unsupported => run_key::state(&run_key::REAL),
        packaged => packaged,
    }
}

/// Asks Windows to turn Clotr's start at sign-in on or off and returns what it actually ended up as -- never just
/// the ask, since the person may have already turned it off in Task Manager (DisabledByUser) or an administrator's
/// policy may block it (DisabledByPolicy), and Settings must show the truth either way.
pub fn request(enable: bool) -> State {
    match packaged_request(enable) {
        State::Unsupported => run_key::request(&run_key::REAL, enable),
        packaged => packaged,
    }
}

/// The argument the Run key starts Clotr with: a launch at sign-in stays in the tray instead of opening the window.
pub const STARTUP_ARG: &str = "--startup";

/// Whether this launch came from Start with Windows: the Run key's own `--startup`, or, for the Store build, the
/// MSIX startup task, which can't pass an argument, so Windows' activation kind says it instead. The DK checks'
/// build always opens its window, so it never asks.
#[cfg_attr(feature = "dk-test-app", allow(dead_code))]
pub fn launched_at_startup<I: IntoIterator<Item = S>, S: AsRef<str>>(args: I) -> bool {
    started_at_sign_in(args, activation_kind())
}

/// How Windows says it started this process. Only a packaged launch has an answer; an unpackaged one gets `None`,
/// so the Run key's argument is all that counts there.
#[cfg_attr(feature = "dk-test-app", allow(dead_code))]
fn activation_kind() -> Option<ActivationKind> {
    ensure_com();
    AppInstance::GetActivatedEventArgs().and_then(|args| args.Kind()).ok()
}

#[cfg_attr(feature = "dk-test-app", allow(dead_code))]
fn started_at_sign_in<I: IntoIterator<Item = S>, S: AsRef<str>>(args: I, kind: Option<ActivationKind>) -> bool {
    kind == Some(ActivationKind::StartupTask)
        || args.into_iter().skip(1).any(|a| a.as_ref().eq_ignore_ascii_case(STARTUP_ARG))
}

/// The per-user Run key: a thin wrapper over three registry calls, pointed at a scratch key in the tests.
pub mod run_key {
    use super::{State, STARTUP_ARG};
    use std::path::Path;
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_BINARY, RRF_RT_REG_SZ,
    };

    /// Where the value lives and what it's called, and where Task Manager marks it on or off.
    pub struct Place<'a> {
        pub run: &'a str,
        pub approved: &'a str,
        pub name: &'a str,
    }

    pub const REAL: Place<'static> = Place {
        run: r"Software\Microsoft\Windows\CurrentVersion\Run",
        approved: r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
        name: "Clotr",
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// What the Run value holds for `exe`: its path in quotes, then `--startup`.
    pub fn value_for(exe: &Path) -> String {
        format!("\"{}\" {STARTUP_ARG}", exe.display())
    }

    /// The state Settings shows, from what the registry holds: on only when the value starts this very exe (a value
    /// left by a build since moved or deleted reads as off, and turning it on writes it fresh), and Task Manager's
    /// "Disabled" mark (an odd first byte in `StartupApproved\Run`) wins over the value.
    pub fn state_from(value: Option<&str>, approved: Option<&[u8]>, exe: &Path) -> State {
        let ours = value.is_some_and(|v| v.trim().eq_ignore_ascii_case(&value_for(exe)));
        if !ours {
            return State::Disabled;
        }
        match approved.and_then(|b| b.first()) {
            Some(b) if b % 2 == 1 => State::DisabledByUser,
            _ => State::Enabled,
        }
    }

    pub fn read_string(key: &str, name: &str) -> Option<String> {
        let (key, name) = (wide(key), wide(name));
        let mut buf = vec![0u16; 2048];
        let mut size = (buf.len() * 2) as u32;
        let got = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
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
        Some(String::from_utf16_lossy(&buf[..len]))
    }

    fn read_binary(key: &str, name: &str) -> Option<Vec<u8>> {
        let (key, name) = (wide(key), wide(name));
        let mut buf = vec![0u8; 64];
        let mut size = buf.len() as u32;
        let got = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_BINARY,
                None,
                Some(buf.as_mut_ptr() as *mut _),
                Some(&mut size),
            )
        };
        got.is_ok().then(|| buf[..(size as usize).min(buf.len())].to_vec())
    }

    pub fn write_string(key: &str, name: &str, value: &str) -> bool {
        let (key, name, data) = (wide(key), wide(name), wide(value));
        unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                PCWSTR(name.as_ptr()),
                REG_SZ.0,
                Some(data.as_ptr() as *const _),
                (data.len() * 2) as u32,
            )
        }
        .is_ok()
    }

    pub fn delete(key: &str, name: &str) {
        let (key, name) = (wide(key), wide(name));
        let _ = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), PCWSTR(name.as_ptr())) };
    }

    fn exe() -> Option<std::path::PathBuf> {
        std::env::current_exe().ok()
    }

    pub fn state(place: &Place) -> State {
        let Some(exe) = exe() else { return State::Unsupported };
        state_from(
            read_string(place.run, place.name).as_deref(),
            read_binary(place.approved, place.name).as_deref(),
            &exe,
        )
    }

    /// On writes the value for this exe; off removes it. Either way, what the registry holds afterwards is the answer.
    pub fn request(place: &Place, enable: bool) -> State {
        let Some(exe) = exe() else { return State::Unsupported };
        if enable {
            write_string(place.run, place.name, &value_for(&exe));
        } else {
            delete(place.run, place.name);
        }
        state(place)
    }
}

fn packaged_request(enable: bool) -> State {
    let Ok(t) = task() else {
        return State::Unsupported;
    };
    if enable {
        t.RequestEnableAsync().and_then(|op| op.join()).map(from_winrt).unwrap_or(State::Unsupported)
    } else {
        t.Disable().ok();
        t.State().map(from_winrt).unwrap_or(State::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn as_str_names_every_state_in_words_a_person_reads() {
        assert_eq!(State::Enabled.as_str(), "enabled");
        assert_eq!(State::Disabled.as_str(), "disabled");
        assert_eq!(State::DisabledByUser.as_str(), "disabled-by-user");
        assert_eq!(State::DisabledByPolicy.as_str(), "disabled-by-policy");
        assert_eq!(State::Unsupported.as_str(), "unsupported");
    }

    #[test]
    fn only_enabled_counts_as_enabled() {
        assert!(State::Enabled.enabled());
        assert!(!State::Disabled.enabled());
        assert!(!State::DisabledByUser.enabled());
        assert!(!State::DisabledByPolicy.enabled());
        assert!(!State::Unsupported.enabled());
    }

    // The unpackaged test binary has no package identity, so every real WinRT call must fail closed to
    // Unsupported rather than panic; `state()` and `request()` then fall back to the Run key (tested below on a
    // scratch key, never the real one).
    #[test]
    fn unpackaged_task_is_unsupported() {
        assert_eq!(packaged_state(), State::Unsupported);
        assert_eq!(packaged_request(false), State::Unsupported);
    }

    #[test]
    fn only_a_startup_argument_after_the_program_name_counts() {
        assert!(launched_at_startup(["clotr.exe", "--startup"]));
        assert!(launched_at_startup(["clotr.exe", "--STARTUP"]));
        assert!(!launched_at_startup(["clotr.exe"]));
        assert!(!launched_at_startup(["--startup"]), "the program's own name is never an argument");
        assert!(!launched_at_startup(["clotr.exe", "--startup-ish"]));
    }

    #[test]
    fn the_store_builds_startup_task_counts_as_a_start_at_sign_in_without_any_argument() {
        assert!(started_at_sign_in(["clotr.exe"], Some(ActivationKind::StartupTask)));
        assert!(!started_at_sign_in(["clotr.exe"], Some(ActivationKind::Launch)), "a click on its tile");
        assert!(!started_at_sign_in(["clotr.exe"], None), "an unpackaged launch with no argument");
        assert!(started_at_sign_in(["clotr.exe", "--startup"], None), "the Run key's own argument still counts");
        assert!(started_at_sign_in(["clotr.exe", "--startup"], Some(ActivationKind::Launch)));
    }

    // This test binary has no package identity: asking Windows how it was started must come back empty rather than
    // fail or panic, and an ordinary unpackaged launch must still open the window.
    #[test]
    fn an_unpackaged_launch_has_no_activation_kind_and_still_opens_the_window() {
        assert_ne!(activation_kind(), Some(ActivationKind::StartupTask));
        assert!(!launched_at_startup(["clotr.exe"]));
    }

    #[test]
    fn the_run_value_quotes_the_exe_and_adds_the_startup_argument() {
        let exe = Path::new(r"C:\Program Files\Clotr\clotr.exe");
        assert_eq!(run_key::value_for(exe), r#""C:\Program Files\Clotr\clotr.exe" --startup"#);
    }

    #[test]
    fn the_state_read_back_is_on_only_for_this_exe_and_task_managers_off_wins() {
        let exe = Path::new(r"C:\Clotr\clotr.exe");
        let ours = run_key::value_for(exe);
        assert_eq!(run_key::state_from(None, None, exe), State::Disabled);
        assert_eq!(run_key::state_from(Some(&ours), None, exe), State::Enabled);
        assert_eq!(run_key::state_from(Some(&ours.to_uppercase()), None, exe), State::Enabled, "paths ignore case");
        assert_eq!(run_key::state_from(Some(r#""D:\old\clotr.exe" --startup"#), None, exe), State::Disabled);
        assert_eq!(run_key::state_from(Some(&ours), Some(&[2, 0, 0]), exe), State::Enabled, "Task Manager: on");
        assert_eq!(run_key::state_from(Some(&ours), Some(&[3, 0, 0]), exe), State::DisabledByUser);
    }

    #[test]
    fn the_run_key_wrapper_writes_reads_back_and_removes_on_a_scratch_key() {
        let run = format!(r"Software\Clotr-test-{}\Run", std::process::id());
        let approved = format!(r"Software\Clotr-test-{}\Approved", std::process::id());
        let place = run_key::Place { run: &run, approved: &approved, name: "Clotr" };
        assert_eq!(run_key::state(&place), State::Disabled);
        assert_eq!(run_key::request(&place, true), State::Enabled);
        let exe = std::env::current_exe().unwrap();
        assert_eq!(run_key::read_string(&run, "Clotr"), Some(run_key::value_for(&exe)));
        assert_eq!(run_key::request(&place, false), State::Disabled);
        assert_eq!(run_key::read_string(&run, "Clotr"), None, "off removes the value");
        run_key::delete(&run, "Clotr");
        let parent = format!(r"Software\Clotr-test-{}", std::process::id());
        let wide: Vec<u16> = parent.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let _ = windows::Win32::System::Registry::RegDeleteTreeW(
                windows::Win32::System::Registry::HKEY_CURRENT_USER,
                windows::core::PCWSTR(wide.as_ptr()),
            );
        }
    }
}
