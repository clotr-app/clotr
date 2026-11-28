use super::scan_run;
use super::{move_somewhere_private, recycle_bin};
use crate::main_window::allowed_links::shell_open;
use crate::{lock, only, Clotr};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

// ---------- Results and its actions: by index into the last scan_start, never a path ----------

/// The single gate for every by-index Results action: stale cards keep their old generation when a new scan starts.
pub(crate) fn scan_for_generation(clotr: &Clotr, generation: u64) -> Result<Arc<scan_run::ScanRun>, String> {
    let current = lock(&clotr.scan);
    let run = current.as_ref().ok_or_else(|| "not-allowed".to_string())?;
    if !run.accepts_generation(generation) {
        return Err("not-allowed".to_string());
    }
    Ok(run.clone())
}

// ---------- Open the folder, Ignore and Save a copy ----------

/// *Open the folder*: File Explorer, with the file selected, from the scan's own list. The page names an index,
/// never a path; the one path this command is allowed to read goes straight to the shell, through
/// `SHOpenFolderAndSelectItems`, so Clotr never starts `explorer.exe` as a process (the Store's certification kit
/// blocks a reference to that, with arguments, as a launched executable).
#[tauri::command]
pub(crate) async fn scan_reveal(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    index: usize,
    generation: u64,
) -> Result<bool, String> {
    only(&window, "main")?;
    let path = {
        let state = scan_for_generation(&clotr, generation)?;
        state.path_of(index).ok_or_else(|| "not-allowed".to_string())?
    };
    reveal_in_explorer(&path).map_err(|_| "not-opened".to_string())?;
    Ok(true)
}

/// Selects `path` in its parent folder's open Explorer window (or opens one), without starting any process:
/// `ILCreateFromPathW` turns the path into a PIDL and `SHOpenFolderAndSelectItems` hands that straight to the
/// shell. Needs COM on the calling thread, which Tauri's async commands can run on any of, so it's opened here
/// the same careful way `offline_web_view.rs` and `start_with_windows.rs` already do (ignoring a changed-mode result: COM already
/// being up on this thread, just not by this call, is still fine for a plain shell call like this one).
fn reveal_in_explorer(path: &Path) -> windows::core::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems};

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let pidl = ILCreateFromPathW(PCWSTR(wide.as_ptr()));
        if pidl.is_null() {
            return Err(windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL));
        }
        let result = SHOpenFolderAndSelectItems(pidl, None, 0);
        ILFree(Some(pidl));
        result
    }
}

/// *Ignore*: Clotr won't bring this file up again (a salted fingerprint, never the path itself).
#[tauri::command]
pub(crate) async fn scan_ignore(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    index: usize,
    generation: u64,
) -> Result<bool, String> {
    only(&window, "main")?;
    let path = {
        let state = scan_for_generation(&clotr, generation)?;
        state
            .path_of(index)
            .ok_or_else(|| "not-allowed".to_string())?
            .to_string_lossy()
            .into_owned()
    };
    lock(&clotr.store)
        .ignore_scan_item("file", &path)
        .map_err(|_| "not-saved".to_string())?;
    Ok(true)
}

/// *Save a copy with them hidden* and *Save a copy without the place*: `bytes` is already redacted or redrawn (the
/// engine, in the scan worker); this only places it through Windows' own Save dialog and refuses the
/// original's own path (`scan_run::write_copy`). `{ "saved": false }` when the person closes the dialog without
/// choosing anywhere, never an error.
#[tauri::command]
pub(crate) async fn scan_save_copy(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    app: AppHandle,
    index: usize,
    generation: u64,
    bytes: Vec<u8>,
    suggested_name: String,
) -> Result<Value, String> {
    only(&window, "main")?;
    let original = {
        let state = scan_for_generation(&clotr, generation)?;
        state.path_of(index).ok_or_else(|| "not-allowed".to_string())?
    };
    let Some(dest) = app.dialog().file().set_file_name(&suggested_name).blocking_save_file() else {
        return Ok(json!({ "saved": false }));
    };
    let dest = dest.into_path().map_err(|_| "not-saved".to_string())?;
    scan_run::write_copy(&dest, &original, &bytes).map_err(|_| "not-saved".to_string())?;
    Ok(json!({ "saved": true }))
}

// ---------- The Recycle Bin and a private folder, each with its Undo ----------

/// *Move to the Recycle Bin* (4-10; every kind, not only a text file's own password, code or key find).
/// The scan stays read-only up to this one button; refuses once the scan is cancelled, since a stopped run's list
/// might not match what's really there anymore, unlike Reveal or Ignore, and refuses a file that changed size or
/// modified time since the scan recorded it (`recycle_bin::recycle`'s own guard).
#[tauri::command]
pub(crate) async fn scan_recycle(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    index: usize,
    generation: u64,
) -> Result<bool, String> {
    only(&window, "main")?;
    let (path, recorded) = {
        let state = scan_for_generation(&clotr, generation)?;
        if state.is_cancelled() {
            return Err("not-allowed".to_string());
        }
        let path = state.path_of(index).ok_or_else(|| "not-allowed".to_string())?;
        let recorded = state.stamp_of(index).ok_or_else(|| "not-allowed".to_string())?;
        (path, recorded)
    };
    let item = recycle_bin::recycle(&path, recorded)?;
    lock(&clotr.recycled).insert(index, item);
    Ok(true)
}

/// *Undo*, right after *Move to the Recycle Bin* on the same card: puts the file back exactly where it was.
#[tauri::command]
pub(crate) async fn scan_unrecycle(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    index: usize,
    generation: u64,
) -> Result<bool, String> {
    only(&window, "main")?;
    let _run = scan_for_generation(&clotr, generation)?;
    let item = lock(&clotr.recycled)
        .remove(&index)
        .ok_or_else(|| "not-allowed".to_string())?;
    recycle_bin::restore(item)?;
    Ok(true)
}

/// *Move it somewhere private*'s own folder picker: Windows' own dialog, opened on OneDrive's Personal Vault
/// when this PC has one. Only the chosen folder's own name goes back to the page; its path stays here, kept for
/// `scan_move`, the same shape `scan_pick_folders` already uses for "Folders I choose".
#[tauri::command]
pub(crate) async fn move_pick_folder(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    only(&window, "main")?;
    let mut dialog = app.dialog().file();
    if let Some(vault) = move_somewhere_private::personal_vault() {
        dialog = dialog.set_directory(vault);
    }
    let Some(picked) = dialog.blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|_| "not-allowed".to_string())?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    *lock(&clotr.move_dest) = Some(path);
    Ok(Some(name))
}

/// *Move it somewhere private*: moves every index in `indices` into the folder `move_pick_folder` already
/// chose, one call for a whole bundle, each file tried and reported on its own so one refusal never stops the
/// rest. Never a path back to the page, only whether each one moved and, if not, why.
#[tauri::command]
pub(crate) async fn scan_move(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    indices: Vec<usize>,
    generation: u64,
) -> Result<Vec<Value>, String> {
    only(&window, "main")?;
    let dest = lock(&clotr.move_dest).clone().ok_or_else(|| "not-allowed".to_string())?;
    let run = scan_for_generation(&clotr, generation)?;
    let mut results = Vec::with_capacity(indices.len());
    for index in indices {
        let attempt = move_one(&run, &dest, index);
        results.push(match attempt {
            Ok(moved) => {
                lock(&clotr.moved).insert(index, moved);
                json!({ "index": index, "moved": true })
            }
            Err(reason) => json!({ "index": index, "moved": false, "reason": reason }),
        });
    }
    Ok(results)
}

/// One file of a bundle into `dest`, refused once the scan was stopped or for an index the run doesn't have.
fn move_one(run: &scan_run::ScanRun, dest: &Path, index: usize) -> Result<move_somewhere_private::Moved, String> {
    if run.is_cancelled() {
        return Err("not-allowed".to_string());
    }
    let path = run.path_of(index).ok_or_else(|| "not-allowed".to_string())?;
    let recorded = run.stamp_of(index).ok_or_else(|| "not-allowed".to_string())?;
    move_somewhere_private::move_into(dest, &path, recorded)
}

/// *Undo*, right after *Move it somewhere private* on the same card: puts the file back exactly where it was.
#[tauri::command]
pub(crate) async fn scan_unmove(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    index: usize,
    generation: u64,
) -> Result<bool, String> {
    only(&window, "main")?;
    let _run = scan_for_generation(&clotr, generation)?;
    let moved = lock(&clotr.moved).remove(&index).ok_or_else(|| "not-allowed".to_string())?;
    move_somewhere_private::move_back(&moved)?;
    Ok(true)
}

// ---------- A saved summary, an accuracy export and an email ----------

/// *Save a summary*: `html` is already built in the web view (summary.js's `summaryPage`, folders, kind names
/// and counts only, never a value); this only places it through Windows' own Save dialog, a plain page with no
/// original to refuse. `{ "saved": false }` when the person closes the dialog without choosing anywhere.
#[tauri::command]
pub(crate) async fn save_summary(window: WebviewWindow, app: AppHandle, html: String) -> Result<Value, String> {
    only(&window, "main")?;
    let Some(dest) = app
        .dialog()
        .file()
        .set_file_name("clotr-summary.html")
        .blocking_save_file()
    else {
        return Ok(json!({ "saved": false }));
    };
    let dest = dest.into_path().map_err(|_| "not-saved".to_string())?;
    std::fs::write(&dest, html.as_bytes()).map_err(|_| "not-saved".to_string())?;
    Ok(json!({ "saved": true }))
}

/// Settings' Accuracy answers *Export*: the page already built the text (settings.js's own
/// `accuracyExportRows`, kind/tier/yes/no only); this only asks where to put it.
#[tauri::command]
pub(crate) async fn save_accuracy_export(window: WebviewWindow, app: AppHandle, text: String) -> Result<Value, String> {
    only(&window, "main")?;
    let Some(dest) = app
        .dialog()
        .file()
        .set_file_name("clotr-accuracy.json")
        .blocking_save_file()
    else {
        return Ok(json!({ "saved": false }));
    };
    let dest = dest.into_path().map_err(|_| "not-saved".to_string())?;
    std::fs::write(&dest, text.as_bytes()).map_err(|_| "not-saved".to_string())?;
    Ok(json!({ "saved": true }))
}

/// "Email it" (the note for your helper) and "Report a problem"
/// (Settings, and Results near "Was this right?"): a `mailto:` built only in results-note.js, from fixed words
/// (Report a problem) or the note's own subject and body (Email it), never anything a page could shape into
/// another scheme. The address is either none at all (Email it, so it goes wherever the person already mails
/// their helper) or this app's own fixed support address (Report a problem): never an address a page chose. The
/// query may hold only `subject` and `body`, once each: nothing else gets a door out.
pub fn mailto_ok(url: &str) -> bool {
    let Some(query) = url
        .strip_prefix("mailto:?")
        .or_else(|| url.strip_prefix("mailto:support@clotr.app?"))
    else {
        return false;
    };
    let mut seen = std::collections::HashSet::new();
    for pair in query.split('&') {
        let Some((key, _)) = pair.split_once('=') else {
            return false;
        };
        if key != "subject" && key != "body" {
            return false;
        }
        if !seen.insert(key) {
            return false;
        }
    }
    !seen.is_empty()
}

#[tauri::command]
pub(crate) async fn open_mailto(window: WebviewWindow, url: String) -> Result<bool, String> {
    only(&window, "main")?;
    if !mailto_ok(&url) {
        return Ok(false);
    }
    shell_open(&url);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_notes_mailto_link_carries_only_a_subject_and_a_body() {
        assert!(mailto_ok("mailto:?subject=A%20note&body=Clotr%20found..."));
        assert!(mailto_ok("mailto:?body=Clotr%20found..."));
        assert!(
            !mailto_ok("mailto:someone@example.com?subject=x&body=y"),
            "no address of its own"
        );
        assert!(
            !mailto_ok("mailto:?subject=x&cc=someone@example.com&body=y"),
            "no field past subject and body"
        );
        assert!(!mailto_ok("mailto:?subject=x&subject=y&body=z"), "no repeated field");
        assert!(!mailto_ok("mailto:?"), "nothing to send isn't a valid note");
        assert!(!mailto_ok("https://example.com/?subject=x&body=y"), "mailto only");
    }

    #[test]
    fn report_a_problem_may_address_only_clotrs_own_support_account_never_another() {
        assert!(mailto_ok(
            "mailto:support@clotr.app?subject=Clotr&body=What%20happened..."
        ));
        assert!(
            !mailto_ok("mailto:someone@example.com?subject=Clotr&body=x"),
            "not a page's own address"
        );
        assert!(
            !mailto_ok("mailto:support@clotr.app.evil.example?subject=x&body=y"),
            "the address, exactly"
        );
        assert!(
            !mailto_ok("mailto:support@clotr.app?subject=x&cc=someone@example.com&body=y"),
            "still only subject and body"
        );
    }
}
