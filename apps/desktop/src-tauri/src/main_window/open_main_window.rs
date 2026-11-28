use crate::app_setup::offline_web_view;
use crate::saved_data::store_file;
use crate::tray::tray_words;
use crate::watching::front_window::set_visible;
use crate::{lock, Clotr, LOG};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

// ---------- The main window ----------

/// The main window's size, in logical pixels (at 150% scaling the minimum still fits a 1366 x 768 screen).
pub(crate) const MAIN_SIZE: (f64, f64) = (1280.0, 800.0);
pub(crate) const MAIN_MIN: (f64, f64) = (900.0, 600.0);

/// The main window's size on a screen with `room` for windows (the taskbar aside, logical pixels): MAIN_SIZE when
/// it fits with the window's frame, smaller when it doesn't, never below MAIN_MIN.
fn main_size(room: (f64, f64)) -> (f64, f64) {
    let (frame_w, frame_h) = (16.0, 48.0); // the borders and Windows' title bar, with a little room
    (
        MAIN_SIZE.0.min(room.0 - frame_w).max(MAIN_MIN.0),
        MAIN_SIZE.1.min(room.1 - frame_h).max(MAIN_MIN.1),
    )
}

/// The main window: Home, Scan, Results, Protection, History and Settings. Opened from the tray or the
/// flyout; closing it leaves Clotr by the clock. `screen` is where it should land: a freshly built window starts
/// there (`main.html#<screen>`), one already open is sent there through the same "go" event main.js already
/// listens on for its own navigation.
pub(crate) fn open_main_to(app: &AppHandle, screen: &str) {
    if let Some(window) = app.get_webview_window("main") {
        dress_main(app, &window);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        set_visible(app, "main", true);
        let _ = app.emit_to("main", "go", screen);
        return;
    }
    let clotr = app.state::<Arc<Clotr>>().inner().clone();
    let size = main_size_here(app);
    let page = format!("main.html#{screen}");
    let built = offline_web_view::window(app, &clotr.webview_dir, &clotr.browser_args, &clotr.locale, "main", &page)
        .map(|builder| {
            builder
                .title("Clotr")
                .inner_size(size.0, size.1)
                .min_inner_size(MAIN_MIN.0, MAIN_MIN.1)
                .center()
                .build()
        });
    if let Some(Ok(window)) = &built {
        watch_main(app, window);
    }
    if !matches!(built, Some(Ok(_))) {
        eprintln!("{LOG} the main window couldn't open");
    }
}

/// The main window's size for the primary monitor's work area (main_size).
fn main_size_here(app: &AppHandle) -> (f64, f64) {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| {
            let (area, scale) = (monitor.work_area(), monitor.scale_factor());
            main_size((area.size.width as f64 / scale, area.size.height as f64 / scale))
        })
        .unwrap_or(MAIN_SIZE)
}

/// Updates visibility on minimize and checks for the close toast when the main window closes.
fn watch_main(app: &AppHandle, window: &WebviewWindow) {
    // Minimizing fires a Resized(0, 0) on Windows before anything else notices; is_minimized() confirms it
    // rather than trusting the size alone, so a plain small resize never gets mistaken for one.
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Resized(_)) {
            if let Some(main_window) = handle.get_webview_window("main") {
                set_visible(&handle, "main", !main_window.is_minimized().unwrap_or(false));
            }
        }
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            let visible = handle
                .get_webview_window("main")
                .and_then(|main_window| main_window.is_visible().ok())
                .unwrap_or(false);
            first_close_toast(&handle, visible);
        }
    });
}

/// The weekly check's hidden window (start_weekly_check), about to be seen: given everything a main window
/// open_main_to builds has -- title bar and close button, a taskbar button, its size, centred, and its minimize and
/// close handling. A window that already has its title bar is a real main window and is left as it is.
pub(crate) fn dress_main(app: &AppHandle, window: &WebviewWindow) {
    if window.is_decorated().unwrap_or(true) {
        return;
    }
    let size = main_size_here(app);
    let _ = window.set_title("Clotr");
    let _ = window.set_decorations(true);
    let _ = window.set_skip_taskbar(false);
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(MAIN_MIN.0, MAIN_MIN.1)));
    let _ = window.set_size(tauri::LogicalSize::new(size.0, size.1));
    let _ = window.center();
    watch_main(app, window);
}

pub(crate) fn open_main(app: &AppHandle) {
    open_main_to(app, "home");
}

// ---------- The first close's toast ----------

/// Whether closing the main window should bring the one toast saying Clotr is still on by the clock: only a window
/// the person could see (the weekly check's hidden one closes itself), and only the first time ever.
fn close_toast_due(visible: bool, shown_before: bool) -> bool {
    visible && !shown_before
}

/// Closing the window keeps Clotr running by the clock, and Windows 11 tucks a new tray icon under ^, so the first
/// close says where it went. Once only (store_file::Once::CloseToast), never a window of its own.
fn first_close_toast(app: &AppHandle, visible: bool) {
    let clotr = app.state::<Arc<Clotr>>().inner().clone();
    if !close_toast_due(visible, lock(&clotr.store).once(store_file::Once::CloseToast)) {
        return;
    }
    if lock(&clotr.store).set_once(store_file::Once::CloseToast).is_err() {
        eprintln!("{LOG} couldn't save that the close note showed");
    }
    let wording = tray_words::Words::new(&clotr.locale_now());
    let _ = app.notification().builder().title("Clotr").body(wording.t("ws.closedToast")).show();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_first_close_of_a_window_the_person_saw_brings_the_toast() {
        assert!(close_toast_due(true, false));
        assert!(!close_toast_due(true, true), "never a second time");
        assert!(!close_toast_due(false, false), "the weekly check's hidden window closing on its own");
    }

    #[test]
    fn the_main_window_is_1280_by_800_when_the_screen_has_room_and_never_below_900_by_600() {
        assert_eq!(main_size((1707.0, 1019.0)), (1280.0, 800.0)); // 2560 x 1600 at 150%
        assert_eq!(main_size((1920.0, 1032.0)), (1280.0, 800.0));
        assert_eq!(main_size((1366.0, 728.0)), (1280.0, 680.0)); // 1366 x 768 at 100%: it fits under the taskbar
        assert_eq!(main_size((1280.0, 680.0)), (1264.0, 632.0));
        assert_eq!(main_size((910.0, 512.0)), (900.0, 600.0)); // 1366 x 768 at 150%: the minimum
    }
}
