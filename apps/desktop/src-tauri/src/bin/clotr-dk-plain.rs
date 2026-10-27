//! A stand-in "ordinary program" for the DK checks (built only with the dk-test-app feature, never part of Clotr):
//! a plain window titled "DK plain window", on no app or terminal list, so a check can bring it to the front and
//! confirm Clotr's card never shows there, however the clipboard changes, and that what's typed in its text box
//! (beside a "Send" button, so only the window's own program keeps it from looking like a chat box) is never read.

#![windows_subsystem = "windows"]

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostQuitMessage, RegisterClassW, ShowWindow,
    TranslateMessage, BS_PUSHBUTTON, CW_USEDEFAULT, ES_AUTOVSCROLL, ES_MULTILINE, HMENU, MSG, SW_SHOW,
    WINDOW_EX_STYLE, WINDOW_STYLE, WM_DESTROY, WM_SETFOCUS, WNDCLASSW, WS_CHILD, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};

static EDIT: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_SETFOCUS {
        let edit = EDIT.load(std::sync::atomic::Ordering::Relaxed);
        if edit != 0 {
            let _ = SetFocus(Some(HWND(edit as *mut _)));
            return LRESULT(0);
        }
    }
    if msg == WM_DESTROY {
        PostQuitMessage(0);
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn main() {
    unsafe {
        let instance = GetModuleHandleW(None).unwrap_or_default();
        let class = WNDCLASSW {
            lpfnWndProc: Some(proc),
            hInstance: instance.into(),
            lpszClassName: w!("ClotrDkPlain"),
            ..Default::default()
        };
        RegisterClassW(&class);
        let Ok(main) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("ClotrDkPlain"),
            w!("DK plain window"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            120,
            120,
            700,
            500,
            None,
            None,
            Some(instance.into()),
            None,
        ) else {
            return;
        };
        let style = WS_CHILD | WS_VISIBLE | WINDOW_STYLE((ES_MULTILINE | ES_AUTOVSCROLL) as u32);
        let edit = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("EDIT"),
            w!(""),
            style,
            16,
            360,
            540,
            80,
            Some(main),
            Some(HMENU(101 as *mut _)),
            Some(instance.into()),
            None,
        );
        let _ = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("BUTTON"),
            w!("Send"),
            WS_CHILD | WS_VISIBLE | WINDOW_STYLE(BS_PUSHBUTTON as u32),
            566,
            360,
            100,
            32,
            Some(main),
            Some(HMENU(103 as *mut _)),
            Some(instance.into()),
            None,
        );
        let _ = ShowWindow(main, SW_SHOW);
        if let Ok(edit) = edit {
            EDIT.store(edit.0 as isize, std::sync::atomic::Ordering::Relaxed);
            let _ = SetFocus(Some(edit));
        }
        let _ = CW_USEDEFAULT;
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
