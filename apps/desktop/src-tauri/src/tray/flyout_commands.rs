use super::tray_menu::{flyout_position, pause_for_hour, set_paused_all_and_notify};
use crate::main_window::open_main_window::open_main_to;
use crate::{lock, only, Clotr};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, WebviewWindow};

// ---------- The flyout ----------

/// Every way the flyout stops being shown goes through here. It closes the window rather than hiding it,
/// because a web view's browser process keeps costing processor time for as long as any window built on it
/// still exists, hidden or not (measured, tests/cpu.rs: a few tenths of a core, forever, for a flyout merely
/// kept around between opens). toggle_flyout already rebuilds it from nothing on the next open, which the
/// shared, already-warm environment (offline_web_view.rs) makes cheap.
pub(crate) fn hide_flyout(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("flyout") {
        let _ = window.close();
    }
}

/// Esc, from flyout.js: the one way the flyout closes itself without taking an action.
#[tauri::command]
pub(crate) async fn close_flyout(window: WebviewWindow) -> Result<(), String> {
    only(&window, "flyout")?;
    hide_flyout(window.app_handle());
    Ok(())
}

/// flyout.js's own ResizeObserver, reporting the panel's real size: the window is set to exactly that and
/// placed from the tray icon rect `toggle_flyout` kept, so it's never taller than its content and never further
/// from the icon than the real size needs.
#[tauri::command]
pub(crate) async fn flyout_fit(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    only(&window, "flyout")?;
    let size = (width.clamp(240.0, 420.0), height.clamp(120.0, 480.0));
    *lock(&clotr.flyout_size) = size;
    if let Some(anchor) = *lock(&clotr.flyout_rect) {
        let (x, y) = flyout_position(anchor, size);
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(size.0, size.1)));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn flyout_open(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, "flyout")?;
    hide_flyout(&app);
    open_main_to(&app, "home");
    Ok(())
}

#[tauri::command]
pub(crate) async fn flyout_scan(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, "flyout")?;
    hide_flyout(&app);
    // "scan-quick": the Scan screen, with a Quick scan started there (main.js), since that's what the button says.
    open_main_to(&app, "scan-quick");
    Ok(())
}

/// "Pause for an hour" / "Resume now": toggles, rather than always pausing, so the same button undoes a
/// pause it just started. Doesn't hide the flyout itself -- flyout.js shows a brief confirmation first, in the
/// window already open, never a new one, and closes it a moment later.
#[tauri::command]
pub(crate) async fn flyout_pause(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    app: AppHandle,
) -> Result<Value, String> {
    only(&window, "flyout")?;
    if lock(&clotr.store).paused_all() {
        *lock(&clotr.paused_until) = None;
        set_paused_all_and_notify(&app, false);
        Ok(json!({ "paused": false }))
    } else {
        pause_for_hour(&app, &clotr.inner().clone());
        Ok(json!({ "paused": true, "pausedUntil": *lock(&clotr.paused_until) }))
    }
}

#[tauri::command]
pub(crate) async fn flyout_quit(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, "flyout")?;
    app.exit(0);
    Ok(())
}
