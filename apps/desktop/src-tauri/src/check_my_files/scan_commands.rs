use crate::main_window::settings_commands::{now_ms, settings_view};
use crate::saved_data::store_file;
use super::scan_run;
use super::capped_reading;
use super::results_commands::scan_for_generation;
use super::scan_plan;
use super::scan_rules;
use crate::{data_dir, lock, only, Clotr};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

// ---------- Leave out of scans: kept in Rust, shown to the page by name and parent only ----------

/// Settings' *Add a folder* and *Add a file*: Windows' own picker, each pick kept in the store by its path (the person
/// chose it). The page hears back only the settings view, whose list names each one and its parent.
#[tauri::command]
pub(crate) async fn scan_exclude_pick(
    window: WebviewWindow,
    app: AppHandle,
    clotr: State<'_, Arc<Clotr>>,
    kind: String,
) -> Result<Value, String> {
    only(&window, "main")?;
    let picked = match kind.as_str() {
        "folder" => app.dialog().file().blocking_pick_folders(),
        "file" => app.dialog().file().blocking_pick_files(),
        _ => return Err("not-allowed".to_string()),
    };
    let paths: Vec<PathBuf> = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|chosen| chosen.into_path().ok())
        .collect();
    {
        let mut store = lock(&clotr.store);
        for path in paths {
            store
                .add_exclusion(&kind, &path.to_string_lossy())
                .map_err(|_| "not-saved".to_string())?;
        }
    }
    Ok(settings_view(&clotr))
}

/// Settings' *Add a type*: ".log", "csv" and the like (the store checks it's a dot and letters or digits).
#[tauri::command]
pub(crate) async fn scan_exclude_type(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    ext: String,
) -> Result<Value, String> {
    only(&window, "main")?;
    let added = lock(&clotr.store)
        .add_exclusion("type", &ext)
        .map_err(|_| "not-saved".to_string())?;
    added.ok_or_else(|| "not-allowed".to_string())?;
    Ok(settings_view(&clotr))
}

/// *Leave this folder out* and *Leave files like this out*, on a file the last scan handed over: by its index,
/// never a path from the page. Hands back the new entry's id (for Undo) and its name and parent.
#[tauri::command]
pub(crate) async fn scan_exclude_from(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    index: usize,
    generation: u64,
    what: String,
) -> Result<Value, String> {
    only(&window, "main")?;
    let (kind, value) = {
        let run = scan_for_generation(&clotr, generation)?;
        run.exclusion_for(index, &what)
            .ok_or_else(|| "not-allowed".to_string())?
    };
    let id = lock(&clotr.store)
        .add_exclusion(kind, &value)
        .map_err(|_| "not-saved".to_string())?
        .ok_or_else(|| "not-allowed".to_string())?;
    let (name, parent) = if kind == "type" {
        (format!(".{}", value.trim_start_matches('.')), String::new())
    } else {
        store_file::name_and_parent(Path::new(&value))
    };
    Ok(json!({ "id": id, "kind": kind, "name": name, "parent": parent }))
}

/// Settings' *Remove* on one entry, and *Undo* right after a Leave out on a Results card.
#[tauri::command]
pub(crate) async fn scan_unexclude(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    id: String,
) -> Result<Value, String> {
    only(&window, "main")?;
    lock(&clotr.store)
        .remove_exclusion(&id)
        .map_err(|_| "not-saved".to_string())?;
    Ok(settings_view(&clotr))
}

// ---------- Check my files: the page never sees a path ----------

/// Windows' own folder picker, for "Folders I choose". Only the chosen folders' own names go back to the page;
/// their paths stay here, kept for the "chosen" scan that follows.
#[tauri::command]
pub(crate) async fn scan_pick_folders(
    window: WebviewWindow,
    app: AppHandle,
    clotr: State<'_, Arc<Clotr>>,
) -> Result<Vec<String>, String> {
    only(&window, "main")?;
    let Some(picked) = app.dialog().file().blocking_pick_folders() else {
        return Ok(vec![]);
    };
    let mut names = Vec::new();
    let mut paths = Vec::new();
    for chosen in picked {
        if let Ok(path) = chosen.into_path() {
            names.push(
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            );
            paths.push(path);
        }
    }
    *lock(&clotr.chosen) = paths;
    Ok(names)
}

// ---------- A scan's record and plan ----------

/// When the last Full scan finished and how many files it kept, for Settings and the Scan screen; null before
/// the first one (or once History was cleared). `again` marks a record an older version wrote, which no scan goes
/// by, so the Scan screen can say why this scan reads everything.
pub(crate) fn full_scan_view(store: &store_file::Store) -> Value {
    match store.baseline_summary() {
        Some((at, files)) if store.baseline_is_old() => json!({ "at": at, "files": files, "again": true }),
        Some((at, files)) => json!({ "at": at, "files": files }),
        None => Value::Null,
    }
}

/// The record a scan of `kind` goes by, so it reads only what's new or changed: the last Full scan's, for Quick,
/// and for a later Full unless the person chose to read everything again. None for Folders I choose, and none
/// while the record is an older version's (`Store::baseline`), so Quick and Full read everything in their reach.
fn scan_baseline(store: &store_file::Store, kind: &str, again: Option<bool>) -> Option<Arc<store_file::Baseline>> {
    match kind {
        "quick" => store.baseline().map(Arc::new),
        "full" if again != Some(true) => store.baseline().map(Arc::new),
        _ => None,
    }
}

/// Testing only: CLOTR_SCAN_ROOT points every kind at one fixture folder, so a check is deterministic on whatever
/// PC runs it; CLOTR_SCAN_DRIVES and CLOTR_SCAN_FLOOR stand in for the fixed drives and Quick's floor.
#[cfg(feature = "dk-test-app")]
fn scan_test_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

#[cfg(not(feature = "dk-test-app"))]
fn scan_test_dir(_: &str) -> Option<PathBuf> {
    None
}

/// The drives a Full scan walks: every fixed drive.
fn scan_drives() -> Vec<PathBuf> {
    scan_test_dir("CLOTR_SCAN_DRIVES")
        .map(|dir| vec![dir])
        .unwrap_or_else(capped_reading::fixed_drives)
}

/// The places a Quick scan walks, each with its label.
fn scan_floor() -> Vec<(PathBuf, String)> {
    scan_test_dir("CLOTR_SCAN_FLOOR")
        .map(|dir| vec![(dir, "downloads".to_string())])
        .unwrap_or_else(capped_reading::floor)
}

/// What every kind of scan goes by: the salt, what the person ignored or left out, and the folders it never reads.
fn plan_ctx(clotr: &Clotr, store: &store_file::Store) -> scan_plan::PlanCtx {
    scan_plan::PlanCtx {
        salt: store.scan_salt(),
        // Ignore: a file is only ever left out here, by its own fingerprint, never remembered as "clean" or
        // carried as a path.
        ignored: Arc::new(store.ignored_files()),
        // Leave out of scans: the folders, files and types the person chose, in Settings or on a Results card.
        excluded: Arc::new(store.exclusions()),
        skip: vec![data_dir(), clotr.webview_dir.clone()],
        personal: scan_rules::personal_places(),
        places: capped_reading::floor(),
        home: scan_rules::home(),
    }
}

// ---------- A scan, from start to stop ----------

/// Starts a scan of `kind` ("quick", "full" or "chosen") and hands back only whether a Full scan has run yet: the
/// files themselves come from `scan_batch`, a batch at a time, by index, never a path. Quick reads Downloads,
/// Desktop, Documents and Pictures with code projects left out, and only what's new or changed there once a Full
/// scan has run; Full reads every fixed drive but Windows' own folders; Chosen reads the folders from Windows' own
/// picker.
/// Clotr's own data folder is never read, whatever the kind.
#[tauri::command]
pub(crate) async fn scan_start(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    kind: String,
    again: Option<bool>,
) -> Result<Value, String> {
    only(&window, "main")?;
    let (ctx, baseline, full_scan, dev) = {
        let store = lock(&clotr.store);
        let ctx = plan_ctx(&clotr, &store);
        let baseline = scan_baseline(&store, &kind, again);
        // The developer switch, off unless turned on: code projects and secret files in Quick and Full both.
        let dev = store.settings().get("scanDevFiles") == Some(&Value::Bool(true));
        (ctx, baseline, full_scan_view(&store), dev)
    };
    // A run that reads only what changed says so, with when the record it goes by was made.
    let mut since = baseline.as_ref().map(|last| last.at);
    let plan = match (kind.as_str(), scan_test_dir("CLOTR_SCAN_ROOT")) {
        (_, Some(root)) => {
            since = None;
            scan_plan::Plan::chosen(capped_reading::chosen_roots(&[root]), ctx)
        }
        ("quick", None) => scan_plan::Plan::quick(scan_floor(), baseline, !dev, dev, ctx),
        ("full", None) => scan_plan::Plan::full(scan_drives(), baseline, dev, ctx),
        ("chosen", None) => scan_plan::Plan::chosen(capped_reading::chosen_roots(&lock(&clotr.chosen)), ctx),
        _ => return Err("not-allowed".to_string()),
    };
    // The run before this one stops (its walks halt the moment it's dropped) and its indices are gone.
    let run = Arc::new(scan_run::ScanRun::start(plan));
    let generation = run.generation();
    *lock(&clotr.scan) = Some(run);
    // A new scan's indices start over, so yesterday's recycled or moved files can't be confused with today's.
    lock(&clotr.recycled).clear();
    lock(&clotr.moved).clear();
    Ok(json!({ "fullScan": full_scan, "since": since, "generation": generation }))
}

/// The next files the walk found, up to a batch, with what it has skipped so far and the counting walk's total.
/// `settled` names the files the page has finished checking since it last asked, and `keep` the ones among them it
/// still needs (finds, and files it couldn't read); every other settled file is let go, so a scan of a whole drive
/// never holds more than a couple of batches of paths.
#[tauri::command]
pub(crate) async fn scan_batch(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    settled: Vec<usize>,
    keep: Vec<usize>,
) -> Result<Value, String> {
    only(&window, "main")?;
    let run = lock(&clotr.scan).clone().ok_or_else(|| "not-allowed".to_string())?;
    let wait = std::time::Duration::from_millis(250);
    let batch = tauri::async_runtime::spawn_blocking(move || run.batch(&settled, &keep, wait))
        .await
        .map_err(|_| "not-allowed".to_string())?;
    let batch = batch.map_err(str::to_string)?;
    serde_json::to_value(batch).map_err(|_| "not-allowed".to_string())
}

/// The page read every file the walk handed over (`completed`), or stopped early. A Full scan that got through
/// every drive leaves its record here for the next Quick or Full one, without the files named in `unread`, and with
/// the ones in `flagged` (worth a look this time) carrying that bit forward.
#[tauri::command]
pub(crate) async fn scan_end(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    completed: bool,
    unread: Vec<usize>,
    flagged: Vec<usize>,
) -> Result<Value, String> {
    only(&window, "main")?;
    let run = lock(&clotr.scan).clone();
    if let (true, Some(run)) = (completed, run) {
        if let Some(records) = run.full_record(&unread, &flagged) {
            let baseline = store_file::Baseline::new(now_ms().max(0) as u64, records);
            lock(&clotr.store)
                .save_baseline(&baseline)
                .map_err(|_| "not-saved".to_string())?;
        }
    }
    Ok(json!({ "fullScan": full_scan_view(&lock(&clotr.store)) }))
}

/// A file's bytes, by the index `scan_batch` handed it over under (never a path from the page). Fails soft: an
/// unreadable file comes back as "locked" (4.3), never silently empty or "clean" -- the walker already found it,
/// so a read failing here almost always means another program has it open.
#[tauri::command]
pub(crate) async fn scan_next(
    window: WebviewWindow,
    clotr: State<'_, Arc<Clotr>>,
    index: usize,
) -> Result<tauri::ipc::Response, String> {
    only(&window, "main")?;
    let run = lock(&clotr.scan).clone().ok_or_else(|| "not-allowed".to_string())?;
    match run.read(index) {
        Some(Ok(bytes)) => Ok(tauri::ipc::Response::new(bytes)),
        Some(Err(_)) => Err("locked".to_string()),
        None => Err("not-allowed".to_string()),
    }
}

/// Stop: no further file is read, however much of the scan was left.
#[tauri::command]
pub(crate) async fn scan_cancel(window: WebviewWindow, clotr: State<'_, Arc<Clotr>>) -> Result<(), String> {
    only(&window, "main")?;
    if let Some(run) = lock(&clotr.scan).as_ref() {
        run.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::scan_plan::{Plan, PlanCtx};
    use super::*;

    #[test]
    fn with_an_older_versions_full_scan_record_quick_and_full_read_everything_in_their_reach() {
        let dir = std::env::temp_dir().join(format!("clotr-scan-choice-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = store_file::Store::open(&dir).unwrap();
        let floor = || vec![(dir.join("Downloads"), "downloads".to_string())];
        let quick = |store: &store_file::Store| {
            Plan::quick(floor(), scan_baseline(store, "quick", None), true, false, PlanCtx::default())
        };
        let full = |store: &store_file::Store, again: bool| {
            Plan::full(vec![dir.clone()], scan_baseline(store, "full", Some(again)), false, Default::default())
        };
        let changes_only =
            |plan: &Plan| plan.baseline.is_some() || plan.roots.iter().any(|root| root.changed_only);

        // Well-formed records the way 1.6.1 (v2, 17 bytes a file) and the version before it (v1, 16) left them.
        let v1_file: Vec<u8> = [3u64.to_le_bytes(), 30u64.to_le_bytes()].concat();
        let v2_file: Vec<u8> = [v1_file.clone(), vec![1u8]].concat();
        for (magic, file) in [(b"CLOTRBL2", v2_file), (b"CLOTRBL1", v1_file)] {
            let raw: Vec<u8> = [magic.to_vec(), 7u64.to_le_bytes().to_vec(), 1u64.to_le_bytes().to_vec(), file].concat();
            std::fs::write(dir.join("scan-baseline.bin"), raw).unwrap();
            let name = String::from_utf8_lossy(magic);
            assert!(!changes_only(&quick(&store)), "{name}: Quick reads all of its floor");
            assert!(!changes_only(&full(&store, false)), "{name}: Full reads every drive");
            assert!(!changes_only(&full(&store, true)), "{name}: Read everything again too");
            assert_eq!(
                full_scan_view(&store),
                json!({ "at": 7, "files": 1, "again": true }),
                "{name}: the Scan screen hears why, and Settings still hears what's kept"
            );
        }

        // A Full scan that finishes writes the current form, and the next scan reads only what's new or changed.
        store.save_baseline(&store_file::Baseline::new(9, vec![(3, 30, false)])).unwrap();
        assert!(changes_only(&quick(&store)));
        assert!(quick(&store).roots.iter().all(|root| root.changed_only));
        assert!(changes_only(&full(&store, false)));
        assert!(!changes_only(&full(&store, true)), "Read everything again still reads everything");
        assert!(scan_baseline(&store, "chosen", None).is_none(), "Folders I choose reads its folders in full");
        assert_eq!(full_scan_view(&store), json!({ "at": 9, "files": 1 }));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
