use super::{card_placement, typing_check};
use crate::ai_apps::window_program;
use crate::app_setup::offline_web_view;
use crate::watching::{clipboard_check_rules, windows_events};
use crate::{lock, Clotr, LOG};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

// ---------- The card ----------

/// How long nothing may need the card -- no AI app or terminal surface in front, no check pending -- before the
/// idle watchdog (in `main`'s setup) gives its hidden window's memory back: long enough that it never fires
/// mid-conversation just because nothing happened to need a check for a few minutes, short enough that the
/// memory doesn't sit unused for the rest of the day once someone's actually left every AI app.
/// CLOTR_CARD_IDLE_DESTROY_MS (dk-test-app only, never shipped): shortens this for a test that can't wait ten
/// real minutes to see the watchdog fire.
pub(crate) fn card_idle_destroy() -> std::time::Duration {
    #[cfg(feature = "dk-test-app")]
    if let Ok(raw) = std::env::var("CLOTR_CARD_IDLE_DESTROY_MS") {
        if let Ok(millis) = raw.parse() {
            return std::time::Duration::from_millis(millis);
        }
    }
    std::time::Duration::from_secs(600)
}

/// Whether the idle watchdog may close the card's window: nothing has needed it for `idle`, and the brain holds no
/// card -- not one on screen, and not one stepped aside until its app comes back, whose warning lives in this page.
pub(crate) fn card_idle_close_due(
    last_needed: Option<std::time::Instant>,
    idle: std::time::Duration,
    brain: &clipboard_check_rules::Brain,
) -> bool {
    last_needed.is_some_and(|last| last.elapsed() >= idle) && brain.card.is_none()
}

/// The card's window, made when the first AI app comes to the front (the web view starts then) and kept, until
/// the idle watchdog destroys a long-unneeded one and the next AI app in front builds it fresh again here, the
/// same way the very first one did. Windows are made on the main thread, so a call from elsewhere waits for it
/// there.
pub(crate) fn card_window(app: &AppHandle, clotr: &Arc<Clotr>) -> bool {
    *lock(&clotr.card_last_needed) = Some(std::time::Instant::now());
    if app.get_webview_window("card").is_some() {
        return true;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let (app_for_main, clotr_for_main) = (app.clone(), clotr.clone());
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(make_card(&app_for_main, &clotr_for_main));
        })
        .is_err()
    {
        return false;
    }
    rx.recv_timeout(std::time::Duration::from_secs(30)).unwrap_or(false)
}

fn make_card(app: &AppHandle, clotr: &Clotr) -> bool {
    if app.get_webview_window("card").is_some() {
        return true;
    }
    let Some(builder) =
        offline_web_view::window(app, &clotr.webview_dir, &clotr.browser_args, &clotr.locale, "card", "card.html")
    else {
        eprintln!("{LOG} the web view couldn't start");
        return false;
    };
    let built = builder
        .title("Clotr")
        .visible(false)
        .focused(false)
        .focusable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .inner_size(480.0, 720.0)
        .build();
    match built {
        Ok(window) => {
            if let Ok(hwnd) = window.hwnd() {
                card_placement::make_quiet(card_placement::hwnd(hwnd.0 as isize));
            }
            // Built hidden: let WebView2 trim it right away, the same as every other moment nobody's looking.
            offline_web_view::set_memory_target(&window, true);
            true
        }
        Err(_) => {
            eprintln!("{LOG} the card's window couldn't start");
            false
        }
    }
}

pub(crate) fn card_hwnd(app: &AppHandle) -> Option<isize> {
    app.get_webview_window("card")
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize)
}

pub(crate) fn place_card(app: &AppHandle, clotr: &Clotr, beside: isize) -> bool {
    let Some(window) = app.get_webview_window("card") else {
        return false;
    };
    let Ok(card) = window.hwnd().map(|hwnd| hwnd.0 as isize) else {
        return false;
    };
    // Asked for first, so WebView2 is already working at full speed by the time the card is on screen.
    offline_web_view::set_memory_target(&window, false);
    let (width, height) = *lock(&clotr.size);
    let shown = card_placement::show(card_placement::hwnd(card), card_placement::hwnd(beside), width, height);
    if shown {
        windows_events::post(windows_events::WM_SHORTCUT, 1);
        windows_events::follow_window(beside);
    }
    shown
}

pub(crate) fn hide_card(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("card") {
        if let Ok(hwnd) = window.hwnd() {
            card_placement::hide(card_placement::hwnd(hwnd.0 as isize));
        }
        // Hidden again until the next copy or typed check: let it go back to costing as little as it can.
        offline_web_view::set_memory_target(&window, true);
    }
    windows_events::post(windows_events::WM_SHORTCUT, 0);
    windows_events::follow_window(0);
}

/// A check for the card's page: sent now once the page has said hello (card_hello), kept for its hello until then.
/// Decided under `pending`'s lock, the one card_hello sets card_ready and takes `pending` under, so a check can't
/// be kept just after hello took what was waiting and then never be collected.
fn ask_card(app: &AppHandle, clotr: &Arc<Clotr>, event: &str, ask: Value) {
    let built = card_window(app, clotr);
    let mut pending = lock(&clotr.pending);
    if built && clotr.card_ready.load(Ordering::SeqCst) {
        let _ = app.emit_to("card", event, ask);
    } else {
        *pending = Some(ask);
    }
}

pub(crate) fn act(app: &AppHandle, clotr: &Arc<Clotr>, todo: Vec<clipboard_check_rules::Do>) {
    for step in todo {
        match step {
            clipboard_check_rules::Do::Check { seq, app: id } => {
                ask_card(app, clotr, "clip", json!({ "seq": seq, "app": id }))
            }
            clipboard_check_rules::Do::CheckSurface { seq, kind } => {
                ask_card(app, clotr, "clip", json!({ "seq": seq, "surface": kind }))
            }
            clipboard_check_rules::Do::CheckTyped { seq, app: id } => {
                ask_card(app, clotr, "typed", json!({ "seq": seq, "app": id, "typed": true }))
            }
            clipboard_check_rules::Do::TypingOn { hwnd } => typing_check::watch(window_program::real_owner(card_placement::hwnd(hwnd)), hwnd),
            clipboard_check_rules::Do::TypingOff => {
                typing_check::stop();
                *lock(&clotr.typed_text) = None;
            }
            // Answered to typing_check.rs directly, through TypingHost in typing_check_host.rs.
            clipboard_check_rules::Do::WatchBox | clipboard_check_rules::Do::ReadBox => {}
            clipboard_check_rules::Do::Show { hwnd } => {
                place_card(app, clotr, hwnd);
            }
            clipboard_check_rules::Do::Hide => hide_card(app),
            clipboard_check_rules::Do::Drop => {
                hide_card(app);
                *lock(&clotr.pending) = None;
                let _ = app.emit_to("card", "hide", ());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The idle watchdog never closes the card's window while the brain still holds a card, on screen or stepped
    /// aside until its app comes back: closing it then lost the warning and later showed an empty window.
    #[test]
    fn the_idle_card_window_is_kept_while_a_stepped_aside_card_waits_for_its_app() {
        let idle = std::time::Duration::from_secs(600);
        let long_ago = std::time::Instant::now().checked_sub(std::time::Duration::from_secs(660));
        let claude = || {
            clipboard_check_rules::Front::Ai(clipboard_check_rules::FrontApp {
                hwnd: 7,
                id: "claude".into(),
            })
        };
        let mut b = clipboard_check_rules::Brain::default();
        b.on_front(claude(), 3);
        b.ready(3, 3, None);
        b.on_front(clipboard_check_rules::Front::Other, 3);
        assert_eq!(b.showing(), None, "stepped aside: not on screen");
        assert!(!card_idle_close_due(long_ago, idle, &b), "but still waiting for its app");
        assert!(b.done(3));
        assert!(card_idle_close_due(long_ago, idle, &b), "nothing held: its memory goes back");
        assert!(
            !card_idle_close_due(Some(std::time::Instant::now()), idle, &b),
            "needed a moment ago"
        );
        assert!(!card_idle_close_due(None, idle, &b), "never built");
    }
}
