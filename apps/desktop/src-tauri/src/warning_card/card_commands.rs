use super::card_window::{hide_card, place_card};
use super::{card_placement, clipboard, paste_into_app, typing_check};
use crate::main_window::settings_commands::{settings_view, tell_settings};
use crate::watching::windows_events;
use crate::{lock, only, Clotr};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

// ---------- The card's commands (capabilities/card.json) ----------

#[tauri::command]
pub(crate) async fn card_hello(window: WebviewWindow, clotr: State<'_, Arc<Clotr>>) -> Result<Value, String> {
    only(&window, "card")?;
    // Ready and what was kept waiting, together under `pending`'s lock (ask_card's own): from here on checks are
    // sent straight to the page, which card.js already listens for before it says hello.
    let pending = {
        let mut pending = lock(&clotr.pending);
        clotr.card_ready.store(true, Ordering::SeqCst);
        pending.take()
    };
    let settings = lock(&clotr.store).settings();
    // Settings' Language when one was picked; the system's own as well, so the card can follow a later change of
    // Language from the "settings" event alone.
    Ok(json!({
        "settings": settings,
        "locale": clotr.locale_now(),
        "systemLocale": clotr.locale,
        "pending": pending,
    }))
}

/// The copy being checked, while its AI app or surface is in front: its text, "private" (marked so by the app it
/// came from: not read), "nothing" (no text) or "stale" (another copy, or it isn't in front). Clotr keeps no copy
/// of it.
#[tauri::command]
pub(crate) async fn read_clip(window: WebviewWindow, clotr: State<'_, Arc<Clotr>>, seq: u32) -> Result<Value, String> {
    only(&window, "card")?;
    let brain = lock(&clotr.brain);
    if !brain.may_read(seq, clipboard::sequence()) {
        return Ok(json!({ "kind": "stale" }));
    }
    Ok(match clipboard::read(windows_events::window()) {
        clipboard::Clip::Text(text) => json!({ "kind": "text", "text": text }),
        clipboard::Clip::Private => json!({ "kind": "private" }),
        clipboard::Clip::Nothing => json!({ "kind": "nothing" }),
    })
}

#[tauri::command]
pub(crate) async fn show_card(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    app: AppHandle,
    seq: u32,
    width: f64,
    height: f64,
) -> Result<bool, String> {
    only(&window, "card")?;
    *lock(&clotr.size) = (width.clamp(200.0, 700.0), height.clamp(80.0, 1200.0));
    let focus = paste_into_app::capture_focus();
    let beside = lock(&clotr.brain).ready(seq, clipboard::sequence(), focus);
    Ok(match beside {
        Some(hwnd) => place_card(&app, &clotr, hwnd),
        None => false,
    })
}

#[tauri::command]
pub(crate) async fn resize_card(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    app: AppHandle,
    width: f64,
    height: f64,
) -> Result<(), String> {
    only(&window, "card")?;
    *lock(&clotr.size) = (width.clamp(200.0, 700.0), height.clamp(80.0, 1200.0));
    let beside = lock(&clotr.brain).showing();
    if let Some(hwnd) = beside {
        place_card(&app, &clotr, hwnd);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn card_done(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    app: AppHandle,
    seq: u32,
) -> Result<(), String> {
    only(&window, "card")?;
    if lock(&clotr.brain).done(seq) {
        hide_card(&app);
    }
    Ok(())
}

/// Clot this leak: the safe version replaces the copy, if it's still the same copy with its AI app in
/// front. Clotr's own copy is never checked again.
#[tauri::command]
pub(crate) async fn hide_in_clipboard(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    seq: u32,
    text: String,
) -> Result<Value, String> {
    only(&window, "card")?;
    let mut brain = lock(&clotr.brain);
    if !brain.may_read(seq, clipboard::sequence()) {
        return Ok(json!({ "ok": false }));
    }
    match clipboard::write(windows_events::window(), &text) {
        Ok(new) => {
            brain.wrote(seq, new);
            Ok(json!({ "ok": true, "seq": new, "history": clipboard::history_on() }))
        }
        Err(_) => Ok(json!({ "ok": false })),
    }
}

// ---------- A typed check's commands ----------

/// What the typing check read for this typed check, taken once: `stale` if it's no longer this check's, or the
/// box's app isn't in front and watched. Clotr keeps no copy once the page has it.
#[tauri::command]
pub(crate) async fn read_typed(window: WebviewWindow, clotr: State<'_, Arc<Clotr>>, seq: u32) -> Result<Value, String> {
    only(&window, "card")?;
    let taken = lock(&clotr.typed_text).take_if(|(typed_seq, _)| *typed_seq == seq);
    let may = lock(&clotr.brain).may_read_typed(seq);
    Ok(match taken {
        Some((_, text)) if may => json!({ "kind": "text", "text": text }),
        _ => json!({ "kind": "stale" }),
    })
}

/// "Clot this leak and copy": the box read once more, now, for the page to swap the details for labels. Only for the
/// typed card on screen, its app in front and its box still watched.
#[tauri::command]
pub(crate) async fn read_box_again(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    seq: u32,
) -> Result<Value, String> {
    only(&window, "card")?;
    if !lock(&clotr.brain).may_read_typed(seq) {
        return Ok(json!({ "kind": "stale" }));
    }
    Ok(match typing_check::read_now() {
        Some(text) => json!({ "kind": "text", "text": text }),
        None => json!({ "kind": "nothing" }),
    })
}

/// "Clot this leak and copy", second half: the safe text on the clipboard, never checked as a copy. Clotr never
/// writes into the box itself; the card tells the person to paste over their message.
#[tauri::command]
pub(crate) async fn copy_safe(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    seq: u32,
    text: String,
) -> Result<Value, String> {
    only(&window, "card")?;
    let mut brain = lock(&clotr.brain);
    if !brain.may_read_typed(seq) {
        return Ok(json!({ "ok": false }));
    }
    match clipboard::write(windows_events::window(), &text) {
        Ok(new) => {
            brain.wrote_typed(new);
            Ok(json!({ "ok": true, "history": clipboard::history_on() }))
        }
        Err(_) => Ok(json!({ "ok": false })),
    }
}

/// The first typed card carried its one-line note; it isn't shown again.
#[tauri::command]
pub(crate) async fn typed_note_seen(window: WebviewWindow, clotr: State<'_, Arc<Clotr>>) -> Result<(), String> {
    only(&window, "card")?;
    lock(&clotr.store)
        .set_typed_note_seen()
        .map_err(|_| "not-saved".to_string())
}

// ---------- Paste, the scam check's note, and back to the app ----------

/// "Ask someone first" on *Is this a scam?*, the main window's own result (not a card, and not something Clotr
/// read a clipboard copy to get to): a plain clipboard write of the note extension/ask-someone.js built, with
/// none of hide_in_clipboard's sequence tracking, since there's no pending clipboard read on this window to
/// keep in step with. The note is fixed text built from sign names only, never a value.
#[tauri::command]
pub(crate) async fn copy_note(window: WebviewWindow, text: String) -> Result<bool, String> {
    only(&window, "main")?;
    Ok(clipboard::write(windows_events::window(), &text).is_ok())
}

/// Paste it, with a real Ctrl+V: only into the text box the card first appeared over, and only if that box still
/// has the keyboard. Clotr never brings anything to the front for this (the AI app already has it); if the check
/// fails, the text stays on the clipboard and the card says so instead.
#[tauri::command]
pub(crate) async fn paste_clip(window: WebviewWindow, clotr: State<'_, Arc<Clotr>>, seq: u32) -> Result<bool, String> {
    only(&window, "card")?;
    let focus = paste_into_app::capture_focus();
    let may = focus
        .as_ref()
        .is_some_and(|captured| lock(&clotr.brain).may_paste(seq, clipboard::sequence(), captured));
    let Some(focus) = focus.filter(|_| may) else {
        return Ok(false);
    };
    Ok(paste_into_app::send_if_focus_unchanged(
        &focus,
        paste_into_app::capture_focus,
        paste_into_app::send_ctrl_v,
    ))
}

#[tauri::command]
pub(crate) async fn back_to_app(window: WebviewWindow, clotr: State<'_, Arc<Clotr>>) -> Result<(), String> {
    only(&window, "card")?;
    let hwnd = lock(&clotr.brain).front_hwnd();
    if let Some(hwnd) = hwnd {
        let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(card_placement::hwnd(hwnd)) };
    }
    Ok(())
}

// ---------- What's recorded ----------

/// Recorded elsewhere (a card, on whatever AI app the person's in), so the main window's History and Home counts
/// update the moment it happens, not the next time it's opened: the same view `settings_hello` would hand
/// back, emitted to "main" so main.js's `show` redraws both from it, no reopening needed.
#[tauri::command]
pub(crate) async fn record(
    window: WebviewWindow,
    app: AppHandle,
    c: State<'_, Arc<Clotr>>,
    events: Value,
) -> Result<usize, String> {
    only(&window, "card")?;
    let n = lock(&c.store)
        .record(&events, &c.app_ids())
        .map_err(|_| "not-saved".to_string())?;
    if n > 0 {
        let _ = app.emit_to("main", "history", settings_view(&c));
    }
    Ok(n)
}

/// A finished scan or Look back read, from the main window alone (a scan never runs behind the card): one row
/// for History's scan list, with the fresh view back so it can redraw without asking again.
#[tauri::command]
pub(crate) async fn record_scan(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    row: Value,
) -> Result<Value, String> {
    only(&window, "main")?;
    lock(&clotr.store).record_scan(&row).map_err(|_| "not-saved".to_string())?;
    Ok(settings_view(&clotr))
}

#[tauri::command]
pub(crate) async fn set_responses(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    app: AppHandle,
    kinds: Value,
    response: String,
) -> Result<usize, String> {
    if window.label() != "card" && window.label() != "main" {
        return Err("not-allowed".into());
    }
    let n = lock(&clotr.store)
        .set_responses(&kinds, &response)
        .map_err(|_| "not-saved".to_string())?;
    tell_settings(&app, &clotr);
    Ok(n)
}
