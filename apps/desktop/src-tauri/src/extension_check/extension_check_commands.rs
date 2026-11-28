use super::browser_extension_files;
use crate::only;
use std::path::{Path, PathBuf};
use tauri::WebviewWindow;

// ---------- Extension check ----------

/// Every browser extension on this PC that `browser_extension_files.rs` can see, read only from each browser's own files.
/// `extcheck-core.js`'s `checkExtensions()`, in the scan worker, decides reach and worth-a-look from this;
/// nothing here does.
#[tauri::command]
pub(crate) async fn ext_check(window: WebviewWindow) -> Result<Vec<browser_extension_files::ExtensionRecord>, String> {
    only(&window, "main")?;
    // Testing only: points the read at a fixture profile tree instead of the real %LOCALAPPDATA%/%APPDATA%, so the
    // check is deterministic on whatever PC runs it (the same idea as scan_start's CLOTR_SCAN_ROOT).
    #[cfg(feature = "dk-test-app")]
    let fixture = std::env::var("CLOTR_EXT_LOCALAPPDATA").ok().map(|local| {
        (
            PathBuf::from(local),
            PathBuf::from(std::env::var("CLOTR_EXT_APPDATA").unwrap_or_default()),
        )
    });
    #[cfg(not(feature = "dk-test-app"))]
    let fixture: Option<(PathBuf, PathBuf)> = None;
    Ok(match fixture {
        Some((local, roaming)) => browser_extension_files::check_all_in(&local, &roaming),
        None => browser_extension_files::check_all(),
    })
}

/// A Chromium extension id: 32 letters, each `a`-`p` (the alphabet every Chromium browser's own ids use), never
/// anything a page could use to smuggle a stray argument to the browser it launches.
fn is_chromium_ext_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

/// *Show me where to remove it* (5.6): each Chromium browser keeps its own extensions page at this address.
/// Firefox has none a companion app can open, so the page never calls this for a Firefox entry.
fn ext_page_url(id: &str) -> Option<String> {
    is_chromium_ext_id(id).then(|| format!("chrome://extensions/?id={id}"))
}

/// Where each Chromium browser's own executable usually lives (a system install under Program Files, or a
/// per-user one under the local app data folder): launching that browser by name, rather than handing the address
/// to `ShellExecuteW` alone, means it opens the browser the extension is actually in, not whichever one Windows
/// happens to default to. `None` when Windows can't find it there: the page falls back to the steps in words,
/// exactly as if no address existed (5.6) — this never guesses, and never searches the whole disk.
fn chromium_exe(browser: &str, program_files: &[PathBuf], local_app_data: &Path) -> Option<PathBuf> {
    let relative_paths: &[&str] = match browser {
        "Chrome" => &[r"Google\Chrome\Application\chrome.exe"],
        "Edge" => &[r"Microsoft\Edge\Application\msedge.exe"],
        "Brave" => &[r"BraveSoftware\Brave-Browser\Application\brave.exe"],
        "Vivaldi" => &[r"Vivaldi\Application\vivaldi.exe"],
        "Opera" => &[r"Programs\Opera\launcher.exe", r"Programs\Opera\opera.exe"],
        _ => return None,
    };
    let roots = program_files.iter().cloned().chain([local_app_data.to_path_buf()]);
    for root in roots {
        for relative in relative_paths {
            let path = root.join(relative);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

#[tauri::command]
pub(crate) async fn ext_reveal(window: WebviewWindow, browser: String, id: String) -> Result<bool, String> {
    only(&window, "main")?;
    let Some(url) = ext_page_url(&id) else {
        return Ok(false);
    };
    let program_files: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(|name| std::env::var_os(name).map(PathBuf::from))
        .collect();
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let Some(exe) = chromium_exe(&browser, &program_files, &local_app_data) else {
        return Ok(false);
    };
    let exe_wide: Vec<u16> = exe.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    let url_wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        windows::Win32::UI::Shell::ShellExecuteW(
            None,
            windows::core::w!("open"),
            windows::core::PCWSTR(exe_wide.as_ptr()),
            windows::core::PCWSTR(url_wide.as_ptr()),
            None,
            windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        );
    }
    Ok(true)
}

#[cfg(test)]
mod ext_reveal_tests {
    use super::*;

    #[test]
    fn only_a_real_chromium_id_gets_an_address_never_an_arbitrary_string() {
        assert_eq!(
            ext_page_url("abcdefghijklmnopabcdefghijklmnop"),
            Some("chrome://extensions/?id=abcdefghijklmnopabcdefghijklmnop".to_string())
        );
        assert_eq!(ext_page_url(""), None);
        assert_eq!(ext_page_url("not-an-id"), None);
        // One character past 'p', or a digit: never a Chromium id, even at the right length.
        assert_eq!(ext_page_url(&"q".repeat(32)), None);
        assert_eq!(ext_page_url(&"a".repeat(31)), None);
        // A page could try to smuggle another launch argument in: still refused, length and alphabet both hold.
        assert_eq!(ext_page_url("abcdefghijklmnop&start-fullscreen="), None);
    }

    #[test]
    fn an_unknown_browser_or_a_missing_exe_is_none_not_a_guess() {
        let dir = std::env::temp_dir().join(format!("clotr-chromium-exe-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(chromium_exe("Internet Explorer", &[dir.clone()], &dir), None);
        assert_eq!(
            chromium_exe("Chrome", &[dir.clone()], &dir),
            None,
            "chrome.exe isn't actually there"
        );
        let app = dir.join("Google").join("Chrome").join("Application");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("chrome.exe"), b"").unwrap();
        assert_eq!(
            chromium_exe("Chrome", &[dir.clone()], &dir),
            Some(app.join("chrome.exe"))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
