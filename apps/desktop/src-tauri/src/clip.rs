//! The clipboard, read only while an AI app is in front (watch.rs decides when) and never kept: a read hands the
//! text straight to the engine page and keeps no copy.
//!
//! What a password manager marks private (ExcludeClipboardContentFromMonitorProcessing, or the older "Clipboard
//! Viewer Ignore") is never read at all: Clotr only learns that it's there.

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardOwner, GetClipboardSequenceNumber,
    IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;

/// Longest text checked: about 2 million characters (a few hundred pages). Anything longer is left alone.
pub const MAX_CHARS: usize = 2_000_000;

#[derive(Debug, PartialEq)]
pub enum Clip {
    Text(String),
    /// Marked private by the app it came from: not read.
    Private,
    /// No text (a picture, files, nothing) or too long to check.
    Nothing,
}

/// Windows counts every change to the clipboard; the same number means the same content.
pub fn sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

fn format(name: PCWSTR) -> u32 {
    unsafe { RegisterClipboardFormatW(name) }
}

/// Marked private by the app that put it there.
pub fn is_private() -> bool {
    [
        w!("ExcludeClipboardContentFromMonitorProcessing"),
        w!("Clipboard Viewer Ignore"),
    ]
    .into_iter()
    .any(|name| unsafe { IsClipboardFormatAvailable(format(name)).is_ok() })
}

/// The clipboard, opened for as short a time as possible. Another app may hold it for a moment, so it tries a few
/// times.
struct Open;
impl Open {
    fn new(owner: HWND) -> Option<Open> {
        for _ in 0..20 {
            if unsafe { OpenClipboard(Some(owner)) }.is_ok() {
                return Some(Open);
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        None
    }
}
impl Drop for Open {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

pub fn read(owner: HWND) -> Clip {
    if is_private() {
        return Clip::Private;
    }
    if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32) }.is_err() {
        return Clip::Nothing;
    }
    let Some(_open) = Open::new(owner) else {
        return Clip::Nothing;
    };
    // Checked again with the clipboard open: the mark could have arrived in between.
    if is_private() {
        return Clip::Private;
    }
    let Ok(handle) = (unsafe { GetClipboardData(CF_UNICODETEXT.0 as u32) }) else {
        return Clip::Nothing;
    };
    let global = HGLOBAL(handle.0);
    let ptr = unsafe { GlobalLock(global) } as *const u16;
    if ptr.is_null() {
        return Clip::Nothing;
    }
    let units = unsafe { GlobalSize(global) } / 2;
    let slice = unsafe { std::slice::from_raw_parts(ptr, units) };
    let end = slice.iter().position(|&c| c == 0).unwrap_or(units);
    let out = if end > MAX_CHARS {
        None
    } else {
        Some(String::from_utf16_lossy(&slice[..end]))
    };
    let _ = unsafe { GlobalUnlock(global) };
    match out {
        Some(text) if !text.trim().is_empty() => Clip::Text(text),
        _ => Clip::Nothing,
    }
}

/// Puts `text` on the clipboard in place of what was there. Returns the clipboard's new sequence number.
pub fn write(owner: HWND, text: &str) -> Result<u32, &'static str> {
    let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let _open = Open::new(owner).ok_or("busy")?;
    unsafe {
        EmptyClipboard().map_err(|_| "empty")?;
        let global = GlobalAlloc(GMEM_MOVEABLE, units.len() * 2).map_err(|_| "memory")?;
        let ptr = GlobalLock(global) as *mut u16;
        if ptr.is_null() {
            let _ = GlobalFree(Some(global));
            return Err("memory");
        }
        std::ptr::copy_nonoverlapping(units.as_ptr(), ptr, units.len());
        let _ = GlobalUnlock(global);
        if SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(global.0))).is_err() {
            let _ = GlobalFree(Some(global));
            return Err("set");
        }
    }
    drop(_open);
    Ok(sequence())
}

#[cfg(test)]
fn exe_of(hwnd: HWND) -> Option<String> {
    if hwnd.0.is_null() {
        return None;
    }
    crate::program::info(hwnd).map(|info| info.exe_path)
}

/// The program that put the current content on the clipboard, read the same way program.rs reads any other window's
/// program -- never the content itself.
pub fn owner_info() -> Option<crate::program::Info> {
    let owner = unsafe { GetClipboardOwner() }.unwrap_or(HWND(std::ptr::null_mut()));
    if owner.0.is_null() {
        return None;
    }
    crate::program::info(owner)
}

/// The owner's path, used to recognize browsers as the clipboard source for a terminal check.
pub fn owner_exe() -> Option<String> {
    owner_info().map(|info| info.exe_path)
}

/// Windows' clipboard history (Win+V) is on: it may still hold what was copied before Clotr hid it.
pub fn history_on() -> bool {
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let mut value: u32 = 0;
    let mut size = 4u32;
    let found = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Clipboard"),
            w!("EnableClipboardHistory"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    found.is_ok() && value == 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WS_POPUP};

    // A plain window of this test's own process, never shown and never touching the real clipboard: exe_of only
    // needs a window handle to resolve, so the clipboard itself stays untouched by this test.
    struct TestWindow(HWND);
    impl TestWindow {
        fn new() -> Self {
            Self(unsafe {
                CreateWindowExW(
                    Default::default(),
                    w!("Static"),
                    w!("clotr-clip-test"),
                    WS_POPUP,
                    0,
                    0,
                    0,
                    0,
                    None,
                    None,
                    None,
                    None,
                )
                .expect("a plain window for the test")
            })
        }
    }
    impl Drop for TestWindow {
        fn drop(&mut self) {
            let _ = unsafe { DestroyWindow(self.0) };
        }
    }

    #[test]
    fn exe_of_names_the_window_that_owns_it() {
        let w = TestWindow::new();
        let me = std::env::current_exe().unwrap().to_string_lossy().to_lowercase();
        assert_eq!(exe_of(w.0).unwrap().to_lowercase(), me);
    }

    #[test]
    fn a_blank_window_has_no_owner() {
        assert_eq!(exe_of(HWND(std::ptr::null_mut())), None);
    }
}
