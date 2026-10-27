//! The one writer: everything Clotr for Windows keeps is one JSON file, store.json, in its own data folder
//! (%LOCALAPPDATA%\Clotr\Desktop, local to this computer, never the roaming profile), written only here.
//!
//! What's in it is the extension's schema with the apps' names: settings, the salt, the vault's
//! fingerprints and formats, and history as event metadata ({ t, site: "app:<id>", type, name, severity, action,
//! fp }). Never a detected value: the pages clean what they send with the engine's own guards (ClotrHost.clean and
//! eventsFor), and everything is checked again here, field by field, before it's written. Anything that doesn't
//! fit is dropped, never stored "just in case".

use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const FILE: &str = "store.json";
/// The last Full scan's record, beside the store (its own file: it can hold a key per file on the PC, which the
/// store's JSON, written whole on every change, shouldn't carry).
const BASELINE_FILE: &str = "scan-baseline.bin";
/// v2 adds one bit a file, "this file had something worth a look", so a changes-only Full can re-read just those
/// files and keep Results complete. v1 on disk still reads fine, with every bit unset (`Baseline::decode`).
const BASELINE_MAGIC: &[u8; 8] = b"CLOTRBL2";
const BASELINE_MAGIC_V1: &[u8; 8] = b"CLOTRBL1";
const KEEP_DAYS: [u64; 3] = [90, 365, 730];
const DEFAULT_KEEP_DAYS: u64 = 365;
const MAX_EVENTS: usize = 20_000;
const MAX_VAULT: usize = 5_000;
const MAX_SCAN_IGNORED: usize = 5_000;
const MAX_SCAN_SEEN: usize = 5_000;
const MAX_SCAN_EXCLUDED: usize = 500;
const MAX_SCAN_ROWS: usize = 500;
// results.js's own "What to do" plan (plan.js's STEPS): a new step there needs its id added below too.
const PLAN_STEP_IDS: [&str; 6] = ["keys", "idPhotos", "idDocs", "photoPlace", "money", "leaveOutFolders"];
// "Was this right?": findings.js's own nouns and the four place tiers Results already knows a file by
// (`file.project`, `file.secret`; neither is "yours". "program" names a skipped-programs folder's own files, kept
// here for the same four-way shape even though today's Results never shows one). One row a kind-tier pair, so the
// most this can ever hold is their product.
const ACCURACY_KINDS: [&str; 17] = [
    "key", "password", "code", "seed", "network", "id", "idPicture", "place", "card", "cardCode", "bank", "birth",
    "address", "phone", "email", "name", "other",
];
const ACCURACY_TIERS: [&str; 4] = ["yours", "program", "project", "secret"];
const MAX_ACCURACY: usize = ACCURACY_KINDS.len() * ACCURACY_TIERS.len();
const DAY_MS: u64 = 86_400_000;

pub struct Store {
    path: PathBuf,
    data: Map<String, Value>,
}

/// A note Clotr shows once and then never again, kept as a `true` under its own key. Only Clotr itself writes these;
/// a page's settings never carry one in.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Once {
    /// The first typed card's one-line note.
    TypedNote,
    /// Home's first-run line saying Clotr doesn't start with Windows until it's switched on.
    StartLine,
    /// The toast on the first close of the main window, saying Clotr is still on by the clock.
    CloseToast,
}

impl Once {
    const ALL: [Once; 3] = [Once::TypedNote, Once::StartLine, Once::CloseToast];

    fn key(self) -> &'static str {
        match self {
            Once::TypedNote => "typedNoteSeen",
            Once::StartLine => "startLineSeen",
            Once::CloseToast => "closeToastSeen",
        }
    }
}

/// As many AI app ids as `seenApps` ever keeps: far more than the built-in list will hold.
const MAX_SEEN_APPS: usize = 64;

/// `seenApps` as read back: app ids only, each once, in the order first seen.
fn clean_seen_apps(raw: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in raw.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        if is_app_id(id) && !out.iter().any(|s| s == id) && out.len() < MAX_SEEN_APPS {
            out.push(id.to_string());
        }
    }
    out
}

/// What a page may change, and how much it may say.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum From {
    /// Settings saved in the main window.
    Settings,
    /// A move file opened in the main window: the same, plus the salt it carries (so the vault's
    /// fingerprints still match).
    MoveFile,
    /// Settings received from the browser bridge, after the protocol has limited their fields.
    #[cfg(feature = "one-clotr")]
    Bridge,
}

impl Store {
    /// The store in `dir`, as it was left. A missing or broken file starts fresh; whatever was there goes through
    /// the same checks as anything new. A salt is made the first time (32 hex characters from the system's secure
    /// random), so fingerprints work from the start.
    pub fn open(dir: &Path) -> io::Result<Store> {
        fs::create_dir_all(dir)?;
        let path = dir.join(FILE);
        let raw: Value = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or(Value::Null);
        let mut data = clean_settings(&raw, true);
        if let Some(Value::Bool(true)) = raw.get("pausedAll") {
            data.insert("pausedAll".into(), Value::Bool(true));
        }
        for note in Once::ALL {
            if let Some(Value::Bool(true)) = raw.get(note.key()) {
                data.insert(note.key().into(), Value::Bool(true));
            }
        }
        let seen_apps = clean_seen_apps(raw.get("seenApps"));
        if !seen_apps.is_empty() {
            data.insert("seenApps".into(), json!(seen_apps));
        }
        if let Some(at) = raw.get("lastWeeklyCheck").and_then(Value::as_u64) {
            data.insert("lastWeeklyCheck".into(), json!(at));
        }
        if let Some(find) = raw.get("lastWeeklyFind") {
            let new_count = find.get("new").and_then(Value::as_u64).unwrap_or(0);
            let still_count = find.get("still").and_then(Value::as_u64).unwrap_or(0);
            data.insert("lastWeeklyFind".into(), json!({ "new": new_count, "still": still_count }));
        }
        let events: Vec<Value> = raw
            .get("events")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(clean_stored_event).collect())
            .unwrap_or_default();
        data.insert("events".into(), Value::Array(events));
        let scans: Vec<Value> = raw
            .get("scans")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(clean_scan_row).collect())
            .unwrap_or_default();
        data.insert("scans".into(), Value::Array(scans));
        data.insert("scanExcluded".into(), Value::Array(clean_exclusions(raw.get("scanExcluded"))));
        let accuracy: Vec<Value> = raw
            .get("accuracy")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(clean_accuracy_row).collect())
            .unwrap_or_default();
        data.insert("accuracy".into(), Value::Array(accuracy));
        let mut store = Store { path, data };
        if !store.data.contains_key("salt") {
            store.data.insert("salt".into(), Value::String(new_salt()?));
        }
        store.prune(now_ms());
        store.write()?;
        Ok(store)
    }

    /// Everything but history, for the pages (the card needs the salt, the vault and the responses to check).
    pub fn settings(&self) -> Value {
        let mut out = self.data.clone();
        out.remove("events");
        out.remove("scans");
        // What's left out of scans holds full paths, so no page ever gets it: Settings reads `exclusions_view()`
        // instead, by name and parent only.
        out.remove("scanExcluded");
        // Its own call (`accuracy_answers`) carries this; Export and the Settings summary read from there.
        out.remove("accuracy");
        Value::Object(out)
    }

    pub fn events(&self) -> Value {
        self.data.get("events").cloned().unwrap_or_else(|| json!([]))
    }

    pub fn scans(&self) -> Value {
        self.data.get("scans").cloned().unwrap_or_else(|| json!([]))
    }

    /// Settings' Language as saved ("en", "es" or "system"), read without copying the rest of the settings.
    pub fn language(&self) -> Option<String> {
        self.data.get("language").and_then(Value::as_str).map(str::to_string)
    }

    pub fn paused_all(&self) -> bool {
        self.data.get("pausedAll") == Some(&Value::Bool(true))
    }

    pub fn app_paused(&self, id: &str) -> bool {
        self.data.get("pausedApps").and_then(|p| p.get(id)) == Some(&Value::Bool(true))
    }

    /// "Check what I type in AI apps": on unless the person switched it off.
    pub fn typing_check(&self) -> bool {
        self.data.get("typingCheck") != Some(&Value::Bool(false))
    }

    /// The first typed card's one-line note was shown (the card's own write; no page sends this as a setting).
    pub fn set_typed_note_seen(&mut self) -> io::Result<()> {
        self.set_once(Once::TypedNote)
    }

    /// Whether a one-time note was already shown, on this start or an earlier one.
    pub fn once(&self, note: Once) -> bool {
        self.data.get(note.key()) == Some(&Value::Bool(true))
    }

    pub fn set_once(&mut self, note: Once) -> io::Result<()> {
        self.data.insert(note.key().into(), Value::Bool(true));
        self.write()
    }

    /// The AI apps Clotr has recognised in front at least once, by id. Home counts these as covered even when no
    /// Store package says they're installed (Claude's own installer leaves none).
    pub fn seen_apps(&self) -> Vec<String> {
        clean_seen_apps(self.data.get("seenApps"))
    }

    /// Adds an app to `seen_apps`. True when it's new, so the caller can tell the main window once, not on every
    /// switch to the app.
    pub fn note_app_seen(&mut self, id: &str) -> io::Result<bool> {
        let mut seen = self.seen_apps();
        if !is_app_id(id) || seen.iter().any(|s| s == id) || seen.len() >= MAX_SEEN_APPS {
            return Ok(false);
        }
        seen.push(id.to_string());
        self.data.insert("seenApps".into(), json!(seen));
        self.write()?;
        Ok(true)
    }

    pub fn set_paused_all(&mut self, on: bool) -> io::Result<()> {
        if on {
            self.data.insert("pausedAll".into(), Value::Bool(true));
        } else {
            self.data.remove("pausedAll");
        }
        self.write()
    }

    /// When the weekly check last ran (its own write, never a page's), so a restart doesn't run it again right
    /// away. None until the first run.
    pub fn last_weekly_check(&self) -> Option<u64> {
        self.data.get("lastWeeklyCheck").and_then(Value::as_u64)
    }

    pub fn set_last_weekly_check(&mut self, at: u64) -> io::Result<()> {
        self.data.insert("lastWeeklyCheck".into(), json!(at));
        self.write()
    }

    /// Home's own words after a weekly check (4-4): how many of its worth-a-look files were new this time and
    /// how many were already on the "seen" list from before -- two counts, read straight from settings(), never a
    /// path or a kind.
    pub fn set_weekly_find(&mut self, new_count: u64, still_count: u64) -> io::Result<()> {
        self.data
            .insert("lastWeeklyFind".into(), json!({ "new": new_count, "still": still_count }));
        self.write()
    }

    /// Everything the last weekly check found that the person hasn't dealt with yet, new and still-here together
    /// -- so a restart can tell Home there's something worth a look without re-running the check.
    pub fn weekly_find_total(&self) -> u64 {
        let find = self.data.get("lastWeeklyFind");
        let get = |k: &str| find.and_then(|v| v.get(k)).and_then(Value::as_u64).unwrap_or(0);
        get("new") + get("still")
    }

    /// History records from the card, for the apps on the list. Returns how many were kept.
    pub fn record(&mut self, events: &Value, apps: &[String]) -> io::Result<usize> {
        let fresh: Vec<Value> = events
            .as_array()
            .map(|list| list.iter().filter_map(|e| clean_event(e, apps)).collect())
            .unwrap_or_default();
        let kept = fresh.len();
        if kept == 0 {
            return Ok(0);
        }
        if let Some(Value::Array(list)) = self.data.get_mut("events") {
            list.extend(fresh);
        }
        self.prune(now_ms());
        self.write()?;
        Ok(kept)
    }

    /// A row for the History screen's scan list: one per finished scan or Look back read, from `scan.js`'s
    /// `finish` or `lookback.js`'s `finishRead`, after `clean_scan_row` has checked it. Never a path, a filename
    /// or a detected value, only when, which kind of scan, how many files or chats, and counts per kind of
    /// detail. Returns false if the row didn't pass the check.
    pub fn record_scan(&mut self, row: &Value) -> io::Result<bool> {
        let Some(mut clean) = clean_scan_row(row) else {
            return Ok(false);
        };
        let list = self.data.entry("scans").or_insert_with(|| json!([]));
        if let Value::Array(arr) = list {
            let scan = clean["scan"].as_str().unwrap_or_default();
            if let Some(previous) = arr.iter().rev().find(|old| old["scan"].as_str() == Some(scan)) {
                let before = previous["counts"].as_object();
                let after = clean["counts"].as_object();
                let mut added = Map::new();
                let mut gone = Map::new();
                if let Some(after) = after {
                    for (kind, count) in after {
                        let delta = count.as_u64().unwrap_or(0).saturating_sub(
                            before.and_then(|m| m.get(kind)).and_then(Value::as_u64).unwrap_or(0),
                        );
                        if delta > 0 {
                            added.insert(kind.clone(), json!(delta));
                        }
                    }
                }
                if let Some(before) = before {
                    for (kind, count) in before {
                        let delta = count.as_u64().unwrap_or(0).saturating_sub(
                            after.and_then(|m| m.get(kind)).and_then(Value::as_u64).unwrap_or(0),
                        );
                        if delta > 0 {
                            gone.insert(kind.clone(), json!(delta));
                        }
                    }
                }
                clean["added"] = Value::Object(added);
                clean["gone"] = Value::Object(gone);
            }
            arr.push(clean);
            if arr.len() > MAX_SCAN_ROWS {
                let extra = arr.len() - MAX_SCAN_ROWS;
                arr.drain(..extra);
            }
        }
        self.write()?;
        Ok(true)
    }

    /// Turning Tourniquet on or off from Protection's own switch: a valid record replaces whatever was there,
    /// anything else (off, or a bad value) takes it off, the same as `set_paused_all` always means what it says
    /// rather than leaving an old record quietly in force. Returns whether it's on now.
    pub fn set_tourniquet(&mut self, t: &Value) -> io::Result<bool> {
        match clean_tourniquet(Some(t)) {
            Some(v) => {
                self.data.insert("tourniquet".into(), v);
                self.write()?;
                let _ = self.write_one_clotr_timestamps(&["tourniquet".into()]);
                Ok(true)
            }
            None => {
                if self.data.remove("tourniquet").is_some() {
                    self.write()?;
                }
                let _ = self.write_one_clotr_timestamps(&["tourniquet".into()]);
                Ok(false)
            }
        }
    }

    fn salt(&self) -> String {
        self.data.get("salt").and_then(Value::as_str).unwrap_or("").to_string()
    }

    /// *Ignore* on a file card, or (later) *Keep it* on an extension card: never the path or
    /// the id itself, only its fingerprint, so a later scan can skip it again without Clotr keeping what it found.
    /// `kind` names the list the fingerprint belongs to ("file" or "ext"), not the kind of detail found.
    pub fn ignore_scan_item(&mut self, kind: &str, value: &str) -> io::Result<String> {
        let fp = scan_fingerprint(&self.salt(), kind, value);
        let list = self.data.entry("scanIgnored").or_insert_with(|| json!([]));
        if let Value::Array(arr) = list {
            let already = arr
                .iter()
                .any(|e| e.get("fp").and_then(Value::as_str) == Some(fp.as_str()) && e.get("kind") == Some(&json!(kind)));
            if !already && arr.len() < MAX_SCAN_IGNORED {
                arr.push(json!({ "fp": fp, "kind": kind }));
            }
        }
        self.write()?;
        Ok(fp)
    }

    /// Whether `value` (a file's path, or an extension's id) is on the ignored list already, from the same
    /// fingerprint `ignore_scan_item` would make for it.
    #[cfg(test)]
    pub fn is_scan_ignored(&self, kind: &str, value: &str) -> bool {
        let fp = scan_fingerprint(&self.salt(), kind, value);
        self.data
            .get("scanIgnored")
            .and_then(Value::as_array)
            .is_some_and(|arr| {
                arr.iter()
                    .any(|e| e.get("fp").and_then(Value::as_str) == Some(fp.as_str()) && e.get("kind") == Some(&json!(kind)))
            })
    }

    /// *Undo* right after *Ignore*, for the same scan run: drops the one fingerprint `ignore_scan_item` just
    /// added, so the next read of this scan counts the card again. Leaves every other ignored item alone. Nothing
    /// offers that Undo yet, so only the tests build it.
    #[cfg(test)]
    pub fn unignore_scan_item(&mut self, kind: &str, value: &str) -> io::Result<()> {
        let fp = scan_fingerprint(&self.salt(), kind, value);
        if let Some(Value::Array(arr)) = self.data.get_mut("scanIgnored") {
            arr.retain(|e| {
                !(e.get("fp").and_then(Value::as_str) == Some(fp.as_str()) && e.get("kind") == Some(&json!(kind)))
            });
        }
        self.write()
    }

    /// *Show them again*, in Settings: clears every item a scan has ever been told to ignore, so the next
    /// scan counts all of them again.
    pub fn clear_scan_ignored(&mut self) -> io::Result<()> {
        self.data.insert("scanIgnored".into(), json!([]));
        self.clear_baseline()?;
        self.write()
    }

    /// *Was this right?* on a file in Results or the workbench: keeps only which of the fixed kinds and
    /// which of the four place tiers, and whether this answer was yes or no, as a running count on that pair's
    /// own row. An unknown kind or tier is refused rather than stored loosely.
    pub fn record_accuracy_answer(&mut self, kind: &str, tier: &str, yes: bool) -> io::Result<bool> {
        if !ACCURACY_KINDS.contains(&kind) || !ACCURACY_TIERS.contains(&tier) {
            return Ok(false);
        }
        let list = self.data.entry("accuracy").or_insert_with(|| json!([]));
        if let Value::Array(arr) = list {
            let field = if yes { "yes" } else { "no" };
            let row = arr
                .iter_mut()
                .find(|e| e.get("kind") == Some(&json!(kind)) && e.get("tier") == Some(&json!(tier)));
            if let Some(row) = row {
                let n = row.get(field).and_then(Value::as_u64).unwrap_or(0);
                row[field] = json!(n.saturating_add(1));
            } else if arr.len() < MAX_ACCURACY {
                let (first_yes, first_no) = if yes { (1, 0) } else { (0, 1) };
                arr.push(json!({ "kind": kind, "tier": tier, "yes": first_yes, "no": first_no }));
            }
        }
        self.write()?;
        Ok(true)
    }

    pub fn accuracy_answers(&self) -> Value {
        self.data.get("accuracy").cloned().unwrap_or_else(|| json!([]))
    }

    /// Settings' own *Clear* beside Accuracy answers: empties the counts, never tied to Clear history (it is
    /// its own small, separate thing the person chooses to keep or not).
    pub fn clear_accuracy_answers(&mut self) -> io::Result<()> {
        self.data.insert("accuracy".into(), json!([]));
        self.write()
    }

    /// The salt a scan keys its record with: the store's own, so a Quick scan matches what the Full one kept.
    pub fn scan_salt(&self) -> String {
        self.salt()
    }

    /// The files the person said to ignore, as a set a walk can check each path against (by fingerprint only).
    pub fn ignored_files(&self) -> IgnoredFiles {
        let fps = self
            .data
            .get("scanIgnored")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter(|e| e.get("kind") == Some(&json!("file")))
                    .filter_map(|e| e.get("fp").and_then(Value::as_str).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        IgnoredFiles { salt: self.salt(), fps }
    }

    /// *Leave out of scans*: a folder or a file the person picked (its full path, kept because they chose it: it's
    /// configuration, never something a scan found) or a file type (".log"). Returns the entry's id, or None for a
    /// value that doesn't fit or a list already full. Clear history and Show them again leave this list alone.
    pub fn add_exclusion(&mut self, kind: &str, value: &str) -> io::Result<Option<String>> {
        let Some(entry) = clean_exclusion(&json!({ "kind": kind, "value": value })) else {
            return Ok(None);
        };
        let salt = self.salt();
        let id = exclusion_id(&salt, &entry);
        let list = self.data.entry("scanExcluded").or_insert_with(|| json!([]));
        if let Value::Array(arr) = list {
            if !arr.iter().any(|e| exclusion_id(&salt, e) == id) {
                if arr.len() >= MAX_SCAN_EXCLUDED {
                    return Ok(None);
                }
                arr.push(entry);
            }
        }
        self.write()?;
        Ok(Some(id))
    }

    /// Settings' own Remove, and Undo right after a Leave out on a Results card. Returns whether one went.
    pub fn remove_exclusion(&mut self, id: &str) -> io::Result<bool> {
        let salt = self.salt();
        let mut removed = false;
        if let Some(Value::Array(arr)) = self.data.get_mut("scanExcluded") {
            let before = arr.len();
            arr.retain(|e| exclusion_id(&salt, e) != id);
            removed = arr.len() != before;
        }
        if removed {
            self.write()?;
        }
        Ok(removed)
    }

    /// What a walk leaves out, for `scan::PlanCtx`.
    pub fn exclusions(&self) -> Exclusions {
        let mut out = Exclusions::default();
        for e in self.data.get("scanExcluded").and_then(Value::as_array).into_iter().flatten() {
            let kind = e.get("kind").and_then(Value::as_str).unwrap_or("");
            let value = e.get("value").and_then(Value::as_str).unwrap_or("");
            match kind {
                "folder" => out.folders.push(lower_path(Path::new(value))),
                "file" => {
                    out.files.insert(lower_path(Path::new(value)));
                }
                _ => {
                    out.types.insert(value.trim_start_matches('.').to_string());
                }
            }
        }
        out
    }

    /// The list for Settings: an id, the kind, and a folder's or file's own name with its parent's, never the path.
    pub fn exclusions_view(&self) -> Value {
        let salt = self.salt();
        let list: Vec<Value> = self
            .data
            .get("scanExcluded")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|e| {
                let kind = e.get("kind").and_then(Value::as_str).unwrap_or("");
                let value = e.get("value").and_then(Value::as_str).unwrap_or("");
                let (name, parent) = if kind == "type" {
                    (value.to_string(), Value::Null)
                } else {
                    let (name, parent) = name_and_parent(Path::new(value));
                    (name, json!(parent))
                };
                json!({ "id": exclusion_id(&salt, e), "kind": kind, "name": name, "parent": parent })
            })
            .collect();
        Value::Array(list)
    }

    fn baseline_path(&self) -> PathBuf {
        self.path.with_file_name(BASELINE_FILE)
    }

    /// The last Full scan's record, or None before the first one (or once it's been cleared, or if the file is
    /// damaged: a Quick scan then simply reads its floor, the same as before any Full scan).
    pub fn baseline(&self) -> Option<Baseline> {
        Baseline::decode(&fs::read(self.baseline_path()).ok()?)
    }

    /// When the last Full scan finished and how many files it kept, from the record's header alone (for Settings
    /// and the Scan screen, without reading every key).
    pub fn baseline_summary(&self) -> Option<(u64, u64)> {
        let mut head = [0u8; 24];
        let mut file = fs::File::open(self.baseline_path()).ok()?;
        io::Read::read_exact(&mut file, &mut head).ok()?;
        (&head[..8] == BASELINE_MAGIC || &head[..8] == BASELINE_MAGIC_V1)
            .then(|| (u64_at(&head, 8), u64_at(&head, 16)))
    }

    /// A finished Full scan's record, written whole beside the store and swapped in, like the store itself.
    pub fn save_baseline(&self, baseline: &Baseline) -> io::Result<()> {
        let path = self.baseline_path();
        let tmp = path.with_extension("bin.tmp");
        fs::write(&tmp, baseline.encode())?;
        fs::rename(&tmp, &path)
    }

    fn clear_baseline(&self) -> io::Result<()> {
        match fs::remove_file(self.baseline_path()) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    /// Tell only what's new (4-4): a salted fingerprint of a file's path plus the kinds found in it, the same
    /// mechanism and cap as Ignore, so the weekly check's own notice never fires twice for the same find -- and
    /// a file whose kinds changed since (a password added where there was only an email before) reads as new
    /// again, since its fingerprint changes with them. Returns whether this is the first time it's been seen;
    /// a fingerprint already on the list, or a list already at its cap, answers false either way.
    pub fn note_scan_find(&mut self, path: &str, kinds: &[String]) -> io::Result<bool> {
        let mut sorted: Vec<&str> = kinds.iter().map(String::as_str).collect();
        sorted.sort_unstable();
        let fp = scan_fingerprint(&self.salt(), "found", &format!("{path}\0{}", sorted.join(",")));
        let list = self.data.entry("scanSeen").or_insert_with(|| json!([]));
        let mut is_new = true;
        if let Value::Array(arr) = list {
            is_new = !arr.iter().any(|e| e.as_str() == Some(fp.as_str()));
            if is_new && arr.len() < MAX_SCAN_SEEN {
                arr.push(json!(fp));
            }
        }
        self.write()?;
        Ok(is_new)
    }

    /// One kind's response, from a choice in the card ("Leave it alone, and stop warning me about…").
    pub fn set_responses(&mut self, kinds: &Value, response: &str) -> io::Result<usize> {
        if !matches!(response, "block" | "warn" | "log") {
            return Ok(0);
        }
        let kinds: Vec<&str> = kinds
            .as_array()
            .map(|k| k.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let responses = self.data.entry("responses").or_insert_with(|| json!({}));
        let mut n = 0;
        if let Value::Object(map) = responses {
            for kind in kinds.into_iter().filter(|k| is_kind(k)).take(64) {
                map.insert(kind.into(), Value::String(response.into()));
                n += 1;
            }
        }
        if n > 0 {
            self.write()?;
            let _ = self.write_one_clotr_timestamps(&["responses".into()]);
        }
        Ok(n)
    }

    /// Settings from the main window or a move file: each key it carries replaces the stored one, after the
    /// checks. A move file never brings history.
    pub fn save_settings(&mut self, incoming: &Value, from: From) -> io::Result<Vec<String>> {
        let clean = clean_settings(incoming, from == From::MoveFile);
        let changed: Vec<String> = clean.keys().cloned().collect();
        for (k, v) in clean {
            self.data.insert(k, v);
        }
        self.prune(now_ms());
        self.write()?;
        if from == From::Settings {
            let _ = self.write_one_clotr_timestamps(&changed);
        }
        Ok(changed)
    }

    fn write_one_clotr_timestamps(&self, changed: &[String]) -> io::Result<()> {
        let shared = ["responses", "largeText", "keepDays", "tourniquet", "replyCheck", "commandCheck", "advanced"];
        let path = self.path.with_file_name("one-clotr-settings.json");
        let mut records: Map<String, Value> = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        for key in changed.iter().filter(|key| shared.contains(&key.as_str())) {
            let value = self.data.get(key).unwrap_or(&Value::Null);
            let linked = records.get(key).and_then(|item| item.get("linked")).cloned().unwrap_or(Value::Bool(true));
            records.insert(key.clone(), json!({"value": value, "updatedAt": now_ms(), "linked": linked}));
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec(&Value::Object(records))?)?;
        fs::rename(tmp, path)
    }

    /// Clear history, in Settings: every record of what was found and what was scanned, the last Full scan's own
    /// record included (the next Quick scan reads its floor only, until a Full scan runs again).
    pub fn clear_history(&mut self) -> io::Result<()> {
        self.data.insert("events".into(), json!([]));
        self.data.insert("scans".into(), json!([]));
        self.clear_baseline()?;
        self.write()
    }

    /// Old history goes after the person's keepDays (90, 365 or 730 days; a year if not set), and never more than
    /// MAX_EVENTS records.
    fn prune(&mut self, now: u64) {
        let days = self
            .data
            .get("keepDays")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_KEEP_DAYS);
        let cutoff = now.saturating_sub(days * DAY_MS);
        if let Some(Value::Array(list)) = self.data.get_mut("events") {
            list.retain(|e| e.get("t").and_then(Value::as_f64).is_some_and(|t| t >= cutoff as f64));
            if list.len() > MAX_EVENTS {
                let extra = list.len() - MAX_EVENTS;
                list.drain(..extra);
            }
        }
    }

    /// Written whole to a temporary file beside it, then swapped in, so a crash never leaves half a file.
    fn write(&self) -> io::Result<()> {
        let tmp = self.path.with_extension("json.tmp");
        let text = serde_json::to_vec_pretty(&Value::Object(self.data.clone()))?;
        fs::write(&tmp, text)?;
        fs::rename(&tmp, &self.path)
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 16 bytes from the system's secure random, as 32 hex characters.
fn new_salt() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(format!("no secure random: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

// ---------- The checks: what may be stored ----------

/// A kind's id, as the engine names them ("credit_card").
pub fn is_kind(k: &str) -> bool {
    (2..=40).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

fn is_app_id(k: &str) -> bool {
    (1..=40).contains(&k.len())
        && k.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A scan's own salted fingerprint: 16 hex characters of SHA-256(salt + kind + value), the same
/// length and idea as the engine's own fingerprints, in a namespace of its own (a scan's "file" or "ext" never
/// matches a card's vault entry, even on the same salt). The path or extension id behind it never leaves this
/// function: *Ignore* and *Keep it* only ever see the fingerprint that comes back.
pub fn scan_fingerprint(salt: &str, kind: &str, value: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b"\0");
    hasher.update(kind.as_bytes());
    hasher.update(b"\0");
    hasher.update(value.as_bytes());
    hasher
        .finalize()
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The files a scan was told to ignore: fingerprints only, checked against a path the same way
/// `ignore_scan_item` made them.
#[derive(Default)]
pub struct IgnoredFiles {
    salt: String,
    fps: HashSet<String>,
}

impl IgnoredFiles {
    pub fn contains(&self, path: &Path) -> bool {
        !self.fps.is_empty() && self.fps.contains(&scan_fingerprint(&self.salt, "file", &path.to_string_lossy()))
    }
}

/// What a scan leaves out because the person said so: folders (and everything inside them), single files, and file
/// types (lower case, without the dot). Paths are compared in lower case, the way Windows does.
#[derive(Default, Clone, Debug)]
pub struct Exclusions {
    folders: Vec<String>,
    files: HashSet<String>,
    types: HashSet<String>,
}

impl Exclusions {
    /// `path` is an excluded folder or sits anywhere inside one.
    pub fn folder(&self, path: &Path) -> bool {
        if self.folders.is_empty() {
            return false;
        }
        let p = lower_path(path);
        self.folders
            .iter()
            .any(|f| p == *f || p.strip_prefix(f.as_str()).is_some_and(|rest| rest.starts_with('\\')))
    }

    /// `path` is an excluded file, or `ext` (lower case, no dot) an excluded type.
    pub fn file(&self, path: &Path, ext: &str) -> bool {
        (!ext.is_empty() && self.types.contains(ext))
            || (!self.files.is_empty() && self.files.contains(&lower_path(path)))
    }
}

/// A path as the exclusions compare it: lower case, Windows' own separator, no trailing one.
fn lower_path(p: &Path) -> String {
    p.to_string_lossy().to_lowercase().replace('/', "\\").trim_end_matches('\\').to_string()
}

/// A folder's or file's own name and its parent's, for a page that never sees the path ("C:" for a drive's root).
pub fn name_and_parent(p: &Path) -> (String, String) {
    let label = |q: &Path| {
        q.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| q.to_string_lossy().trim_end_matches('\\').to_string())
    };
    (label(p), p.parent().map(label).unwrap_or_default())
}

fn exclusion_id(salt: &str, e: &Value) -> String {
    let kind = e.get("kind").and_then(Value::as_str).unwrap_or("");
    let value = e.get("value").and_then(Value::as_str).unwrap_or("");
    scan_fingerprint(salt, "exclude", &format!("{kind}\0{}", value.to_lowercase()))
}

/// One exclusion as it may be stored: a folder or file by its absolute path (at most 1,024 characters), or a type
/// as a dot and 1 to 16 letters or digits, in lower case.
fn clean_exclusion(e: &Value) -> Option<Value> {
    let kind = e.get("kind")?.as_str()?;
    let value = e.get("value")?.as_str()?;
    match kind {
        "folder" | "file" => {
            let ok = !value.is_empty() && value.len() <= 1024 && Path::new(value).is_absolute() && !value.contains('\0');
            ok.then(|| json!({ "kind": kind, "value": value }))
        }
        "type" => {
            let ext = value.trim_start_matches('.').to_ascii_lowercase();
            let ok = (1..=16).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_alphanumeric());
            ok.then(|| json!({ "kind": "type", "value": format!(".{ext}") }))
        }
        _ => None,
    }
}

fn clean_exclusions(v: Option<&Value>) -> Vec<Value> {
    v.and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(clean_exclusion).take(MAX_SCAN_EXCLUDED).collect())
        .unwrap_or_default()
}

/// What a Full scan leaves for the next Quick or Full one: per file, a salted key of its path, a stamp of its size
/// and when it last changed, and whether it had something worth a look -- never the path, its name, its kind or
/// anything in it. A later scan reads a file only when its key is missing (new since), its stamp differs (changed
/// since), or (a Full scan only) the bit is set, so Results can still show whatever it finds there today.
/// Kept sorted by key, so a lookup is a binary search.
pub struct Baseline {
    pub at: u64,
    entries: Vec<(u64, u64, bool)>,
}

impl Baseline {
    pub fn new(at: u64, mut entries: Vec<(u64, u64, bool)>) -> Baseline {
        entries.sort_unstable_by_key(|e| e.0);
        entries.dedup_by_key(|e| e.0);
        Baseline { at, entries }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the file keyed `key` is just as the Full scan saw it.
    pub fn unchanged(&self, key: u64, stamp: u64) -> bool {
        self.entries
            .binary_search_by_key(&key, |e| e.0)
            .is_ok_and(|i| self.entries[i].1 == stamp)
    }

    /// Whether the file keyed `key` had something worth a look the last time a Full scan read it. A changes-only
    /// Full re-reads a file this is true for even when `unchanged` is also true, so Results stays current on it.
    pub fn flagged(&self, key: u64) -> bool {
        self.entries.binary_search_by_key(&key, |e| e.0).is_ok_and(|i| self.entries[i].2)
    }

    /// The magic, when, how many, then each key, stamp and bit: 17 bytes a file, little-endian.
    fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(24 + self.entries.len() * 17);
        out.extend_from_slice(BASELINE_MAGIC);
        out.extend_from_slice(&self.at.to_le_bytes());
        out.extend_from_slice(&(self.entries.len() as u64).to_le_bytes());
        for (key, stamp, flag) in &self.entries {
            out.extend_from_slice(&key.to_le_bytes());
            out.extend_from_slice(&stamp.to_le_bytes());
            out.push(u8::from(*flag));
        }
        out
    }

    /// Only a record whose header and length agree and whose keys are in order; anything else is no record. A v1
    /// record (no bit) decodes too, every entry's bit unset, so an old baseline migrates the moment it's read.
    fn decode(bytes: &[u8]) -> Option<Baseline> {
        if bytes.len() < 24 {
            return None;
        }
        let at = u64_at(bytes, 8);
        let count = usize::try_from(u64_at(bytes, 16)).ok()?;
        let entries: Vec<(u64, u64, bool)> = if &bytes[..8] == BASELINE_MAGIC {
            if bytes.len() != count.checked_mul(17)?.checked_add(24)? {
                return None;
            }
            bytes[24..]
                .as_chunks::<17>()
                .0
                .iter()
                .map(|c| (u64_at(c, 0), u64_at(c, 8), c[16] != 0))
                .collect()
        } else if &bytes[..8] == BASELINE_MAGIC_V1 {
            if bytes.len() != count.checked_mul(16)?.checked_add(24)? {
                return None;
            }
            bytes[24..]
                .as_chunks::<16>()
                .0
                .iter()
                .map(|c| (u64_at(c, 0), u64_at(c, 8), false))
                .collect()
        } else {
            return None;
        };
        entries.windows(2).all(|w| w[0].0 < w[1].0).then_some(Baseline { at, entries })
    }
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap_or([0; 8]))
}

/// A file's key in the Full scan record: 8 bytes of SHA-256(salt, "baseline", its path in lower case), so the
/// record can tell one file from another without ever holding where it is.
pub fn baseline_key(salt: &str, path: &Path) -> u64 {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b"\0baseline\0");
    hasher.update(path.to_string_lossy().to_lowercase().as_bytes());
    u64_at(&hasher.finalize(), 0)
}

/// A file's size and last-change time (Windows' own FILETIME), folded into one number: any change to either
/// changes it.
pub fn baseline_stamp(size: u64, modified: u64) -> u64 {
    size.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ modified
}

/// A history record's fingerprint: 16 hex characters, as the engine makes them. One made only of digits is dropped
/// (the record stays, without it): sixteen digits is also what a card number looks like, and a real fingerprint is
/// all digits only about once in 1,800 times.
fn event_fp(v: Option<&Value>) -> String {
    match v.and_then(Value::as_str) {
        Some(fp) if is_hex(fp, 16) && !fp.bytes().all(|b| b.is_ascii_digit()) => fp.into(),
        _ => String::new(),
    }
}

/// A kind's name as people read it ("Credit Card Number", "Número de tarjeta"): words only. A digit, an @ or a
/// colon means it isn't a kind's name, so the record is dropped.
fn kind_name(v: Option<&Value>) -> Option<String> {
    let name = v?.as_str()?;
    let ok = !name.trim().is_empty()
        && name.chars().count() <= 64
        && !name
            .chars()
            .any(|c| c.is_ascii_digit() || matches!(c, '@' | ':' | '<' | '>' | '\n' | '\r'));
    ok.then(|| name.into())
}

/// A history record from the card: exactly the extension's fields, for an AI app on the list, or nothing.
pub fn clean_event(e: &Value, apps: &[String]) -> Option<Value> {
    let site = e.get("site")?.as_str()?;
    let app = site.strip_prefix("app:")?;
    if !apps.iter().any(|a| a == app) {
        return None;
    }
    clean_record(e, site)
}

/// A record already in the file (an app since taken off the list keeps its history).
fn clean_stored_event(e: &Value) -> Option<Value> {
    let site = e.get("site")?.as_str()?;
    is_app_id(site.strip_prefix("app:")?).then_some(())?;
    clean_record(e, site)
}

fn clean_record(e: &Value, site: &str) -> Option<Value> {
    let t = e.get("t")?.as_f64().filter(|t| t.is_finite() && *t >= 0.0)?;
    let kind = e.get("type")?.as_str().filter(|k| is_kind(k))?;
    let severity = e
        .get("severity")?
        .as_str()
        .filter(|s| matches!(*s, "high" | "medium" | "low"))?;
    let action = e
        .get("action")?
        .as_str()
        .filter(|a| matches!(*a, "redacted" | "allowed" | "suppressed"))?;
    let name = kind_name(e.get("name"))?;
    let mut record = json!({
        "t": t.floor() as u64,
        "site": site,
        "type": kind,
        "name": name,
        "severity": severity,
        "action": action,
        "fp": event_fp(e.get("fp")),
    });
    if e.get("scheme").and_then(Value::as_u64) == Some(2) {
        record["scheme"] = json!(2);
    }
    Some(record)
}

/// Tourniquet's own record, the same shape sites.js's cleanTourniquet keeps on the stored settings: exactly
/// `{ for: "child" | "adult", since }`, or `{ for: "after_scam", since, until }` with until after since and no
/// more than 61 days later. Whether it's still on (the stored since/until against the clock) is for the pages
/// to work out, the same as the extension does; this only keeps the shape honest on the way to disk.
const TOURNIQUET_LONGEST_MS: f64 = 61.0 * 86_400_000.0;
fn clean_tourniquet(t: Option<&Value>) -> Option<Value> {
    let obj = t?.as_object()?;
    let since = obj.get("since")?.as_f64().filter(|t| t.is_finite() && *t >= 0.0)?;
    let for_ = obj.get("for")?.as_str()?;
    match for_ {
        "child" | "adult" if obj.len() == 2 => Some(json!({ "for": for_, "since": since.floor() as u64 })),
        "after_scam" if obj.len() == 3 => {
            let until = obj.get("until")?.as_f64().filter(|u| u.is_finite() && *u >= 0.0)?;
            (until > since && until - since <= TOURNIQUET_LONGEST_MS)
                .then(|| json!({ "for": "after_scam", "since": since.floor() as u64, "until": until.floor() as u64 }))
        }
        _ => None,
    }
}

/// A History scan row: when, which kind of scan, how many files or chats it read, and how many of each kind of
/// detail it found. Nothing identifies a file, a chat or a value, so a row is safe to keep as long as an event.
fn clean_scan_row(e: &Value) -> Option<Value> {
    let t = e.get("t")?.as_f64().filter(|t| t.is_finite() && *t >= 0.0)?;
    let scan = e
        .get("scan")?
        .as_str()
        .filter(|s| matches!(*s, "quick" | "full" | "chosen" | "lookback"))?;
    let items = e.get("items")?.as_u64().filter(|n| *n <= 1_000_000)?;
    let seconds = e
        .get("seconds")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n.min(86_400.0).floor() as u64);
    let counts = e.get("counts")?.as_object()?;
    let counts: Map<String, Value> = counts
        .iter()
        .filter(|(k, v)| is_kind(k) && v.as_u64().is_some_and(|n| n <= 1_000_000))
        .take(64)
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let mut row = json!({
        "t": t.floor() as u64,
        "scan": scan,
        "items": items,
        "counts": counts,
    });
    if let Some(seconds) = seconds {
        row["seconds"] = json!(seconds);
    }
    Some(row)
}

/// "Was this right?": one row a kind-and-tier pair, with how many times it was answered yes and how many
/// no. Never a file, its name, its place or the value -- only one of the fixed kinds and one of the four tiers.
fn clean_accuracy_row(e: &Value) -> Option<Value> {
    let kind = e.get("kind")?.as_str().filter(|k| ACCURACY_KINDS.contains(k))?;
    let tier = e.get("tier")?.as_str().filter(|t| ACCURACY_TIERS.contains(t))?;
    let yes = e.get("yes")?.as_u64().filter(|n| *n <= 1_000_000)?;
    let no = e.get("no")?.as_u64().filter(|n| *n <= 1_000_000)?;
    Some(json!({ "kind": kind, "tier": tier, "yes": yes, "no": no }))
}

/// A vault entry, as decide.js's cleanVaultEntry keeps it: a fingerprint ("value", "word") or a format with no
/// digit in it ("shape"), never the thing itself.
pub fn clean_vault_entry(e: &Value) -> Option<Value> {
    let kind = e
        .get("kind")?
        .as_str()
        .filter(|k| matches!(*k, "value" | "word" | "shape"))?;
    let kind_id = e.get("type")?.as_str().filter(|k| is_kind(k))?;
    let added = e
        .get("added")
        .and_then(Value::as_f64)
        .filter(|t| t.is_finite() && *t >= 0.0)
        .unwrap_or(0.0);
    let mut out = json!({ "kind": kind, "type": kind_id, "added": added.floor() as u64 });
    if kind == "shape" {
        let shape = e.get("shape")?.as_str()?;
        let marks = shape.chars().filter(|c| matches!(c, '#' | '@')).count();
        if marks < 2 || shape.chars().any(|c| c.is_ascii_digit()) || shape.chars().count() > 40 {
            return None;
        }
        out["shape"] = json!(shape);
    } else {
        let fp = e.get("fp")?.as_str().filter(|fp| is_hex(fp, 16))?;
        out["fp"] = json!(fp);
        if kind == "word" {
            let words = e.get("words").and_then(Value::as_f64).unwrap_or(1.0).clamp(1.0, 4.0);
            out["words"] = json!(words as u64);
        }
        if kind == "value" {
            let mode = e
                .get("mode")
                .and_then(Value::as_str)
                .filter(|m| matches!(*m, "protect" | "allow"));
            out["mode"] = json!(mode.unwrap_or("protect"));
        }
        if e.get("scheme").and_then(Value::as_u64) == Some(2) {
            out["scheme"] = json!(2);
        }
    }
    if e.get("learned") == Some(&Value::Bool(true)) {
        out["learned"] = json!(true);
    }
    Some(out)
}

/// Settings: only the keys Clotr for Windows uses, each with sane values (backup.js's clean, with the apps' names).
/// The salt only from a move file or the store itself.
pub fn clean_settings(s: &Value, with_salt: bool) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(s) = s.as_object() else { return out };
    let keep = |v: Option<&Value>, ok: &dyn Fn(&str, &Value) -> bool| -> Option<Value> {
        let map = v?.as_object()?;
        Some(Value::Object(
            map.iter()
                .filter(|(k, v)| ok(k, v))
                .take(500)
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ))
    };
    if let Some(v) = keep(s.get("responses"), &|k, v| {
        is_kind(k) && matches!(v.as_str(), Some("block" | "warn" | "log"))
    }) {
        out.insert("responses".into(), v);
    }
    if let Some(v) = keep(s.get("appModes"), &|k, v| {
        is_app_id(k) && matches!(v.as_str(), Some("block" | "log"))
    }) {
        out.insert("appModes".into(), v);
    }
    if let Some(v) = keep(s.get("pausedApps"), &|k, v| is_app_id(k) && v == &Value::Bool(true)) {
        out.insert("pausedApps".into(), v);
    }
    if let Some(v) = keep(s.get("guided"), &|k, v| {
        is_kind(k) && v.as_f64().is_some_and(f64::is_finite)
    }) {
        out.insert("guided".into(), v);
    }
    if let Some(Value::Bool(b)) = s.get("largeText") {
        out.insert("largeText".into(), Value::Bool(*b));
    }
    for key in ["replyCheck", "commandCheck", "advanced"] {
        if let Some(Value::Bool(value)) = s.get(key) {
            out.insert(key.into(), Value::Bool(*value));
        }
    }
    if let Some(v) = clean_tourniquet(s.get("tourniquet")) {
        out.insert("tourniquet".into(), v);
    }
    // The main window's own settings: the browser's move file never carries these (move-file.js's own
    // list leaves them out), but a plain switch or a named choice is harmless either way, so they're cleaned
    // the same as everything above.
    if let Some(Value::Bool(b)) = s.get("startWithWindows") {
        out.insert("startWithWindows".into(), Value::Bool(*b));
    }
    if let Some(v) = s.get("look").and_then(Value::as_str) {
        if matches!(v, "system" | "dark" | "light" | "plum" | "ember") {
            out.insert("look".into(), json!(v));
        } else if v == "savanna" {
            out.insert("look".into(), json!("plum"));
        }
    }
    if let Some(v) = s.get("motion").and_then(Value::as_str) {
        if matches!(v, "system" | "still") {
            out.insert("motion".into(), json!(v));
        }
    }
    if let Some(v) = s.get("language").and_then(Value::as_str) {
        if matches!(v, "system" | "en" | "es") {
            out.insert("language".into(), json!(v));
        }
    }
    if let Some(Value::Bool(b)) = s.get("typingCheck") {
        out.insert("typingCheck".into(), Value::Bool(*b));
    }
    if let Some(Value::Bool(b)) = s.get("weeklyCheck") {
        out.insert("weeklyCheck".into(), Value::Bool(*b));
    }
    if let Some(Value::Bool(b)) = s.get("notifyFind") {
        out.insert("notifyFind".into(), Value::Bool(*b));
    }
    // The developer switch: Quick and Full read code projects and secret files too.
    if let Some(Value::Bool(b)) = s.get("scanDevFiles") {
        out.insert("scanDevFiles".into(), Value::Bool(*b));
    }
    // What to do first, above Results: a step's own id, ticked, from results.js's `save`. Never a file name
    // or what was found, so an allow-list of the plan's own ids is enough.
    if let Some(list) = s.get("planTicked").and_then(Value::as_array) {
        let mut seen = std::collections::HashSet::new();
        let ticked: Vec<Value> = list
            .iter()
            .filter_map(Value::as_str)
            .filter(|id| PLAN_STEP_IDS.contains(id))
            .take(PLAN_STEP_IDS.len())
            .filter(|id| seen.insert(id.to_string()))
            .map(|id| json!(id))
            .collect();
        out.insert("planTicked".into(), Value::Array(ticked));
    }
    // Guided or Detailed results (design/later/results-modes.design.md, section 6): a named choice, same as `look`.
    if let Some(v) = s.get("resultsMode").and_then(Value::as_str) {
        if matches!(v, "guided" | "detailed") {
            out.insert("resultsMode".into(), json!(v));
        }
    }
    // "My helper", for the note's heading once it's built: the person's own words, trimmed and capped, never
    // read by anything but the apps that show it back to them.
    if let Some(v) = s.get("helperName").and_then(Value::as_str) {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            out.insert("helperName".into(), json!(""));
        } else {
            let capped: String = trimmed.chars().take(60).collect();
            out.insert("helperName".into(), json!(capped));
        }
    }
    if let Some(d) = s
        .get("keepDays")
        .and_then(Value::as_u64)
        .filter(|d| KEEP_DAYS.contains(d))
    {
        out.insert("keepDays".into(), json!(d));
    }
    if let Some(list) = s.get("vault").and_then(Value::as_array) {
        let mut seen = std::collections::HashSet::new();
        let vault: Vec<Value> = list
            .iter()
            .take(MAX_VAULT)
            .filter_map(clean_vault_entry)
            .filter(|e| {
                let key = format!(
                    "{}:{}:{}",
                    e["kind"],
                    e["type"],
                    e.get("fp").or(e.get("shape")).unwrap_or(&Value::Null)
                );
                seen.insert(key.to_lowercase())
            })
            .collect();
        out.insert("vault".into(), Value::Array(vault));
    }
    if let Some(list) = s.get("scanIgnored").and_then(Value::as_array) {
        let mut seen = std::collections::HashSet::new();
        let ignored: Vec<Value> = list
            .iter()
            .filter(|e| {
                let fp = e.get("fp").and_then(Value::as_str).filter(|fp| is_hex(fp, 16));
                let kind = e.get("kind").and_then(Value::as_str).filter(|k| matches!(*k, "file" | "ext"));
                matches!((fp, kind), (Some(_), Some(_)))
            })
            .take(MAX_SCAN_IGNORED)
            .filter(|e| seen.insert(format!("{}:{}", e["kind"], e["fp"])))
            .cloned()
            .collect();
        out.insert("scanIgnored".into(), Value::Array(ignored));
    }
    if let Some(list) = s.get("scanSeen").and_then(Value::as_array) {
        let mut seen = std::collections::HashSet::new();
        let fps: Vec<Value> = list
            .iter()
            .filter_map(|e| e.as_str())
            .filter(|fp| is_hex(fp, 16))
            .take(MAX_SCAN_SEEN)
            .filter(|fp| seen.insert(fp.to_lowercase()))
            .map(|fp| json!(fp))
            .collect();
        out.insert("scanSeen".into(), Value::Array(fps));
    }
    if with_salt {
        if let Some(salt) = s.get("salt").and_then(Value::as_str).filter(|x| is_hex(x, 32)) {
            out.insert("salt".into(), json!(salt));
        }
    }
    out
}

/// What a move file actually changed, in counts and names only, never the values themselves: the settings
/// page's "Brought over" line compares the store's own settings from just before and just after the import, so a
/// field only shows when it's genuinely different, never just carried along unchanged. Never the salt or `guided`
/// (an internal counter): neither means anything to the person reading this.
pub fn brought_summary(before: &Value, after: &Value) -> Value {
    let get = |v: &Value, k: &str| v.get(k).cloned().unwrap_or(Value::Null);
    let mut parts = Map::new();
    let (b, a) = (get(before, "responses"), get(after, "responses"));
    if a != b {
        parts.insert("responses".into(), json!(a.as_object().map(Map::len).unwrap_or(0)));
    }
    let (b, a) = (get(before, "vault"), get(after, "vault"));
    if a != b {
        parts.insert("vault".into(), json!(a.as_array().map(Vec::len).unwrap_or(0)));
    }
    let (b, a) = (get(before, "largeText"), get(after, "largeText"));
    if a != b {
        parts.insert("largeText".into(), json!(a.as_bool().unwrap_or(false)));
    }
    let (b, a) = (get(before, "keepDays"), get(after, "keepDays"));
    if a != b {
        parts.insert("keepDays".into(), a);
    }
    json!({ "changed": !parts.is_empty(), "parts": Value::Object(parts) })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CARD: &str = "4111111111111111";
    const PHONE: &str = "4155550132";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("clotr-store-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn shared_settings_changes_keep_only_local_values_and_their_write_time() {
        let dir = temp_dir("one-clotr-settings-time");
        let mut store = Store::open(&dir).unwrap();
        store.save_settings(&json!({"largeText":true,"keepDays":90}), From::Settings).unwrap();
        store.set_responses(&json!(["email"]), "block").unwrap();
        store.set_tourniquet(&Value::Null).unwrap();
        let metadata: Value = serde_json::from_slice(&fs::read(dir.join("one-clotr-settings.json")).unwrap()).unwrap();
        assert_eq!(metadata["largeText"]["value"], true);
        assert_eq!(metadata["largeText"]["updatedAt"].is_u64(), true);
        assert_eq!(metadata["responses"]["value"]["email"], "block");
        assert_eq!(metadata["tourniquet"]["value"], Value::Null);
        assert!(metadata.get("salt").is_none());
        assert!(metadata.get("events").is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    fn apps() -> Vec<String> {
        vec!["claude".into(), "chatgpt".into()]
    }

    fn event(fp: &str) -> Value {
        json!({ "t": 1_700_000_000_000u64, "site": "app:claude", "type": "credit_card", "name": "Credit Card Number",
                "severity": "high", "action": "redacted", "fp": fp })
    }

    #[test]
    fn a_new_store_gets_a_salt_from_the_secure_random_and_keeps_it() {
        let dir = temp_dir("salt");
        let salt = Store::open(&dir).unwrap().settings()["salt"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(is_hex(&salt, 32), "{salt}");
        assert_eq!(Store::open(&dir).unwrap().settings()["salt"], json!(salt));
        let other = temp_dir("salt2");
        assert_ne!(Store::open(&other).unwrap().settings()["salt"], json!(salt));
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(other);
    }

    #[test]
    fn each_one_time_note_is_kept_once_shown_and_a_page_can_never_set_one() {
        let dir = temp_dir("once");
        let mut store = Store::open(&dir).unwrap();
        for note in [Once::StartLine, Once::CloseToast] {
            assert!(!store.once(note), "{note:?} starts unshown");
        }
        store.set_once(Once::StartLine).unwrap();
        assert!(store.once(Once::StartLine));
        assert!(!store.once(Once::CloseToast), "each note is its own");
        store.set_once(Once::CloseToast).unwrap();
        let reopened = Store::open(&dir).unwrap();
        assert!(reopened.once(Once::StartLine) && reopened.once(Once::CloseToast), "a restart keeps both");
        let from_page = clean_settings(&json!({ "startLineSeen": true, "closeToastSeen": true }), false);
        assert!(from_page.is_empty(), "{from_page:?}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_ai_app_seen_in_front_is_kept_once_across_a_restart_and_never_taken_from_a_page() {
        let dir = temp_dir("seen-apps");
        let mut store = Store::open(&dir).unwrap();
        assert!(store.seen_apps().is_empty());
        assert!(store.note_app_seen("claude").unwrap(), "new the first time");
        assert!(!store.note_app_seen("claude").unwrap(), "not new the second");
        assert!(store.note_app_seen("chatgpt").unwrap());
        assert_eq!(Store::open(&dir).unwrap().seen_apps(), ["claude", "chatgpt"]);
        assert!(!clean_settings(&json!({ "seenApps": ["copilot"] }), false).contains_key("seenApps"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_seen_list_read_back_keeps_only_app_ids() {
        let dir = temp_dir("seen-apps-odd");
        fs::create_dir_all(&dir).unwrap();
        let raw = json!({ "seenApps": ["claude", "..\\x", 7, "Claude", "", "claude", "chatgpt"] });
        fs::write(dir.join(FILE), serde_json::to_vec(&raw).unwrap()).unwrap();
        assert_eq!(Store::open(&dir).unwrap().seen_apps(), ["claude", "chatgpt"]);
        let mut store = Store::open(&dir).unwrap();
        assert!(!store.note_app_seen("Not An Id").unwrap(), "an id Clotr's list could never hold is refused");
        assert_eq!(store.seen_apps(), ["claude", "chatgpt"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_typed_notes_seen_mark_survives_a_restart_and_a_page_can_never_set_it() {
        let dir = temp_dir("typed-note");
        let mut store = Store::open(&dir).unwrap();
        assert_eq!(store.settings().get("typedNoteSeen"), None);
        store.set_typed_note_seen().unwrap();
        assert_eq!(store.settings()["typedNoteSeen"], json!(true));
        // Restarting keeps it, so the first typed card's note shows once, not once per start.
        assert_eq!(Store::open(&dir).unwrap().settings()["typedNoteSeen"], json!(true));
        // Only the card's own command sets it; a settings save never carries it in.
        assert!(!clean_settings(&json!({ "typedNoteSeen": true }), false).contains_key("typedNoteSeen"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_weekly_checks_own_time_survives_a_restart_and_a_page_can_never_set_it() {
        let dir = temp_dir("weekly");
        let mut store = Store::open(&dir).unwrap();
        assert_eq!(store.last_weekly_check(), None);
        store.set_last_weekly_check(1_700_000_000_000).unwrap();
        assert_eq!(store.last_weekly_check(), Some(1_700_000_000_000));
        // Restarting keeps it, the same way pausedAll does.
        assert_eq!(Store::open(&dir).unwrap().last_weekly_check(), Some(1_700_000_000_000));
        // Settings saved from the main window never carry it in: clean_settings has no case for the key, so a
        // hostile or buggy save can't move the clock back.
        let clean = clean_settings(&json!({ "lastWeeklyCheck": 0 }), false);
        assert!(!clean.contains_key("lastWeeklyCheck"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_weekly_finds_new_and_still_counts_survive_a_restart_and_a_page_can_never_set_them() {
        let dir = temp_dir("weekly-find");
        let mut store = Store::open(&dir).unwrap();
        assert_eq!(store.weekly_find_total(), 0);
        store.set_weekly_find(1, 3).unwrap();
        assert_eq!(store.weekly_find_total(), 4);
        assert_eq!(Store::open(&dir).unwrap().weekly_find_total(), 4);
        let clean = clean_settings(&json!({ "lastWeeklyFind": { "new": 9, "still": 9 } }), false);
        assert!(!clean.contains_key("lastWeeklyFind"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn events_keep_only_the_extensions_fields() {
        let mut e = event("0123456789abcdef");
        e["text"] = json!("my card is 4111 1111 1111 1111");
        e["via"] = json!("bandage");
        let clean = clean_event(&e, &apps()).unwrap();
        let mut keys: Vec<&String> = clean.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["action", "fp", "name", "severity", "site", "t", "type"]);
    }

    #[test]
    fn scheme_two_survives_history_and_vault_cleaning_while_old_entries_stay_unmarked() {
        let mut fresh_event = event("0123456789abcdef");
        fresh_event["scheme"] = json!(2);
        let cleaned_event = clean_event(&fresh_event, &apps()).unwrap();
        assert_eq!(cleaned_event["scheme"], json!(2));

        let old_event = clean_event(&event("0123456789abcdef"), &apps()).unwrap();
        assert!(old_event.get("scheme").is_none());

        let fresh_vault = json!({
            "kind": "value",
            "type": "phone_number",
            "fp": "0123456789abcdef",
            "scheme": 2,
            "added": 1
        });
        assert_eq!(clean_vault_entry(&fresh_vault).unwrap()["scheme"], json!(2));

        let old_vault = json!({ "kind": "value", "type": "phone_number", "fp": "0123456789abcdef", "added": 1 });
        assert!(clean_vault_entry(&old_vault).unwrap().get("scheme").is_none());
    }

    #[test]
    fn events_with_a_value_where_a_name_or_fingerprint_goes_lose_it_or_are_dropped() {
        assert_eq!(
            clean_event(&event(CARD), &apps()).unwrap()["fp"],
            json!(""),
            "a card number is not a fingerprint"
        );
        assert_eq!(
            clean_event(&event("4111 1111 1111 1111"), &apps()).unwrap()["fp"],
            json!("")
        );
        let mut named = event("0123456789abcdef");
        named["name"] = json!(format!("Card {CARD}"));
        assert_eq!(clean_event(&named, &apps()), None);
        named["name"] = json!("someone@example.com");
        assert_eq!(clean_event(&named, &apps()), None);
        let mut kind = event("0123456789abcdef");
        kind["type"] = json!(PHONE);
        assert_eq!(clean_event(&kind, &apps()), None);
    }

    #[test]
    fn events_only_for_ai_apps_on_the_list_and_known_choices() {
        let mut e = event("0123456789abcdef");
        e["site"] = json!("app:thunderbird");
        assert_eq!(clean_event(&e, &apps()), None);
        e["site"] = json!("chatgpt.com");
        assert_eq!(clean_event(&e, &apps()), None);
        let mut a = event("0123456789abcdef");
        a["action"] = json!("mentioned");
        assert_eq!(clean_event(&a, &apps()), None, "no AI replies are read on Windows");
        assert!(clean_event(&event("0123456789abcdef"), &apps()).is_some());
    }

    #[test]
    fn vault_entries_are_fingerprints_or_formats_never_values() {
        let fp = json!({ "kind": "value", "type": "phone_number", "fp": "0123456789abcdef", "added": 1 });
        assert_eq!(clean_vault_entry(&fp).unwrap()["mode"], json!("protect"));
        let raw = json!({ "kind": "value", "type": "phone_number", "value": PHONE, "added": 1 });
        assert_eq!(clean_vault_entry(&raw), None);
        let shape_with_digits = json!({ "kind": "shape", "type": "my_id", "shape": "AB-1234##" });
        assert_eq!(clean_vault_entry(&shape_with_digits), None);
        let shape = json!({ "kind": "shape", "type": "my_id", "shape": "AB-####" });
        assert!(clean_vault_entry(&shape).is_some());
    }

    // ---------- Check my files' Ignore and Extension check's Keep it ----------

    #[test]
    fn a_scan_fingerprint_never_carries_the_path_or_id_it_was_made_from() {
        let path = r"C:\Users\test\Downloads\tax-notes.txt";
        let fp = scan_fingerprint("salt1", "file", path);
        assert_eq!(fp.len(), 16, "{fp}");
        assert!(fp.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(!fp.contains("tax") && !fp.to_lowercase().contains("downloads"));
        // Same salt, same value: the same fingerprint every time, so a later scan recognizes it.
        assert_eq!(fp, scan_fingerprint("salt1", "file", path));
        // A different salt, a different kind, or a different value: a different fingerprint.
        assert_ne!(fp, scan_fingerprint("salt2", "file", path));
        assert_ne!(fp, scan_fingerprint("salt1", "ext", path));
        assert_ne!(fp, scan_fingerprint("salt1", "file", r"C:\Users\test\Downloads\other.txt"));
    }

    #[test]
    fn ignoring_a_file_makes_the_next_scan_recognize_it_by_fingerprint_alone() {
        let dir = temp_dir("ignore");
        let mut store = Store::open(&dir).unwrap();
        let path = r"C:\Users\test\Downloads\tax-notes.txt";
        assert!(!store.is_scan_ignored("file", path));
        let fp = store.ignore_scan_item("file", path).unwrap();
        assert!(store.is_scan_ignored("file", path));
        assert!(!store.is_scan_ignored("ext", path), "a different list");
        assert!(!store.is_scan_ignored("file", r"C:\Users\test\Downloads\other.txt"));
        // The fingerprint on disk, never the path.
        let raw = fs::read_to_string(dir.join("store.json")).unwrap();
        assert!(raw.contains(&fp) && !raw.contains("tax-notes"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ignoring_the_same_file_twice_keeps_one_entry() {
        let dir = temp_dir("ignore-twice");
        let mut store = Store::open(&dir).unwrap();
        let path = r"C:\Users\test\Downloads\tax-notes.txt";
        store.ignore_scan_item("file", path).unwrap();
        store.ignore_scan_item("file", path).unwrap();
        assert_eq!(store.settings()["scanIgnored"].as_array().unwrap().len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_ignored_file_is_still_recognized_after_clotr_restarts() {
        let dir = temp_dir("ignore-reload");
        let path = r"C:\Users\test\Desktop\logins.txt";
        {
            let mut store = Store::open(&dir).unwrap();
            store.ignore_scan_item("file", path).unwrap();
        }
        let reopened = Store::open(&dir).unwrap();
        assert!(reopened.is_scan_ignored("file", path));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn undo_right_after_ignore_drops_only_that_fingerprint() {
        let dir = temp_dir("unignore");
        let mut store = Store::open(&dir).unwrap();
        let path = r"C:\Users\test\Downloads\tax-notes.txt";
        let other = r"C:\Users\test\Downloads\other.txt";
        store.ignore_scan_item("file", path).unwrap();
        store.ignore_scan_item("file", other).unwrap();
        assert!(store.is_scan_ignored("file", path));
        store.unignore_scan_item("file", path).unwrap();
        assert!(!store.is_scan_ignored("file", path), "undone");
        assert!(store.is_scan_ignored("file", other), "a different item, left alone");
        assert_eq!(store.settings()["scanIgnored"].as_array().unwrap().len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn undoing_an_item_never_on_the_list_does_nothing() {
        let dir = temp_dir("unignore-missing");
        let mut store = Store::open(&dir).unwrap();
        store.unignore_scan_item("file", r"C:\Users\test\Downloads\never-ignored.txt").unwrap();
        let count = store.settings()["scanIgnored"].as_array().map_or(0, Vec::len);
        assert_eq!(count, 0);
        let _ = fs::remove_dir_all(dir);
    }

    // ---------- Tell only what's new ----------

    #[test]
    fn a_find_is_new_once_and_never_again_after_that() {
        let dir = temp_dir("seen-once");
        let mut store = Store::open(&dir).unwrap();
        let path = r"C:\Users\test\Downloads\tax-notes.txt";
        let kinds = vec!["us_ssn".to_string()];
        assert!(store.note_scan_find(path, &kinds).unwrap(), "the first time, it's new");
        assert!(!store.note_scan_find(path, &kinds).unwrap(), "the same path and kinds again: not new");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_find_is_new_again_once_its_own_kinds_change() {
        let dir = temp_dir("seen-kinds-change");
        let mut store = Store::open(&dir).unwrap();
        let path = r"C:\Users\test\Downloads\notes.txt";
        assert!(store.note_scan_find(path, &["email".to_string()]).unwrap());
        assert!(!store.note_scan_find(path, &["email".to_string()]).unwrap());
        assert!(
            store.note_scan_find(path, &["email".to_string(), "password".to_string()]).unwrap(),
            "a password found in it since: a different fingerprint, so new again"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_finds_own_kinds_in_any_order_are_the_same_fingerprint() {
        let dir = temp_dir("seen-order");
        let mut store = Store::open(&dir).unwrap();
        let path = r"C:\Users\test\Downloads\notes.txt";
        assert!(store.note_scan_find(path, &["password".to_string(), "email".to_string()]).unwrap());
        assert!(!store.note_scan_find(path, &["email".to_string(), "password".to_string()]).unwrap());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_seen_fingerprint_never_carries_the_path_or_the_kinds_it_was_made_from() {
        let dir = temp_dir("seen-private");
        let mut store = Store::open(&dir).unwrap();
        store
            .note_scan_find(r"C:\Users\test\Downloads\tax-notes.txt", &["us_ssn".to_string()])
            .unwrap();
        let raw = fs::read_to_string(dir.join("store.json")).unwrap();
        assert!(!raw.contains("tax-notes") && !raw.to_lowercase().contains("ssn"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_seen_find_survives_a_restart() {
        let dir = temp_dir("seen-reload");
        let path = r"C:\Users\test\Desktop\logins.txt";
        {
            let mut store = Store::open(&dir).unwrap();
            store.note_scan_find(path, &["password".to_string()]).unwrap();
        }
        let mut reopened = Store::open(&dir).unwrap();
        assert!(!reopened.note_scan_find(path, &["password".to_string()]).unwrap());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn show_them_again_clears_every_ignored_item() {
        let dir = temp_dir("clear-ignored");
        let mut store = Store::open(&dir).unwrap();
        store.ignore_scan_item("file", r"C:\Users\test\Downloads\tax-notes.txt").unwrap();
        store.ignore_scan_item("ext", "exe").unwrap();
        assert_eq!(store.settings()["scanIgnored"].as_array().unwrap().len(), 2);
        store.clear_scan_ignored().unwrap();
        assert_eq!(store.settings()["scanIgnored"].as_array().unwrap().len(), 0);
        let _ = fs::remove_dir_all(dir);
    }

    // ---------- History's scan rows ----------

    fn scan_row(scan: &str) -> Value {
        json!({ "t": 1_700_000_000_000u64, "scan": scan, "items": 40, "seconds": 4, "counts": { "credit_card": 1 } })
    }

    #[test]
    fn a_scan_row_keeps_only_when_kind_count_and_counts_per_detail() {
        let clean = clean_scan_row(&scan_row("quick")).unwrap();
        let mut keys: Vec<&String> = clean.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["counts", "items", "scan", "seconds", "t"]);
        assert_eq!(clean["counts"], json!({ "credit_card": 1 }));
    }

    #[test]
    fn older_scan_rows_do_not_gain_a_fabricated_duration() {
        let mut row = scan_row("quick");
        row.as_object_mut().unwrap().remove("seconds");
        let clean = clean_scan_row(&row).unwrap();
        assert_eq!(clean.get("seconds"), None);
    }

    #[test]
    fn a_scan_row_never_carries_a_path_a_filename_or_a_detected_value() {
        let mut row = scan_row("full");
        row["path"] = json!(r"C:\Users\test\Downloads\tax-notes.txt");
        row["name"] = json!("tax-notes.txt");
        row["value"] = json!(CARD);
        let clean = clean_scan_row(&row).unwrap();
        let raw = serde_json::to_string(&clean).unwrap();
        assert!(!raw.contains("tax-notes") && !raw.contains(CARD));
    }

    #[test]
    fn a_scan_row_with_an_unknown_scan_or_detail_kind_is_dropped_or_trimmed() {
        let mut bad_scan = scan_row("folder");
        assert_eq!(clean_scan_row(&bad_scan), None);
        bad_scan["scan"] = json!("lookback");
        assert!(clean_scan_row(&bad_scan).is_some());
        let mut bad_kind = scan_row("quick");
        bad_kind["counts"] = json!({ "credit_card": 1, "not a kind!": 2 });
        assert_eq!(clean_scan_row(&bad_kind).unwrap()["counts"], json!({ "credit_card": 1 }));
    }

    #[test]
    fn recording_a_scan_row_adds_it_and_a_bad_one_is_refused() {
        let dir = temp_dir("scan-row");
        let mut store = Store::open(&dir).unwrap();
        assert!(store.record_scan(&scan_row("quick")).unwrap());
        assert_eq!(store.scans().as_array().unwrap().len(), 1);
        assert!(!store.record_scan(&scan_row("folder")).unwrap());
        assert_eq!(store.scans().as_array().unwrap().len(), 1);
        assert!(!store.settings().as_object().unwrap().contains_key("scans"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn scan_comparison_keeps_only_per_kind_count_changes() {
        let dir = temp_dir("scan-delta");
        let mut store = Store::open(&dir).unwrap();
        let mut first = scan_row("quick");
        first["counts"] = json!({ "credit_card": 3, "password": 1 });
        store.record_scan(&first).unwrap();
        let mut next = scan_row("quick");
        next["counts"] = json!({ "credit_card": 1, "phone": 2 });
        store.record_scan(&next).unwrap();
        let latest = store.scans().as_array().unwrap().last().unwrap().clone();
        assert_eq!(latest["added"], json!({ "phone": 2 }));
        assert_eq!(latest["gone"], json!({ "credit_card": 2, "password": 1 }));
        let raw = serde_json::to_string(&latest).unwrap();
        assert!(!raw.contains("tax") && !raw.contains(CARD));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn scan_rows_are_still_there_after_clotr_restarts_and_capped() {
        let dir = temp_dir("scan-row-reload");
        {
            let mut store = Store::open(&dir).unwrap();
            for _ in 0..(MAX_SCAN_ROWS + 10) {
                store.record_scan(&scan_row("quick")).unwrap();
            }
        }
        let reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.scans().as_array().unwrap().len(), MAX_SCAN_ROWS);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn clearing_history_clears_scan_rows_too() {
        let dir = temp_dir("scan-row-clear");
        let mut store = Store::open(&dir).unwrap();
        store.record_scan(&scan_row("quick")).unwrap();
        store.clear_history().unwrap();
        assert_eq!(store.scans(), json!([]));
        let _ = fs::remove_dir_all(dir);
    }

    // ---------- Tourniquet ----------

    #[test]
    fn tourniquet_keeps_only_its_own_two_shapes() {
        assert_eq!(
            clean_tourniquet(Some(&json!({ "for": "child", "since": 1000 }))),
            Some(json!({ "for": "child", "since": 1000 }))
        );
        assert_eq!(
            clean_tourniquet(Some(&json!({ "for": "adult", "since": 1000 }))),
            Some(json!({ "for": "adult", "since": 1000 }))
        );
        let day = 86_400_000u64;
        assert_eq!(
            clean_tourniquet(Some(&json!({ "for": "after_scam", "since": 1000, "until": 1000 + 30 * day }))),
            Some(json!({ "for": "after_scam", "since": 1000, "until": 1000 + 30 * day }))
        );
        assert_eq!(clean_tourniquet(None), None);
        assert_eq!(clean_tourniquet(Some(&Value::Null)), None);
    }

    #[test]
    fn tourniquet_rejects_an_unknown_word_a_stray_field_or_a_bad_end() {
        let day = 86_400_000u64;
        assert_eq!(clean_tourniquet(Some(&json!({ "for": "teen", "since": 1000 }))), None);
        assert_eq!(
            clean_tourniquet(Some(&json!({ "for": "child", "since": 1000, "until": 2000 }))),
            None,
            "until only belongs to after_scam"
        );
        assert_eq!(
            clean_tourniquet(Some(&json!({ "for": "after_scam", "since": 1000 }))),
            None,
            "after_scam needs an until"
        );
        assert_eq!(
            clean_tourniquet(Some(&json!({ "for": "after_scam", "since": 2000, "until": 1000 }))),
            None,
            "until before since"
        );
        assert_eq!(
            clean_tourniquet(Some(&json!({ "for": "after_scam", "since": 1000, "until": 1000 + 62 * day }))),
            None,
            "more than 61 days"
        );
    }

    #[test]
    fn a_bad_tourniquet_record_is_dropped_on_save_and_reload_without_touching_anything_else() {
        let dir = temp_dir("tourniquet");
        let mut store = Store::open(&dir).unwrap();
        store
            .save_settings(&json!({ "tourniquet": { "for": "nonsense" }, "largeText": true }), From::Settings)
            .unwrap();
        assert_eq!(store.settings().get("tourniquet"), None);
        assert_eq!(store.settings()["largeText"], json!(true));
        store
            .save_settings(&json!({ "tourniquet": { "for": "child", "since": 1000 } }), From::Settings)
            .unwrap();
        let reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.settings()["tourniquet"], json!({ "for": "child", "since": 1000 }));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn set_tourniquet_turns_it_on_and_a_bad_or_empty_value_turns_it_off() {
        let dir = temp_dir("set-tourniquet");
        let mut store = Store::open(&dir).unwrap();
        assert!(store.set_tourniquet(&json!({ "for": "adult", "since": 1000 })).unwrap());
        assert_eq!(store.settings()["tourniquet"], json!({ "for": "adult", "since": 1000 }));
        assert!(!store.set_tourniquet(&json!({ "for": "nonsense" })).unwrap());
        assert_eq!(store.settings().get("tourniquet"), None, "a bad value takes it off, not leaves the old one");
        store.set_tourniquet(&json!({ "for": "child", "since": 2000 })).unwrap();
        assert!(!store.set_tourniquet(&Value::Null).unwrap());
        assert_eq!(store.settings().get("tourniquet"), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_malformed_scan_ignored_entry_is_dropped_on_reload() {
        let s = json!({ "scanIgnored": [
            { "fp": "0123456789abcdef", "kind": "file" },
            { "fp": "not-hex-at-all!!", "kind": "file" },
            { "fp": "0123456789abcdef", "kind": "folder" },
            { "fp": "0123456789abcdef" },
        ] });
        let cleaned = clean_settings(&s, false);
        assert_eq!(
            cleaned["scanIgnored"],
            json!([{ "fp": "0123456789abcdef", "kind": "file" }])
        );
    }

    #[test]
    fn a_malformed_scan_seen_entry_is_dropped_on_reload() {
        let s = json!({ "scanSeen": ["0123456789abcdef", "not-hex-at-all!!", "0123456789abcdef"] });
        let cleaned = clean_settings(&s, false);
        assert_eq!(cleaned["scanSeen"], json!(["0123456789abcdef"]), "bad entries dropped, duplicates kept once");
    }

    #[test]
    fn settings_keep_known_keys_and_the_salt_only_from_a_move_file() {
        let s = json!({
            "responses": { "credit_card": "log", "phone_number": "maybe", "4111": "warn" },
            "pausedApps": { "claude": true, "chatgpt": false },
            "keepDays": 30,
            "largeText": true,
            "salt": "0123456789abcdef0123456789abcdef",
            "draft": CARD,
            "events": [event("0123456789abcdef")],
        });
        let plain = clean_settings(&s, false);
        assert_eq!(plain["responses"], json!({ "credit_card": "log" }));
        assert_eq!(plain["pausedApps"], json!({ "claude": true }));
        assert!(!plain.contains_key("keepDays") && !plain.contains_key("salt") && !plain.contains_key("draft"));
        assert!(!plain.contains_key("events"), "settings never carry history");
        assert_eq!(
            clean_settings(&s, true)["salt"],
            json!("0123456789abcdef0123456789abcdef")
        );
    }

    #[test]
    fn the_main_windows_own_settings_are_kept_only_as_their_named_choices() {
        let s = json!({
            "startWithWindows": true,
            "look": "dark",
            "motion": "still",
            "language": "es",
            "weeklyCheck": true,
            "notifyFind": false,
            "scanDevFiles": true,
        });
        let clean = clean_settings(&s, false);
        assert_eq!(clean["startWithWindows"], json!(true));
        assert_eq!(clean["look"], json!("dark"));
        assert_eq!(clean["motion"], json!("still"));
        assert_eq!(clean["language"], json!("es"));
        assert_eq!(clean["weeklyCheck"], json!(true));
        assert_eq!(clean["notifyFind"], json!(false));
        assert_eq!(clean["scanDevFiles"], json!(true));

        let hostile = json!({
            "look": "<script>",
            "motion": "smooth",
            "language": "fr",
            "startWithWindows": "yes",
            "weeklyCheck": 1,
            "notifyFind": "true",
            "scanDevFiles": "no",
        });
        let dropped = clean_settings(&hostile, false);
        for key in [
            "look",
            "motion",
            "language",
            "startWithWindows",
            "weeklyCheck",
            "notifyFind",
            "scanDevFiles",
        ] {
            assert!(!dropped.contains_key(key), "{key}");
        }
    }

    #[test]
    fn plan_ticked_keeps_only_known_step_ids_deduped_and_capped() {
        let s = json!({ "planTicked": ["keys", "money", "keys", "not-a-step", 7, "idPhotos"] });
        let clean = clean_settings(&s, false);
        assert_eq!(clean["planTicked"], json!(["keys", "money", "idPhotos"]));
    }

    #[test]
    fn plan_ticked_survives_a_round_trip_through_the_store() {
        let dir = temp_dir("plan-ticked");
        let mut store = Store::open(&dir).unwrap();
        store
            .save_settings(&json!({ "planTicked": ["keys", "idDocs"] }), From::Settings)
            .unwrap();
        drop(store);
        let reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.settings()["planTicked"], json!(["keys", "idDocs"]));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn results_mode_keeps_only_guided_or_detailed() {
        assert_eq!(
            clean_settings(&json!({ "resultsMode": "guided" }), false)["resultsMode"],
            json!("guided")
        );
        assert_eq!(
            clean_settings(&json!({ "resultsMode": "detailed" }), false)["resultsMode"],
            json!("detailed")
        );
        assert!(!clean_settings(&json!({ "resultsMode": "verbose" }), false).contains_key("resultsMode"));
        assert!(!clean_settings(&json!({ "resultsMode": 1 }), false).contains_key("resultsMode"));
    }

    #[test]
    fn helper_name_is_trimmed_and_capped_never_rejected() {
        let clean = clean_settings(&json!({ "helperName": "  Sam  " }), false);
        assert_eq!(clean["helperName"], json!("Sam"));
        let empty = clean_settings(&json!({ "helperName": "   " }), false);
        assert_eq!(empty["helperName"], json!(""));
        let long = "a".repeat(200);
        let capped = clean_settings(&json!({ "helperName": long }), false);
        assert_eq!(capped["helperName"].as_str().unwrap().chars().count(), 60);
        assert!(!clean_settings(&json!({ "helperName": 7 }), false).contains_key("helperName"));
    }

    #[test]
    fn results_mode_and_helper_name_survive_a_round_trip_through_the_store() {
        let dir = temp_dir("results-mode");
        let mut store = Store::open(&dir).unwrap();
        store
            .save_settings(&json!({ "resultsMode": "guided", "helperName": "Sam" }), From::Settings)
            .unwrap();
        drop(store);
        let reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.settings()["resultsMode"], json!("guided"));
        assert_eq!(reopened.settings()["helperName"], json!("Sam"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn savanna_plum_is_migrated_to_plum() {
        let s = json!({ "look": "savanna" });
        assert_eq!(clean_settings(&s, false)["look"], json!("plum"));
    }

    #[test]
    fn current_named_looks_are_kept_and_unknown_looks_are_dropped() {
        for look in ["plum", "ember"] {
            assert_eq!(clean_settings(&json!({ "look": look }), false)["look"], json!(look));
        }
        assert!(!clean_settings(&json!({ "look": "unknown" }), false).contains_key("look"));
    }

    #[test]
    fn the_file_never_holds_a_planted_value_after_hostile_writes() {
        let dir = temp_dir("planted");
        let mut store = Store::open(&dir).unwrap();
        let mut e = event(CARD);
        e["name"] = json!("Credit Card Number");
        e["extra"] = json!(CARD);
        store
            .record(
                &json!([e, { "t": 1, "site": "app:claude", "type": "phone_number", "name": PHONE,
                                   "severity": "high", "action": "allowed", "fp": PHONE }]),
                &apps(),
            )
            .unwrap();
        store.set_responses(&json!([CARD, "credit_card"]), "log").unwrap();
        store
            .save_settings(
                &json!({ "vault": [{ "kind": "value", "type": "phone_number", "value": PHONE }],
                                    "guided": { PHONE: 1 }, "note": CARD }),
                From::Settings,
            )
            .unwrap();
        let text = fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(!text.contains(CARD) && !text.contains(PHONE), "{text}");
        let _ = fs::remove_dir_all(dir);
    }

    /// The shared move file (tests/fixtures/): what the settings page brings from it (the keys the app keeps,
    /// apps/desktop/ui/move-file.js) is stored as it is, salt included, and nothing else is.
    #[test]
    fn the_shared_move_file_is_kept_as_brought() {
        let fixture: Value = serde_json::from_str(include_str!("../../../../tests/fixtures/move-file.json")).unwrap();
        let sealed = &fixture["settings"];
        let mut brought = Map::new();
        for k in ["responses", "guided", "keepDays", "largeText", "salt", "vault"] {
            brought.insert(k.into(), sealed[k].clone());
        }
        let dir = temp_dir("move");
        let mut store = Store::open(&dir).unwrap();
        store
            .save_settings(&Value::Object(brought.clone()), From::MoveFile)
            .unwrap();
        let kept = Store::open(&dir).unwrap().settings();
        for k in ["responses", "guided", "keepDays", "largeText", "salt", "vault"] {
            assert_eq!(kept[k], brought[k], "{k}");
        }
        for browser_only in ["paused", "siteModes", "lock", "bandage", "tourniquet"] {
            assert!(kept.get(browser_only).is_none(), "{browser_only}");
        }
        let mut plain = Store::open(&temp_dir("move-plain")).unwrap();
        let before = plain.settings()["salt"].clone();
        plain.save_settings(&Value::Object(brought), From::Settings).unwrap();
        assert_eq!(
            plain.settings()["salt"],
            before,
            "the main window can't change the salt"
        );
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(temp_dir("move-plain"));
    }

    #[test]
    fn history_older_than_keep_days_goes() {
        let dir = temp_dir("prune");
        let mut store = Store::open(&dir).unwrap();
        store.save_settings(&json!({ "keepDays": 90 }), From::Settings).unwrap();
        let now = now_ms();
        let old = json!({ "t": now - 100 * DAY_MS, "site": "app:claude", "type": "email", "name": "Email Address",
                          "severity": "medium", "action": "allowed", "fp": "" });
        let new = json!({ "t": now, "site": "app:claude", "type": "email", "name": "Email Address",
                          "severity": "medium", "action": "allowed", "fp": "" });
        assert_eq!(store.record(&json!([old, new]), &apps()).unwrap(), 2);
        assert_eq!(store.events().as_array().unwrap().len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    /// The move file's own success message lists what changed, in counts and names, never values -- so this
    /// only surfaces a field when the store's settings actually differ before and after, never the salt or guided
    /// (neither means anything to the person), and says nothing changed when nothing did.
    #[test]
    fn brought_summary_lists_only_what_actually_changed() {
        let before = json!({
            "responses": { "email": "warn" },
            "vault": [{ "kind": "value", "type": "phone_number", "value": "1" }],
            "largeText": false,
            "keepDays": 365,
            "salt": "aaaa",
            "guided": { "email": 1 },
        });
        let after = json!({
            "responses": { "email": "warn", "phone_number": "block" },
            "vault": [{ "kind": "value", "type": "phone_number", "value": "1" },
                      { "kind": "value", "type": "email", "value": "2" }],
            "largeText": true,
            "keepDays": 365,
            "salt": "bbbb",
            "guided": { "email": 5 },
        });
        let brought = brought_summary(&before, &after);
        assert_eq!(brought["changed"], json!(true));
        assert_eq!(brought["parts"]["responses"], json!(2), "a count of kinds, never which ones");
        assert_eq!(brought["parts"]["vault"], json!(2));
        assert_eq!(brought["parts"]["largeText"], json!(true));
        assert!(brought["parts"].get("keepDays").is_none(), "unchanged, so left out");
        assert!(brought["parts"].get("salt").is_none(), "never surfaced");
        assert!(brought["parts"].get("guided").is_none(), "never surfaced");
    }

    #[test]
    fn brought_summary_says_nothing_changed_when_everything_already_matched() {
        let same = json!({ "responses": { "email": "warn" }, "vault": [], "largeText": false, "keepDays": 90 });
        let brought = brought_summary(&same, &same);
        assert_eq!(brought["changed"], json!(false));
        assert_eq!(brought["parts"], json!({}));
    }

    #[test]
    fn a_full_scan_record_entry_is_only_a_key_a_stamp_and_the_look_bit_never_a_value_kind_or_fingerprint() {
        // Read against the real source, the way PRIVACY.md's promises are checked (desktop-privacy.test.js): if
        // `Baseline`'s entry type ever grows a field, this fails loudly rather than silently widening what the
        // bit is allowed to carry.
        let source = include_str!("store.rs");
        assert!(
            source.contains("entries: Vec<(u64, u64, bool)>"),
            "a Full scan record entry must stay exactly a key, a stamp and the look bit, nothing else"
        );
        // And the bytes on disk match that shape exactly: no slack room for a kind byte or a fingerprint's worth
        // of extra bytes (a fingerprint alone, as used elsewhere for history, is 32 bytes on its own).
        let entries: Vec<(u64, u64, bool)> = (0..50).map(|i| (i, i * 2, i % 3 == 0)).collect();
        let raw = Baseline::new(1, entries.clone()).encode();
        assert_eq!(raw.len(), 24 + entries.len() * 17);
        let back = Baseline::decode(&raw).unwrap();
        for (key, stamp, flag) in &entries {
            assert_eq!(back.flagged(*key), *flag);
            assert!(back.unchanged(*key, *stamp));
        }
    }

    #[test]
    fn the_full_scan_record_round_trips_and_holds_keys_stamps_and_the_look_bit_only() {
        let dir = temp_dir("baseline");
        let store = Store::open(&dir).unwrap();
        assert!(store.baseline().is_none() && store.baseline_summary().is_none(), "no Full scan yet");
        let salt = store.scan_salt();
        let path = Path::new(r"C:\Users\test\Downloads\tax-notes.txt");
        let key = baseline_key(&salt, path);
        let stamp = baseline_stamp(51, 133_000_000_000_000_000);
        store
            .save_baseline(&Baseline::new(1_760_000_000_000, vec![(key, stamp, true), (7, 9, false), (key, stamp, true)]))
            .unwrap();
        let back = store.baseline().unwrap();
        assert_eq!(back.at, 1_760_000_000_000);
        assert_eq!(back.len(), 2, "one entry a file");
        assert!(back.unchanged(key, stamp));
        assert!(back.flagged(key), "it had something worth a look");
        assert!(!back.flagged(7), "this one didn't");
        assert!(!back.flagged(9), "a key never recorded");
        assert!(!back.unchanged(key, baseline_stamp(52, 133_000_000_000_000_000)), "a new size is a change");
        assert!(!back.unchanged(key, baseline_stamp(51, 133_000_000_000_000_001)), "a new time is a change");
        assert!(!back.unchanged(8, 9), "a file the Full scan never saw");
        assert_eq!(store.baseline_summary(), Some((1_760_000_000_000, 2)));
        // On disk: 24 bytes of header and 17 a file (one more than v1's 16, for the bit), and nothing of the path.
        let raw = fs::read(dir.join("scan-baseline.bin")).unwrap();
        assert_eq!(raw.len(), 24 + 2 * 17);
        assert_eq!(&raw[..8], b"CLOTRBL2");
        assert!(!String::from_utf8_lossy(&raw).to_lowercase().contains("tax-notes"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_v1_baseline_on_disk_reads_fine_with_every_bit_unset_and_re_saves_as_v2() {
        let dir = temp_dir("baseline-v1");
        let store = Store::open(&dir).unwrap();
        // A v1 record written by hand, the shape the app wrote before the look bit existed: magic, at, count, then
        // 16 bytes a file (no bit).
        let mut raw = Vec::new();
        raw.extend_from_slice(b"CLOTRBL1");
        raw.extend_from_slice(&7u64.to_le_bytes()); // at
        raw.extend_from_slice(&2u64.to_le_bytes()); // count
        for (key, stamp) in [(3u64, 30u64), (9u64, 90u64)] {
            raw.extend_from_slice(&key.to_le_bytes());
            raw.extend_from_slice(&stamp.to_le_bytes());
        }
        fs::write(dir.join("scan-baseline.bin"), &raw).unwrap();
        let back = store.baseline().unwrap();
        assert_eq!(back.at, 7);
        assert_eq!(back.len(), 2);
        assert!(back.unchanged(3, 30) && back.unchanged(9, 90));
        assert!(!back.flagged(3) && !back.flagged(9), "the bit starts unset on a migrated v1 record");
        assert_eq!(store.baseline_summary(), Some((7, 2)), "the summary reads a v1 header too");
        // Saving again (the first v2 Full) writes the v2 shape from here on.
        store.save_baseline(&back).unwrap();
        let re_read = fs::read(dir.join("scan-baseline.bin")).unwrap();
        assert_eq!(&re_read[..8], b"CLOTRBL2");
        assert_eq!(re_read.len(), 24 + 2 * 17);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_damaged_record_is_no_record() {
        let dir = temp_dir("baseline-damaged");
        let store = Store::open(&dir).unwrap();
        store.save_baseline(&Baseline::new(1, vec![(1, 1, false), (2, 2, false)])).unwrap();
        let file = dir.join("scan-baseline.bin");
        let mut raw = fs::read(&file).unwrap();
        raw.pop();
        fs::write(&file, &raw).unwrap();
        assert!(store.baseline().is_none(), "cut short");
        let mut raw = Baseline::new(1, vec![(1, 1, false), (2, 2, false)]).encode();
        raw[24..32].copy_from_slice(&5u64.to_le_bytes());
        fs::write(&file, &raw).unwrap();
        assert!(store.baseline().is_none(), "keys out of order");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn clearing_history_or_showing_ignored_files_again_also_forgets_the_full_scan_record() {
        let dir = temp_dir("baseline-clear");
        let mut store = Store::open(&dir).unwrap();
        store.save_baseline(&Baseline::new(1, vec![(1, 1, false)])).unwrap();
        store.clear_history().unwrap();
        assert!(store.baseline().is_none() && store.baseline_summary().is_none());
        store.save_baseline(&Baseline::new(1, vec![(1, 1, false)])).unwrap();
        store.clear_scan_ignored().unwrap();
        assert!(store.baseline().is_none());
        store.clear_history().unwrap(); // nothing left to remove is still fine
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_files_record_key_is_salted_and_ignores_case() {
        let path = Path::new(r"C:\Users\test\Downloads\Notes.txt");
        assert_eq!(baseline_key("s1", path), baseline_key("s1", Path::new(r"c:\users\test\downloads\notes.txt")));
        assert_ne!(baseline_key("s1", path), baseline_key("s2", path));
        assert_ne!(baseline_key("s1", path), baseline_key("s1", Path::new(r"C:\Users\test\Downloads\Other.txt")));
    }

    #[test]
    fn the_ignored_files_a_walk_checks_are_the_ones_ignore_made() {
        let dir = temp_dir("ignored-files");
        let mut store = Store::open(&dir).unwrap();
        let path = r"C:\Users\test\Downloads\tax-notes.txt";
        assert!(!store.ignored_files().contains(Path::new(path)));
        store.ignore_scan_item("file", path).unwrap();
        store.ignore_scan_item("ext", "abcdef").unwrap();
        let ignored = store.ignored_files();
        assert!(ignored.contains(Path::new(path)));
        assert!(!ignored.contains(Path::new(r"C:\Users\test\Downloads\other.txt")));
        assert!(!ignored.contains(Path::new("abcdef")), "an extension's entry isn't a file's");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn leave_out_keeps_the_chosen_path_and_never_hands_it_to_a_page() {
        let dir = temp_dir("exclude");
        let mut store = Store::open(&dir).unwrap();
        let folder = r"C:\Users\test\Desktop\Clotr\.claude\worktrees";
        let id = store.add_exclusion("folder", folder).unwrap().expect("an absolute path fits");
        assert_eq!(store.add_exclusion("folder", folder).unwrap(), Some(id.clone()), "the same one twice is one");
        store.add_exclusion("type", "LOG").unwrap().expect("a type, with or without its dot");
        store.add_exclusion("file", r"C:\Users\test\Documents\corpus.jsonl").unwrap();
        assert_eq!(store.add_exclusion("folder", r"relative\path").unwrap(), None, "only an absolute path");
        assert_eq!(store.add_exclusion("type", ".no way").unwrap(), None, "a type is letters and digits");
        assert_eq!(store.add_exclusion("drive", r"C:\").unwrap(), None, "only the three kinds");

        let settings = serde_json::to_string(&store.settings()).unwrap();
        assert!(!settings.contains("worktrees") && !settings.contains("scanExcluded"), "never in a page's settings");
        let view = store.exclusions_view();
        assert_eq!(view.as_array().unwrap().len(), 3);
        assert_eq!(view[0]["name"], json!("worktrees"));
        assert_eq!(view[0]["parent"], json!(".claude"));
        assert_eq!(view[1]["name"], json!(".log"));
        assert!(!view.to_string().contains(r"C:\\Users"), "names and parents only");

        let ex = store.exclusions();
        assert!(ex.folder(Path::new(r"c:\users\TEST\desktop\clotr\.claude\worktrees")));
        assert!(ex.folder(Path::new(r"C:\Users\test\Desktop\Clotr\.claude\worktrees\ap-1\src")), "and inside it");
        assert!(!ex.folder(Path::new(r"C:\Users\test\Desktop\Clotr\.claude\worktrees-old")), "a name that only starts the same");
        assert!(ex.file(Path::new(r"C:\x\app.log"), "log"));
        assert!(ex.file(Path::new(r"C:\Users\test\Documents\CORPUS.jsonl"), "jsonl"));
        assert!(!ex.file(Path::new(r"C:\Users\test\Documents\notes.jsonl"), "jsonl"));

        // Kept across a restart, and through Clear history and Show them again: the person chose these.
        store.clear_history().unwrap();
        store.clear_scan_ignored().unwrap();
        let mut reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.exclusions_view().as_array().unwrap().len(), 3);
        // A page saving settings can't add one either.
        reopened
            .save_settings(&json!({ "scanExcluded": [{ "kind": "folder", "value": r"C:\Windows" }] }), From::Settings)
            .unwrap();
        assert_eq!(reopened.exclusions_view().as_array().unwrap().len(), 3);

        assert!(reopened.remove_exclusion(&id).unwrap());
        assert!(!reopened.remove_exclusion(&id).unwrap(), "already gone");
        assert!(!reopened.exclusions().folder(Path::new(folder)));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn was_this_right_answers_round_trip_as_counts_a_kind_and_tier_pair_only() {
        let dir = temp_dir("accuracy");
        let mut store = Store::open(&dir).unwrap();
        assert_eq!(store.accuracy_answers(), json!([]));
        assert!(store.record_accuracy_answer("password", "yours", true).unwrap());
        assert!(store.record_accuracy_answer("password", "yours", true).unwrap());
        assert!(store.record_accuracy_answer("password", "yours", false).unwrap());
        assert!(store.record_accuracy_answer("card", "secret", true).unwrap());
        // An unknown kind or tier is refused, never stored loosely.
        assert!(!store.record_accuracy_answer("made-up", "yours", true).unwrap());
        assert!(!store.record_accuracy_answer("password", "made-up", true).unwrap());

        let view = store.accuracy_answers();
        let rows = view.as_array().unwrap();
        assert_eq!(rows.len(), 2, "one row a kind-tier pair, not one an answer");
        let pw = rows.iter().find(|r| r["kind"] == json!("password")).unwrap();
        assert_eq!(pw["tier"], json!("yours"));
        assert_eq!(pw["yes"], json!(2));
        assert_eq!(pw["no"], json!(1));
        let card = rows.iter().find(|r| r["kind"] == json!("card")).unwrap();
        assert_eq!(card["tier"], json!("secret"));
        assert_eq!(card["yes"], json!(1));
        assert_eq!(card["no"], json!(0));
        assert!(!store.settings().to_string().contains("accuracy"), "its own call carries it, not settings");

        // Survives a restart.
        let reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.accuracy_answers().as_array().unwrap().len(), 2);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn clear_accuracy_answers_empties_them_without_touching_history() {
        let dir = temp_dir("accuracy-clear");
        let mut store = Store::open(&dir).unwrap();
        store.record_accuracy_answer("key", "project", true).unwrap();
        store.record_scan(&scan_row("quick")).unwrap();
        store.clear_accuracy_answers().unwrap();
        assert_eq!(store.accuracy_answers(), json!([]));
        assert_eq!(store.scans().as_array().unwrap().len(), 1, "Clear history and this stay apart");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_accuracy_answer_never_carries_a_file_a_name_a_place_or_a_value() {
        let dir = temp_dir("accuracy-export");
        let mut store = Store::open(&dir).unwrap();
        store.record_accuracy_answer("email", "project", true).unwrap();
        store.record_accuracy_answer("id", "secret", false).unwrap();
        let raw = store.accuracy_answers().to_string();
        for field in ["path", "name", "file", "place", "value", "folder", "fp", "t"] {
            assert!(!raw.contains(&format!("\"{field}\"")), "{field} has no business in an accuracy row");
        }
        let _ = fs::remove_dir_all(dir);
    }
}
