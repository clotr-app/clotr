use super::*;

// ---------- The checks: what may be stored ----------

/// The most a count in a History scan row or a "Was this right?" row may say.
const MOST_COUNTED: u64 = 1_000_000;

/// A kind's id, as the engine names them ("credit_card").
pub fn is_kind(id: &str) -> bool {
    let fits = (2..=40).contains(&id.len());
    fits && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_')
}

/// An AI app's id: lower case letters, digits and dashes.
pub(super) fn is_app_id(id: &str) -> bool {
    let fits = (1..=40).contains(&id.len());
    fits && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// Exactly `len` characters of lower case hex, the way the salt and every fingerprint are written.
pub(super) fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// A time or a length of time as JSON carries it: a real number, not below zero.
fn is_non_negative(number: f64) -> bool {
    number.is_finite() && number >= 0.0
}

// ---------- Scan fingerprints and the ignore list ----------

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
    let digest = hasher.finalize();
    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// The files a scan was told to ignore: fingerprints only, checked against a path the same way
/// `ignore_scan_item` made them.
#[derive(Default)]
pub struct IgnoredFiles {
    pub(super) salt: String,
    pub(super) fps: HashSet<String>,
}

impl IgnoredFiles {
    pub fn contains(&self, path: &Path) -> bool {
        if self.fps.is_empty() {
            return false;
        }
        let fingerprint = scan_fingerprint(&self.salt, "file", &path.to_string_lossy());
        self.fps.contains(&fingerprint)
    }
}

// ---------- Leave out of scans ----------

/// What a scan leaves out because the person said so: folders (and everything inside them), single files, and file
/// types (lower case, without the dot). Paths are compared in lower case, the way Windows does.
#[derive(Default, Clone, Debug)]
pub struct Exclusions {
    pub(super) folders: Vec<String>,
    pub(super) files: HashSet<String>,
    pub(super) types: HashSet<String>,
}

impl Exclusions {
    /// `path` is an excluded folder or sits anywhere inside one.
    pub fn folder(&self, path: &Path) -> bool {
        if self.folders.is_empty() {
            return false;
        }
        let path = lower_path(path);
        self.folders.iter().any(|folder| is_same_or_inside(&path, folder))
    }

    /// `path` is an excluded file, or `ext` (lower case, no dot) an excluded type.
    pub fn file(&self, path: &Path, ext: &str) -> bool {
        if !ext.is_empty() && self.types.contains(ext) {
            return true;
        }
        !self.files.is_empty() && self.files.contains(&lower_path(path))
    }
}

/// A path as the exclusions compare it: lower case, Windows' own separator, no trailing one.
pub(super) fn lower_path(path: &Path) -> String {
    let lower = path.to_string_lossy().to_lowercase();
    let backslashed = lower.replace('/', "\\");
    backslashed.trim_end_matches('\\').to_string()
}

/// Both lower-cased paths: `path` is `folder` or sits inside it ("c:\a\b" is inside "c:\a", "c:\ab" isn't).
fn is_same_or_inside(path: &str, folder: &str) -> bool {
    if path == folder {
        return true;
    }
    path.strip_prefix(folder).is_some_and(|rest| rest.starts_with('\\'))
}

/// A folder's or file's own name and its parent's, for a page that never sees the path ("C:" for a drive's root).
pub fn name_and_parent(path: &Path) -> (String, String) {
    let parent = path.parent().map(own_name).unwrap_or_default();
    (own_name(path), parent)
}

/// The last part of a path, or for a drive's root the path itself without its separator.
fn own_name(path: &Path) -> String {
    match path.file_name() {
        Some(name) => name.to_string_lossy().into_owned(),
        None => path.to_string_lossy().trim_end_matches('\\').to_string(),
    }
}

/// An exclusion's id: its kind and value, salted, so Settings can name one without the path.
pub(super) fn exclusion_id(salt: &str, entry: &Value) -> String {
    let kind = entry.get("kind").and_then(Value::as_str).unwrap_or("");
    let value = entry.get("value").and_then(Value::as_str).unwrap_or("");
    let named = format!("{kind}\0{}", value.to_lowercase());
    scan_fingerprint(salt, "exclude", &named)
}

/// One exclusion as it may be stored: a folder or file by its absolute path (at most 1,024 characters), or a type
/// as a dot and 1 to 16 letters or digits, in lower case.
pub(super) fn clean_exclusion(entry: &Value) -> Option<Value> {
    let kind = entry.get("kind")?.as_str()?;
    let value = entry.get("value")?.as_str()?;
    match kind {
        "folder" | "file" => fits_as_path(value).then(|| json!({ "kind": kind, "value": value })),
        "type" => {
            let ext = value.trim_start_matches('.').to_ascii_lowercase();
            fits_as_type(&ext).then(|| json!({ "kind": "type", "value": format!(".{ext}") }))
        }
        _ => None,
    }
}

fn fits_as_path(value: &str) -> bool {
    let fits = !value.is_empty() && value.len() <= 1024;
    fits && Path::new(value).is_absolute() && !value.contains('\0')
}

fn fits_as_type(ext: &str) -> bool {
    (1..=16).contains(&ext.len()) && ext.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

pub(super) fn clean_exclusions(raw: Option<&Value>) -> Vec<Value> {
    let Some(list) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter().filter_map(clean_exclusion).take(MAX_SCAN_EXCLUDED).collect()
}

// ---------- The Full scan record ----------

/// The record's header: its magic, when, and how many files.
pub(super) const RECORD_HEADER_BYTES: usize = 24;
/// One file's key, stamp and bit.
const RECORD_ENTRY_BYTES: usize = 17;

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
        entries.sort_unstable_by_key(|entry| entry.0);
        entries.dedup_by_key(|entry| entry.0);
        Baseline { at, entries }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the file keyed `key` is just as the Full scan saw it.
    pub fn unchanged(&self, key: u64, stamp: u64) -> bool {
        self.entry_for(key).is_some_and(|(_, saved_stamp, _)| *saved_stamp == stamp)
    }

    /// Whether the file keyed `key` had something worth a look the last time a Full scan read it. A changes-only
    /// Full re-reads a file this is true for even when `unchanged` is also true, so Results stays current on it.
    pub fn flagged(&self, key: u64) -> bool {
        self.entry_for(key).is_some_and(|(_, _, worth_a_look)| *worth_a_look)
    }

    fn entry_for(&self, key: u64) -> Option<&(u64, u64, bool)> {
        let index = self.entries.binary_search_by_key(&key, |entry| entry.0).ok()?;
        Some(&self.entries[index])
    }

    /// The magic, when, how many, then each key, stamp and bit: 17 bytes a file, little-endian.
    pub(super) fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(RECORD_HEADER_BYTES + self.entries.len() * RECORD_ENTRY_BYTES);
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

    /// Only a current record whose header and length agree and whose keys are in order; anything else, an older
    /// version's record included, is no record.
    pub(super) fn decode(bytes: &[u8]) -> Option<Baseline> {
        if bytes.len() < RECORD_HEADER_BYTES || &bytes[..8] != BASELINE_MAGIC {
            return None;
        }
        let at = u64_at(bytes, 8);
        let count = usize::try_from(u64_at(bytes, 16)).ok()?;
        let expected_len = count.checked_mul(RECORD_ENTRY_BYTES)?.checked_add(RECORD_HEADER_BYTES)?;
        if bytes.len() != expected_len {
            return None;
        }
        let entries: Vec<(u64, u64, bool)> = bytes[RECORD_HEADER_BYTES..]
            .as_chunks::<RECORD_ENTRY_BYTES>()
            .0
            .iter()
            .map(|chunk| (u64_at(chunk, 0), u64_at(chunk, 8), chunk[16] != 0))
            .collect();
        let in_order = entries.windows(2).all(|pair| pair[0].0 < pair[1].0);
        in_order.then_some(Baseline { at, entries })
    }
}

/// The eight bytes at `at`, little-endian, as one number.
pub(super) fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap_or([0; 8]))
}

/// A file's key in the Full scan record: 8 bytes of SHA-256(salt, "baseline", its path in lower case), so the
/// record can tell one file from another without ever holding where it is.
pub fn baseline_key(salt: &str, path: &Path) -> u64 {
    use sha2::{Digest, Sha256};
    let lowered = path.to_string_lossy().to_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b"\0baseline\0");
    hasher.update(lowered.as_bytes());
    u64_at(&hasher.finalize(), 0)
}

/// A file's size and last-change time (Windows' own FILETIME), folded into one number: any change to either
/// changes it.
pub fn baseline_stamp(size: u64, modified: u64) -> u64 {
    size.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ modified
}

// ---------- History ----------

/// A history record's fingerprint: 16 hex characters, as the engine makes them. One made only of digits is dropped
/// (the record stays, without it): sixteen digits is also what a card number looks like, and a real fingerprint is
/// all digits only about once in 1,800 times.
fn event_fp(raw: Option<&Value>) -> String {
    let Some(fp) = raw.and_then(Value::as_str) else {
        return String::new();
    };
    let all_digits = fp.bytes().all(|byte| byte.is_ascii_digit());
    if !is_hex(fp, 16) || all_digits {
        return String::new();
    }
    fp.into()
}

/// A kind's name as people read it ("Credit Card Number", "Número de tarjeta"): words only. A digit, an @ or a
/// colon means it isn't a kind's name, so the record is dropped.
fn kind_name(raw: Option<&Value>) -> Option<String> {
    let name = raw?.as_str()?;
    if name.trim().is_empty() || name.chars().count() > 64 {
        return None;
    }
    let has_odd_mark = name
        .chars()
        .any(|character| character.is_ascii_digit() || matches!(character, '@' | ':' | '<' | '>' | '\n' | '\r'));
    if has_odd_mark {
        return None;
    }
    Some(name.into())
}

/// A history record from the card: exactly the extension's fields, for an AI app on the list, or nothing.
pub fn clean_event(event: &Value, apps: &[String]) -> Option<Value> {
    let site = event.get("site")?.as_str()?;
    let app = site.strip_prefix("app:")?;
    if !apps.iter().any(|listed| listed == app) {
        return None;
    }
    clean_record(event, site)
}

/// A record already in the file (an app since taken off the list keeps its history).
pub(super) fn clean_stored_event(event: &Value) -> Option<Value> {
    let site = event.get("site")?.as_str()?;
    let app = site.strip_prefix("app:")?;
    if !is_app_id(app) {
        return None;
    }
    clean_record(event, site)
}

fn clean_record(event: &Value, site: &str) -> Option<Value> {
    let time = event.get("t")?.as_f64().filter(|time| is_non_negative(*time))?;
    let kind = event.get("type")?.as_str().filter(|kind| is_kind(kind))?;
    let severity = event
        .get("severity")?
        .as_str()
        .filter(|severity| matches!(*severity, "high" | "medium" | "low"))?;
    let action = event
        .get("action")?
        .as_str()
        .filter(|action| matches!(*action, "redacted" | "allowed" | "suppressed"))?;
    let name = kind_name(event.get("name"))?;
    let mut record = json!({
        "t": time.floor() as u64,
        "site": site,
        "type": kind,
        "name": name,
        "severity": severity,
        "action": action,
        "fp": event_fp(event.get("fp")),
    });
    if event.get("scheme").and_then(Value::as_u64) == Some(2) {
        record["scheme"] = json!(2);
    }
    Some(record)
}

/// A History scan row: when, which kind of scan, how many files or chats it read, and how many of each kind of
/// detail it found. Nothing identifies a file, a chat or a value, so a row is safe to keep as long as an event.
pub(super) fn clean_scan_row(row: &Value) -> Option<Value> {
    let time = row.get("t")?.as_f64().filter(|time| is_non_negative(*time))?;
    let scan = row
        .get("scan")?
        .as_str()
        .filter(|scan| matches!(*scan, "quick" | "full" | "chosen" | "lookback"))?;
    let items = row.get("items")?.as_u64().filter(|items| *items <= MOST_COUNTED)?;
    let seconds = row
        .get("seconds")
        .and_then(Value::as_f64)
        .filter(|seconds| is_non_negative(*seconds))
        .map(|seconds| seconds.min(86_400.0).floor() as u64);
    let counts = clean_scan_counts(row.get("counts")?.as_object()?);
    let mut clean = json!({
        "t": time.floor() as u64,
        "scan": scan,
        "items": items,
        "counts": counts,
    });
    if let Some(seconds) = seconds {
        clean["seconds"] = json!(seconds);
    }
    Some(clean)
}

/// Up to 64 kinds, each with its count.
fn clean_scan_counts(counts: &Map<String, Value>) -> Map<String, Value> {
    counts
        .iter()
        .filter(|(kind, count)| is_kind(kind) && count.as_u64().is_some_and(|count| count <= MOST_COUNTED))
        .take(64)
        .map(|(kind, count)| (kind.clone(), count.clone()))
        .collect()
}

// ---------- Tourniquet ----------

/// The longest an after-scam Tourniquet may last: 61 days.
const TOURNIQUET_LONGEST_MS: f64 = 61.0 * 86_400_000.0;

/// Tourniquet's own record, the same shape sites.js's cleanTourniquet keeps on the stored settings: exactly
/// `{ for: "child" | "adult", since }`, or `{ for: "after_scam", since, until }` with until after since and no
/// more than 61 days later. Whether it's still on (the stored since/until against the clock) is for the pages
/// to work out, the same as the extension does; this only keeps the shape honest on the way to disk.
pub(super) fn clean_tourniquet(raw: Option<&Value>) -> Option<Value> {
    let record = raw?.as_object()?;
    let since = record.get("since")?.as_f64().filter(|since| is_non_negative(*since))?;
    let since_ms = since.floor() as u64;
    let protects = record.get("for")?.as_str()?;
    match protects {
        "child" | "adult" if record.len() == 2 => Some(json!({ "for": protects, "since": since_ms })),
        "after_scam" if record.len() == 3 => {
            let until = record.get("until")?.as_f64().filter(|until| is_non_negative(*until))?;
            let in_window = until > since && until - since <= TOURNIQUET_LONGEST_MS;
            in_window.then(|| json!({ "for": "after_scam", "since": since_ms, "until": until.floor() as u64 }))
        }
        _ => None,
    }
}

// ---------- Was this right? ----------

/// "Was this right?": one row a kind-and-tier pair, with how many times it was answered yes and how many
/// no. Never a file, its name, its place or the value -- only one of the fixed kinds and one of the four tiers.
pub(super) fn clean_accuracy_row(row: &Value) -> Option<Value> {
    let kind = row.get("kind")?.as_str().filter(|kind| ACCURACY_KINDS.contains(kind))?;
    let tier = row.get("tier")?.as_str().filter(|tier| ACCURACY_TIERS.contains(tier))?;
    let yes = row.get("yes")?.as_u64().filter(|yes| *yes <= MOST_COUNTED)?;
    let no = row.get("no")?.as_u64().filter(|no| *no <= MOST_COUNTED)?;
    Some(json!({ "kind": kind, "tier": tier, "yes": yes, "no": no }))
}

// ---------- The vault ----------

const MAX_VAULT: usize = 5_000;

/// A vault entry, as decide.js's cleanVaultEntry keeps it: a fingerprint ("value", "word") or a format with no
/// digit in it ("shape"), never the thing itself.
pub fn clean_vault_entry(entry: &Value) -> Option<Value> {
    let kind = entry
        .get("kind")?
        .as_str()
        .filter(|kind| matches!(*kind, "value" | "word" | "shape"))?;
    let kind_id = entry.get("type")?.as_str().filter(|id| is_kind(id))?;
    let added = entry
        .get("added")
        .and_then(Value::as_f64)
        .filter(|added| is_non_negative(*added))
        .unwrap_or(0.0);
    let mut clean = json!({ "kind": kind, "type": kind_id, "added": added.floor() as u64 });
    if kind == "shape" {
        let shape = entry.get("shape")?.as_str().filter(|shape| fits_as_shape(shape))?;
        clean["shape"] = json!(shape);
    } else {
        let fp = entry.get("fp")?.as_str().filter(|fp| is_hex(fp, 16))?;
        clean["fp"] = json!(fp);
        if kind == "word" {
            let words = entry.get("words").and_then(Value::as_f64).unwrap_or(1.0).clamp(1.0, 4.0);
            clean["words"] = json!(words as u64);
        }
        if kind == "value" {
            let mode = entry
                .get("mode")
                .and_then(Value::as_str)
                .filter(|mode| matches!(*mode, "protect" | "allow"));
            clean["mode"] = json!(mode.unwrap_or("protect"));
        }
        if entry.get("scheme").and_then(Value::as_u64) == Some(2) {
            clean["scheme"] = json!(2);
        }
    }
    if entry.get("learned") == Some(&Value::Bool(true)) {
        clean["learned"] = json!(true);
    }
    Some(clean)
}

/// A format: at least two `#` or `@` marks, no digit, at most 40 characters.
fn fits_as_shape(shape: &str) -> bool {
    let marks = shape.chars().filter(|mark| matches!(mark, '#' | '@')).count();
    let has_digit = shape.chars().any(|character| character.is_ascii_digit());
    marks >= 2 && !has_digit && shape.chars().count() <= 40
}

/// The first `MAX_VAULT` entries that pass, each fingerprint or format once.
fn clean_vault(list: &[Value]) -> Vec<Value> {
    let mut seen = HashSet::new();
    list.iter()
        .take(MAX_VAULT)
        .filter_map(clean_vault_entry)
        .filter(|entry| seen.insert(vault_key(entry)))
        .collect()
}

/// What makes two vault entries the same one, in lower case.
fn vault_key(entry: &Value) -> String {
    let fp_or_shape = entry.get("fp").or(entry.get("shape")).unwrap_or(&Value::Null);
    let key = format!("{}:{}:{}", entry["kind"], entry["type"], fp_or_shape);
    key.to_lowercase()
}

// ---------- Settings ----------

const KEEP_DAYS: [u64; 3] = [90, 365, 730];
// results.js's own "What to do" plan (plan.js's STEPS): a new step there needs its id added below too.
const PLAN_STEP_IDS: [&str; 6] = ["keys", "idPhotos", "idDocs", "photoPlace", "money", "leaveOutFolders"];

/// Settings: only the keys Clotr for Windows uses, each with sane values (backup.js's clean, with the apps' names).
/// The salt only from a move file or the store itself.
pub fn clean_settings(raw: &Value, with_salt: bool) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(raw) = raw.as_object() else {
        return out;
    };
    keep_entries(raw, "responses", &mut out, |kind, response| {
        is_kind(kind) && matches!(response.as_str(), Some("block" | "warn" | "log"))
    });
    keep_entries(raw, "appModes", &mut out, |app, mode| {
        is_app_id(app) && matches!(mode.as_str(), Some("block" | "log"))
    });
    keep_entries(raw, "pausedApps", &mut out, |app, paused| is_app_id(app) && paused == &Value::Bool(true));
    keep_entries(raw, "guided", &mut out, |kind, count| {
        is_kind(kind) && count.as_f64().is_some_and(f64::is_finite)
    });
    keep_switches(raw, &["largeText", "replyCheck", "commandCheck", "advanced"], &mut out);
    if let Some(tourniquet) = clean_tourniquet(raw.get("tourniquet")) {
        out.insert("tourniquet".into(), tourniquet);
    }

    // The main window's own settings: the browser's move file never carries these (move-file.js's own
    // list leaves them out), but a plain switch or a named choice is harmless either way, so they're cleaned
    // the same as everything above.
    keep_switches(raw, &["startWithWindows"], &mut out);
    if let Some(look) = raw.get("look").and_then(Value::as_str).and_then(clean_look) {
        out.insert("look".into(), json!(look));
    }
    keep_choice(raw, "motion", &["system", "still"], &mut out);
    keep_choice(raw, "language", &["system", "en", "es"], &mut out);
    keep_switches(raw, &["typingCheck", "weeklyCheck", "notifyFind"], &mut out);
    // The developer switch: Quick and Full read code projects and secret files too.
    keep_switches(raw, &["scanDevFiles"], &mut out);
    if let Some(list) = raw.get("planTicked").and_then(Value::as_array) {
        out.insert("planTicked".into(), Value::Array(clean_plan_ticked(list)));
    }
    // Guided or Detailed results (design/later/results-modes.design.md, section 6): a named choice, same as `look`.
    keep_choice(raw, "resultsMode", &["guided", "detailed"], &mut out);
    // "My helper", for the note's heading once it's built: the person's own words, trimmed and capped, never
    // read by anything but the apps that show it back to them.
    if let Some(name) = raw.get("helperName").and_then(Value::as_str) {
        let capped: String = name.trim().chars().take(60).collect();
        out.insert("helperName".into(), json!(capped));
    }
    let keep_days = raw.get("keepDays").and_then(Value::as_u64).filter(|days| KEEP_DAYS.contains(days));
    if let Some(days) = keep_days {
        out.insert("keepDays".into(), json!(days));
    }

    // The lists: fingerprints and formats only.
    if let Some(list) = raw.get("vault").and_then(Value::as_array) {
        out.insert("vault".into(), Value::Array(clean_vault(list)));
    }
    if let Some(list) = raw.get("scanIgnored").and_then(Value::as_array) {
        out.insert("scanIgnored".into(), Value::Array(clean_scan_ignored(list)));
    }
    if let Some(list) = raw.get("scanSeen").and_then(Value::as_array) {
        out.insert("scanSeen".into(), Value::Array(clean_scan_seen(list)));
    }
    if with_salt {
        let salt = raw.get("salt").and_then(Value::as_str).filter(|salt| is_hex(salt, 32));
        if let Some(salt) = salt {
            out.insert("salt".into(), json!(salt));
        }
    }
    out
}

/// An object kept under `key`, with only the entries `allowed` passes, and at most 500 of them.
fn keep_entries(
    raw: &Map<String, Value>,
    key: &str,
    out: &mut Map<String, Value>,
    allowed: impl Fn(&str, &Value) -> bool,
) {
    let Some(entries) = raw.get(key).and_then(Value::as_object) else {
        return;
    };
    let kept: Map<String, Value> = entries
        .iter()
        .filter(|(name, value)| allowed(name, value))
        .take(500)
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    out.insert(key.into(), Value::Object(kept));
}

/// Each switch in `keys` that's true or false.
fn keep_switches(raw: &Map<String, Value>, keys: &[&str], out: &mut Map<String, Value>) {
    for key in keys {
        if let Some(Value::Bool(on)) = raw.get(*key) {
            out.insert((*key).into(), Value::Bool(*on));
        }
    }
}

/// A named choice, kept when it's one of `choices`.
fn keep_choice(raw: &Map<String, Value>, key: &str, choices: &[&str], out: &mut Map<String, Value>) {
    let Some(choice) = raw.get(key).and_then(Value::as_str) else {
        return;
    };
    if choices.contains(&choice) {
        out.insert(key.into(), json!(choice));
    }
}

/// "light" is a look again, Android's Light. The old warm Light was moved to Plum and saved that way the
/// first time a 1.6.1 store opened (open() writes back what it cleaned), so nobody who had it then lands
/// here by surprise.
fn clean_look(look: &str) -> Option<&str> {
    match look {
        "system" | "light" | "plum" | "ember" => Some(look),
        "savanna" => Some("plum"),
        "dark" => Some("ember"),
        _ => None,
    }
}

/// What to do first, above Results: a step's own id, ticked, from results.js's `save`. Never a file name
/// or what was found, so an allow-list of the plan's own ids is enough.
fn clean_plan_ticked(list: &[Value]) -> Vec<Value> {
    let mut seen = HashSet::new();
    list.iter()
        .filter_map(Value::as_str)
        .filter(|id| PLAN_STEP_IDS.contains(id))
        .take(PLAN_STEP_IDS.len())
        .filter(|id| seen.insert(id.to_string()))
        .map(|id| json!(id))
        .collect()
}

fn clean_scan_ignored(list: &[Value]) -> Vec<Value> {
    let mut seen = HashSet::new();
    list.iter()
        .filter(|entry| is_ignored_entry(entry))
        .take(MAX_SCAN_IGNORED)
        .filter(|entry| seen.insert(format!("{}:{}", entry["kind"], entry["fp"])))
        .cloned()
        .collect()
}

/// An ignored file or extension: its fingerprint, and which of the two lists it's on.
fn is_ignored_entry(entry: &Value) -> bool {
    let fp = entry.get("fp").and_then(Value::as_str);
    let kind = entry.get("kind").and_then(Value::as_str);
    let fp_fits = fp.is_some_and(|fp| is_hex(fp, 16));
    let kind_fits = kind.is_some_and(|kind| matches!(kind, "file" | "ext"));
    fp_fits && kind_fits
}

fn clean_scan_seen(list: &[Value]) -> Vec<Value> {
    let mut seen = HashSet::new();
    list.iter()
        .filter_map(Value::as_str)
        .filter(|fp| is_hex(fp, 16))
        .take(MAX_SCAN_SEEN)
        .filter(|fp| seen.insert(fp.to_lowercase()))
        .map(|fp| json!(fp))
        .collect()
}

// ---------- What a move file brought ----------

/// What a move file actually changed, in counts and names only, never the values themselves: the settings
/// page's "Brought over" line compares the store's own settings from just before and just after the import, so a
/// field only shows when it's genuinely different, never just carried along unchanged. Never the salt or `guided`
/// (an internal counter): neither means anything to the person reading this.
pub fn brought_summary(before: &Value, after: &Value) -> Value {
    let mut parts = Map::new();
    let responses = field_or_null(after, "responses");
    if responses != field_or_null(before, "responses") {
        parts.insert("responses".into(), json!(responses.as_object().map(Map::len).unwrap_or(0)));
    }
    let vault = field_or_null(after, "vault");
    if vault != field_or_null(before, "vault") {
        parts.insert("vault".into(), json!(vault.as_array().map(Vec::len).unwrap_or(0)));
    }
    let large_text = field_or_null(after, "largeText");
    if large_text != field_or_null(before, "largeText") {
        parts.insert("largeText".into(), json!(large_text.as_bool().unwrap_or(false)));
    }
    let keep_days = field_or_null(after, "keepDays");
    if keep_days != field_or_null(before, "keepDays") {
        parts.insert("keepDays".into(), keep_days);
    }
    json!({ "changed": !parts.is_empty(), "parts": Value::Object(parts) })
}

fn field_or_null(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}
