use crate::app_setup::offline_web_view;
use crate::main_window::open_main_window::{dress_main, MAIN_MIN};
use crate::main_window::settings_commands::now_ms;
use crate::tray::tray_words;
use crate::{lock, only, Clotr, LOG};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

// ---------- The weekly check: a Quick scan on its own, once a week, while Clotr runs ----------

const WEEK_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Never run yet, or the last run was a full week or more ago. Simplified from the suite's own "Sunday at
/// noon" wording to a plain seven-day interval: the local date and clock Windows would need for the exact day
/// and hour aren't worth carrying for one background check, and "about once a week, while the PC is on" is
/// what the person actually gets either way.
pub(crate) fn weekly_check_due(now_ms: u64, last: Option<u64>) -> bool {
    match last {
        None => true,
        Some(last) => now_ms.saturating_sub(last) >= WEEK_MS,
    }
}

/// Starts a Quick scan with nobody watching: a hidden window on the same "main" label the real window uses
/// (so it's allowed every command `scan_start`/`scan_next`/`record_scan` need, and so a person opening Clotr
/// mid-check simply sees their own weekly scan running rather than two windows fighting for the name), pointed
/// at `main.html?weekly=1#scan`, which `main.js` reads once on load to start the scan itself and report back
/// through `weekly_check_done`. Skipped entirely if a real main window is already open -- the next hourly tick
/// tries again, and a week's slack means missing one evening never matters.
pub(crate) fn start_weekly_check(app: &AppHandle, clotr: &Arc<Clotr>) {
    if app.get_webview_window("main").is_some() {
        clotr.weekly_running.store(false, Ordering::SeqCst);
        return;
    }
    let page = "main.html?weekly=1#scan";
    let built = offline_web_view::window(app, &clotr.webview_dir, &clotr.browser_args, &clotr.locale, "main", page)
        .map(|builder| {
            builder
                .inner_size(MAIN_MIN.0, MAIN_MIN.1)
                .visible(false)
                .decorations(false)
                .skip_taskbar(true)
                .build()
        });
    if !matches!(built, Some(Ok(_))) {
        eprintln!("{LOG} the weekly check's window couldn't open");
        clotr.weekly_running.store(false, Ordering::SeqCst);
        return;
    }
    // A watchdog, not the normal path: if the page never calls back (a worker that hangs, a scan over the file
    // cap taking longer than expected), the hidden window and the "one at a time" flag would otherwise never
    // clear, and the check would silently stop running forever.
    let (app_for_watchdog, clotr_for_watchdog) = (app.clone(), clotr.clone());
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(600));
        if clotr_for_watchdog.weekly_running.swap(false, Ordering::SeqCst) {
            close_hidden_main(&app_for_watchdog);
        }
    });
}

/// The weekly check's hidden window, closed. A main window the person can see is left as it is.
fn close_hidden_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if !window.is_visible().unwrap_or(true) {
        let _ = window.close();
    }
}

// ---------- A weekly check's finds ----------

/// The page's `files` as (index, kinds) pairs. An entry in any other shape is left out.
fn weekly_finds(files: &Value) -> Vec<(usize, Vec<String>)> {
    files
        .as_array()
        .map(|list| list.iter().filter_map(weekly_find).collect())
        .unwrap_or_default()
}

/// One `{ "index": usize, "kinds": [String] }`, or None.
fn weekly_find(entry: &Value) -> Option<(usize, Vec<String>)> {
    let index = entry.get("index")?.as_u64()? as usize;
    let kinds = entry
        .get("kinds")?
        .as_array()?
        .iter()
        .filter_map(|kind| kind.as_str().map(String::from))
        .collect();
    Some((index, kinds))
}

/// Each find with its path, from the scan on record. A find whose index that scan doesn't have is dropped.
fn weekly_find_paths(clotr: &Clotr, finds: Vec<(usize, Vec<String>)>) -> Vec<(usize, String, Vec<String>)> {
    let scan = lock(&clotr.scan);
    let state = scan.as_ref();
    finds
        .into_iter()
        .filter_map(|(index, kinds)| {
            let path = state?.path_of(index)?.to_string_lossy().into_owned();
            Some((index, path, kinds))
        })
        .collect()
}

/// The indices of the finds the store hadn't seen before, each noted as seen now.
fn note_new_finds(clotr: &Clotr, finds: Vec<(usize, String, Vec<String>)>) -> Vec<usize> {
    let mut store = lock(&clotr.store);
    finds
        .into_iter()
        .filter_map(|(index, path, kinds)| {
            let is_new = store.note_scan_find(&path, &kinds).unwrap_or(false);
            is_new.then_some(index)
        })
        .collect()
}

/// The weekly check's one notice, in the language Clotr speaks now: one new find, or how many.
fn notify_new_finds(window: &WebviewWindow, clotr: &Clotr, new_count: u64) {
    let wording = tray_words::Words::new(&clotr.locale_now());
    let body = if new_count == 1 {
        wording.t("ws.notifyOne")
    } else {
        wording.t1("ws.notify", new_count)
    };
    let _ = window
        .app_handle()
        .notification()
        .builder()
        .title("Clotr")
        .body(body)
        .show();
}

/// `files`: the worth-a-look files this weekly run found, as `[{ "index": usize, "kinds": [String] }]` --
/// scan.js's own `isWorthALook` already filtered out the lemon-only ones (4-1), so a repeat email address never
/// counts as new here either. Each is checked against the store's own "seen" fingerprints (4-4: the same
/// mechanism as Ignore, by path and kinds, never a value) before the hidden window closes, so the notice -- and
/// Results, once opened -- speak only to what's actually new since last time.
#[tauri::command]
pub(crate) async fn weekly_check_done(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    files: Value,
) -> Result<Value, String> {
    only(&window, "main")?;
    let _ = lock(&clotr.store).set_last_weekly_check(now_ms() as u64);
    clotr.weekly_running.store(false, Ordering::SeqCst);

    let with_paths = weekly_find_paths(&clotr, weekly_finds(&files));
    let total = with_paths.len() as u64;
    let new_indices = note_new_finds(&clotr, with_paths);

    let new_count = new_indices.len() as u64;
    let still_count = total.saturating_sub(new_count);
    let _ = lock(&clotr.store).set_weekly_find(new_count, still_count);
    // Home's own status word (home_status.rs's "look"): anything from this run that still waits for the person, new
    // or already seen before, not only the brand-new ones -- the tray icon catches up next time it redraws.
    clotr.worth_a_look.store(total > 0, Ordering::SeqCst);
    let notify = lock(&clotr.store).settings().get("notifyFind") != Some(&Value::Bool(false));
    if new_count > 0 && notify {
        notify_new_finds(&window, &clotr, new_count);
    }
    if new_count > 0 {
        // New finds with the ability to open the full findings report: rather than close the hidden window
        // (nothing new, the usual path below), show it, land it on Results, and let scan.js mark the new ones --
        // it already has every file's own kinds in memory, this command only ever sees an index and a path.
        let _ = window.emit("go", "results");
        dress_main(window.app_handle(), &window);
        let _ = window.show();
        let _ = window.set_focus();
    } else if !window.is_visible().unwrap_or(true) {
        let _ = window.close();
    }
    Ok(json!({ "newIndices": new_indices }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_weekly_check_is_due_the_first_time_and_again_a_week_later_never_sooner() {
        assert!(weekly_check_due(1_700_000_000_000, None));
        let last = 1_700_000_000_000u64;
        assert!(!weekly_check_due(last + WEEK_MS - 1, Some(last)));
        assert!(weekly_check_due(last + WEEK_MS, Some(last)));
        assert!(weekly_check_due(last + WEEK_MS * 3, Some(last)));
    }
}
