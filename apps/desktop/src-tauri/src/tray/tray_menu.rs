use super::flyout_commands::hide_flyout;
use super::tray_words;
use crate::app_setup::offline_web_view;
use crate::main_window::open_main_window::open_main;
use crate::main_window::settings_commands::{apply_pause, now_ms};
use crate::warning_card::card_placement;
use crate::watching::front_window::set_visible;
use crate::{lock, Clotr, TrayItems, LOG};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, Rect, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

// ---------- The tray and its flyout ----------

/// The tray icon's state: a pause the person chose matters more to show than something merely worth a look (which
/// has no icon of its own beyond this dot yet).
fn tray_icon_for(paused: bool, worth_a_look: bool) -> &'static str {
    if paused {
        "off"
    } else if worth_a_look {
        "look"
    } else {
        "on"
    }
}

fn tray_icon_image(state: &str) -> tauri::image::Image<'static> {
    match state {
        "off" => tauri::include_image!("icons/tray-off.png"),
        "look" => tauri::include_image!("icons/tray-look.png"),
        _ => tauri::include_image!("icons/tray-on.png"),
    }
}

fn set_paused_all(app: &AppHandle, on: bool) {
    let clotr = app.state::<Arc<Clotr>>().inner().clone();
    if lock(&clotr.store).set_paused_all(on).is_err() {
        eprintln!("{LOG} couldn't save the pause");
    }
    apply_pause(app, &clotr);
    if let Some(tray) = app.tray_by_id("clotr") {
        let state = tray_icon_for(on, clotr.worth_a_look.load(Ordering::SeqCst));
        let _ = tray.set_icon(Some(tray_icon_image(state)));
    }
    retell_tray(app, &clotr);
    let _ = app.emit_to("main", "paused", on);
}

fn paused_now(app: &AppHandle) -> bool {
    let clotr = app.state::<Arc<Clotr>>().inner().clone();
    let paused = lock(&clotr.store).paused_all();
    paused
}

/// The tray's words in the language every window speaks now (Settings' Language, or Windows' own): its three menu
/// items and its tooltip, the pause item and the tooltip following the pause too. Run again whenever either changes.
pub(crate) fn retell_tray(app: &AppHandle, clotr: &Clotr) {
    let wording = tray_words::Words::new(&clotr.locale_now());
    let paused = lock(&clotr.store).paused_all();
    if let Some(tray) = app.tray_by_id("clotr") {
        let _ = tray.set_tooltip(Some(wording.t(tooltip_word(paused))));
    }
    if let Some(items) = lock(&clotr.tray_items).as_ref() {
        let _ = items.open.set_text(wording.t("ws.trayOpen"));
        let _ = items.pause.set_text(wording.t(pause_word(paused)));
        let _ = items.quit.set_text(wording.t("tray.quit"));
    }
}

/// Home and the native tray menu change an indefinite pause. The timed flyout already confirms in place; its
/// automatic resume has no open page, so it uses this same Windows toast path.
pub(crate) fn set_paused_all_and_notify(app: &AppHandle, on: bool) {
    let clotr = app.state::<Arc<Clotr>>().inner().clone();
    // A pause or resume from here is the person's own, so a timed pause's hour no longer applies (the tray menu's
    // item reaches here with one still running; the other callers have cleared it already).
    *lock(&clotr.paused_until) = None;
    set_paused_all(app, on);
    let wording = tray_words::Words::new(&clotr.locale_now());
    let body = wording.t(if on { "ws.pausedConfirm" } else { "ws.resumedConfirm" });
    let _ = app.notification().builder().title("Clotr").body(body).show();
}

// ---------- A timed pause ----------

const PAUSE_HOUR_MS: i64 = 60 * 60 * 1000;

/// The tray flyout's "Pause for an hour": a plain pause (so every other window agrees Clotr is paused) with its own
/// deadline, lifted by itself. A later, unrelated "Turn it back on" clears `paused_until` first (`set_paused`), so
/// when this timer wakes it finds a deadline that isn't its own and leaves the (by-then-different) pause alone.
pub(crate) fn pause_for_hour(app: &AppHandle, clotr: &Arc<Clotr>) {
    set_paused_all(app, true);
    let until = now_ms() + PAUSE_HOUR_MS;
    *lock(&clotr.paused_until) = Some(until);
    // Saved with the pause, so a restart within the hour still ends it on time (store_file.rs ends one already past).
    if lock(&clotr.store).set_paused_until(until).is_err() {
        eprintln!("{LOG} couldn't save when the pause ends");
    }
    lift_pause_at(app, clotr, until);
}

/// The one-shot timer that lifts a timed pause at `until`: started by pause_for_hour, and at start-up for a timed
/// pause a restart left with time still to run.
pub(crate) fn lift_pause_at(app: &AppHandle, clotr: &Arc<Clotr>, until: i64) {
    let (app, clotr) = (app.clone(), clotr.clone());
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis((until - now_ms()).max(0) as u64));
        if *lock(&clotr.paused_until) == Some(until) {
            *lock(&clotr.paused_until) = None;
            set_paused_all_and_notify(&app, false);
        }
    });
}

// ---------- Where the flyout goes ----------

/// Before flyout.js has measured the panel (the very first open): close to the real content, so the
/// first paint is already near its final spot and size. `flyout_fit` corrects it a moment later.
pub(crate) const FLYOUT_GUESS: (f64, f64) = (320.0, 290.0);

/// Above the tray icon, right-aligned to it, never covering it or running off the screen's usable area. Every
/// input and the result are logical pixels, already converted for whatever scale the screen is at (100% or 150%):
/// the one function covers both.
fn flyout_spot(
    icon_right: f64,
    icon_top: f64,
    work: (f64, f64, f64, f64),
    width: f64,
    height: f64) -> (f64, f64,
) {
    const MARGIN: f64 = 8.0;
    let (work_left, work_top, work_right, work_bottom) = work;
    let x = (icon_right - width).min(work_right - width).max(work_left);
    let y = (icon_top - height - MARGIN).min(work_bottom - height).max(work_top);
    (x, y)
}

/// Where the tray icon sits, in the primary screen's logical pixels: resolved once from whatever Windows gave the
/// click event (physical or logical), and kept (Clotr's `flyout_rect`) so the flyout can be placed again, at its
/// real size, the moment flyout.js reports it (`flyout_fit`) without needing a fresh click.
#[derive(Clone, Copy, Debug)]
pub(crate) struct FlyoutAnchor {
    icon_right: f64,
    icon_top: f64,
    work: (f64, f64, f64, f64),
}

fn flyout_anchor(app: &AppHandle, rect: Rect) -> FlyoutAnchor {
    let monitor = app.primary_monitor().ok().flatten();
    let scale = monitor.as_ref().map(|primary| primary.scale_factor()).unwrap_or(1.0);
    let work = monitor
        .map(|primary| {
            let area = primary.work_area();
            let (left, top) = (area.position.x as f64 / scale, area.position.y as f64 / scale);
            (
                left,
                top,
                left + area.size.width as f64 / scale,
                top + area.size.height as f64 / scale,
            )
        })
        .unwrap_or((0.0, 0.0, 1920.0, 1040.0));
    let position = rect.position.to_logical::<f64>(scale);
    let size = rect.size.to_logical::<f64>(scale);
    FlyoutAnchor {
        icon_right: position.x + size.width,
        icon_top: position.y,
        work,
    }
}

pub(crate) fn flyout_position(anchor: FlyoutAnchor, size: (f64, f64)) -> (f64, f64) {
    flyout_spot(anchor.icon_right, anchor.icon_top, anchor.work, size.0, size.1)
}

// ---------- Opening the flyout ----------

/// Borderless, always-on-top and never in the taskbar, the same as the card: Windows doesn't hand a window like
/// that the keyboard just because it's shown, so (like `reach_card`) it gets the same push to the front before
/// Tauri's own `set_focus` can hold it. Without this, Esc never reaches flyout.js's listener.
fn focus_flyout(window: &WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        let flyout = card_placement::hwnd(hwnd.0 as isize);
        let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(flyout) };
    }
    let _ = window.set_focus();
}

/// Left click on the tray icon: the flyout, above the icon, closing on a second click (the open one) and
/// (through `on_window_event` below) the moment it loses focus, since any other click is "elsewhere". Esc closes
/// it too, through `close_flyout`, called from flyout.js.
pub(crate) fn toggle_flyout(app: &AppHandle, rect: Rect) {
    let clotr = app.state::<Arc<Clotr>>().inner().clone();
    let anchor = flyout_anchor(app, rect);
    *lock(&clotr.flyout_rect) = Some(anchor);
    if let Some(window) = app.get_webview_window("flyout") {
        if window.is_visible().unwrap_or(false) {
            hide_flyout(app);
        } else {
            show_flyout_again(app, &clotr, &window, anchor);
        }
        return;
    }
    build_flyout(app, &clotr, anchor);
}

/// The flyout already built, shown again at the size flyout.js already measured (or the guess, the very first
/// time): placed the same way every open, never stretched back out to a size nothing asked for.
fn show_flyout_again(app: &AppHandle, clotr: &Clotr, window: &WebviewWindow, anchor: FlyoutAnchor) {
    let (x, y) = flyout_position(anchor, *lock(&clotr.flyout_size));
    let _ = window.set_position(LogicalPosition::new(x, y));
    let _ = window.show();
    focus_flyout(window);
    set_visible(app, "flyout", true);
}

/// The flyout's first open: built at FLYOUT_GUESS's size, which `flyout_fit` corrects once flyout.js measures it.
fn build_flyout(app: &AppHandle, clotr: &Clotr, anchor: FlyoutAnchor) {
    let Some(builder) =
        offline_web_view::window(app, &clotr.webview_dir, &clotr.browser_args, &clotr.locale, "flyout", "flyout.html")
    else {
        eprintln!("{LOG} the flyout couldn't start");
        return;
    };
    let (x, y) = flyout_position(anchor, FLYOUT_GUESS);
    let built = builder
        .title("Clotr")
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .inner_size(FLYOUT_GUESS.0, FLYOUT_GUESS.1)
        .position(x, y)
        .build();
    match built {
        Ok(window) => {
            focus_flyout(&window);
            let closer = app.clone();
            window.on_window_event(move |event| on_flyout_event(&closer, event));
        }
        Err(_) => eprintln!("{LOG} the flyout couldn't start"),
    }
}

/// The flyout takes the keyboard once it's truly active, and closes the moment it loses it.
fn on_flyout_event(closer: &AppHandle, event: &tauri::WindowEvent) {
    match event {
        // Activation can land after the window is already built (Windows grants a brand-new process's first
        // window the front on its own time); set_focus right away can be too early to take, so it's asked for
        // again the moment the window is truly active, which is when Esc needs it.
        tauri::WindowEvent::Focused(true) => {
            if let Some(window) = closer.get_webview_window("flyout") {
                focus_flyout(&window);
            }
        }
        tauri::WindowEvent::Focused(false) => {
            hide_flyout(closer);
        }
        _ => {}
    }
}

// ---------- The tray menu ----------

/// The tray menu's pause item says what a click does next: "Pause until I turn it back on" (the flyout's own
/// button is the timed one) or "Resume Clotr". A plain item, never a checkmark.
fn pause_word(paused: bool) -> &'static str {
    if paused {
        "tray.resume"
    } else {
        "tray.pause"
    }
}

fn tooltip_word(paused: bool) -> &'static str {
    if paused {
        "tray.paused"
    } else {
        "tray.on"
    }
}

pub(crate) fn tray(app: &AppHandle, clotr: &Clotr) -> tauri::Result<()> {
    let wording = tray_words::Words::new(&clotr.locale_now());
    let paused = lock(&clotr.store).paused_all();
    let open = MenuItem::with_id(app, "open", wording.t("ws.trayOpen"), true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", wording.t(pause_word(paused)), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", wording.t("tray.quit"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pause, &PredefinedMenuItem::separator(app)?, &quit])?;
    *lock(&clotr.tray_items) = Some(TrayItems {
        open: open.clone(),
        pause: pause.clone(),
        quit: quit.clone(),
    });
    TrayIconBuilder::with_id("clotr")
        .icon(tray_icon_image(tray_icon_for(
            paused,
            clotr.worth_a_look.load(Ordering::SeqCst),
        )))
        .tooltip(wording.t(tooltip_word(paused)))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => open_main(app),
            // The item flips whatever the pause is now, timed or not, the same as Home's own button.
            "pause" => set_paused_all_and_notify(app, !paused_now(app)),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_flyout(tray.app_handle(), rect);
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tray_says_what_a_click_does_next_in_either_language() {
        let en = tray_words::Words::new("en");
        assert_eq!(en.t(pause_word(false)), "Pause until I turn it back on");
        assert_eq!(en.t(pause_word(true)), "Resume Clotr");
        assert_eq!(en.t(tooltip_word(false)), "Clotr checks what you copy while an AI app is in front");
        let es = tray_words::Words::new(&tray_words::effective_locale(Some("es"), "en-US"));
        assert_eq!(es.t(pause_word(false)), "Pausar hasta que lo vuelva a activar");
        assert_eq!(es.t(pause_word(true)), "Reanudar Clotr");
        assert_eq!(es.t(tooltip_word(false)), "Clotr revisa lo que copias mientras tienes delante una app de IA");
        assert_eq!(en.t("ws.closedToast"), "Clotr is still on, by the clock (look under ^).");
        assert_eq!(es.t("ws.closedToast"), "Clotr sigue activo junto al reloj (búscalo bajo ^).");
    }

    #[test]
    fn the_tray_icon_shows_a_pause_over_worth_a_look_and_on_when_quiet() {
        assert_eq!(tray_icon_for(true, true), "off");
        assert_eq!(tray_icon_for(true, false), "off");
        assert_eq!(tray_icon_for(false, true), "look");
        assert_eq!(tray_icon_for(false, false), "on");
    }

    #[test]
    fn the_flyout_sits_above_the_tray_icon_right_aligned_to_it() {
        let work = (0.0, 0.0, 1920.0, 1040.0);
        assert_eq!(flyout_spot(1900.0, 1020.0, work, 320.0, 360.0), (1580.0, 652.0));
        // The same spot in a screen already in logical pixels at 150% scaling: the function doesn't see the
        // scale at all, only whatever logical numbers its caller already converted.
        let work_150 = (0.0, 0.0, 1280.0, 693.0);
        assert_eq!(flyout_spot(1260.0, 680.0, work_150, 320.0, 360.0), (940.0, 312.0));
    }

    /// A guessed height taller than the flyout's real content used to reserve that much room above the tray
    /// icon too, sitting the flyout further from it than it needed to be (on top of showing as an empty frame).
    /// flyout_fit replaces the guess with flyout.js's measured size, which this pins numerically.
    #[test]
    fn a_too_tall_guess_used_to_sit_the_flyout_further_above_the_icon_than_its_real_content_needs() {
        let work = (0.0, 0.0, 1920.0, 1040.0);
        let icon_top = 1020.0;
        let (_, guessed_y) = flyout_spot(1900.0, icon_top, work, 320.0, 360.0); // the old hardcoded FLYOUT_SIZE
        let (_, real_y) = flyout_spot(1900.0, icon_top, work, 320.0, 290.0); // flyout.js's measured content
        assert!(
            real_y > guessed_y,
            "a shorter, real height sits closer to the icon, not reserved for a guess"
        );
        assert_eq!(real_y, icon_top - 290.0 - 8.0);
    }

    #[test]
    fn the_flyout_stays_on_the_screen() {
        let work = (0.0, 0.0, 1920.0, 1040.0);
        assert_eq!(
            flyout_spot(40.0, 1020.0, work, 320.0, 360.0),
            (0.0, 652.0),
            "an icon near the screen's left edge"
        );
        assert_eq!(
            flyout_spot(1900.0, 20.0, work, 320.0, 360.0),
            (1580.0, 0.0),
            "an icon near the top (a vertical taskbar)"
        );
    }
}
