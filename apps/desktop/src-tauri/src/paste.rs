//! Whatever already has the keyboard when the card appears, and giving it a real paste.
//!
//! The card never takes the keyboard (card.rs's `make_quiet`): the AI app's text box keeps Windows' real focus the
//! whole time the card is up. So a paste never needs to bring anything to the front -- it only needs to know
//! whether the box that had the keyboard when the card first showed is still the one that has it now. UI
//! Automation's RuntimeId is its own per-element identity, present even for the web-rendered inputs common in the
//! Chromium-based AI apps this is for (which often have no name or automation id to compare instead).

use windows::core::BOOL;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, SAFEARRAY,
};
use windows::Win32::System::Ole::{
    SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetLBound, SafeArrayGetUBound, SafeArrayUnaccessData,
};
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL, VK_V,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

/// Whatever has the keyboard right now, as UI Automation's own id for it. `None` when nothing is focused, or
/// Windows won't say -- the card then never pastes (the safe side).
pub fn capture_focus() -> Option<Vec<i32>> {
    unsafe {
        // UI Automation is a COM client; this may run on whichever thread Tauri happens to give the command.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let el = uia.GetFocusedElement().ok()?;
        // A password field is never a paste target, even when its RuntimeId matches the card's first field.
        let password = el.CurrentIsPassword().map(BOOL::as_bool).unwrap_or(true);
        let element_pid = el.CurrentProcessId().ok()?;
        let foreground = GetForegroundWindow();
        let mut foreground_pid = 0u32;
        GetWindowThreadProcessId(foreground, Some(&mut foreground_pid));
        let arr = el.GetRuntimeId().ok()?;
        focus_token(
            password,
            foreground_pid as i32,
            element_pid,
            foreground.0 as isize,
            runtime_id(arr)?,
        )
    }
}

/// A paste token is only usable for a non-password field owned by the current foreground process. Include that
/// process and exact foreground window in the token so the second capture can't authorize a different app/window.
fn focus_token(
    password: bool,
    foreground_pid: i32,
    element_pid: i32,
    foreground_window: isize,
    mut id: Vec<i32>,
) -> Option<Vec<i32>> {
    if password || foreground_pid <= 0 || foreground_pid != element_pid || id.is_empty() {
        return None;
    }
    let hwnd = foreground_window as i64;
    id.extend([element_pid, hwnd as u32 as i32, (hwnd >> 32) as u32 as i32]);
    Some(id)
}

/// A RuntimeId SAFEARRAY of `i32`s, copied out as a plain, comparable `Vec` (and freed): UI Automation hands these
/// out as a pointer Clotr never keeps past this call.
unsafe fn runtime_id(arr: *mut SAFEARRAY) -> Option<Vec<i32>> {
    if arr.is_null() {
        return None;
    }
    let Ok(lo) = SafeArrayGetLBound(arr, 1) else {
        let _ = SafeArrayDestroy(arr);
        return None;
    };
    let Ok(hi) = SafeArrayGetUBound(arr, 1) else {
        let _ = SafeArrayDestroy(arr);
        return None;
    };
    let mut data: *mut i32 = std::ptr::null_mut();
    if SafeArrayAccessData(arr, &mut data as *mut _ as *mut _).is_err() {
        let _ = SafeArrayDestroy(arr);
        return None;
    }
    // Counted in i64 so bounds the other program chose can't overflow; an empty id identifies nothing, and two
    // empty ones would otherwise compare equal however different the boxes behind them are.
    let n = (i64::from(hi) - i64::from(lo) + 1).max(0) as usize;
    let out = (n > 0 && !data.is_null()).then(|| std::slice::from_raw_parts(data, n).to_vec());
    let _ = SafeArrayUnaccessData(arr);
    let _ = SafeArrayDestroy(arr);
    out
}

/// Recheck the exact foreground window, process, and focused element immediately before sending Ctrl+V.
pub fn send_if_focus_unchanged(
    expected: &[i32],
    capture: impl FnOnce() -> Option<Vec<i32>>,
    send: impl FnOnce() -> bool,
) -> bool {
    if capture().as_deref() != Some(expected) {
        return false;
    }
    send()
}

/// A real Ctrl+V, as a person presses it. UIPI can block SendInput when the target runs elevated; report that so the
/// card leaves the text on the clipboard and tells the person to paste it themselves.
pub fn send_ctrl_v() -> bool {
    send_ctrl_v_with(|keys| unsafe { SendInput(keys, std::mem::size_of::<INPUT>() as i32) })
}

fn send_ctrl_v_with(send: impl FnOnce(&[INPUT]) -> u32) -> bool {
    let key = |vk: VIRTUAL_KEY, flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    let keys = [
        key(VK_CONTROL, Default::default()),
        key(VK_V, Default::default()),
        key(VK_V, KEYEVENTF_KEYUP),
        key(VK_CONTROL, KEYEVENTF_KEYUP),
    ];
    send(&keys) == keys.len() as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Ole::{SafeArrayCreateVector, SafeArrayPutElement};
    use windows::Win32::System::Variant::VT_I4;

    #[test]
    fn paste_token_refuses_password_fields_and_a_different_process() {
        assert_eq!(focus_token(true, 7, 7, 11, vec![1]), None);
        assert_eq!(focus_token(false, 8, 7, 11, vec![1]), None);
        assert_eq!(focus_token(false, 0, 0, 11, vec![1]), None);
    }

    #[test]
    fn paste_token_keeps_process_and_window_identity_with_the_element_id() {
        let token = focus_token(false, 7, 7, 0x1_0000_0002, vec![10, 20]).unwrap();
        assert_eq!(token, vec![10, 20, 7, 2, 1]);
    }

    #[test]
    fn focus_change_after_the_first_check_skips_the_send() {
        let first = vec![1, 2, 3];
        let changed = vec![1, 2, 4];
        let mut sent = false;
        assert!(!send_if_focus_unchanged(&first, || Some(changed), || {
            sent = true;
            true
        }));
        assert!(!sent, "the changed target never receives Ctrl+V");
    }

    #[test]
    fn send_input_result_controls_whether_the_card_may_close() {
        assert!(send_ctrl_v_with(|_| 4));
        assert!(
            !send_ctrl_v_with(|_| 0),
            "UIPI or another block leaves the text for manual paste"
        );
    }

    // Whatever app is in front answers UI Automation for its own text box, so its RuntimeId is that program's to
    // shape: an empty one comes back as "no focus to compare" (the card then never pastes), never a read through
    // a pointer an empty array doesn't have to fill in.
    #[test]
    fn an_empty_runtime_id_is_no_focus_never_a_read_through_an_empty_array() {
        let empty = unsafe { SafeArrayCreateVector(VT_I4, 0, 0) };
        assert!(!empty.is_null(), "an empty array for the test");
        assert_eq!(unsafe { runtime_id(empty) }, None);
    }

    #[test]
    fn a_runtime_id_is_copied_out_whole() {
        let arr = unsafe { SafeArrayCreateVector(VT_I4, 0, 3) };
        for (i, v) in [42i32, 7, -1].iter().enumerate() {
            let index = i as i32;
            unsafe { SafeArrayPutElement(arr, &index, v as *const i32 as *const _) }.unwrap();
        }
        assert_eq!(unsafe { runtime_id(arr) }, Some(vec![42, 7, -1]));
    }
}
