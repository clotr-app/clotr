//! Listening, not polling: Windows tells Clotr when another window comes to the front (SetWinEventHook) and when the
//! clipboard changes (AddClipboardFormatListener). With no AI app in front, that's all that happens: no reading,
//! no timer, no work.
//!
//! Everything here runs on one thread with a hidden message-only window. It also owns the card's keyboard shortcut
//! (Alt+Shift+C, held only while the card is showing) and, while the card shows, follows the AI app's window.

use std::sync::mpsc::Sender;
use std::sync::OnceLock;
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::AddClipboardFormatListener;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_NOREPEAT, MOD_SHIFT};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
    PostMessageW, RegisterClassW, TranslateMessage, EVENT_OBJECT_LOCATIONCHANGE, EVENT_SYSTEM_FOREGROUND, HWND_MESSAGE,
    MSG, OBJID_WINDOW, WINDOW_EX_STYLE, WINDOW_STYLE, WINEVENT_OUTOFCONTEXT, WM_APP, WM_CLIPBOARDUPDATE, WM_HOTKEY,
    WNDCLASSW,
};

/// What the watcher tells the rest of Clotr.
#[derive(Debug)]
pub enum Heard {
    Front(isize),
    Clipboard,
    Moved(isize),
    Shortcut,
}

/// What the rest of Clotr asks of the watcher thread.
pub const WM_FOLLOW: u32 = WM_APP + 1; // wparam: the AI app's window to follow (0: stop)
pub const WM_SHORTCUT: u32 = WM_APP + 2; // wparam: 1 hold the shortcut, 0 let it go
const HOTKEY_ID: i32 = 0xC1;

static TX: OnceLock<Sender<Heard>> = OnceLock::new();
static WINDOW: OnceLock<isize> = OnceLock::new();

/// The watcher's hidden window (owns Clotr's clipboard writes, gets the shortcut).
pub fn window() -> HWND {
    HWND(WINDOW.get().copied().unwrap_or(0) as *mut _)
}

/// Follow this AI app's window (0: stop), unless it's already the one followed.
pub fn follow_window(app: isize) {
    if FOLLOWING.load(std::sync::atomic::Ordering::Relaxed) != app {
        post(WM_FOLLOW, app as usize);
    }
}

pub fn post(msg: u32, wparam: usize) {
    if let Some(&h) = WINDOW.get() {
        let _ = unsafe { PostMessageW(Some(HWND(h as *mut _)), msg, WPARAM(wparam), LPARAM(0)) };
    }
}

fn send(heard: Heard) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(heard);
    }
}

unsafe extern "system" fn on_foreground(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    _object: i32,
    _child: i32,
    _thread: u32,
    _time: u32,
) {
    send(Heard::Front(hwnd.0 as isize));
}

static FOLLOWING: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
static MOVES: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// Follows one AI app's window while the card shows beside it: Windows reports moves of that app's windows only
/// (none from anywhere else, so nothing runs while the mouse moves elsewhere). 0 stops following.
unsafe fn follow(app: isize) {
    use std::sync::atomic::Ordering::Relaxed;
    let old = MOVES.swap(0, Relaxed);
    if old != 0 {
        let _ = UnhookWinEvent(HWINEVENTHOOK(old as *mut _));
    }
    FOLLOWING.store(app, Relaxed);
    if app == 0 {
        return;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(HWND(app as *mut _), Some(&mut pid));
    if pid == 0 {
        return;
    }
    let hook = SetWinEventHook(
        EVENT_OBJECT_LOCATIONCHANGE,
        EVENT_OBJECT_LOCATIONCHANGE,
        None,
        Some(on_location),
        pid,
        0,
        WINEVENT_OUTOFCONTEXT,
    );
    MOVES.store(hook.0 as isize, Relaxed);
}

unsafe extern "system" fn on_location(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _thread: u32,
    _time: u32,
) {
    let following = FOLLOWING.load(std::sync::atomic::Ordering::Relaxed);
    if object == OBJID_WINDOW.0 && child == 0 && following != 0 && hwnd.0 as isize == following {
        send(Heard::Moved(following));
    }
}

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_CLIPBOARDUPDATE => {
            send(Heard::Clipboard);
            LRESULT(0)
        }
        WM_HOTKEY if wparam.0 as i32 == HOTKEY_ID => {
            send(Heard::Shortcut);
            LRESULT(0)
        }
        WM_SHORTCUT => {
            if wparam.0 == 1 {
                let _ = RegisterHotKey(Some(hwnd), HOTKEY_ID, MOD_ALT | MOD_SHIFT | MOD_NOREPEAT, 'C' as u32);
            } else {
                let _ = UnregisterHotKey(Some(hwnd), HOTKEY_ID);
            }
            LRESULT(0)
        }
        WM_FOLLOW => {
            follow(wparam.0 as isize);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Starts the watcher thread. What it hears goes to `tx`; the first thing it reports is the window in front now.
pub fn start(tx: Sender<Heard>) -> std::io::Result<()> {
    let _ = TX.set(tx);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("clotr-watch".into())
        .spawn(move || unsafe {
            let instance = GetModuleHandleW(None).unwrap_or_default();
            let class = WNDCLASSW {
                lpfnWndProc: Some(proc),
                hInstance: instance.into(),
                lpszClassName: w!("ClotrWatch"),
                ..Default::default()
            };
            RegisterClassW(&class);
            let Ok(hwnd) = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("ClotrWatch"),
                w!("Clotr"),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(instance.into()),
                None,
            ) else {
                let _ = ready_tx.send(false);
                return;
            };
            let _ = WINDOW.set(hwnd.0 as isize);
            let listening = AddClipboardFormatListener(hwnd).is_ok();
            let front = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(on_foreground),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            let _ = ready_tx.send(listening && !front.is_invalid());
            send(Heard::Front(GetForegroundWindow().0 as isize));
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = UnhookWinEvent(front);
            follow(0);
        })?;
    match ready_rx.recv() {
        Ok(true) => Ok(()),
        _ => Err(std::io::Error::other(
            "Windows didn't let Clotr listen for the clipboard",
        )),
    }
}
