//! A stand-in "AI app" for the DK checks (built only with the dk-test-app feature, never part of Clotr): a plain
//! window titled "DK test AI app" with a chat-shaped text box (a "Send" button beside it) and a password box, so a
//! check can bring an AI app to the front, paste or type into it and see that Clotr's card never takes the
//! keyboard from it, and that the typing check reads the chat box and never the password box. UI Automation names
//! the boxes by their control ids: 101 the chat box, 102 the password box, 103 Send.

#![windows_subsystem = "windows"]

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostQuitMessage, RegisterClassW, ShowWindow,
    TranslateMessage, BS_PUSHBUTTON, CW_USEDEFAULT, ES_AUTOHSCROLL, ES_AUTOVSCROLL, ES_MULTILINE, ES_PASSWORD, HMENU,
    MSG, SW_SHOW, WINDOW_EX_STYLE, WINDOW_STYLE, WM_DESTROY, WM_SETFOCUS, WNDCLASSW, WS_BORDER, WS_CHILD,
    WS_OVERLAPPEDWINDOW, WS_TABSTOP, WS_VISIBLE, WS_VSCROLL,
};

static EDIT: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // Like a chat app: whenever the window has the keyboard, its text box does.
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
            lpszClassName: w!("ClotrDkAi"),
            ..Default::default()
        };
        RegisterClassW(&class);
        let Ok(main) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("ClotrDkAi"),
            w!("DK test AI app"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            120,
            120,
            1000,
            700,
            None,
            None,
            Some(instance.into()),
            None,
        ) else {
            return;
        };
        let child = |class, text, style: WINDOW_STYLE, (x, y, w, h), id: usize| {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                text,
                WS_CHILD | WS_VISIBLE | WS_TABSTOP | style,
                x,
                y,
                w,
                h,
                Some(main),
                Some(HMENU(id as *mut _)),
                Some(instance.into()),
                None,
            )
        };
        let style = WS_VSCROLL | WINDOW_STYLE((ES_MULTILINE | ES_AUTOVSCROLL) as u32);
        let edit = child(w!("EDIT"), w!(""), style, (16, 560, 840, 80), 101);
        let password = WS_BORDER | WINDOW_STYLE((ES_PASSWORD | ES_AUTOHSCROLL) as u32);
        let _ = child(w!("EDIT"), w!(""), password, (16, 510, 300, 28), 102);
        let _ = child(w!("BUTTON"), w!("Send"), WINDOW_STYLE(BS_PUSHBUTTON as u32), (866, 560, 100, 32), 103);
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
