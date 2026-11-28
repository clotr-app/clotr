//! The card's window: borderless, see-through around the warning, always on top, and never active. It sits at the
//! top right of the AI app's window, just under its title bar (where the browser's warning sits on a page), inside
//! the screen the app is on. Showing it, moving it and hiding it never take focus from the AI app.

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetWindowLongPtrW, GetWindowRect, IsIconic, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST,
};

/// Just under a title bar, in the app's own scale.
const BELOW_TITLE: f64 = 40.0;

pub fn hwnd(h: isize) -> HWND {
    HWND(h as *mut _)
}

/// The card never becomes the active window, has no taskbar button and stays above the AI app.
pub fn make_quiet(card: HWND) {
    unsafe {
        let ex = GetWindowLongPtrW(card, GWL_EXSTYLE);
        let want = ex | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0 | WS_EX_TOPMOST.0) as isize;
        if ex != want {
            SetWindowLongPtrW(card, GWL_EXSTYLE, want);
        }
    }
}

/// Where the card goes for an AI app window at `app` (its visible bounds), on a screen whose usable area is `work`,
/// at `scale` (1.0 = 96 dpi): the top right corner, under the title bar, kept inside the screen. Sizes in pixels.
pub fn spot(app: RECT, work: RECT, scale: f64, width: i32, height: i32) -> (i32, i32) {
    let below = (BELOW_TITLE * scale).round() as i32;
    let mut x = app.right - width;
    let mut y = app.top + below;
    x = x.min(work.right - width).max(work.left);
    y = y.min(work.bottom - height).max(work.top);
    (x, y)
}

fn bounds(app: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    let ok = unsafe {
        DwmGetWindowAttribute(
            app,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
    }
    .is_ok()
        || unsafe { GetWindowRect(app, &mut r) }.is_ok();
    ok.then_some(r)
}

/// Shows the card beside the AI app at its size (in CSS pixels; the app's screen sets the scale).
pub fn show(card: HWND, app: HWND, width: f64, height: f64) -> bool {
    if unsafe { IsIconic(app) }.as_bool() {
        return false;
    }
    let Some(r) = bounds(app) else { return false };
    let monitor = unsafe { MonitorFromWindow(app, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return false;
    }
    // The screen's own scale (an app that doesn't know about scaling reports 96 dpi for itself).
    let (mut dpi, mut _y) = (96u32, 96u32);
    let _ = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi, &mut _y) };
    let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
    // The size asked for is the page's; the window adds whatever frame Windows keeps around it.
    let (frame_w, frame_h) = frame(card);
    let w = (width * scale).ceil() as i32 + frame_w;
    let h = (height * scale).ceil() as i32 + frame_h;
    let (x, y) = spot(r, info.rcWork, scale, w, h);
    make_quiet(card);
    unsafe { SetWindowPos(card, Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW) }.is_ok()
}

/// How much bigger the window is than the part the page draws in.
fn frame(card: HWND) -> (i32, i32) {
    let (mut outer, mut inner) = (RECT::default(), RECT::default());
    let ok = unsafe { GetWindowRect(card, &mut outer).is_ok() && GetClientRect(card, &mut inner).is_ok() };
    if !ok {
        return (0, 0);
    }
    let w = (outer.right - outer.left) - (inner.right - inner.left);
    let h = (outer.bottom - outer.top) - (inner.bottom - inner.top);
    (w.clamp(0, 64), h.clamp(0, 64))
}

pub fn hide(card: HWND) {
    let _ = unsafe { ShowWindow(card, SW_HIDE) };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
        RECT {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn the_card_sits_at_the_apps_top_right_under_its_title_bar() {
        let work = rect(0, 0, 1920, 1040);
        assert_eq!(spot(rect(200, 100, 1400, 900), work, 1.0, 372, 200), (1028, 140));
        assert_eq!(spot(rect(200, 100, 1400, 900), work, 1.5, 558, 300), (842, 160));
    }

    #[test]
    fn the_card_stays_on_the_screen() {
        let work = rect(0, 0, 1920, 1040);
        assert_eq!(
            spot(rect(1700, 900, 2600, 1300), work, 1.0, 372, 200),
            (1548, 840),
            "an app partly off the screen"
        );
        assert_eq!(
            spot(rect(-100, -50, 200, 300), work, 1.0, 372, 200),
            (0, 0),
            "an app smaller than the card"
        );
        let second = rect(1920, 0, 3840, 1080);
        assert_eq!(
            spot(rect(1920, 0, 3840, 1080), second, 1.0, 372, 200),
            (3468, 40),
            "on a second screen"
        );
    }
}
