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

#[path = "stored_value_checks.rs"]
mod stored_value_checks;
pub use stored_value_checks::*;

// ---------- What's kept, where, and how much ----------

const FILE: &str = "store.json";
/// The last Full scan's record, beside the store (its own file: it can hold a key per file on the PC, which the
/// store's JSON, written whole on every change, shouldn't carry).
const BASELINE_FILE: &str = "scan-baseline.bin";
/// A key, a stamp and one bit a file ("this file had something worth a look", so a changes-only Full can re-read
/// just those files and keep Results complete). v3 has v2's layout under a new magic: Clotr reads files the version
/// that wrote a v1 or v2 record couldn't (UTF-16 text, sign-in files like .pgpass), so a file that record calls
/// unchanged may never have been read. The magic moves on again whenever Clotr starts reading something new.
const BASELINE_MAGIC: &[u8; 8] = b"CLOTRBL3";
/// Records an older version wrote. No scan goes by one (`Baseline::decode` refuses it), but its header still says
/// when and how many for Settings, and lets the Scan screen say why this scan reads everything.
const BASELINE_MAGICS_OLD: [&[u8; 8]; 2] = [b"CLOTRBL1", b"CLOTRBL2"];
const DEFAULT_KEEP_DAYS: u64 = 365;
const DAY_MS: u64 = 86_400_000;
const MAX_EVENTS: usize = 20_000;
const MAX_SCAN_IGNORED: usize = 5_000;
const MAX_SCAN_SEEN: usize = 5_000;
const MAX_SCAN_EXCLUDED: usize = 500;
const MAX_SCAN_ROWS: usize = 500;
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
/// The settings One Clotr shares with the browser extension, each with the time it last changed here.
const SHARED_SETTINGS: [&str; 7] =
    ["responses", "largeText", "keepDays", "tourniquet", "replyCheck", "commandCheck", "advanced"];

/// The store as it's open: its file's path and everything in it, already cleaned.
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

// ---------- What open() keeps from the file ----------

/// As many AI app ids as `seenApps` ever keeps: far more than the built-in list will hold.
const MAX_SEEN_APPS: usize = 64;

/// The file's JSON, or null when it's missing or broken.
fn read_store_file(path: &Path) -> Value {
    let Ok(bytes) = fs::read(path) else {
        return Value::Null;
    };
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

/// A timed pause ("Pause for an hour") keeps its deadline; one that passed while Clotr wasn't running
/// ends here, rather than coming back as a pause with no end.
fn keep_pause(raw: &Value, data: &mut Map<String, Value>) {
    if raw.get("pausedAll") != Some(&Value::Bool(true)) {
        return;
    }
    let until = raw.get("pausedUntil").and_then(Value::as_i64);
    if until.is_some_and(|until| until <= now_ms() as i64) {
        return;
    }
    data.insert("pausedAll".into(), Value::Bool(true));
    if let Some(until) = until {
        data.insert("pausedUntil".into(), json!(until));
    }
}

/// What only Clotr itself writes: the one-time notes, the apps seen in front and the weekly check's last result.
fn keep_own_marks(raw: &Value, data: &mut Map<String, Value>) {
    for note in Once::ALL {
        if raw.get(note.key()) == Some(&Value::Bool(true)) {
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
}

/// History, the scan rows, what's left out of scans and the "Was this right?" counts, each checked row by row.
fn keep_lists(raw: &Value, data: &mut Map<String, Value>) {
    let events = cleaned_rows(raw.get("events"), clean_stored_event);
    data.insert("events".into(), Value::Array(events));
    let scans = cleaned_rows(raw.get("scans"), clean_scan_row);
    data.insert("scans".into(), Value::Array(scans));
    data.insert("scanExcluded".into(), Value::Array(clean_exclusions(raw.get("scanExcluded"))));
    let accuracy = cleaned_rows(raw.get("accuracy"), clean_accuracy_row);
    data.insert("accuracy".into(), Value::Array(accuracy));
}

/// Every row of a list that passes `clean`, or none when it isn't a list.
fn cleaned_rows(raw: Option<&Value>, clean: fn(&Value) -> Option<Value>) -> Vec<Value> {
    let Some(list) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter().filter_map(clean).collect()
}

/// `seenApps` as read back: app ids only, each once, in the order first seen.
fn clean_seen_apps(raw: Option<&Value>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for id in raw.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        if is_app_id(id) && !seen.iter().any(|known| known == id) && seen.len() < MAX_SEEN_APPS {
            seen.push(id.to_string());
        }
    }
    seen
}

/// Each kind whose count in `to` is above its count in `from`, by how much: the kinds a scan added, or (the other
/// way round) the ones gone since the last scan of its kind.
fn count_rises(from: Option<&Map<String, Value>>, to: Option<&Map<String, Value>>) -> Map<String, Value> {
    let mut rises = Map::new();
    let Some(to) = to else {
        return rises;
    };
    for (kind, count) in to {
        let earlier = from.and_then(|counts| counts.get(kind)).and_then(Value::as_u64).unwrap_or(0);
        let rise = count.as_u64().unwrap_or(0).saturating_sub(earlier);
        if rise > 0 {
            rises.insert(kind.clone(), json!(rise));
        }
    }
    rises
}

/// An entry of the ignored list for this fingerprint, on this list ("file" or "ext").
fn is_ignored_as(entry: &Value, fp: &str, kind: &str) -> bool {
    let same_fp = entry.get("fp").and_then(Value::as_str) == Some(fp);
    same_fp && entry.get("kind") == Some(&json!(kind))
}

/// One exclusion as Settings lists it: an id, the kind, and a folder's or file's own name with its parent's.
fn exclusion_for_settings(salt: &str, entry: &Value) -> Value {
    let kind = entry.get("kind").and_then(Value::as_str).unwrap_or("");
    let value = entry.get("value").and_then(Value::as_str).unwrap_or("");
    let (name, parent) = if kind == "type" {
        (value.to_string(), Value::Null)
    } else {
        let (name, parent) = name_and_parent(Path::new(value));
        (name, json!(parent))
    };
    json!({ "id": exclusion_id(salt, entry), "kind": kind, "name": name, "parent": parent })
}

impl Store {
    // ---------- Opening ----------

    /// The store in `dir`, as it was left. A missing or broken file starts fresh; whatever was there goes through
    /// the same checks as anything new. A salt is made the first time (32 hex characters from the system's secure
    /// random), so fingerprints work from the start.
    pub fn open(dir: &Path) -> io::Result<Store> {
        fs::create_dir_all(dir)?;
        let path = dir.join(FILE);
        let raw = read_store_file(&path);
        let mut data = clean_settings(&raw, true);
        keep_pause(&raw, &mut data);
        keep_own_marks(&raw, &mut data);
        keep_lists(&raw, &mut data);
        let mut store = Store { path, data };
        if !store.data.contains_key("salt") {
            store.data.insert("salt".into(), Value::String(new_salt()?));
        }
        store.prune(now_ms());
        store.write()?;
        Ok(store)
    }

    // ---------- What the pages read ----------

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

    // ---------- Pause and the typing check ----------

    pub fn paused_all(&self) -> bool {
        self.data.get("pausedAll") == Some(&Value::Bool(true))
    }

    pub fn app_paused(&self, id: &str) -> bool {
        self.data.get("pausedApps").and_then(|paused| paused.get(id)) == Some(&Value::Bool(true))
    }

    /// "Check what I type in AI apps": on unless the person switched it off.
    pub fn typing_check(&self) -> bool {
        self.data.get("typingCheck") != Some(&Value::Bool(false))
    }

    /// A plain pause or resume: either way, no deadline (`set_paused_until` adds one for a timed pause).
    pub fn set_paused_all(&mut self, on: bool) -> io::Result<()> {
        if on {
            self.data.insert("pausedAll".into(), Value::Bool(true));
        } else {
            self.data.remove("pausedAll");
        }
        self.data.remove("pausedUntil");
        self.write()
    }

    /// When a timed pause ends, in milliseconds since the epoch: None for a plain pause or no pause.
    pub fn paused_until(&self) -> Option<i64> {
        self.data.get("pausedUntil").and_then(Value::as_i64)
    }

    /// The deadline of the timed pause just started (after `set_paused_all(true)`), kept so a restart within the
    /// hour still ends it on time.
    pub fn set_paused_until(&mut self, until: i64) -> io::Result<()> {
        self.data.insert("pausedUntil".into(), json!(until));
        self.write()
    }

    // ---------- One-time notes and the apps seen in front ----------

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
        if !is_app_id(id) || seen.iter().any(|known| known == id) || seen.len() >= MAX_SEEN_APPS {
            return Ok(false);
        }
        seen.push(id.to_string());
        self.data.insert("seenApps".into(), json!(seen));
        self.write()?;
        Ok(true)
    }

    // ---------- The weekly check ----------

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
        let find = json!({ "new": new_count, "still": still_count });
        self.data.insert("lastWeeklyFind".into(), find);
        self.write()
    }

    /// Everything the last weekly check found that the person hasn't dealt with yet, new and still-here together
    /// -- so a restart can tell Home there's something worth a look without re-running the check.
    pub fn weekly_find_total(&self) -> u64 {
        let find = self.data.get("lastWeeklyFind");
        let count = |key: &str| find.and_then(|counts| counts.get(key)).and_then(Value::as_u64).unwrap_or(0);
        count("new") + count("still")
    }

    // ---------- History ----------

    /// History records from the card, for the apps on the list. Returns how many were kept.
    pub fn record(&mut self, events: &Value, apps: &[String]) -> io::Result<usize> {
        let fresh: Vec<Value> = events
            .as_array()
            .map(|list| list.iter().filter_map(|event| clean_event(event, apps)).collect())
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
        if let Value::Array(rows) = list {
            // Beside the last scan of the same kind: which kinds it found more of, and which fewer.
            let scan = clean["scan"].as_str().unwrap_or_default();
            if let Some(previous) = rows.iter().rev().find(|old| old["scan"].as_str() == Some(scan)) {
                let before = previous["counts"].as_object();
                let after = clean["counts"].as_object();
                let added = count_rises(before, after);
                let gone = count_rises(after, before);
                clean["added"] = Value::Object(added);
                clean["gone"] = Value::Object(gone);
            }
            rows.push(clean);
            if rows.len() > MAX_SCAN_ROWS {
                let extra = rows.len() - MAX_SCAN_ROWS;
                rows.drain(..extra);
            }
        }
        self.write()?;
        Ok(true)
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
        let Some(Value::Array(list)) = self.data.get_mut("events") else {
            return;
        };
        list.retain(|event| event.get("t").and_then(Value::as_f64).is_some_and(|time| time >= cutoff as f64));
        if list.len() > MAX_EVENTS {
            let extra = list.len() - MAX_EVENTS;
            list.drain(..extra);
        }
    }

    // ---------- Tourniquet and each kind's response ----------

    /// Turning Tourniquet on or off from Protection's own switch: a valid record replaces whatever was there,
    /// anything else (off, or a bad value) takes it off, the same as `set_paused_all` always means what it says
    /// rather than leaving an old record quietly in force. Returns whether it's on now.
    pub fn set_tourniquet(&mut self, raw: &Value) -> io::Result<bool> {
        let Some(tourniquet) = clean_tourniquet(Some(raw)) else {
            if self.data.remove("tourniquet").is_some() {
                self.write()?;
            }
            let _ = self.write_one_clotr_timestamps(&["tourniquet".into()]);
            return Ok(false);
        };
        self.data.insert("tourniquet".into(), tourniquet);
        self.write()?;
        let _ = self.write_one_clotr_timestamps(&["tourniquet".into()]);
        Ok(true)
    }

    /// One kind's response, from a choice in the card ("Leave it alone, and stop warning me about…").
    pub fn set_responses(&mut self, kinds: &Value, response: &str) -> io::Result<usize> {
        if !matches!(response, "block" | "warn" | "log") {
            return Ok(0);
        }
        let kinds: Vec<&str> = kinds
            .as_array()
            .map(|list| list.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let responses = self.data.entry("responses").or_insert_with(|| json!({}));
        let mut count = 0;
        if let Value::Object(map) = responses {
            for kind in kinds.into_iter().filter(|kind| is_kind(kind)).take(64) {
                map.insert(kind.into(), Value::String(response.into()));
                count += 1;
            }
        }
        if count > 0 {
            self.write()?;
            let _ = self.write_one_clotr_timestamps(&["responses".into()]);
        }
        Ok(count)
    }

    // ---------- The ignored and seen lists ----------

    fn salt(&self) -> String {
        self.data.get("salt").and_then(Value::as_str).unwrap_or("").to_string()
    }

    /// The salt a scan keys its record with: the store's own, so a Quick scan matches what the Full one kept.
    pub fn scan_salt(&self) -> String {
        self.salt()
    }

    /// *Ignore* on a file card, or (later) *Keep it* on an extension card: never the path or
    /// the id itself, only its fingerprint, so a later scan can skip it again without Clotr keeping what it found.
    /// `kind` names the list the fingerprint belongs to ("file" or "ext"), not the kind of detail found.
    pub fn ignore_scan_item(&mut self, kind: &str, value: &str) -> io::Result<String> {
        let fp = scan_fingerprint(&self.salt(), kind, value);
        let list = self.data.entry("scanIgnored").or_insert_with(|| json!([]));
        if let Value::Array(entries) = list {
            let already = entries.iter().any(|entry| is_ignored_as(entry, &fp, kind));
            if !already && entries.len() < MAX_SCAN_IGNORED {
                entries.push(json!({ "fp": fp, "kind": kind }));
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
        self.items_of("scanIgnored").any(|entry| is_ignored_as(entry, &fp, kind))
    }

    /// *Undo* right after *Ignore*, for the same scan run: drops the one fingerprint `ignore_scan_item` just
    /// added, so the next read of this scan counts the card again. Leaves every other ignored item alone. Nothing
    /// offers that Undo yet, so only the tests build it.
    #[cfg(test)]
    pub fn unignore_scan_item(&mut self, kind: &str, value: &str) -> io::Result<()> {
        let fp = scan_fingerprint(&self.salt(), kind, value);
        if let Some(Value::Array(entries)) = self.data.get_mut("scanIgnored") {
            entries.retain(|entry| !is_ignored_as(entry, &fp, kind));
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

    /// The files the person said to ignore, as a set a walk can check each path against (by fingerprint only).
    pub fn ignored_files(&self) -> IgnoredFiles {
        let fps = self
            .items_of("scanIgnored")
            .filter(|entry| entry.get("kind") == Some(&json!("file")))
            .filter_map(|entry| entry.get("fp").and_then(Value::as_str).map(String::from))
            .collect();
        IgnoredFiles { salt: self.salt(), fps }
    }

    /// Tell only what's new (4-4): a salted fingerprint of a file's path plus the kinds found in it, the same
    /// mechanism and cap as Ignore, so the weekly check's own notice never fires twice for the same find -- and
    /// a file whose kinds changed since (a password added where there was only an email before) reads as new
    /// again, since its fingerprint changes with them. Returns whether this is the first time it's been seen;
    /// a fingerprint already on the list, or a list already at its cap, answers false either way.
    pub fn note_scan_find(&mut self, path: &str, kinds: &[String]) -> io::Result<bool> {
        let mut sorted: Vec<&str> = kinds.iter().map(String::as_str).collect();
        sorted.sort_unstable();
        let found = format!("{path}\0{}", sorted.join(","));
        let fp = scan_fingerprint(&self.salt(), "found", &found);
        let list = self.data.entry("scanSeen").or_insert_with(|| json!([]));
        let mut is_new = true;
        if let Value::Array(fps) = list {
            is_new = !fps.iter().any(|seen| seen.as_str() == Some(fp.as_str()));
            if is_new && fps.len() < MAX_SCAN_SEEN {
                fps.push(json!(fp));
            }
        }
        self.write()?;
        Ok(is_new)
    }

    /// A stored list's items, or none when it's missing.
    fn items_of(&self, key: &str) -> impl Iterator<Item = &Value> {
        self.data.get(key).and_then(Value::as_array).into_iter().flatten()
    }

    // ---------- Was this right? ----------

    /// *Was this right?* on a file in Results or the workbench: keeps only which of the fixed kinds and
    /// which of the four place tiers, and whether this answer was yes or no, as a running count on that pair's
    /// own row. An unknown kind or tier is refused rather than stored loosely.
    pub fn record_accuracy_answer(&mut self, kind: &str, tier: &str, yes: bool) -> io::Result<bool> {
        if !ACCURACY_KINDS.contains(&kind) || !ACCURACY_TIERS.contains(&tier) {
            return Ok(false);
        }
        let list = self.data.entry("accuracy").or_insert_with(|| json!([]));
        if let Value::Array(rows) = list {
            let answer = if yes { "yes" } else { "no" };
            let row = rows
                .iter_mut()
                .find(|row| row.get("kind") == Some(&json!(kind)) && row.get("tier") == Some(&json!(tier)));
            if let Some(row) = row {
                let count = row.get(answer).and_then(Value::as_u64).unwrap_or(0);
                row[answer] = json!(count.saturating_add(1));
            } else if rows.len() < MAX_ACCURACY {
                let (first_yes, first_no) = if yes { (1, 0) } else { (0, 1) };
                rows.push(json!({ "kind": kind, "tier": tier, "yes": first_yes, "no": first_no }));
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

    // ---------- Leave out of scans ----------

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
        if let Value::Array(entries) = list {
            let already = entries.iter().any(|kept| exclusion_id(&salt, kept) == id);
            if !already {
                if entries.len() >= MAX_SCAN_EXCLUDED {
                    return Ok(None);
                }
                entries.push(entry);
            }
        }
        self.write()?;
        Ok(Some(id))
    }

    /// Settings' own Remove, and Undo right after a Leave out on a Results card. Returns whether one went.
    pub fn remove_exclusion(&mut self, id: &str) -> io::Result<bool> {
        let salt = self.salt();
        let mut removed = false;
        if let Some(Value::Array(entries)) = self.data.get_mut("scanExcluded") {
            let before = entries.len();
            entries.retain(|entry| exclusion_id(&salt, entry) != id);
            removed = entries.len() != before;
        }
        if removed {
            self.write()?;
        }
        Ok(removed)
    }

    /// What a walk leaves out, for `scan_plan::PlanCtx`.
    pub fn exclusions(&self) -> Exclusions {
        let mut exclusions = Exclusions::default();
        for entry in self.items_of("scanExcluded") {
            let kind = entry.get("kind").and_then(Value::as_str).unwrap_or("");
            let value = entry.get("value").and_then(Value::as_str).unwrap_or("");
            match kind {
                "folder" => exclusions.folders.push(lower_path(Path::new(value))),
                "file" => {
                    exclusions.files.insert(lower_path(Path::new(value)));
                }
                _ => {
                    exclusions.types.insert(value.trim_start_matches('.').to_string());
                }
            }
        }
        exclusions
    }

    /// The list for Settings: an id, the kind, and a folder's or file's own name with its parent's, never the path.
    pub fn exclusions_view(&self) -> Value {
        let salt = self.salt();
        let entries = self.items_of("scanExcluded");
        let list: Vec<Value> = entries.map(|entry| exclusion_for_settings(&salt, entry)).collect();
        Value::Array(list)
    }

    // ---------- The Full scan record ----------

    fn baseline_path(&self) -> PathBuf {
        self.path.with_file_name(BASELINE_FILE)
    }

    /// The last Full scan's record, or None before the first one (or once it's been cleared, if the file is damaged,
    /// or if an older version wrote it: a scan then reads everything in its reach, the same as before any Full scan).
    pub fn baseline(&self) -> Option<Baseline> {
        Baseline::decode(&fs::read(self.baseline_path()).ok()?)
    }

    /// The record's first 24 bytes: its magic, when, and how many files.
    fn baseline_head(&self) -> Option<[u8; RECORD_HEADER_BYTES]> {
        let mut head = [0u8; RECORD_HEADER_BYTES];
        let mut file = fs::File::open(self.baseline_path()).ok()?;
        io::Read::read_exact(&mut file, &mut head).ok()?;
        Some(head)
    }

    /// When the last Full scan finished and how many files it kept, from the record's header alone (for Settings
    /// and the Scan screen, without reading every key). An older version's record answers too: Clotr keeps it until
    /// the next Full scan that finishes writes over it.
    pub fn baseline_summary(&self) -> Option<(u64, u64)> {
        let head = self.baseline_head()?;
        let magic = &head[..8];
        let known = magic == BASELINE_MAGIC || BASELINE_MAGICS_OLD.iter().any(|old| magic == *old);
        known.then(|| (u64_at(&head, 8), u64_at(&head, 16)))
    }

    /// Whether the record on disk is one an older version wrote, which no scan goes by.
    pub fn baseline_is_old(&self) -> bool {
        let Some(head) = self.baseline_head() else {
            return false;
        };
        BASELINE_MAGICS_OLD.iter().any(|old| &head[..8] == *old)
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
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }

    // ---------- Settings, and writing the file ----------

    /// Settings from the main window or a move file: each key it carries replaces the stored one, after the
    /// checks. A move file never brings history.
    pub fn save_settings(&mut self, incoming: &Value, from: From) -> io::Result<Vec<String>> {
        let clean = clean_settings(incoming, from == From::MoveFile);
        let changed: Vec<String> = clean.keys().cloned().collect();
        for (key, value) in clean {
            self.data.insert(key, value);
        }
        self.prune(now_ms());
        self.write()?;
        if from == From::Settings {
            let _ = self.write_one_clotr_timestamps(&changed);
        }
        Ok(changed)
    }

    /// For each shared setting in `changed`: its value now and when it changed, beside the store, keeping the
    /// `linked` mark it had (true for one not there yet).
    fn write_one_clotr_timestamps(&self, changed: &[String]) -> io::Result<()> {
        let path = self.path.with_file_name("one-clotr-settings.json");
        let mut records: Map<String, Value> = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        for key in changed.iter().filter(|key| SHARED_SETTINGS.contains(&key.as_str())) {
            let value = self.data.get(key).unwrap_or(&Value::Null);
            let linked = records.get(key).and_then(|record| record.get("linked")).cloned();
            let linked = linked.unwrap_or(Value::Bool(true));
            records.insert(key.clone(), json!({"value": value, "updatedAt": now_ms(), "linked": linked}));
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec(&Value::Object(records))?)?;
        fs::rename(tmp, path)
    }

    /// Written whole to a temporary file beside it, then swapped in, so a crash never leaves half a file.
    fn write(&self) -> io::Result<()> {
        let tmp = self.path.with_extension("json.tmp");
        let text = serde_json::to_vec_pretty(&Value::Object(self.data.clone()))?;
        fs::write(&tmp, text)?;
        fs::rename(&tmp, &self.path)
    }
}

// ---------- Clock and salt ----------

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// 16 bytes from the system's secure random, as 32 hex characters.
fn new_salt() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(format!("no secure random: {error}")))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
#[path = "store_file_tests.rs"]
mod tests;
