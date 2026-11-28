use crate::ai_apps::{ai_app_list, run_box_and_terminals, window_program};
use crate::main_window::settings_commands::settings_view;
use crate::warning_card::card_window::{act, card_hwnd, card_window, place_card};
use crate::warning_card::{card_placement, clipboard};
use crate::{lock, Clotr};
#[cfg(feature = "dk-test-app")]
use crate::LOG;
use std::sync::Arc;
use super::{clipboard_check_rules, windows_events};
use tauri::{AppHandle, Emitter, Manager};

// ---------- What's in front ----------

/// CLOTR_TRACE_FRONT (dk-test-app only, never shipped): one line to stderr each time the window in front changes,
/// with exactly what `find` was given and settled on -- so a real app's own matching can be read without a
/// debugger. Asks the signer itself, past what `find`'s lazy closure needed, so the line is the same whether or not
/// a package family already decided it.
#[cfg(feature = "dk-test-app")]
fn trace_front(info: &window_program::Info, matched: Option<&str>) {
    use std::sync::OnceLock;
    static ON: OnceLock<bool> = OnceLock::new();
    if !*ON.get_or_init(|| std::env::var_os("CLOTR_TRACE_FRONT").is_some()) {
        return;
    }
    let signer = window_program::signer(&info.exe_path);
    eprintln!(
        "{LOG} trace-front: exe={} family={} publisher={} id={}",
        info.exe_path,
        info.package_family.as_deref().unwrap_or("(none)"),
        signer.as_deref().unwrap_or("(unsigned, or not asked)"),
        matched.unwrap_or("(no match)")
    );
}

/// An AI app Clotr just recognised in front counts as covered from now on, even with no Store package to find
/// (`ai_app_list::covered`). The main window hears about it the first time only, with the same view settings_hello gives.
fn note_seen(app: &AppHandle, clotr: &Clotr, id: &str) {
    let new = lock(&clotr.store).note_app_seen(id).unwrap_or(false);
    if new {
        let _ = app.emit_to("main", "history", settings_view(clotr));
    }
}

fn front_of(app: &AppHandle, clotr: &Clotr, raw_hwnd: isize) -> clipboard_check_rules::Front {
    if raw_hwnd == 0 {
        return clipboard_check_rules::Front::Other;
    }
    if card_hwnd(app) == Some(raw_hwnd) {
        return clipboard_check_rules::Front::Card;
    }
    let hwnd = card_placement::hwnd(raw_hwnd);
    if window_program::pid_of(hwnd) == std::process::id() {
        return clipboard_check_rules::Front::Other; // Clotr's main window
    }
    let Some(info) = window_program::info(hwnd) else {
        return clipboard_check_rules::Front::Other;
    };
    let program = ai_app_list::Program {
        exe_path: &info.exe_path,
        package_family: info.package_family.as_deref(),
    };
    let found = ai_app_list::find(&clotr.apps, &program, &mut || window_program::signer(&info.exe_path));
    // The safety net: a program signed by a known AI maker that matched no app, named on Home so this would have
    // said so about Codex on day one. With every built-in maker already claimed by an app, this mostly can't fire
    // for OpenAI or Anthropic any more -- it's here for a future maker entry added ahead of its product.
    *lock(&clotr.unmatched_maker) = if found.is_none() {
        ai_app_list::unmatched_maker_name(&clotr.makers, &program, &mut || window_program::signer(&info.exe_path))
    } else {
        None
    };
    #[cfg(feature = "dk-test-app")]
    trace_front(&info, found.map(|ai_app| ai_app.id.as_str()));
    if let Some(ai_app) = found {
        note_seen(app, clotr, &ai_app.id);
    }
    match found {
        Some(ai_app) => clipboard_check_rules::Front::Ai(clipboard_check_rules::FrontApp {
            hwnd: raw_hwnd,
            id: ai_app.id.clone(),
        }),
        None => match run_box_and_terminals::find(
            &run_box_and_terminals::Window {
                class: &window_program::class_of(hwnd),
                owner_exe: &info.exe_path,
                package_family: info.package_family.as_deref(),
            },
            &clotr.terminals,
            clipboard::owner_exe().as_deref(),
            &mut || window_program::signer(&info.exe_path),
        ) {
            Some(kind) => clipboard_check_rules::Front::Surface(clipboard_check_rules::FrontSurface {
                hwnd: raw_hwnd,
                kind: kind.to_string(),
            }),
            None => clipboard_check_rules::Front::Other,
        },
    }
}

/// Whether the current clipboard copy belongs to a built-in AI app, using the same file, package and signer rules
/// that identify an AI app in front. The sequence checks keep a clipboard update during owner lookup from pairing
/// one copy with another copy's owner.
fn copied_in_ai_app(clotr: &Clotr, seq: u32) -> bool {
    if clipboard::sequence() != seq {
        return false;
    }
    let Some(owner) = clipboard::owner_info() else {
        return false;
    };
    if clipboard::sequence() != seq {
        return false;
    }
    let program = ai_app_list::Program {
        exe_path: &owner.exe_path,
        package_family: owner.package_family.as_deref(),
    };
    ai_app_list::find(&clotr.apps, &program, &mut || window_program::signer(&owner.exe_path)).is_some()
}

pub(crate) fn hear(app: &AppHandle, clotr: &Arc<Clotr>, heard: windows_events::Heard) {
    let todo = match heard {
        windows_events::Heard::Front(raw_hwnd) => {
            let front = front_of(app, clotr, raw_hwnd);
            if matches!(front, clipboard_check_rules::Front::Ai(_) | clipboard_check_rules::Front::Surface(_)) {
                card_window(app, clotr); // the web view starts when the first AI app or surface comes to the front
            }
            let seq = clipboard::sequence();
            let copied_in_ai_app = copied_in_ai_app(clotr, seq);
            lock(&clotr.brain).on_front_with_copy_origin(front, seq, copied_in_ai_app)
        }
        windows_events::Heard::Clipboard => {
            let seq = clipboard::sequence();
            let copied_in_ai_app = copied_in_ai_app(clotr, seq);
            lock(&clotr.brain).on_clipboard_with_copy_origin(seq, copied_in_ai_app)
        }
        windows_events::Heard::Moved(raw_hwnd) => {
            if lock(&clotr.brain).showing() == Some(raw_hwnd) {
                place_card(app, clotr, raw_hwnd);
            }
            vec![]
        }
        windows_events::Heard::Shortcut => {
            reach_card(app, clotr);
            vec![]
        }
    };
    act(app, clotr, todo);
}

/// Alt+Shift+C (held only while the card shows): the card takes the keyboard, on purpose. Esc gives it back.
fn reach_card(app: &AppHandle, clotr: &Clotr) {
    if lock(&clotr.brain).showing().is_none() {
        return;
    }
    let Some(window) = app.get_webview_window("card") else {
        return;
    };
    if let Ok(hwnd) = window.hwnd() {
        let card = card_placement::hwnd(hwnd.0 as isize);
        let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(card) };
    }
    let _ = window.set_focus();
    let _ = app.emit_to("card", "reach", ());
}

/// Tells one window's page whether anyone can actually see it right now (tauri.js, theme.css): minimized or
/// hidden, a page's own CSS animations are the opposite of free, since AWAKE_ARGS keeps the whole web view
/// rendering at full rate no matter what Windows thinks of the window.
pub(crate) fn set_visible(app: &AppHandle, label: &str, visible: bool) {
    let _ = app.emit_to(label, "visible", visible);
}
