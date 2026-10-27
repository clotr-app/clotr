//! The walker: finds files Check my files can read, read only, 100% local.
//!
//! It knows Windows' known folders (Downloads, Desktop, Documents), the PC's fixed drives, and opens Windows' own
//! folder picker for "Folders I choose". It walks on its own thread and hands each file it can read to the page
//! over a small channel, a batch at a time, under an index: the page never sees a path, so it can never ask for one
//! the walker didn't hand over. A second walk of the same plan only counts names and sizes, so the progress bar and the
//! time left are real without a list of every file held anywhere. A full path lives only in this module's memory,
//! for the run's own `fs::read`, and is never logged, stored or handed to the page.
//!
//! What it skips, and never opens: a link or junction (a reparse point: never followed, so a loop can't happen), a
//! hidden or system file, an online-only cloud placeholder (reading one would make the cloud drive download it).
//! Every scan kind skips program and developer files and password managers' own vaults (`skiplist.rs`, counted for
//! Results' one line) and whatever the person chose to leave out of scans. In a folder it also skips what Windows
//! itself owns; across a drive (Full) only Windows' own folders, the Recycle Bin and the page and hibernation files.
//! Depth and file-count caps keep a scan bounded; a file over its format's cap is counted as "too big to read",
//! never opened.
//!
//! The same file in many places (a project's worktrees, a copied folder) is read once per place but counted as one:
//! each batch's bytes are read here as it's handed over, hashed on the way, and held only until the page takes them,
//! so a later copy carries `dupOf`, the index of the first one, with no second read.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::skiplist::{self, Verdict};
use crate::store::{baseline_key, baseline_stamp, Baseline, Exclusions, IgnoredFiles};

use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{
    SHGetKnownFolderPath, FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music, FOLDERID_Pictures,
    FOLDERID_Profile, FOLDERID_Videos, KF_FLAG_DEFAULT,
};

static NEXT_SCAN_GENERATION: AtomicU64 = AtomicU64::new(1);

// ---------- Attributes (Microsoft Learn, "File Attribute Constants") ----------
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x40000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x400000;
const ONLINE_ONLY: u32 = FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

fn is_dir(a: u32) -> bool {
    a & FILE_ATTRIBUTE_DIRECTORY != 0
}
fn is_link(a: u32) -> bool {
    a & FILE_ATTRIBUTE_REPARSE_POINT != 0
}
fn is_hidden_or_system(a: u32) -> bool {
    a & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
}
fn is_online_only(a: u32) -> bool {
    a & ONLINE_ONLY != 0
}

// ---------- Known folders (4.2) ----------

/// Wherever Windows points it (a `KNOWNFOLDERID`), including a redirected, OneDrive-backed folder.
fn known_folder(id: &windows::core::GUID) -> Option<PathBuf> {
    unsafe {
        let pwstr = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let path = pwstr.to_string().ok().map(PathBuf::from);
        CoTaskMemFree(Some(pwstr.0 as *const _));
        path
    }
}

pub fn downloads() -> Option<PathBuf> {
    known_folder(&FOLDERID_Downloads)
}
pub fn desktop() -> Option<PathBuf> {
    known_folder(&FOLDERID_Desktop)
}
pub fn documents() -> Option<PathBuf> {
    known_folder(&FOLDERID_Documents)
}
pub fn pictures() -> Option<PathBuf> {
    known_folder(&FOLDERID_Pictures)
}

/// The person's own user folder (`C:\Users\<name>`), which a drive's files are placed by.
pub fn home() -> Option<PathBuf> {
    known_folder(&FOLDERID_Profile)
}

/// The places a person keeps their own files: the user folder and its known folders. Never taken for an installed
/// program, even with a setup's .exe and a few .dll files sitting loose in Downloads.
pub fn personal_places() -> Vec<PathBuf> {
    [
        known_folder(&FOLDERID_Profile),
        downloads(),
        desktop(),
        documents(),
        pictures(),
        known_folder(&FOLDERID_Music),
        known_folder(&FOLDERID_Videos),
    ]
    .into_iter()
    .flatten()
    .collect()
}

// ---------- What Clotr knows how to read, and each format's cap (4.2) ----------

const TEXT_EXTS: &[&str] = &[
    "txt", "csv", "tsv", "md", "json", "jsonl", "log", "env", "ini", "conf", "cfg", "toml", "yaml", "yml", "xml",
    "sql", "js", "mjs", "ts", "py", "rb", "go", "java", "cs", "php", "sh", "ps1", "html", "htm", "svg",
];
const DOC_EXTS: &[&str] = &["docx", "docm", "xlsx", "xlsm", "pptx", "pptm", "odt", "ods", "odp", "pdf"];
const PICTURE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "heic"];

// A key or sign-in file: no picture or document reader applies, but it's still plain text the engine's own
// private-key and token patterns can read. Named by their extension (a VPN profile, an npm or netrc login) or,
// for the ones a key generator leaves with no extension at all, by their exact name.
const KEY_FILE_EXTS: &[&str] = &["pem", "key", "ppk", "ovpn", "npmrc", "netrc"];
const KEY_FILE_NAMES: &[&str] = &["id_rsa", "id_ed25519", "credentials"];

const TEXT_CAP: u64 = 2 * 1024 * 1024;
const DOC_CAP: u64 = 20 * 1024 * 1024;
const PICTURE_CAP: u64 = 20 * 1024 * 1024;

// Zip budget (4.8): the most a single scan will ever unpack out of every .zip it meets, combined. A real export
// (Google Takeout, a backup, an AI chat export) rarely holds more than a few hundred megabytes once you look at
// what Clotr would actually read from it (text, documents, pictures, each already capped above); a zip bomb's
// whole point is a tiny file ballooning far past that once unpacked. 256 MiB is roomy enough for a real export
// and still a hard ceiling against a crafted one, applied once across the whole scan rather than per zip.
const ZIP_BUDGET: u64 = 256 * 1024 * 1024;

/// What a file's extension reads as ("text", "doc" or "picture") and the size past which it's "too big to read",
/// or `None` for a format Clotr doesn't know how to read (not counted at all: it was never something Clotr could
/// find a detail in).
fn category(ext: &str) -> Option<(&'static str, u64)> {
    let e = ext.to_ascii_lowercase();
    if TEXT_EXTS.contains(&e.as_str()) || KEY_FILE_EXTS.contains(&e.as_str()) {
        Some(("text", TEXT_CAP))
    } else if DOC_EXTS.contains(&e.as_str()) {
        Some(("doc", DOC_CAP))
    } else if PICTURE_EXTS.contains(&e.as_str()) {
        Some(("picture", PICTURE_CAP))
    } else {
        None
    }
}

/// A `.env` file itself, or one of its variants (`.env.local`, `.env.production`): Rust's own `extension()` reads
/// the part after a later dot as the extension (so `.env.local`'s is "local", not "env"), which is why this checks
/// the name directly instead of going through `category()`.
fn is_env_variant(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == ".env" || n.starts_with(".env.")
}

/// Like `category()`, but also recognizes a key or sign-in file by its exact name when it has no extension of
/// its own (`id_rsa`) or when its extension alone wouldn't say what it is (`.env.local`).
fn category_for(name: &str, ext: &str) -> Option<(&'static str, u64)> {
    let lower = name.to_ascii_lowercase();
    if (ext.is_empty() && KEY_FILE_NAMES.contains(&lower.as_str())) || skiplist::SECRET_NAMES.contains(&lower.as_str())
    {
        return Some(("text", TEXT_CAP));
    }
    if is_env_variant(name) {
        return Some(("text", TEXT_CAP));
    }
    category(ext)
}

// ---------- Folders a scan never opens (4.0, 4.2) ----------

// Build tools' own folders (`node_modules`, `.git`, Cargo's `target`) are `skiplist.rs`'s now, for every scan kind,
// and counted for Results; this list is only what Windows itself owns.
const SKIP_DIR_NAMES: &[&str] = &[
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "appdata", // Clotr's own data folder lives under here, never opened
    "$recycle.bin",
    "system volume information",
];

fn skip_dir_name(name: &str) -> bool {
    SKIP_DIR_NAMES.contains(&name.to_ascii_lowercase().as_str())
}

/// A Full scan's own, much shorter list: only the folders Windows itself owns at a drive's root -- the system,
/// the installed programs, the Recycle Bin, restore points, recovery and update leftovers. Everything else on a
/// fixed drive is opened, AppData and project folders included, the way an antivirus scan reaches.
const DRIVE_ROOT_SKIPS: &[&str] = &[
    "windows",
    "windows.old",
    "program files",
    "program files (x86)",
    "programdata",
    "$recycle.bin",
    "system volume information",
    "recovery",
    "$winreagent",
    "$windows.~bt",
    "$windows.~ws",
    "config.msi",
    "perflogs",
];

/// On a drive, these two are skipped wherever they are (each drive keeps its own Recycle Bin and restore points).
const DRIVE_ANYWHERE_SKIPS: &[&str] = &["$recycle.bin", "system volume information"];

/// The page, swap and hibernation files, at a drive's root. They're hidden system files in a format Clotr doesn't
/// read anyway; named here so a Full scan never opens one even on a PC where those attributes were changed.
const DRIVE_ROOT_FILE_SKIPS: &[&str] = &["pagefile.sys", "hiberfil.sys", "swapfile.sys"];

// ---------- Caps (4.2): depth 12, at most 50,000 files a scan ----------

pub const MAX_DEPTH: usize = 12;
pub const MAX_FILES: usize = 50_000;
/// A Full scan's depth: deeper than any real folder tree, still a stop for a pathological one. It has no file cap:
/// the walk streams, so memory stays the same however many files a drive holds.
pub const MAX_DEPTH_FULL: usize = 64;

#[derive(Clone, Copy)]
pub struct WalkLimits {
    pub max_depth: usize,
    pub max_files: usize,
}
impl Default for WalkLimits {
    fn default() -> Self {
        WalkLimits {
            max_depth: MAX_DEPTH,
            max_files: MAX_FILES,
        }
    }
}

/// A file the walker found and will hand over to the reader: never a path outside this module. `folder` is the top
/// place a person would look in: a known folder's key ("downloads", "desktop", "documents", "pictures"), the first
/// folder below the home folder ("AppData"), a drive with its first folder ("D: › Games"), or the chosen folder's
/// own name. `place` is the folders between that and the file, shortened (`place_of`).
pub struct Candidate {
    pub path: PathBuf,
    pub name: String,
    pub folder: String,
    pub place: Vec<String>,
    /// The name of the folder the file sits in (the one holding the zip, for an entry inside one), never its path.
    pub parent: String,
    pub ext: String,
    pub size: u64,
    pub kind: &'static str,
    /// Some(entry name) for a file read out of a .zip at `path` instead of `path` itself (4.8); `read()` branches
    /// on this alone, so a zip's own entries need no other place in the walker to be treated differently.
    pub zip_entry: Option<String>,
    /// It sits inside a code project (a chosen folder reads them, and Quick and Full with the developer switch on;
    /// Results gives them their own heading).
    pub project: bool,
    /// A file made to hold a key or a password (`.env`, a private key, a sign-in file), read only where code projects
    /// are: under the same heading.
    pub secret: bool,
    /// A secret file an app keeps its own sign-in in (`skiplist::app_signin`): Results says to leave it and sign out
    /// of the app, rather than to delete or move it.
    pub app_signin: bool,
    /// The real file's own size on disk at scan time (the zip's, for an entry inside one, never the entry's own
    /// declared size): paired with `modified` so *Move it somewhere private* and *Move to the Recycle Bin* can
    /// refuse a file that changed since the scan looked at it, the same way Quick's own baseline does.
    pub on_disk_size: u64,
    pub modified: u64,
    /// A Full scan only: this file hasn't changed since the last one, but its record said it had something worth
    /// a look, so it's being read again anyway rather than skipped, and Results shows it like any other.
    pub earlier: bool,
}

/// How much of a JPEG the check reads: its place (EXIF) sits in the first segments, so the rest of the photo is
/// never carried to the page. A name that says it's an ID needs no bytes at all.
const JPEG_HEAD: u64 = 256 * 1024;

impl Candidate {
    fn head_only(&self) -> bool {
        self.zip_entry.is_none() && self.kind == "picture" && matches!(self.ext.as_str(), "jpg" | "jpeg")
    }

    /// The bytes the check reads for this file: what the time left weighs, on both walks alike.
    pub fn check_bytes(&self) -> u64 {
        if self.head_only() {
            self.size.min(JPEG_HEAD)
        } else {
            self.size
        }
    }
}

#[derive(Default, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub too_big: usize,
    pub online_only: usize,
    pub capped_files: bool,
    pub capped_depth: bool,
    /// Folders that only hold program and developer files, never opened.
    pub dev_folders: usize,
    /// Lock files, minified scripts and `.env` templates, never read.
    pub dev_files: usize,
    /// Password managers' and browsers' own password stores, files or folders, never opened.
    pub vaults: usize,
    /// Folders, files and file types the person chose to leave out.
    pub excluded: usize,
    /// Code projects left out: a folder holding `.git` or a build or package file (skiplist::project_marker).
    pub code_projects: usize,
    /// Files inside code projects that a scan leaving projects out would otherwise have read.
    pub project_files: usize,
    /// Installed programs and games met (a game library, or a folder an installer filled), never opened.
    pub programs: usize,
    /// Files made to hold a key or a password that a scan leaving them out would otherwise have read.
    pub secret_files: usize,
    /// Folders and files an app keeps for itself (caches, logs, temp files, a browser's page storage, an AI coding
    /// tool's history), never opened.
    pub app_data: usize,
    /// Folders inside AppData left out as a whole, the developer switch off: apps' own storage, not what a person
    /// writes or saves.
    pub app_storage: usize,
}

// ---------- What a scan walks ----------

/// How a root is walked. A folder (Quick's floor, Folders I choose) skips what only a build tool or Windows makes
/// anywhere inside it; a drive (Full, and Quick's look across the PC) skips only Windows' own folders at its root.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Reach {
    Folder,
    Drive,
}

#[derive(Clone)]
pub struct Root {
    pub path: PathBuf,
    pub label: String,
    pub reach: Reach,
    /// Quick's look across the drives: only a file the last Full scan didn't see as it is now.
    pub changed_only: bool,
}

impl Root {
    pub fn folder(path: PathBuf, label: String) -> Root {
        Root {
            path,
            label,
            reach: Reach::Folder,
            changed_only: false,
        }
    }

    /// A whole drive ("C:\"), named by its letter.
    pub fn drive(path: PathBuf, changed_only: bool) -> Root {
        let label = path.to_string_lossy().trim_end_matches('\\').to_string();
        Root {
            path,
            label,
            reach: Reach::Drive,
            changed_only,
        }
    }
}

/// What every scan carries whatever its kind: the store's salt (for the Full scan record's keys), the files the
/// person said to ignore, what they chose to leave out of scans, and folders never opened whatever their name
/// (Clotr's own data folder).
#[derive(Clone, Default)]
pub struct PlanCtx {
    pub salt: String,
    pub ignored: Arc<IgnoredFiles>,
    pub excluded: Arc<Exclusions>,
    pub skip: Vec<PathBuf>,
    /// The places a person keeps their own files (the user folder, Desktop, Documents...): never taken for an
    /// installed program, whatever sits loose in them.
    pub personal: Vec<PathBuf>,
    /// The known folders with their keys (`floor()`) and the home folder, which a drive's files are placed by.
    pub places: Vec<(PathBuf, String)>,
    pub home: Option<PathBuf>,
}

/// Everything one walk needs. Cloned for the counting walk beside it, so both walk exactly the same files.
#[derive(Clone)]
pub struct Plan {
    pub roots: Vec<Root>,
    pub limits: WalkLimits,
    pub ctx: PlanCtx,
    /// The last Full scan's record, for `changed_only` roots.
    pub baseline: Option<Arc<Baseline>>,
    /// A Full scan keeps a key and a stamp for every file it could read, for the next Quick one.
    pub record: bool,
    /// Code projects are counted, never read (Quick and Full, unless the person turned that off).
    pub leave_projects: bool,
    /// Files made to hold a key or a password are counted, never read (Quick and Full, unless the developer switch
    /// is on).
    pub leave_secrets: bool,
}

impl Plan {
    /// Folders I choose: each folder in full, with the usual caps.
    pub fn chosen(folders: Vec<(PathBuf, String)>, ctx: PlanCtx) -> Plan {
        Plan {
            roots: folders.into_iter().map(|(p, l)| Root::folder(p, l)).collect(),
            limits: WalkLimits::default(),
            ctx,
            baseline: None,
            record: false,
            leave_projects: false,
            leave_secrets: false,
        }
    }

    /// Full: every fixed drive, every folder but Windows' own and installed programs, no file cap, and a record kept
    /// for the next Quick or Full scan. Code projects and secret files are counted and left out unless `dev` (the
    /// developer switch). With the last Full scan's record (`since`), only what's new or changed since: an unchanged
    /// file keeps its place in the new record unread.
    pub fn full(drives: Vec<PathBuf>, since: Option<Arc<Baseline>>, dev: bool, ctx: PlanCtx) -> Plan {
        let changed_only = since.is_some();
        Plan {
            roots: drives.into_iter().map(|d| Root::drive(d, changed_only)).collect(),
            limits: WalkLimits {
                max_depth: MAX_DEPTH_FULL,
                max_files: usize::MAX,
            },
            ctx,
            baseline: since,
            record: true,
            leave_projects: !dev,
            leave_secrets: !dev,
        }
    }

    /// Quick: the places people keep their own files (Downloads, Desktop, Documents, Pictures), with code projects
    /// counted and left out unless the person turned that off. Once a Full scan has left its record, only what's new
    /// or changed since in those same places: a Full scan is where the rest of the PC is read.
    pub fn quick(
        floor: Vec<(PathBuf, String)>,
        baseline: Option<Arc<Baseline>>,
        leave_projects: bool,
        dev: bool,
        ctx: PlanCtx,
    ) -> Plan {
        let changed_only = baseline.is_some();
        let roots = floor
            .into_iter()
            .map(|(p, l)| Root {
                changed_only,
                ..Root::folder(p, l)
            })
            .collect();
        Plan {
            roots,
            limits: WalkLimits {
                max_depth: MAX_DEPTH_FULL,
                max_files: MAX_FILES,
            },
            ctx,
            baseline,
            record: false,
            leave_projects,
            leave_secrets: !dev,
        }
    }
}

// ---------- The walker ----------

/// What a walk saw besides the files it handed over: what it skipped, the Full scan record when the plan keeps
/// one, and whether it got through every root (not stopped by a cap, a cancel or the page going away).
pub struct Walked {
    pub counts: Counts,
    pub records: Vec<(u64, u64)>,
    pub complete: bool,
}

/// Walks `plan`, handing each file it can read to `sink` the moment it's found, never as a list: every root's own
/// files first, then each root's folders depth first, each folder's own files before the folders inside it. So a
/// file sitting right on the Desktop is never crowded out of the file cap by one big project folder beside it, and
/// what's held in memory is only the folders still to visit along the current path. Stops at the cap, at `cancel`,
/// or when `sink` answers false. `published`, when given, gets the counts as each folder finishes.
pub fn walk_plan(
    plan: &Plan,
    cancel: &AtomicBool,
    published: Option<&Mutex<Counts>>,
    sink: impl FnMut(Candidate) -> bool,
) -> Walked {
    walk_with(plan, cancel, published, true, sink)
}

fn walk_with(
    plan: &Plan,
    cancel: &AtomicBool,
    published: Option<&Mutex<Counts>>,
    open_zips: bool,
    sink: impl FnMut(Candidate) -> bool,
) -> Walked {
    let mut walk = Walk {
        plan,
        cancel,
        published,
        counts: Counts::default(),
        open_zips,
        zip_budget: ZIP_BUDGET,
        emitted: 0,
        records: Vec::new(),
        sink,
    };
    let complete = walk.run();
    if let Some(p) = published {
        *lock(p) = walk.counts;
    }
    Walked {
        counts: walk.counts,
        records: walk.records,
        complete,
    }
}

/// The old shape, for the tests: every root a folder, every file collected.
#[cfg(test)]
pub fn walk(roots: &[(PathBuf, String)], limits: &WalkLimits) -> (Vec<Candidate>, Counts) {
    let plan = Plan {
        roots: roots.iter().map(|(p, l)| Root::folder(p.clone(), l.clone())).collect(),
        limits: *limits,
        ctx: PlanCtx::default(),
        baseline: None,
        record: false,
        leave_projects: false,
        leave_secrets: false,
    };
    let mut files = Vec::new();
    let walked = walk_plan(&plan, &AtomicBool::new(false), None, |c| {
        files.push(c);
        true
    });
    (files, walked.counts)
}

/// The folder being listed: its own name as Windows shows it (for the page) and in lower case (for the skip list),
/// and where it is the way a person would look for it (`place_of`).
struct Place {
    lower: String,
    name: String,
    top: String,
    sub: Vec<String>,
}

/// The folders from `base` down to `dir`, as Windows shows their names: `Some(vec![])` for `base` itself, `None`
/// when `dir` isn't inside it. Compared without case, the way Windows does.
fn below(base: &Path, dir: &Path) -> Option<Vec<String>> {
    fn same_component(a: Component<'_>, b: Component<'_>) -> bool {
        a.as_os_str().to_string_lossy().eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
    }

    let mut dir_components = dir.components();
    for base_component in base.components() {
        let dir_component = dir_components.next()?;
        if !same_component(base_component, dir_component) {
            return None;
        }
    }
    Some(dir_components.map(|component| component.as_os_str().to_string_lossy().into_owned()).collect())
}

/// How many folders below the top place a file's place shows before it's shortened to the first two, "…" and the
/// one the file is in.
const PLACE_PARTS: usize = 3;

/// Where `dir` is, the way a person would look for it: its top place and the folders below that. In a folder root
/// (Quick's places, a chosen folder) the top is the root itself. On a drive it's the known folder it sits in, else
/// the first folder below the home folder, else the drive with its first folder; a drive's own root is "C:".
fn place_of(root: &Root, ctx: &PlanCtx, dir: &Path) -> (String, Vec<String>) {
    let (top, mut sub) = match root.reach {
        Reach::Folder => (root.label.clone(), below(&root.path, dir).unwrap_or_default()),
        Reach::Drive => {
            let known = ctx
                .places
                .iter()
                .find_map(|(p, key)| below(p, dir).map(|sub| (key.clone(), sub)));
            let home = || {
                let home = ctx.home.as_ref()?;
                let mut rest = below(home, dir)?;
                if rest.is_empty() {
                    let name = home.file_name()?.to_string_lossy().into_owned();
                    return Some((name, rest));
                }
                let first = rest.remove(0);
                Some((first, rest))
            };
            known.or_else(home).unwrap_or_else(|| {
                let mut rest = below(&root.path, dir).unwrap_or_default();
                if rest.is_empty() {
                    (root.label.clone(), rest)
                } else {
                    let first = rest.remove(0);
                    (format!("{} › {first}", root.label), rest)
                }
            })
        }
    };
    if sub.len() > PLACE_PARTS {
        let last = sub.pop().unwrap_or_default();
        sub.truncate(PLACE_PARTS - 1);
        sub.push("…".to_string());
        sub.push(last);
    }
    (top, sub)
}

/// What a folder inherits from the folders around it: it sits inside a code project, inside a folder of sign-in
/// material (`.ssh`, `.aws`), or inside `AppData`, where a folder named `Logs` or `Cache` is an app's own.
#[derive(Clone, Copy, Default)]
struct Mark {
    project: bool,
    secret: bool,
    appdata: bool,
}

struct Walk<'a, F: FnMut(Candidate) -> bool> {
    plan: &'a Plan,
    cancel: &'a AtomicBool,
    published: Option<&'a Mutex<Counts>>,
    counts: Counts,
    /// Off only for the by-hand count of a real PC, which never opens a file: a zip is handed over as itself.
    open_zips: bool,
    zip_budget: u64,
    emitted: usize,
    records: Vec<(u64, u64)>,
    sink: F,
}

impl<F: FnMut(Candidate) -> bool> Walk<'_, F> {
    fn run(&mut self) -> bool {
        let plan = self.plan;
        let mut below = Vec::with_capacity(plan.roots.len());
        for root in &plan.roots {
            let mut dirs = Vec::new();
            // A chosen folder inside one the person left out stays out too.
            if plan.ctx.excluded.folder(&root.path) {
                self.counts.excluded += 1;
                below.push(dirs);
                continue;
            }
            if !self.folder(root, &root.path, 0, Mark::default(), &mut dirs) {
                return false;
            }
            below.push(dirs);
        }
        for (root, dirs) in plan.roots.iter().zip(below) {
            if !self.descend(root, dirs) {
                return false;
            }
        }
        true
    }

    /// A root's folders, depth first: a stack holding, for each folder open along the way, its subfolders still to
    /// visit, each with whether it sits inside a code project.
    fn descend(&mut self, root: &Root, top: Vec<(PathBuf, Mark)>) -> bool {
        let mut stack = vec![(top.into_iter(), 1usize)];
        loop {
            let Some((todo, depth)) = stack.last_mut() else {
                return true;
            };
            let depth = *depth;
            let Some((dir, mark)) = todo.next() else {
                stack.pop();
                continue;
            };
            if depth > self.plan.limits.max_depth {
                self.counts.capped_depth = true;
                continue;
            }
            let mut dirs = Vec::new();
            if !self.folder(root, &dir, depth, mark, &mut dirs) {
                return false;
            }
            if !dirs.is_empty() {
                stack.push((dirs.into_iter(), depth + 1));
            }
        }
    }

    /// One folder's own files, handed over in listing order; the subfolders a walk may open go into `dirs`, decided
    /// once the listing is through, so a `build` folder can be judged by the `package.json` beside it. The listing is
    /// read whole first, since a `.git` or a `package.json` anywhere in it makes the folder a code project, which
    /// decides what happens to every file in it. A root (Desktop, a chosen folder, a drive) is never a project
    /// itself, only what's inside it.
    fn folder(&mut self, root: &Root, dir: &Path, depth: usize, mark: Mark, dirs: &mut Vec<(PathBuf, Mark)>) -> bool {
        // The places a person keeps their own files (their home folder, Desktop, Documents...) are never taken for
        // an app's own storage, whatever sits loose in them.
        let personal = depth == 0 || self.plan.ctx.personal.iter().any(|p| same_path(p, dir));
        // Apps' own storage, anywhere inside AppData (Local, LocalLow, Roaming): never opened at all, unless the
        // developer switch is on. It's an app's own, not what a person writes or saves, the same reasoning as the
        // finer rules below, just for the whole of AppData rather than one cache or log folder at a time.
        if !personal && mark.appdata && self.plan.leave_secrets {
            self.counts.app_storage += 1;
            return true;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return true; // removed, or no permission: a scan never stops because one folder is gone
        };
        let at_drive_root = root.reach == Reach::Drive && depth == 0;
        let (top, sub) = place_of(root, &self.plan.ctx, dir);
        let place = Place {
            lower: dir.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default(),
            name: dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| root.label.clone()),
            top,
            sub,
        };
        let mut listing = Vec::new();
        let mut installed = skiplist::Installed::default();
        let mut made = skiplist::AppMade::default();
        let mut marker = false;
        for entry in entries.flatten() {
            if self.cancel.load(Ordering::Relaxed) {
                return false;
            }
            // DirEntry::metadata never follows a reparse point (a link's target, or a loop back to an ancestor),
            // and on Windows it comes with the listing itself, so a drive's worth of files costs no extra calls.
            let Ok(meta) = entry.metadata() else { continue };
            if is_link(meta.file_attributes()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let lower = name.to_ascii_lowercase();
            let dir_entry = is_dir(meta.file_attributes());
            installed.note(&lower, dir_entry);
            made.saw(&lower, dir_entry);
            marker |= skiplist::project_marker(&lower, dir_entry);
            listing.push((entry, meta, name, lower));
        }
        // A program or a code project is never taken from a stray file in a personal place either: a home folder
        // often holds a stray package.json, and Downloads a setup's .exe with its .dll files.
        // A cache marked as one, or an app's page storage: never opened further, inside a project or not.
        if !personal && made.is_app_data() {
            if !(mark.project && self.plan.leave_projects) {
                self.counts.app_data += 1;
            }
            return true;
        }
        // An installed program or game, by what its own folder holds (an uninstaller, a game store's files, an
        // .exe with its libraries): never opened further. A code project never counts as one.
        if !personal && !marker && installed.is_program() {
            if !(mark.project && self.plan.leave_projects) {
                self.counts.programs += 1;
            }
            return true;
        }
        let project = mark.project || (!personal && marker);
        let left_out = project && self.plan.leave_projects;
        if left_out && !mark.project {
            self.counts.code_projects += 1;
        }
        let mark = Mark { project, ..mark };
        let mut siblings = skiplist::Siblings::default();
        let mut subdirs: Vec<(PathBuf, String)> = Vec::new();
        for (entry, meta, name, lower) in listing {
            if self.cancel.load(Ordering::Relaxed) {
                return false;
            }
            if self.at_cap() {
                self.counts.capped_files = true;
                return false;
            }
            let attrs = meta.file_attributes();
            if is_dir(attrs) {
                if self.opens(root, &lower, at_drive_root) {
                    subdirs.push((entry.path(), lower));
                }
                continue;
            }
            siblings.note(&lower);
            if is_hidden_or_system(attrs) || (at_drive_root && DRIVE_ROOT_FILE_SKIPS.contains(&lower.as_str())) {
                continue;
            }
            if left_out {
                self.count_project_file(&lower, &place);
                continue;
            }
            if !self.file(root, entry.path(), name, &lower, &place, &meta, mark) {
                return false;
            }
        }
        for (path, lower) in subdirs {
            if self.plan.ctx.skip.iter().any(|s| same_path(s, &path)) {
                continue;
            }
            let verdict = if skiplist::app_folder(&lower, mark.appdata) {
                Verdict::AppData
            } else {
                skiplist::folder(&lower, &place.lower, &siblings, &path)
            };
            let inner = Mark {
                appdata: mark.appdata || lower == "appdata",
                ..mark
            };
            match verdict {
                // Inside a project left out, what's skipped anyway isn't counted twice.
                Verdict::Dev | Verdict::Program | Verdict::AppData if left_out => {}
                Verdict::Dev => self.counts.dev_folders += 1,
                Verdict::Vault => self.counts.vaults += 1,
                Verdict::Program => self.counts.programs += 1,
                Verdict::AppData => self.counts.app_data += 1,
                _ if self.plan.ctx.excluded.folder(&path) => self.counts.excluded += 1,
                // Sign-in material is walked like any folder, so a scan leaving it out can still count its files.
                Verdict::Secret => dirs.push((path, Mark { secret: true, ..inner })),
                Verdict::Read => dirs.push((path, inner)),
            }
        }
        if let Some(p) = self.published {
            *lock(p) = self.counts;
        }
        true
    }

    /// A file inside a code project a scan leaves out: counted when it's one Clotr would have read, never opened.
    fn count_project_file(&mut self, lower: &str, place: &Place) {
        let ext = Path::new(lower).extension().and_then(|e| e.to_str()).unwrap_or("");
        let reads = ext == "zip" || category_for(lower, ext).is_some();
        if reads && skiplist::file(lower, ext, &place.lower, Path::new("")) == Verdict::Read {
            self.counts.project_files += 1;
        }
    }

    fn opens(&self, root: &Root, lower: &str, at_drive_root: bool) -> bool {
        match root.reach {
            Reach::Folder => !skip_dir_name(lower),
            Reach::Drive => {
                !DRIVE_ANYWHERE_SKIPS.contains(&lower) && !(at_drive_root && DRIVE_ROOT_SKIPS.contains(&lower))
            }
        }
    }

    fn at_cap(&self) -> bool {
        self.emitted + self.counts.too_big >= self.plan.limits.max_files
    }

    fn emit(&mut self, candidate: Candidate) -> bool {
        self.emitted += 1;
        (self.sink)(candidate)
    }

    /// One plain file: left out unless it's a format Clotr reads (or a .zip); counted as online-only or too big
    /// rather than opened; on Quick's pass across the drives, left out when the Full scan saw it just as it is. A
    /// Full scan records only a file it hands over to be read, so one it never opened is new to the next Quick one.
    #[allow(clippy::too_many_arguments)]
    fn file(
        &mut self,
        root: &Root,
        path: PathBuf,
        name: String,
        lower: &str,
        place: &Place,
        meta: &fs::Metadata,
        mark: Mark,
    ) -> bool {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match skiplist::file(lower, &ext, &place.lower, &path) {
            Verdict::Vault => {
                self.counts.vaults += 1;
                return true;
            }
            Verdict::Dev => {
                self.counts.dev_files += 1;
                return true;
            }
            Verdict::AppData => {
                self.counts.app_data += 1;
                return true;
            }
            _ => {}
        }
        let is_zip = ext == "zip";
        let category = category_for(&name, &ext);
        if !is_zip && category.is_none() {
            return true;
        }
        let secret = !is_zip && (mark.secret || skiplist::secret_file(lower, &ext, &place.lower));
        if secret && self.plan.leave_secrets {
            self.counts.secret_files += 1;
            return true;
        }
        if self.plan.ctx.excluded.file(&path, &ext) {
            self.counts.excluded += 1;
            return true;
        }
        let size = meta.len();
        let mut record = None;
        let mut earlier = false;
        if self.plan.record || root.changed_only {
            let key = baseline_key(&self.plan.ctx.salt, &path);
            let stamp = baseline_stamp(size, meta.last_write_time());
            let unchanged = root.changed_only && self.plan.baseline.as_ref().is_some_and(|b| b.unchanged(key, stamp));
            // A Full scan re-reads an unchanged file anyway when its last record said it had something worth a
            // look, so Results can show whether that's still true; everything else unchanged is kept in
            // the new record without a second read.
            earlier = unchanged && self.plan.record && self.plan.baseline.as_ref().is_some_and(|b| b.flagged(key));
            if unchanged && !earlier {
                if self.plan.record {
                    self.records.push((key, stamp));
                }
                return true;
            }
            record = self.plan.record.then_some((key, stamp));
        }
        if is_online_only(meta.file_attributes()) {
            self.counts.online_only += 1;
            return true; // never opened: opening it would make the cloud drive download it
        }
        if self.plan.ctx.ignored.contains(&path) {
            return true;
        }
        if is_zip && self.open_zips {
            self.records.extend(record);
            return self.zip_entries(&path, &name, place, mark.project, earlier);
        }
        let Some((kind, cap)) = category.or(is_zip.then_some(("zip", u64::MAX))) else {
            return true;
        };
        if size > cap {
            self.counts.too_big += 1;
            return true;
        }
        self.records.extend(record);
        self.emit(Candidate {
            path,
            name,
            folder: place.top.clone(),
            place: place.sub.clone(),
            parent: place.name.clone(),
            ext,
            size,
            kind,
            zip_entry: None,
            project: mark.project,
            secret,
            app_signin: secret && skiplist::app_signin(lower, &place.lower),
            on_disk_size: size,
            modified: meta.last_write_time(),
            earlier,
        })
    }

    /// Every entry inside one `.zip` that Clotr knows how to read (4.8), counted the same careful way a plain file
    /// is: this only reads the zip's own directory listing (`by_index_raw`, which never decompresses or checks a
    /// password), so "counts first, no bytes read" still holds. A folder entry is skipped; an entry whose name
    /// doesn't match a format Clotr reads is left out exactly like it would be outside a zip, which is also why
    /// another `.zip` nested inside is never opened: nothing here recurses into one. An encrypted entry is still
    /// counted here (its name and declared size cost nothing to read) and only fails once something actually tries
    /// to read its bytes, the same "not read" path a locked file already takes. `zip_budget` is shared across every
    /// zip this whole scan meets, so one large zip can't spend what the next one needed.
    fn zip_entries(&mut self, zip_path: &Path, zip_name: &str, place: &Place, project: bool, earlier: bool) -> bool {
        // The zip's own size and modified time, never an entry's declared size: the changed-since-scan guard acts
        // on the real file at `path`, which for an entry inside a zip is the zip itself.
        let (zip_size, zip_modified) = match fs::metadata(zip_path) {
            Ok(meta) => (meta.len(), meta.last_write_time()),
            Err(_) => return true,
        };
        let Ok(file) = fs::File::open(zip_path) else { return true };
        let Ok(mut archive) = zip::ZipArchive::new(file) else {
            return true;
        };
        for i in 0..archive.len() {
            if self.cancel.load(Ordering::Relaxed) {
                return false;
            }
            if self.at_cap() {
                self.counts.capped_files = true;
                return false;
            }
            let Ok(entry) = archive.by_index_raw(i) else { continue };
            if entry.is_dir() {
                continue;
            }
            let Ok(entry_name) = entry.name() else { continue };
            let entry_name = entry_name.into_owned();
            let base_name = Path::new(&entry_name)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| entry_name.clone());
            let ext = Path::new(&base_name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let Some((kind, cap)) = category_for(&base_name, &ext) else {
                continue;
            };
            // Inside a zip only a single file's own rules apply: its lock files and templates, its secret files,
            // and the types the person left out. A vault zipped up is still counted as one, never opened.
            match skiplist::file(&base_name.to_lowercase(), &ext, "", zip_path) {
                Verdict::Vault => {
                    self.counts.vaults += 1;
                    continue;
                }
                Verdict::Dev => {
                    self.counts.dev_files += 1;
                    continue;
                }
                Verdict::AppData => {
                    self.counts.app_data += 1;
                    continue;
                }
                _ => {}
            }
            let secret = skiplist::secret_file(&base_name.to_lowercase(), &ext, "");
            if secret && self.plan.leave_secrets {
                self.counts.secret_files += 1;
                continue;
            }
            if self.plan.ctx.excluded.file(Path::new(""), &ext) {
                self.counts.excluded += 1;
                continue;
            }
            let size = entry.size();
            if size > cap || size > self.zip_budget {
                self.counts.too_big += 1;
                continue;
            }
            self.zip_budget -= size;
            let candidate = Candidate {
                path: zip_path.to_path_buf(),
                name: format!("{base_name} (in {zip_name})"),
                folder: place.top.clone(),
                place: place.sub.clone(),
                parent: place.name.clone(),
                ext,
                size,
                kind,
                zip_entry: Some(entry_name),
                project,
                secret,
                app_signin: false,
                on_disk_size: zip_size,
                modified: zip_modified,
                earlier,
            };
            if !self.emit(candidate) {
                return false;
            }
        }
        true
    }
}

// ---------- Reading ----------

/// The format's own cap for a candidate's kind ("text", "doc" or "picture"), the same one the walker counted it
/// against.
fn cap_of(kind: &str) -> u64 {
    match kind {
        "doc" => DOC_CAP,
        "picture" => PICTURE_CAP,
        _ => TEXT_CAP,
    }
}

/// Everything `from` holds, as long as that's no more than `limit` bytes; past that it's an error ("not read"),
/// never a file cut short and never more than `limit + 1` bytes held in memory on the way to finding out.
fn read_capped(from: impl Read, limit: u64) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    from.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bigger than it was counted as",
        ));
    }
    Ok(bytes)
}

/// One entry's bytes, read straight out of its zip (4.8): reopens the zip fresh, same as a plain file is read
/// fresh each time, so nothing about an entry is ever cached. `by_name`, never `by_index`: the index inside this
/// fresh archive handle isn't guaranteed to land on the same entry `by_index_raw` saw while walking. Held to the
/// size the walker counted: a zip's declared size is only a claim, and its compressed data can unpack to far
/// more, so an entry that runs past what it claimed is "not read" rather than unpacked in full.
fn read_zip_entry(zip_path: &Path, entry_name: &str, counted: u64) -> std::io::Result<Vec<u8>> {
    let file = fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let entry = archive.by_name(entry_name)?;
    read_capped(entry, counted)
}

/// Quick's places (4.1, 4.2): Downloads, Desktop, Documents and Pictures, where people keep their own files. A known
/// folder Windows can't resolve is left out, not an error: the rest of the scan still runs.
pub fn floor() -> Vec<(PathBuf, String)> {
    distinct_places(
        [
            (downloads(), "downloads"),
            (desktop(), "desktop"),
            (documents(), "documents"),
            (pictures(), "pictures"),
        ]
        .into_iter()
        .filter_map(|(p, l)| Some((p?, l.to_string())))
        .collect(),
    )
}

/// Places with any that sit inside another left out (a Pictures folder moved into Documents, say), so no file is
/// read twice in one scan.
fn distinct_places(places: Vec<(PathBuf, String)>) -> Vec<(PathBuf, String)> {
    let key = |p: &Path| p.to_string_lossy().to_lowercase().trim_end_matches('\\').to_string();
    let keys: Vec<String> = places.iter().map(|(p, _)| key(p)).collect();
    places
        .into_iter()
        .enumerate()
        .filter(|(i, _)| {
            let me = &keys[*i];
            // Left out when it's inside another place, or the same folder as one listed before it.
            !keys
                .iter()
                .enumerate()
                .any(|(j, other)| (j < *i && other == me) || me.starts_with(&format!("{other}\\")))
        })
        .map(|(_, place)| place)
        .collect()
}

/// The folders the person chose in Windows' own picker, each named by its own folder name.
pub fn chosen_roots(paths: &[PathBuf]) -> Vec<(PathBuf, String)> {
    paths
        .iter()
        .map(|p| {
            let label = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            (p.clone(), label)
        })
        .collect()
}

/// Every fixed drive Windows lists (A: to Z:): never a removable, network, optical or RAM drive.
pub fn fixed_drives() -> Vec<PathBuf> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    const DRIVE_FIXED: u32 = 3;
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .filter_map(|i| {
            let root = format!("{}:\\", (b'A' + i) as char);
            let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            let fixed = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) } == DRIVE_FIXED;
            fixed.then(|| PathBuf::from(root))
        })
        .collect()
}

// ---------- One scan, streamed ----------

/// How many files one `batch` hands the page, and how many the walker may run ahead of it.
const BATCH: usize = 64;
const AHEAD: usize = 256;
/// The most one batch reads ahead and holds for the page, by the sizes the walker counted: a batch stops short
/// once its files add up to this, so a folder of big documents never holds more than about this much in memory
/// (one file bigger than this goes in a batch of its own).
const BATCH_BYTES: u64 = 16 * 1024 * 1024;
/// How many of a batch's files are read at once. Opening a file Windows hasn't touched in a while is slow (the
/// disk, and an antivirus checking it on open), and one at a time a batch of 64 cold files kept the page's
/// checks waiting for over a second. Eight cuts that wait several times over and holds no more bytes than before.
const READERS: usize = 8;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What both walks report while they run, shared with their threads.
#[derive(Default)]
struct Progress {
    cancel: AtomicBool,
    failed: AtomicBool,
    walked: AtomicBool,
    complete: AtomicBool,
    counted_files: AtomicU64,
    counted_bytes: AtomicU64,
    counted: AtomicBool,
    counts: Mutex<Counts>,
    records: Mutex<Vec<(u64, u64)>>,
}

fn guard_walker<T>(progress: &Progress, walk: impl FnOnce() -> T) -> Option<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(walk)) {
        Ok(result) => Some(result),
        Err(_) => {
            eprintln!("[Clotr] a scan walker stopped after a panic");
            progress.failed.store(true, Ordering::SeqCst);
            progress.cancel.store(true, Ordering::SeqCst);
            None
        }
    }
}

/// The files handed to the page so far that are still held: the ones it hasn't finished checking yet (`live`, until
/// a batch call names them as settled and says which had finds) and the ones with finds (`kept`, for Results'
/// actions, by index). The page checks several at once and asks for the next batch before the last one is through,
/// so `live` can span two batches. `held` is their bytes, read as each batch was handed over and kept only until
/// the page takes each one.
/// `first` maps a file's content (its size, extension and a hash of its bytes) to the index it was first handed
/// over under: a key, never the bytes or a path.
#[derive(Default)]
struct Listed {
    next: usize,
    live: HashMap<usize, Candidate>,
    kept: HashMap<usize, Candidate>,
    held: HashMap<usize, std::io::Result<Vec<u8>>>,
    first: HashMap<(u64, [u8; 16]), usize>,
}

/// A file as the page sees it: never its path.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shown {
    pub index: usize,
    pub name: String,
    pub folder: String,
    /// The folders between `folder` and the file, by name only and shortened ("…" stands for the ones left out).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub place: Vec<String>,
    /// The folder it sits in, by name only.
    pub parent: String,
    pub ext: String,
    pub size: u64,
    pub kind: &'static str,
    /// The same bytes were already handed over under this index (another copy of the same file): Results shows the
    /// two as one entry. Left out for a file seen for the first time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dup_of: Option<usize>,
    /// It sits inside a code project.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub project: bool,
    /// It's a file made to hold a key or a password (read only with the developer switch on, or in a chosen folder).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub secret: bool,
    /// It's an app's own sign-in, kept in the app's own folder.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub app_signin: bool,
    /// A Full scan only: unchanged since the last one, read again anyway because its record said it had something
    /// worth a look. The page never counts it towards "files that changed".
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub earlier: bool,
    /// The bytes the check reads (the head of a JPEG, all of anything else), which the time left weighs.
    pub reads: u64,
}

/// A file's content key for `dupOf`: its size, and SHA-256 over its extension and bytes, cut to 16 bytes. An empty
/// file has no key (every empty file would otherwise be "the same").
fn content_key(ext: &str, bytes: &[u8]) -> Option<(u64, [u8; 16])> {
    use sha2::{Digest, Sha256};
    if bytes.is_empty() {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(ext.as_bytes());
    hasher.update(b"\0");
    hasher.update(bytes);
    let mut key = [0u8; 16];
    key.copy_from_slice(&hasher.finalize()[..16]);
    Some((bytes.len() as u64, key))
}

/// A candidate's bytes, read fresh: a zip entry out of its zip, a plain file held to its format's cap.
fn read_candidate(c: &Candidate) -> std::io::Result<Vec<u8>> {
    match &c.zip_entry {
        Some(entry_name) => read_zip_entry(&c.path, entry_name, c.size),
        None => fs::File::open(&c.path).and_then(|file| read_capped(file, cap_of(c.kind))),
    }
}

/// What the check reads of a candidate: a JPEG's head, everything else in full. Save a copy reads it fresh and whole.
fn read_for_check(c: &Candidate) -> std::io::Result<Vec<u8>> {
    if !c.head_only() {
        return read_candidate(c);
    }
    let mut bytes = Vec::new();
    fs::File::open(&c.path)?.take(JPEG_HEAD).read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[derive(serde::Serialize)]
pub struct Total {
    pub files: u64,
    pub bytes: u64,
    /// The counting walk has finished: `files` and `bytes` are the whole run's, so the progress bar can show a share.
    pub counted: bool,
}

#[derive(serde::Serialize)]
pub struct Batch {
    pub files: Vec<Shown>,
    /// The walk is over and every file it found has been handed over.
    pub done: bool,
    pub counts: Counts,
    pub total: Total,
}

/// One scan's state, kept only in memory and dropped when the next scan starts or Clotr closes (4.0: results
/// never outlive the run). The walker runs on its own thread and hands files over a small channel, so however big
/// the drive, only one batch's paths and the files worth a look are ever held here. A second walk of the same plan
/// only counts files and bytes, for the progress bar and the time left.
pub struct ScanRun {
    generation: u64,
    progress: Arc<Progress>,
    readers: usize,
    keeps_record: bool,
    salt: String,
    rx: Mutex<Option<Receiver<Candidate>>>,
    listed: Mutex<Listed>,
}

impl ScanRun {
    pub fn start(plan: Plan) -> ScanRun {
        Self::start_with(plan, READERS)
    }

    fn start_with(plan: Plan, readers: usize) -> ScanRun {
        #[cfg(test)]
        {
            return Self::start_inner(plan, readers, false);
        }
        #[cfg(not(test))]
        {
            Self::start_inner(plan, readers)
        }
    }

    #[cfg(test)]
    fn start_panicking(plan: Plan) -> ScanRun {
        Self::start_inner(plan, READERS, true)
    }

    fn start_inner(plan: Plan, readers: usize, #[cfg(test)] panic_walkers: bool) -> ScanRun {
        let generation = NEXT_SCAN_GENERATION.fetch_add(1, Ordering::Relaxed);
        let progress = Arc::new(Progress::default());
        let keeps_record = plan.record;
        let salt = plan.ctx.salt.clone();
        let (tx, rx) = sync_channel(AHEAD);
        let mut counting = plan.clone();
        counting.record = false;
        let p = progress.clone();
        std::thread::spawn(move || {
            if let Some(walked) = guard_walker(&p, || {
                #[cfg(test)]
                if panic_walkers {
                    panic!("synthetic walker panic");
                }
                walk_plan(&plan, &p.cancel, Some(&p.counts), |c| tx.send(c).is_ok())
            }) {
                *lock(&p.records) = walked.records;
                p.complete.store(walked.complete, Ordering::SeqCst);
            }
            p.walked.store(true, Ordering::SeqCst);
            drop(tx); // only now: the page's next batch hears the walk is over, with its counts already in place
        });
        let p = progress.clone();
        std::thread::spawn(move || {
            if let Some(walked) = guard_walker(&p, || {
                #[cfg(test)]
                if panic_walkers {
                    panic!("synthetic walker panic");
                }
                walk_plan(&counting, &p.cancel, None, |c| {
                    p.counted_files.fetch_add(1, Ordering::Relaxed);
                    p.counted_bytes.fetch_add(c.check_bytes(), Ordering::Relaxed);
                    true
                })
            }) {
                if walked.complete || walked.counts.capped_files {
                    p.counted.store(true, Ordering::SeqCst);
                }
            }
        });
        ScanRun {
            generation,
            progress,
            readers: readers.max(1),
            keeps_record,
            salt,
            rx: Mutex::new(Some(rx)),
            listed: Mutex::default(),
        }
    }

    /// The id attached to this run's result cards and every action on their indices.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// A by-index action is valid only for the scan whose results supplied the index.
    pub fn accepts_generation(&self, generation: u64) -> bool {
        self.generation == generation
    }

    /// The next files to read, up to BATCH, waiting at most `wait` for the first; each gets the index the page reads
    /// it by. `settled` names the files the page has finished checking since its last call, and `keep` the ones
    /// among them it still needs (finds, or a file it couldn't open): those stay for Results, and every other settled
    /// file is let go, bytes and all. A file not yet settled stays as it is, so the page can check one batch while
    /// it asks for the next.
    pub fn batch(&self, settled: &[usize], keep: &[usize], wait: Duration) -> Result<Batch, &'static str> {
        if self.progress.failed.load(Ordering::SeqCst) {
            self.cancel();
            return Err("scan-failed");
        }
        {
            let mut listed = lock(&self.listed);
            for index in settled {
                listed.held.remove(index);
                if let Some(c) = listed.live.remove(index) {
                    if keep.contains(index) {
                        listed.kept.insert(*index, c);
                    }
                }
            }
        }
        let mut got: Vec<Candidate> = Vec::new();
        let mut done = false;
        if let Some(rx) = lock(&self.rx).as_ref() {
            match rx.recv_timeout(wait) {
                Ok(c) => {
                    let mut bytes = c.size;
                    got.push(c);
                    while got.len() < BATCH && bytes < BATCH_BYTES {
                        match rx.try_recv() {
                            Ok(c) => {
                                bytes += c.size;
                                got.push(c);
                            }
                            Err(TryRecvError::Empty) => break,
                            Err(TryRecvError::Disconnected) => {
                                done = true;
                                break;
                            }
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => done = true,
            }
        } else {
            done = true;
        }
        if self.progress.failed.load(Ordering::SeqCst) {
            self.cancel();
            return Err("scan-failed");
        }
        // Each file is read here, once, outside every lock (a Stop never waits on a read), and hashed on the way:
        // the page's own read then takes these same bytes, and a later copy of a file already handed over says so.
        let read = self.read_all(got);
        let mut listed = lock(&self.listed);
        let files = read
            .into_iter()
            .map(|(c, bytes)| {
                let index = listed.next;
                listed.next += 1;
                // Only a whole file has a content key: two photos can share their first quarter megabyte.
                let key = bytes
                    .as_ref()
                    .ok()
                    .filter(|_| !c.head_only())
                    .and_then(|b| content_key(&c.ext, b));
                let dup_of = key.and_then(|k| match listed.first.get(&k) {
                    Some(&first) => Some(first),
                    None => {
                        listed.first.insert(k, index);
                        None
                    }
                });
                let shown = Shown {
                    index,
                    name: c.name.clone(),
                    folder: c.folder.clone(),
                    place: c.place.clone(),
                    parent: c.parent.clone(),
                    ext: c.ext.clone(),
                    size: c.size,
                    kind: c.kind,
                    dup_of,
                    project: c.project,
                    secret: c.secret,
                    app_signin: c.app_signin,
                    earlier: c.earlier,
                    reads: c.check_bytes(),
                };
                listed.live.insert(index, c);
                listed.held.insert(index, bytes);
                shown
            })
            .collect();
        let p = &self.progress;
        Ok(Batch {
            files,
            done,
            counts: *lock(&p.counts),
            total: Total {
                files: p.counted_files.load(Ordering::Relaxed),
                bytes: p.counted_bytes.load(Ordering::Relaxed),
                counted: p.counted.load(Ordering::SeqCst),
            },
        })
    }

    /// A batch's files read several at once, each still read whole by one thread, and handed back in the order the
    /// walk found them.
    fn read_all(&self, got: Vec<Candidate>) -> Vec<(Candidate, std::io::Result<Vec<u8>>)> {
        let read_one = |c: &Candidate| {
            if self.is_cancelled() {
                Err(std::io::Error::other("stopped"))
            } else {
                read_for_check(c)
            }
        };
        let threads = self.readers.min(got.len());
        let mut bytes: Vec<Option<std::io::Result<Vec<u8>>>> = (0..got.len()).map(|_| None).collect();
        if threads <= 1 {
            for (slot, c) in bytes.iter_mut().zip(&got) {
                *slot = Some(read_one(c));
            }
        } else {
            let next = AtomicUsize::new(0);
            std::thread::scope(|scope| {
                let handles: Vec<_> = (0..threads)
                    .map(|_| {
                        scope.spawn(|| {
                            let mut mine = Vec::new();
                            loop {
                                let i = next.fetch_add(1, Ordering::Relaxed);
                                let Some(c) = got.get(i) else { break mine };
                                mine.push((i, read_one(c)));
                            }
                        })
                    })
                    .collect();
                for handle in handles {
                    // A reader that panicked leaves its files unread, never the whole scan stopped.
                    for (i, b) in handle.join().unwrap_or_default() {
                        bytes[i] = Some(b);
                    }
                }
            });
        }
        got.into_iter()
            .zip(bytes)
            .map(|(c, b)| (c, b.unwrap_or_else(|| Err(std::io::Error::other("not read")))))
            .collect()
    }

    fn with<T>(&self, index: usize, f: impl FnOnce(&Candidate) -> T) -> Option<T> {
        let listed = lock(&self.listed);
        listed.live.get(&index).or_else(|| listed.kept.get(&index)).map(f)
    }

    /// A handed-over file's bytes by its index: the first time, the bytes its batch already read (taken, so they're
    /// held no longer); after that, read fresh each time (never cached). `None` for an index this run doesn't hold
    /// or once cancelled; `Some(Err(_))` for a file that can't be read (fail soft: "not read", never "clean"). A zip
    /// entry (4.8) is read out of its own zip instead of straight off disk; an encrypted one fails here, exactly the
    /// same "not read" path a locked file already takes. A plain file that grew past its format's cap since it was
    /// found is "not read" too.
    pub fn read(&self, index: usize) -> Option<std::io::Result<Vec<u8>>> {
        if self.is_cancelled() {
            return None;
        }
        if let Some(bytes) = lock(&self.listed).held.remove(&index) {
            return Some(bytes);
        }
        let candidate = self.with(index, |f| Candidate {
            path: f.path.clone(),
            name: String::new(),
            folder: String::new(),
            place: Vec::new(),
            parent: String::new(),
            ext: String::new(),
            size: f.size,
            kind: f.kind,
            zip_entry: f.zip_entry.clone(),
            project: f.project,
            secret: f.secret,
            app_signin: false,
            on_disk_size: 0,
            modified: 0,
            earlier: f.earlier,
        })?;
        Some(read_candidate(&candidate))
    }

    /// The real file's size and modified time as the scan itself saw them (the zip's, for an entry inside one):
    /// what *Move it somewhere private* and *Move to the Recycle Bin* compare against before they touch anything,
    /// so a file that changed since the scan looked at it is refused rather than acted on blind.
    pub fn stamp_of(&self, index: usize) -> Option<(u64, u64)> {
        self.with(index, |f| (f.on_disk_size, f.modified))
    }

    /// What *Leave this folder out* and *Leave files like this out* would leave out, for a handed-over file: its
    /// folder's path (the one holding the zip, for an entry inside one) or its type, never anything the page sent.
    pub fn exclusion_for(&self, index: usize, what: &str) -> Option<(&'static str, String)> {
        self.with(index, |f| match what {
            "folder" => f.path.parent().map(|p| ("folder", p.to_string_lossy().into_owned())),
            "type" if !f.ext.is_empty() => Some(("type", f.ext.clone())),
            _ => None,
        })
        .flatten()
    }

    /// A handed-over file's own path, by its index (*Open the folder*, *Ignore* and *Save a copy...* all act by
    /// index, never a path the page handed back).
    pub fn path_of(&self, index: usize) -> Option<PathBuf> {
        self.with(index, |f| f.path.clone())
    }

    /// Stop: both walks halt at their next file, and no further file is read.
    pub fn cancel(&self) {
        self.progress.cancel.store(true, Ordering::SeqCst);
        lock(&self.rx).take(); // a walker waiting on a full channel hears it close and stops there
        lock(&self.listed).held.clear(); // bytes the page will never take now
    }

    pub fn is_cancelled(&self) -> bool {
        self.progress.cancel.load(Ordering::SeqCst)
    }

    /// The Full scan record, once: only for a Full scan whose walk got through every drive and wasn't cancelled.
    /// The page asks for it only after reading every file the walk handed over (`scan_end`), naming the ones it
    /// couldn't read (kept back from each batch for this, which come out of the record: the next Quick scan reads
    /// them again rather than trusting a file nobody looked inside) and the ones that had something worth a look
    /// this time: every other entry's bit is unset, whatever it carried before, since only a file actually
    /// read this run can earn it back.
    pub fn full_record(&self, unread: &[usize], flagged: &[usize]) -> Option<Vec<(u64, u64, bool)>> {
        let p = &self.progress;
        let whole = self.keeps_record
            && !self.is_cancelled()
            && !p.failed.load(Ordering::SeqCst)
            && p.walked.load(Ordering::SeqCst)
            && p.complete.load(Ordering::SeqCst);
        if !whole {
            return None;
        }
        let keyed = |indexes: &[usize]| -> std::collections::HashSet<u64> {
            indexes
                .iter()
                .filter_map(|&i| self.path_of(i))
                .map(|path| baseline_key(&self.salt, &path))
                .collect()
        };
        let skip = keyed(unread);
        let flag = keyed(flagged);
        let records = std::mem::take(&mut *lock(&p.records));
        Some(
            records
                .into_iter()
                .filter(|(key, _)| !skip.contains(key))
                .map(|(key, stamp)| (key, stamp, flag.contains(&key)))
                .collect(),
        )
    }

    /// The tests' own run: `files` already listed, at indexes 0, 1, 2...
    #[cfg(test)]
    pub fn listed(files: Vec<Candidate>) -> ScanRun {
        let mut listed = Listed::default();
        for c in files {
            listed.live.insert(listed.next, c);
            listed.next += 1;
        }
        ScanRun {
            generation: NEXT_SCAN_GENERATION.fetch_add(1, Ordering::Relaxed),
            progress: Arc::default(),
            readers: READERS,
            keeps_record: false,
            salt: String::new(),
            rx: Mutex::new(None),
            listed: Mutex::new(listed),
        }
    }
}

impl Drop for ScanRun {
    /// A run that's replaced or closed stops both its walks, the counting one included.
    fn drop(&mut self) {
        self.progress.cancel.store(true, Ordering::SeqCst);
    }
}

// ---------- Results' actions: a fix writes a new file, never the one that was read ----------

/// Whether `a` and `b` are the same file on disk, as far as a plain path compare can tell (Windows paths are
/// case-insensitive; this never touches the disk, so it still catches the match before anything is written).
/// `write_copy` is the one place this guards: Windows' own Save dialog won't usually offer the original's name
/// back, but a person can still type it in by hand, so the refusal is checked here, not hoped for there.
pub fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_ascii_lowercase() == b.to_string_lossy().to_ascii_lowercase()
}

/// *Save a copy with them hidden* and *Save a copy without the place*: `bytes` (already redacted or redrawn, by
/// the engine in the scan worker) go to `dest`, never to `original`. Refuses even an attempt to overwrite the
/// file the scan read, so a fix can never touch the source it came from (4.0: read only).
pub fn write_copy(dest: &Path, original: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if same_path(dest, original) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "a copy refuses the original's own path",
        ));
    }
    fs::write(dest, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn result_actions_reject_a_generation_from_before_the_new_scan_start() {
        let plan = || Plan::chosen(Vec::new(), PlanCtx::default());
        let old_scan = ScanRun::start(plan());
        let old_generation = old_scan.generation();
        let new_scan = ScanRun::start(plan());

        assert_ne!(old_generation, new_scan.generation());
        assert!(!new_scan.accepts_generation(old_generation));
        assert!(new_scan.accepts_generation(new_scan.generation()));
        new_scan.cancel();
        old_scan.cancel();
    }

    #[test]
    fn a_panicking_walker_returns_an_error_and_keeps_process_alive() {
        let run = ScanRun::start_panicking(Plan::chosen(Vec::new(), PlanCtx::default()));
        assert!(matches!(
            run.batch(&[], &[], Duration::from_secs(5)),
            Err("scan-failed")
        ));
        assert!(run.is_cancelled());
    }

    struct TestTempDir(PathBuf);

    impl TestTempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("clotr-scan-test-{name}-{}", std::process::id()));
            let guard = Self(dir);
            let _ = fs::remove_dir_all(&guard.0);
            fs::create_dir_all(&guard.0).unwrap();
            guard
        }
    }

    impl std::ops::Deref for TestTempDir {
        type Target = PathBuf;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl AsRef<std::path::Path> for TestTempDir {
        fn as_ref(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir(name: &str) -> TestTempDir {
        TestTempDir::new(name)
    }

    #[test]
    fn a_test_folder_is_removed_when_its_body_panics() {
        let path = std::env::temp_dir().join(format!("clotr-scan-test-panic-cleanup-{}", std::process::id()));
        let result = std::panic::catch_unwind(|| {
            let dir = temp_dir("panic-cleanup");
            assert_eq!(dir.as_ref(), path.as_path());
            panic!("simulated test failure");
        });

        assert!(result.is_err());
        assert!(!path.exists(), "the fixture folder survived a panicking test body");
    }

    #[test]
    fn attributes_are_read_by_their_bit_only() {
        assert!(!is_link(0) && !is_hidden_or_system(0) && !is_online_only(0) && !is_dir(0));
        assert!(is_dir(FILE_ATTRIBUTE_DIRECTORY));
        assert!(is_link(FILE_ATTRIBUTE_REPARSE_POINT));
        assert!(is_hidden_or_system(FILE_ATTRIBUTE_HIDDEN));
        assert!(is_hidden_or_system(FILE_ATTRIBUTE_SYSTEM));
        assert!(is_online_only(FILE_ATTRIBUTE_OFFLINE));
        assert!(is_online_only(FILE_ATTRIBUTE_RECALL_ON_OPEN));
        assert!(is_online_only(FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS));
        // A plain, present, read-only file: none of the skip conditions.
        assert!(!is_link(0x21) && !is_hidden_or_system(0x21) && !is_online_only(0x21));
    }

    #[test]
    fn a_format_clotr_reads_gets_its_caps_category_and_an_unknown_one_is_left_out() {
        assert_eq!(category("TXT"), Some(("text", TEXT_CAP)));
        assert_eq!(category("xlsx"), Some(("doc", DOC_CAP)));
        assert_eq!(category("heic"), Some(("picture", PICTURE_CAP)));
        assert_eq!(category("exe"), None);
        assert_eq!(category(""), None);
    }

    #[test]
    fn a_key_or_sign_in_file_reads_as_text_by_its_extension_or_its_exact_name() {
        for ext in ["pem", "key", "ppk", "ovpn", "npmrc", "netrc"] {
            assert_eq!(category(ext), Some(("text", TEXT_CAP)), "{ext}");
        }
        for name in ["id_rsa", "id_ed25519", "credentials", "ID_RSA"] {
            assert_eq!(category_for(name, ""), Some(("text", TEXT_CAP)), "{name}");
        }
        // A name that merely contains one of these words, or carries its own extension, isn't a match: only the
        // exact, extension-less name is a key file Clotr already knows the shape of.
        assert_eq!(category_for("id_rsa.pub", "pub"), None);
        assert_eq!(category_for("my_credentials", ""), None);
    }

    #[test]
    fn dot_env_and_its_variants_read_as_text_however_rust_splits_their_extension() {
        for name in [".env", ".env.local", ".env.production", ".ENV.LOCAL"] {
            assert_eq!(category_for(name, "local"), Some(("text", TEXT_CAP)), "{name}");
        }
        assert_eq!(category_for("envelope.txt", "txt"), Some(("text", TEXT_CAP)));
        assert_eq!(category_for(".environment", ""), None, "not a .env variant, just starts with the letters");
    }

    #[test]
    fn a_folder_only_windows_makes_is_never_opened() {
        for n in ["Windows", "AppData", "Program Files"] {
            assert!(skip_dir_name(n), "{n}");
        }
        assert!(!skip_dir_name("Documents"));
    }

    // A Rust project's own build output: Cargo's `.fingerprint` folder can hold one JSON file per compiled unit,
    // easily thousands of them across a few worktrees, none of it a person's own content. Before `target` joined
    // `SKIP_DIR_NAMES`, a scan would count and read every one of them, racing the whole 50,000-file cap against
    // real files in the same scan and spending most of its time on build output instead.
    #[test]
    fn a_rust_build_output_folder_is_never_opened() {
        let dir = temp_dir("cargo-target");
        let fingerprint = dir.join("target").join("debug").join(".fingerprint");
        fs::create_dir_all(&fingerprint).unwrap();
        fs::write(dir.join("target").join("CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55").unwrap();
        for i in 0..50 {
            fs::write(fingerprint.join(format!("unit-{i}.json")), b"{\"rustc\":1,\"features\":[]}").unwrap();
        }
        fs::write(dir.join("notes.txt"), "password: Sunflower!2024").unwrap();
        let (files, _) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["notes.txt"], "target's own fingerprint files were never entered");
    }

    // Rust's own standard library bypasses Windows' 260-character MAX_PATH for absolute paths (it talks to the
    // Win32 API in its `\\?\`-prefixed, "verbatim" form under the hood), so the walker needs no special handling
    // of its own: a path well past 260 characters still counts and reads exactly like a short one.
    #[test]
    fn a_path_past_260_characters_still_walks_and_reads() {
        let base = temp_dir("longpath");
        let mut deep = base.clone();
        for i in 0..6 {
            deep = deep.join(format!("segment-folder-number-{i}-padded-out-long"));
        }
        fs::create_dir_all(&deep).unwrap();
        let file = deep.join("notes.txt");
        fs::write(&file, b"password: Sunflower!2024").unwrap();
        assert!(file.to_string_lossy().len() > 260, "the fixture itself must clear MAX_PATH");

        let (files, counts) = walk(&[(base.clone(), "chosen".into())], &WalkLimits::default());
        assert_eq!(files.len(), 1);
        assert!(!counts.capped_depth);
        let state = ScanRun::listed(files);
        let bytes = state.read(0).unwrap().expect("a long path still reads fine");
        assert_eq!(bytes, b"password: Sunflower!2024");
    }

    #[test]
    fn walking_counts_readable_files_and_skips_a_build_folder() {
        let dir = temp_dir("basic");
        fs::write(dir.join("logins.txt"), "password: Sunflower!2024").unwrap();
        fs::write(dir.join("photo.jpg"), [0xffu8, 0xd8]).unwrap();
        fs::write(dir.join("unknown.exe"), [0u8; 4]).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("node_modules").join("secret.txt"), "AKIA4HPQ7XZ2R6TWLJ3N").unwrap();
        let (files, counts) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"logins.txt") && names.contains(&"photo.jpg"));
        assert!(!names.contains(&"unknown.exe"), "not a format Clotr reads");
        assert!(!names.contains(&"secret.txt"), "node_modules is never opened");
        assert_eq!(counts.too_big, 0);
    }

    #[test]
    fn walking_counts_a_key_file_with_no_extension_and_a_dot_env_variant() {
        let dir = temp_dir("keyfiles");
        fs::write(dir.join("id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----").unwrap();
        fs::write(dir.join(".env.local"), "API_TOKEN=sk_test_fake").unwrap();
        fs::write(dir.join("readme"), "no extension, not a key file").unwrap();
        let (files, _) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"id_rsa") && names.contains(&".env.local"));
        assert!(!names.contains(&"readme"), "a plain extension-less file Clotr doesn't recognize by name");
    }

    #[test]
    fn a_file_over_its_formats_cap_is_too_big_to_read_never_opened() {
        let dir = temp_dir("toobig");
        fs::write(dir.join("notes.txt"), vec![b'a'; (TEXT_CAP + 1) as usize]).unwrap();
        fs::write(dir.join("small.txt"), "fits").unwrap();
        let (files, counts) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        assert_eq!(counts.too_big, 1);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "small.txt");
    }

    #[test]
    fn a_hidden_or_system_file_is_never_counted_or_read() {
        let dir = temp_dir("hiddensys");
        let hidden = dir.join("hidden-notes.txt");
        let system = dir.join("system-config.ini");
        let plain = dir.join("plain.txt");
        fs::write(&hidden, "password: Sunflower!2024").unwrap();
        fs::write(&system, "password: Sunflower!2024").unwrap();
        fs::write(&plain, "ok").unwrap();
        let attrib = |flag: &str, path: &PathBuf| {
            std::process::Command::new("attrib")
                .args([flag, path.to_str().unwrap()])
                .status()
                .expect("attrib")
        };
        assert!(attrib("+h", &hidden).success());
        assert!(attrib("+s", &system).success());
        let (files, _) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["plain.txt"]);
    }

    // A directory junction (mklink /J) is a reparse point, exactly as a link or a loop back to an ancestor would
    // be: the walker must never follow it, whatever it points to. /J never needs elevation (unlike a symbolic
    // link), so this runs on any Windows account.
    #[test]
    fn a_junction_is_never_followed_even_when_it_loops_back_on_itself() {
        let dir = temp_dir("junction");
        fs::write(dir.join("real.txt"), "ok").unwrap();
        let link = dir.join("loop-back");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", link.to_str().unwrap(), dir.to_str().unwrap()])
            .status()
            .expect("mklink");
        assert!(status.success(), "mklink /J needs no elevation");
        let (files, _) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        // Only the one real file: the junction back to `dir` itself was never entered, so the scan finished
        // (a walker that followed it would recurse forever on this exact fixture).
        assert_eq!(files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["real.txt"]);
    }

    #[test]
    fn depth_past_the_cap_is_never_read_so_a_walker_can_never_recurse_forever() {
        let dir = temp_dir("depth");
        let mut deep = dir.clone();
        for i in 0..(MAX_DEPTH + 4) {
            deep = deep.join(format!("d{i}"));
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("too-deep.txt"), "x").unwrap();
        let limits = WalkLimits {
            max_depth: 3,
            max_files: MAX_FILES,
        };
        let (files, counts) = walk(&[(dir.clone(), "chosen".into())], &limits);
        assert!(files.is_empty(), "nothing that deep should ever be read");
        assert!(counts.capped_depth);
    }

    #[test]
    fn the_file_cap_stops_a_scan_at_the_limit() {
        let dir = temp_dir("filecap");
        for i in 0..10 {
            fs::write(dir.join(format!("f{i}.txt")), "x").unwrap();
        }
        let limits = WalkLimits {
            max_depth: MAX_DEPTH,
            max_files: 4,
        };
        let (files, counts) = walk(&[(dir.clone(), "chosen".into())], &limits);
        assert_eq!(files.len(), 4);
        assert!(counts.capped_files);
    }

    // A file sitting right on the Desktop must never lose its place to a big folder beside it: one project folder
    // can hold more files than the whole cap, and walking it first used to fill the scan before the Desktop's own
    // files (or the next root's) were ever reached.
    #[test]
    fn the_file_cap_reaches_every_roots_own_files_before_a_deep_folder_fills_it() {
        let downloads = temp_dir("cap-order-downloads");
        let desktop = temp_dir("cap-order-desktop");
        let project = desktop.join("A big project");
        fs::create_dir_all(&project).unwrap();
        for i in 0..10 {
            fs::write(project.join(format!("f{i}.txt")), "x").unwrap();
        }
        fs::write(desktop.join("my aws key.txt"), "AKIA4HPQ7XZ2R6TWLJ3N").unwrap();
        let deep_downloads = downloads.join("Old backup");
        fs::create_dir_all(&deep_downloads).unwrap();
        for i in 0..10 {
            fs::write(deep_downloads.join(format!("b{i}.txt")), "x").unwrap();
        }
        fs::write(downloads.join("statement.txt"), "x").unwrap();
        let limits = WalkLimits {
            max_depth: MAX_DEPTH,
            max_files: 4,
        };
        let roots = [(downloads.clone(), "downloads".into()), (desktop.clone(), "desktop".into())];
        let (files, counts) = walk(&roots, &limits);
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert!(counts.capped_files);
        assert!(names.contains(&"statement.txt"), "Downloads' own file: {names:?}");
        assert!(names.contains(&"my aws key.txt"), "the Desktop's own file: {names:?}");
    }

    #[test]
    fn an_online_only_placeholder_is_counted_but_never_opened() {
        // The real attribute (FILE_ATTRIBUTE_OFFLINE / RECALL_ON_OPEN / RECALL_ON_DATA_ACCESS) needs a real cloud
        // placeholder (OneDrive), which is a manual check. The bit math itself is proven
        // above (attributes_are_read_by_their_bit_only) and exercised here against the real walker's skip path by
        // asserting a file that disappears between counting and reading is "not read", never "clean" (fail
        // soft) — the same path an online-only file that slipped through would take.
        let dir = temp_dir("onlineish");
        let gone = dir.join("gone.txt");
        fs::write(&gone, "x").unwrap();
        let (files, _) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        let state = ScanRun::listed(files);
        fs::remove_file(&gone).unwrap();
        assert!(state.read(0).unwrap().is_err(), "removed between counting and reading: not read, never clean");
    }

    #[test]
    fn cancelling_stops_every_further_read() {
        let dir = temp_dir("cancel");
        fs::write(dir.join("a.txt"), "x").unwrap();
        let (files, _) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        let state = ScanRun::listed(files);
        assert!(state.read(0).is_some());
        state.cancel();
        assert!(state.read(0).is_none());
    }

    // Rule: "read only, always: the walker never writes, moves or deletes a file." Marking the fixture read-only
    // on disk before reading it proves the point by construction: if `read()` ever attempted a write, a rename or
    // a delete, it would fail against a read-only file; reading it succeeds, and the bytes and the file's size on
    // disk are exactly what was written, untouched.
    #[test]
    fn reading_a_file_never_writes_moves_or_deletes_it() {
        let dir = temp_dir("readonly");
        let path = dir.join("tax-notes.txt");
        let original = b"wages: 51000, ssn: 219-09-9999".to_vec();
        fs::write(&path, &original).unwrap();
        let status = std::process::Command::new("attrib")
            .args(["+r", path.to_str().unwrap()])
            .status()
            .expect("attrib");
        assert!(status.success());

        let (files, _) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        assert_eq!(files.len(), 1);
        let state = ScanRun::listed(files);
        let bytes = state.read(0).unwrap().expect("a read-only file still reads fine");
        assert_eq!(bytes, original, "read gave back exactly what was on disk");
        assert_eq!(fs::read(&path).unwrap(), original, "still there, still read-only, untouched");
        assert_eq!(fs::metadata(&path).unwrap().len(), original.len() as u64);

        let _ = std::process::Command::new("attrib").args(["-r", path.to_str().unwrap()]).status();
    }

    #[test]
    fn a_missing_root_is_skipped_not_an_error() {
        let (files, counts) = walk(&[(PathBuf::from(r"Z:\does-not-exist-clotr"), "chosen".into())], &WalkLimits::default());
        assert!(files.is_empty());
        assert!(!counts.capped_files && !counts.capped_depth);
    }

    // ---------- Results' actions: a copy never lands on the file Clotr read ----------

    #[test]
    fn same_path_matches_itself_and_is_case_insensitive_like_windows() {
        let p = PathBuf::from(r"C:\Users\test\Downloads\tax-notes.txt");
        assert!(same_path(&p, &p));
        assert!(same_path(&p, &PathBuf::from(r"c:\users\TEST\downloads\TAX-NOTES.TXT")));
        assert!(!same_path(&p, &PathBuf::from(r"C:\Users\test\Downloads\other.txt")));
    }

    #[test]
    fn write_copy_refuses_the_original_and_leaves_it_untouched() {
        let dir = temp_dir("writecopy-refuse");
        let original = dir.join("tax-notes.txt");
        let before = b"wages: 51000, ssn: 219-09-9999".to_vec();
        fs::write(&original, &before).unwrap();

        let err = write_copy(&original, &original, b"[REDACTED]").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        assert_eq!(fs::read(&original).unwrap(), before, "the original was never touched");
    }

    #[test]
    fn write_copy_writes_only_to_a_different_path() {
        let dir = temp_dir("writecopy-ok");
        let original = dir.join("tax-notes.txt");
        fs::write(&original, b"wages: 51000, ssn: 219-09-9999").unwrap();
        let dest = dir.join("tax-notes (hidden).txt");

        write_copy(&dest, &original, b"wages: [REDACTED SSN]").unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"wages: [REDACTED SSN]");
        assert_eq!(fs::read(&original).unwrap(), b"wages: 51000, ssn: 219-09-9999", "untouched");
    }

    #[test]
    fn path_of_is_none_past_the_end_of_the_list_or_once_cancelled() {
        let dir = temp_dir("pathof");
        fs::write(dir.join("a.txt"), "x").unwrap();
        let (files, _) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        let state = ScanRun::listed(files);
        assert!(state.path_of(0).is_some());
        assert!(state.path_of(5).is_none());
        state.cancel();
        assert!(state.path_of(0).is_some(), "the path itself doesn't depend on cancel, only reading bytes does");
    }

    #[test]
    fn quicks_places_are_downloads_desktop_documents_and_pictures_and_a_chosen_folder_keeps_its_name() {
        let floor: Vec<String> = floor().into_iter().map(|(_, l)| l).collect();
        assert_eq!(floor, ["downloads", "desktop", "documents", "pictures"]);
        let chosen = chosen_roots(&[PathBuf::from(r"C:\Users\someone\USB Drive")]);
        assert_eq!(chosen[0].1, "USB Drive");
    }

    // ---------- Reading inside a .zip (4.8) ----------

    use std::io::Write;
    use zip::unstable::write::FileOptionsExt;
    use zip::write::{SimpleFileOptions, ZipWriter};

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = ZipWriter::new(fs::File::create(path).unwrap());
        for (name, bytes) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    fn write_encrypted_zip(path: &Path, name: &str, bytes: &[u8], password: &[u8]) {
        let mut zip = ZipWriter::new(fs::File::create(path).unwrap());
        let options = SimpleFileOptions::default().with_deprecated_encryption(password).unwrap();
        zip.start_file(name, options).unwrap();
        zip.write_all(bytes).unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn a_zip_with_a_passwords_file_inside_is_counted_and_reads_its_own_bytes() {
        let dir = temp_dir("zip-basic");
        let zip_path = dir.join("export.zip");
        write_zip(&zip_path, &[("passwords.csv", b"site,password\nbank,hunter2")]);
        let (files, counts) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        assert_eq!(counts.too_big, 0);
        assert_eq!(files.len(), 1, "the zip itself is never counted as a file, only what's inside it");
        assert_eq!(files[0].kind, "text");
        assert!(files[0].name.contains("passwords.csv") && files[0].name.contains("export.zip"));
        let state = ScanRun::listed(files);
        let bytes = state.read(0).unwrap().expect("an unencrypted entry reads fine");
        assert_eq!(bytes, b"site,password\nbank,hunter2");
    }

    #[test]
    fn an_encrypted_zip_entry_is_counted_but_never_read_not_read_never_clean() {
        let dir = temp_dir("zip-encrypted");
        let zip_path = dir.join("backup.zip");
        write_encrypted_zip(&zip_path, "logins.txt", b"password: Sunflower!2024", b"hunter2");
        let (files, _) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        // Counted (its name and declared size cost nothing to look at), same as any other file Clotr found.
        assert_eq!(files.len(), 1);
        let state = ScanRun::listed(files);
        assert!(state.read(0).unwrap().is_err(), "encrypted: not read, never clean");
    }

    #[test]
    fn a_zip_nested_inside_another_zip_is_never_opened() {
        let dir = temp_dir("zip-nested");
        let zip_path = dir.join("outer.zip");
        // The inner "zip" doesn't even need to be a real archive: nothing here ever tries to read it, which is
        // exactly the point of this test.
        write_zip(&zip_path, &[("inner.zip", b"not a real archive"), ("readme.txt", b"just the outer file")]);
        let (files, _) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.iter().any(|n| n.contains("readme.txt")));
        assert!(!names.iter().any(|n| n.contains("inner.zip")), "a zip entry is never itself opened");
    }

    #[test]
    fn a_zip_entry_past_this_scans_own_budget_counts_as_too_big_never_read() {
        let dir = temp_dir("zip-budget");
        let zip_path = dir.join("big.zip");
        write_zip(&zip_path, &[("notes.txt", b"well under the format cap, just not under the budget left")]);
        let plan = Plan::chosen(vec![(dir.clone(), "chosen".into())], PlanCtx::default());
        let cancel = AtomicBool::new(false);
        let mut files = Vec::new();
        let mut walk = Walk {
            plan: &plan,
            cancel: &cancel,
            published: None,
            counts: Counts::default(),
            open_zips: true,
            zip_budget: 4, // far smaller than the entry, however small the entry already is
            emitted: 0,
            records: Vec::new(),
            sink: |c| {
                files.push(c);
                true
            },
        };
        let place = Place {
            lower: "chosen".into(),
            name: "chosen".into(),
            top: "chosen".into(),
            sub: Vec::new(),
        };
        assert!(walk.zip_entries(&zip_path, "big.zip", &place, false, false));
        let counts = walk.counts;
        drop(walk);
        assert!(files.is_empty(), "the scan's own zip budget, not the format cap, ran out first");
        assert_eq!(counts.too_big, 1);
    }

    // A zip bomb's whole shape: a tiny compressed file whose declared uncompressed size is already over the
    // format's own cap. The walker reads that declared size from the zip's own directory listing (never
    // decompressing to find out), so this is caught the same way an oversized plain file already is.
    #[test]
    fn a_zip_bomb_shaped_entry_is_too_big_by_its_declared_size_never_decompressed() {
        let dir = temp_dir("zip-bomb");
        let zip_path = dir.join("bomb.zip");
        let huge = vec![0u8; (TEXT_CAP + 1) as usize]; // one repeated byte: compresses to almost nothing
        write_zip(&zip_path, &[("notes.txt", &huge)]);
        let (files, counts) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        assert!(files.is_empty());
        assert_eq!(counts.too_big, 1);
        let on_disk = fs::metadata(&zip_path).unwrap().len();
        assert!(on_disk < TEXT_CAP, "the zip file on disk stays tiny; only its declared size is huge");
    }

    /// Rewrites every declared uncompressed size in a one-entry zip (its local header and its central directory
    /// record) to `size`, leaving the compressed data and its checksum exactly as they were: the shape of a zip
    /// that lies about how big its entry is.
    fn lie_about_size(path: &Path, size: u32) {
        let mut bytes = fs::read(path).unwrap();
        assert_eq!(&bytes[..4], b"PK\x03\x04", "a local header first");
        bytes[22..26].copy_from_slice(&size.to_le_bytes());
        let central = bytes.windows(4).position(|w| w == b"PK\x01\x02").expect("a central directory record");
        bytes[central + 24..central + 28].copy_from_slice(&size.to_le_bytes());
        fs::write(path, bytes).unwrap();
    }

    // A crafted zip can say its entry is tiny while the compressed data inside unpacks to far more: the walker
    // only ever sees the claim. Reading has to hold the entry to what it claimed (and the format's cap), or one
    // small file in Downloads makes the weekly check unpack gigabytes into memory.
    #[test]
    fn a_zip_entry_that_unpacks_past_its_declared_size_is_not_read_never_unpacked_in_full() {
        let dir = temp_dir("zip-liar");
        let zip_path = dir.join("liar.zip");
        let huge = vec![0u8; (TEXT_CAP * 2) as usize];
        write_zip(&zip_path, &[("notes.txt", &huge)]);
        lie_about_size(&zip_path, 64);
        let (files, _) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        assert_eq!(files.len(), 1, "counted by the size it claims");
        assert_eq!(files[0].size, 64);
        let state = ScanRun::listed(files);
        let read = state.read(0).unwrap();
        assert!(
            read.is_err(),
            "an entry bigger than it claimed is not read, never handed over ({} bytes came back)",
            read.map(|b| b.len()).unwrap_or(0)
        );
    }

    // The walker counts a file, then the page asks for it a moment later: a file that grew past its format's cap
    // in between (a download still arriving, a sync client, another program) is "not read", never read whole.
    #[test]
    fn a_file_that_grew_past_its_cap_after_it_was_counted_is_not_read() {
        let dir = temp_dir("grew");
        let path = dir.join("notes.txt");
        fs::write(&path, b"short when counted").unwrap();
        let (files, _) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        assert_eq!(files.len(), 1);
        fs::write(&path, vec![b'a'; (TEXT_CAP + 1) as usize]).unwrap();
        let state = ScanRun::listed(files);
        assert!(state.read(0).unwrap().is_err(), "past the cap now: not read");
        fs::write(&path, b"still small").unwrap();
        assert_eq!(state.read(0).unwrap().unwrap(), b"still small", "a file under its cap still reads whole");
    }

    // ---------- Full and Quick scan cases ----------

    fn names(files: &[Candidate]) -> Vec<String> {
        let mut out: Vec<String> = files.iter().map(|f| f.name.clone()).collect();
        out.sort();
        out
    }

    fn walk_all(plan: &Plan) -> (Vec<Candidate>, Walked) {
        let mut files = Vec::new();
        let walked = walk_plan(plan, &AtomicBool::new(false), None, |c| {
            files.push(c);
            true
        });
        (files, walked)
    }

    /// A walk's own `(key, stamp)` records, as a baseline with every bit unset: for tests that don't care which
    /// files were flagged last time.
    fn no_flags(records: Vec<(u64, u64)>) -> Vec<(u64, u64, bool)> {
        records.into_iter().map(|(key, stamp)| (key, stamp, false)).collect()
    }

    /// A stand-in drive: Windows' own folders at its root, a Recycle Bin, a page file, and a person's files in the
    /// places an antivirus scan reaches and a folder scan doesn't (AppData, a project's node_modules).
    fn fake_drive(dir: &Path) {
        for (folder, file) in [
            ("Windows/System32", "setup.log"),
            ("Program Files/Tool", "config.json"),
            ("ProgramData/Vendor", "token.txt"),
            ("$Recycle.Bin/S-1-5-21", "deleted.txt"),
            ("System Volume Information", "tracking.log"),
            ("Users/me/AppData/Roaming/app", "settings.json"),
            ("Users/me/code/site/node_modules/pkg", ".env"),
            ("Users/me/Downloads", "statement.txt"),
            ("Users/me/Documents/deep/er/still", "notes.md"),
            ("Data/$Recycle.Bin", "old.txt"),
            ("Data/Windows", "my windows notes.txt"),
        ] {
            fs::create_dir_all(dir.join(folder)).unwrap();
            fs::write(dir.join(folder).join(file), "x").unwrap();
        }
        fs::write(dir.join("pagefile.sys.txt"), "x").unwrap();
        for f in ["pagefile.sys", "hiberfil.sys", "swapfile.sys"] {
            fs::write(dir.join(f), "x").unwrap();
        }
        fs::write(dir.join("readme.txt"), "x").unwrap();
    }

    #[test]
    fn full_reaches_every_folder_on_a_drive_but_windows_own_the_recycle_bin_and_the_page_file() {
        let dir = temp_dir("full-reach");
        fake_drive(&dir);
        // A drive's own name for its files is "C:"; the stand-in is named for its folder, which is fine here.
        let (files, walked) = walk_all(&Plan::full(vec![dir.clone()], None, false, PlanCtx::default()));
        assert!(walked.complete);
        assert_eq!(
            names(&files),
            [
                "my windows notes.txt",
                "notes.md",
                "pagefile.sys.txt",
                "readme.txt",
                "statement.txt",
            ],
            "AppData is left out as a whole; node_modules never is; Windows' folders only at the root are skipped"
        );
        assert_eq!(walked.counts.dev_folders, 1, "node_modules, counted for Results");
        assert_eq!(walked.counts.app_storage, 1, "the AppData folder, left out in one step");
        assert!(!walked.counts.capped_files && !walked.counts.capped_depth);
    }

    #[test]
    fn a_folder_scan_still_skips_what_only_windows_or_a_build_tool_makes() {
        let dir = temp_dir("folder-reach");
        fake_drive(&dir);
        let (files, _) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        let names = names(&files);
        assert!(!names.contains(&"settings.json".to_string()), "AppData");
        assert!(!names.contains(&".env".to_string()), "node_modules");
        assert!(names.contains(&"statement.txt".to_string()));
    }

    #[test]
    fn a_folder_named_in_the_plans_skip_list_is_never_opened() {
        let dir = temp_dir("skip-list");
        fake_drive(&dir);
        let ctx = PlanCtx {
            skip: vec![dir.join("users").join("ME").join("AppData")],
            ..PlanCtx::default()
        };
        let (files, _) = walk_all(&Plan::full(vec![dir.clone()], None, false, ctx));
        assert!(!names(&files).contains(&"settings.json".to_string()), "Clotr's own data folder, whatever its case");
    }

    #[test]
    fn full_records_each_file_it_hands_over_and_nothing_it_skipped() {
        let dir = temp_dir("full-record");
        fs::write(dir.join("a.txt"), "x").unwrap();
        fs::write(dir.join("b.md"), "y").unwrap();
        fs::write(dir.join("photo.raw"), "not a format Clotr reads").unwrap();
        fs::write(dir.join("big.txt"), vec![b'a'; (TEXT_CAP + 1) as usize]).unwrap();
        let ctx = PlanCtx {
            salt: "s".into(),
            ..PlanCtx::default()
        };
        let (files, walked) = walk_all(&Plan::full(vec![dir.clone()], None, false, ctx));
        assert_eq!(files.len(), 2);
        assert_eq!(walked.records.len(), 2, "too big or unreadable: never recorded, so Quick looks again");
        let mut keys: Vec<u64> = walked.records.iter().map(|r| r.0).collect();
        keys.sort();
        let mut want = vec![baseline_key("s", &dir.join("a.txt")), baseline_key("s", &dir.join("b.md"))];
        want.sort();
        assert_eq!(keys, want);
        let (_, chosen) = walk_all(&Plan::chosen(vec![(dir.clone(), "chosen".into())], PlanCtx::default()));
        assert!(chosen.records.is_empty(), "only Full keeps a record");
    }

    /// A Desktop with a person's own notes beside two code projects: one with a `.git` folder, one with only a
    /// `package.json`, each holding test files with made-up keys in a subfolder.
    fn desktop_with_projects(dir: &Path) {
        fs::write(dir.join("taxes.txt"), "x").unwrap();
        fs::create_dir_all(dir.join("Trip photos")).unwrap();
        fs::write(dir.join("Trip photos/notes.md"), "x").unwrap();
        for (project, marker) in [("shop", ".git"), ("bot", "package.json")] {
            let root = dir.join(project);
            fs::create_dir_all(root.join("tests/fixtures")).unwrap();
            if marker == ".git" {
                fs::create_dir_all(root.join(".git")).unwrap();
                fs::write(root.join(".git/config"), "x").unwrap();
            } else {
                fs::write(root.join(marker), "{}").unwrap();
            }
            fs::write(root.join(".env"), "x").unwrap();
            fs::write(root.join("app.py"), "x").unwrap();
            fs::write(root.join("logo.bin"), "x").unwrap();
            fs::write(root.join("tests/fixtures/keys.json"), "x").unwrap();
            fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
            fs::write(root.join("node_modules/pkg/index.js"), "x").unwrap();
        }
    }

    #[test]
    fn quick_leaves_code_projects_out_and_counts_them() {
        let dir = temp_dir("quick-projects");
        desktop_with_projects(&dir);
        let plan = Plan::quick(vec![(dir.clone(), "desktop".into())], None, true, false, PlanCtx::default());
        let (files, walked) = walk_all(&plan);
        assert_eq!(names(&files), ["notes.md", "taxes.txt"], "only the person's own files");
        assert_eq!(walked.counts.code_projects, 2);
        // .env, app.py and keys.json in each (package.json too, in the one that has it); logo.bin isn't a type
        // Clotr reads, and node_modules is skipped as always.
        assert_eq!(walked.counts.project_files, 7);
        assert_eq!(walked.counts.dev_folders, 0, "what's inside a project left out isn't counted twice");
    }

    #[test]
    fn full_leaves_code_projects_out_like_quick_and_counts_them() {
        let dir = temp_dir("full-leaves-projects");
        desktop_with_projects(&dir);
        let (files, walked) = walk_all(&Plan::full(vec![dir.clone()], None, false, PlanCtx::default()));
        assert_eq!(names(&files), ["notes.md", "taxes.txt"], "only the person's own files");
        assert_eq!(walked.counts.code_projects, 2);
        assert_eq!(walked.counts.project_files, 7);
    }

    #[test]
    fn the_developer_switch_and_a_chosen_folder_read_code_projects_and_mark_their_files() {
        let dir = temp_dir("full-projects");
        desktop_with_projects(&dir);
        for plan in [
            Plan::full(vec![dir.clone()], None, true, PlanCtx::default()),
            Plan::chosen(vec![(dir.clone(), "chosen".into())], PlanCtx::default()),
            Plan::quick(vec![(dir.clone(), "desktop".into())], None, false, true, PlanCtx::default()),
        ] {
            let (files, walked) = walk_all(&plan);
            assert_eq!((walked.counts.code_projects, walked.counts.project_files), (0, 0), "nothing left out");
            let in_projects: Vec<&str> = files.iter().filter(|f| f.project).map(|f| f.name.as_str()).collect();
            assert_eq!(in_projects.len(), 7, "{in_projects:?}");
            assert!(in_projects.contains(&"keys.json"), "a subfolder of a project is in it too");
            let own: Vec<&str> = files.iter().filter(|f| !f.project).map(|f| f.name.as_str()).collect();
            assert_eq!(own.len(), 2, "{own:?}");
        }
    }

    #[test]
    fn a_place_that_is_itself_a_project_is_still_read() {
        let dir = temp_dir("root-project");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join("notes.txt"), "x").unwrap();
        let (files, walked) = walk_all(&Plan::quick(vec![(dir.clone(), "desktop".into())], None, true, false, PlanCtx::default()));
        assert_eq!(names(&files), ["notes.txt"]);
        assert_eq!(walked.counts.code_projects, 0);
    }

    #[test]
    fn quick_with_no_full_scan_yet_reads_its_places_in_full_and_nothing_else() {
        let drive = temp_dir("quick-nofull-drive");
        fake_drive(&drive);
        let downloads = drive.join("Users/me/Downloads");
        let (files, walked) = walk_all(&Plan::quick(vec![(downloads, "downloads".into())], None, true, false, PlanCtx::default()));
        assert_eq!(names(&files), ["statement.txt"]);
        assert_eq!(files[0].folder, "downloads");
        assert!(walked.records.is_empty());
    }

    #[test]
    fn quick_after_a_full_scan_reads_only_what_is_new_or_changed_in_its_places() {
        let drive = temp_dir("quick-drive");
        let floor = drive.join("Users").join("me").join("Downloads");
        fake_drive(&drive);
        let ctx = PlanCtx {
            salt: "s".into(),
            ..PlanCtx::default()
        };
        let (_, full) = walk_all(&Plan::full(vec![drive.clone()], None, false, ctx.clone()));
        let baseline = Arc::new(Baseline::new(1, no_flags(full.records)));
        let quick = || Plan::quick(vec![(floor.clone(), "downloads".into())], Some(baseline.clone()), true, false, ctx.clone());
        let (files, _) = walk_all(&quick());
        assert!(files.is_empty(), "nothing changed: nothing to read");
        fs::write(floor.join("statement.txt"), "a changed line").unwrap();
        fs::write(floor.join("new.txt"), "x").unwrap();
        fs::write(drive.join("Users/me/Documents/deep/er/still/notes.md"), "a new line").unwrap();
        let (files, _) = walk_all(&quick());
        assert_eq!(names(&files), ["new.txt", "statement.txt"], "elsewhere on the drive waits for a Full scan");
    }

    #[test]
    fn places_inside_another_place_are_read_once() {
        let docs = PathBuf::from("C:\\Users\\me\\Documents");
        let places = distinct_places(vec![
            (docs.clone(), "documents".into()),
            (docs.join("Pictures"), "pictures".into()),
            (PathBuf::from("C:\\Users\\me\\Desktop"), "desktop".into()),
            (PathBuf::from("c:\\users\\me\\documents\\"), "again".into()),
            (PathBuf::from("C:\\Users\\me\\Documents2"), "documents2".into()),
        ]);
        let labels: Vec<&str> = places.iter().map(|(_, l)| l.as_str()).collect();
        assert_eq!(labels, ["documents", "desktop", "documents2"]);
    }

    #[test]
    fn a_full_walk_is_cancelled_at_the_next_file() {
        let dir = temp_dir("full-cancel");
        for i in 0..20 {
            fs::write(dir.join(format!("{i}.txt")), "x").unwrap();
        }
        let cancel = AtomicBool::new(false);
        let mut seen = 0;
        let walked = walk_plan(&Plan::full(vec![dir.clone()], None, false, PlanCtx::default()), &cancel, None, |_| {
            seen += 1;
            if seen == 3 {
                cancel.store(true, Ordering::SeqCst);
            }
            true
        });
        assert_eq!(seen, 3);
        assert!(!walked.complete);
    }

    fn drain(run: &ScanRun, keep_every: usize) -> (Vec<Shown>, Batch) {
        let mut all = Vec::new();
        let mut keep = Vec::new();
        let mut settled = Vec::new();
        for _ in 0..1000 {
            let batch = run.batch(&settled, &keep, Duration::from_secs(5)).unwrap();
            settled = batch.files.iter().map(|f| f.index).collect();
            keep = batch.files.iter().map(|f| f.index).filter(|i| i % keep_every == 0).collect();
            let done = batch.done;
            all.extend(batch.files.iter().map(|f| Shown {
                index: f.index,
                name: f.name.clone(),
                folder: f.folder.clone(),
                place: f.place.clone(),
                parent: f.parent.clone(),
                ext: f.ext.clone(),
                size: f.size,
                kind: f.kind,
                dup_of: f.dup_of,
                project: f.project,
                secret: f.secret,
                app_signin: f.app_signin,
                earlier: f.earlier,
                reads: f.reads,
            }));
            if done {
                return (all, batch);
            }
        }
        panic!("the walk never finished");
    }

    #[test]
    fn a_run_hands_files_over_in_batches_and_lets_go_of_the_ones_the_page_didnt_keep() {
        let dir = temp_dir("run-batches");
        for i in 0..150 {
            fs::write(dir.join(format!("{i:03}.txt")), "x").unwrap();
        }
        let run = ScanRun::start(Plan::chosen(vec![(dir.clone(), "chosen".into())], PlanCtx::default()));
        let (files, last) = drain(&run, 10);
        assert_eq!(files.len(), 150);
        let indexes: Vec<usize> = files.iter().map(|f| f.index).collect();
        assert_eq!(indexes, (0..150).collect::<Vec<_>>(), "every file once, in order");
        assert!(files.iter().all(|f| f.folder == "chosen" && f.kind == "text"));
        // The counting walk finished, so the total is the whole run's.
        std::thread::sleep(Duration::from_millis(200));
        let total = run.batch(&[], &[], Duration::from_millis(1)).unwrap().total;
        assert!(total.counted && total.files == 150 && total.bytes == 150, "{:?}", (total.files, total.bytes));
        assert!(last.done);
        let held = (0..150).filter(|&i| run.path_of(i).is_some()).count();
        assert!(held <= 15 + BATCH, "only kept files and the last batch are held: {held}");
        assert!(run.path_of(10).is_some() && run.read(10).unwrap().is_ok(), "a kept file still reads");
        assert!(run.path_of(11).is_none(), "a file the page let go of is gone");
    }

    #[test]
    fn cancelling_a_run_ends_its_batches() {
        let dir = temp_dir("run-cancel");
        for i in 0..400 {
            fs::write(dir.join(format!("{i:03}.txt")), "x").unwrap();
        }
        let run = ScanRun::start(Plan::chosen(vec![(dir.clone(), "chosen".into())], PlanCtx::default()));
        let first = run.batch(&[], &[], Duration::from_secs(5)).unwrap();
        assert!(!first.files.is_empty());
        run.cancel();
        let after = run.batch(&[], &[], Duration::from_millis(50)).unwrap();
        assert!(after.done && after.files.is_empty());
        assert!(run.read(first.files[0].index).is_none());
        assert!(run.full_record(&[], &[]).is_none());
    }

    #[test]
    fn a_full_run_leaves_its_record_only_once_the_walk_is_whole_and_without_unread_files() {
        let dir = temp_dir("run-record");
        for name in ["a.txt", "b.txt", "c.txt"] {
            fs::write(dir.join(name), "x").unwrap();
        }
        let ctx = PlanCtx {
            salt: "s".into(),
            ..PlanCtx::default()
        };
        let run = ScanRun::start(Plan::full(vec![dir.clone()], None, false, ctx));
        let (files, _) = drain(&run, 1);
        let b = files.iter().find(|f| f.name == "b.txt").unwrap().index;
        let a = files.iter().find(|f| f.name == "a.txt").unwrap().index;
        let records = run.full_record(&[b], &[a]).expect("a whole Full walk");
        assert_eq!(records.len(), 2);
        assert!(!records.iter().any(|r| r.0 == baseline_key("s", &dir.join("b.txt"))), "b couldn't be read");
        assert!(
            records.iter().any(|r| r.0 == baseline_key("s", &dir.join("a.txt")) && r.2),
            "a came back worth a look, so its bit is set"
        );
        assert!(
            records.iter().any(|r| r.0 == baseline_key("s", &dir.join("c.txt")) && !r.2),
            "c wasn't named, so its bit stays unset"
        );
        let chosen = ScanRun::start(Plan::chosen(vec![(dir.clone(), "chosen".into())], PlanCtx::default()));
        drain(&chosen, 1);
        assert!(chosen.full_record(&[], &[]).is_none(), "only Full keeps a record");
    }

    // ---------- What a scan leaves alone, and the same file in many places ----------

    /// A messy desktop: a project with its packages, a venv, a template and a real `.env`, a Bitwarden vault, a
    /// KeePass file, and three copies of one note (the way worktrees of one repo hold the same file).
    fn messy_desktop(dir: &Path) {
        let put = |rel: &str, body: &[u8]| {
            let p = dir.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, body).unwrap();
        };
        put("site/package.json", b"{\"name\":\"site\"}");
        put("site/node_modules/left-pad/index.js", b"const KEY = 'AKIA4HPQ7XZ2R6TWLJ3N';");
        put("site/node_modules/left-pad/test/fixture.json", b"{\"password\":\"hunter22\"}");
        put("site/dist/bundle.js", b"var t='ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';");
        put("site/.env.example", b"API_KEY=put-your-key-here");
        put("site/.env", b"API_KEY=sk_live_realrealreal");
        put("site/package-lock.json", b"{\"integrity\":\"sha512-abc\"}");
        put("tool/.venv/pyvenv.cfg", b"home = C:\\Python312");
        put("tool/.venv/Lib/site-packages/requests/test_auth.py", b"token = 'abc'");
        put("tool/main.py", b"print('hi')");
        put("Bitwarden/data.json", b"{\"encrypted\":\"2.abc|def\"}");
        put("vault.kdbx", &[3, 217, 162, 154]);
        for copy in ["clotr", "ap-one", "ap-two"] {
            put(&format!("{copy}/notes.txt"), b"password: Sunflower!2024");
        }
        put("other/notes.txt", b"a different note with the same name");
    }

    #[test]
    fn a_scan_skips_program_files_and_vaults_reads_a_real_env_and_counts_both() {
        let dir = temp_dir("messy");
        messy_desktop(&dir);
        let (files, walked) = walk_all(&Plan::chosen(vec![(dir.clone(), "desktop".into())], PlanCtx::default()));
        assert_eq!(
            names(&files),
            [".env", "main.py", "notes.txt", "notes.txt", "notes.txt", "notes.txt", "package.json"],
            "only the person's own files: no node_modules, dist, venv, template, lock file or vault"
        );
        let c = walked.counts;
        assert_eq!(c.dev_folders, 3, "node_modules, dist (beside package.json) and the venv");
        assert_eq!(c.vaults, 2, "Bitwarden's data.json and the .kdbx");
        assert_eq!(c.dev_files, 2, ".env.example and package-lock.json");
    }

    #[test]
    fn the_same_file_in_three_places_is_read_once_each_and_the_copies_point_at_the_first() {
        let dir = temp_dir("dups");
        messy_desktop(&dir);
        let run = ScanRun::start(Plan::chosen(vec![(dir.clone(), "desktop".into())], PlanCtx::default()));
        let (files, last) = drain(&run, 1);
        let notes: Vec<&Shown> = files.iter().filter(|f| f.name == "notes.txt").collect();
        assert_eq!(notes.len(), 4);
        let same: Vec<&&Shown> = notes.iter().filter(|f| f.parent != "other").collect();
        let first = same.iter().find(|f| f.dup_of.is_none()).expect("one of the three is the first");
        let copies: Vec<_> = same.iter().filter(|f| f.dup_of.is_some()).collect();
        assert_eq!(copies.len(), 2);
        assert!(copies.iter().all(|f| f.dup_of == Some(first.index)), "each copy names the first copy's index");
        assert!(copies.iter().all(|f| f.index > first.index), "the first copy was handed over first");
        let different = notes.iter().find(|f| f.parent == "other").unwrap();
        assert_eq!(different.dup_of, None, "a different file with the same name is its own entry");
        let mut parents: Vec<&str> = same.iter().map(|f| f.parent.as_str()).collect();
        parents.sort_unstable();
        assert_eq!(parents, ["ap-one", "ap-two", "clotr"], "each copy's folder by name, never a path");
        assert_eq!(last.counts.vaults, 2);
    }

    // By hand only, for a before and after on a real folder: walks and reads CLOTR_MEASURE_ROOT the way a scan
    // does and writes what it handed over (paths, copies, counts, time) to CLOTR_MEASURE_OUT, for a script to run
    // the engine over. `cargo test measure_a_folder -- --ignored`.
    #[test]
    #[ignore = "reads the folder named by CLOTR_MEASURE_ROOT"]
    fn measure_a_folder() {
        let (Some(root), Some(out)) = (std::env::var_os("CLOTR_MEASURE_ROOT"), std::env::var_os("CLOTR_MEASURE_OUT"))
        else {
            return;
        };
        let began = std::time::Instant::now();
        let run = ScanRun::start(Plan::chosen(vec![(PathBuf::from(root), "chosen".into())], PlanCtx::default()));
        let (files, last) = drain(&run, 1);
        let ms = began.elapsed().as_millis() as u64;
        let rows: Vec<serde_json::Value> = files
            .iter()
            .map(|f| {
                serde_json::json!({
                    "index": f.index,
                    "path": run.path_of(f.index).map(|p| p.to_string_lossy().into_owned()),
                    "parent": f.parent,
                    "dupOf": f.dup_of,
                })
            })
            .collect();
        let report = serde_json::json!({ "ms": ms, "counts": last.counts, "files": rows });
        fs::write(out, report.to_string()).unwrap();
    }

    /// A PC with a bit of everything Full leaves out: a code project, secret files loose and in their tools' homes,
    /// a vault, a game with its uninstaller and redistributables, a game library, a tool with its libraries, the
    /// per-user program folder, an editor's and a browser's extensions. And the person's own files beside them,
    /// a setup's .exe and .dll files loose in Downloads included.
    fn pc_with_everything(drive: &Path) -> PathBuf {
        let me = drive.join("Users").join("me");
        let put = |rel: &str, text: &str| {
            let path = drive.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        };
        put("Users/me/Desktop/taxes.txt", "x");
        put("Users/me/package.json", "{}");
        put("Users/me/Desktop/shop/package.json", "{}");
        put("Users/me/Desktop/shop/app.py", "x");
        put("Users/me/Documents/.env", "x");
        put("Users/me/Documents/server.pem", "x");
        put("Users/me/Documents/passwords.kdbx", "x");
        put("Users/me/.ssh/id_ed25519", "x");
        put("Users/me/.aws/credentials", "x");
        put("Users/me/.npmrc", "x");
        put("Users/me/Downloads/letter.txt", "x");
        for loose in ["setup.exe", "a.dll", "b.dll", "c.dll"] {
            put(&format!("Users/me/Downloads/{loose}"), "x");
        }
        put("Users/me/AppData/Local/Temp/attachment.txt", "x");
        put("Users/me/AppData/Local/Programs/Editor/resources/app.js", "x");
        put("Users/me/.vscode/extensions/some.ext/ext.js", "x");
        put("Users/me/AppData/Local/Google/Chrome/User Data/Default/Preferences", "x");
        put("Users/me/AppData/Local/Google/Chrome/User Data/Default/Extensions/abc/1.0/bg.js", "x");
        put("Games/Space Game/SpaceGame.exe", "x");
        put("Games/Space Game/unins000.exe", "x");
        put("Games/Space Game/Content/config.json", "x");
        fs::create_dir_all(drive.join("Games/Space Game/_Redist")).unwrap();
        put("SteamLibrary/steamapps/common/Other Game/readme.txt", "x");
        for part in ["tool.exe", "one.dll", "two.dll", "three.dll", "readme.txt"] {
            put(&format!("Tools/Tool/{part}"), "x");
        }
        me
    }

    #[test]
    fn full_leaves_out_projects_secret_files_vaults_and_installed_programs_and_games() {
        let drive = temp_dir("full-scope");
        let me = pc_with_everything(&drive);
        let ctx = PlanCtx {
            personal: vec![me.clone(), me.join("Downloads"), me.join("Desktop"), me.join("Documents")],
            ..PlanCtx::default()
        };
        let (files, walked) = walk_all(&Plan::full(vec![drive.clone()], None, false, ctx.clone()));
        let mut read = names(&files);
        read.sort();
        // The package.json loose in the home folder is read like any file: a home folder is never a code project.
        // The attachment in AppData's Temp is an app's working copy, left out with the rest of Temp.
        assert_eq!(read, ["letter.txt", "package.json", "taxes.txt"], "only the person's own files");
        let c = walked.counts;
        assert_eq!((c.code_projects, c.project_files), (1, 2), "package.json and app.py");
        assert_eq!(c.secret_files, 5, ".env, the .pem, the SSH key, the AWS sign-in and .npmrc");
        assert_eq!(c.vaults, 1);
        // The game, the game library and the tool: the per-user program folder and the Chrome extensions folder
        // are inside AppData, left out with the rest of it instead of being counted as programs on their own.
        assert_eq!(c.programs, 4);
        assert_eq!(c.app_storage, 1, "the whole of AppData, left out in one step");

        // The developer switch: the project and the secret files are read, each under its own mark.
        let (files, walked) = walk_all(&Plan::full(vec![drive.clone()], None, true, ctx));
        let marked = |f: &&Candidate| f.project || f.secret;
        let mut dev: Vec<String> = files.iter().filter(marked).map(|f| f.name.clone()).collect();
        dev.sort();
        assert_eq!(dev, [".env", ".npmrc", "app.py", "credentials", "id_ed25519", "package.json", "server.pem"]);
        assert!(files.iter().filter(|f| f.name == ".env").all(|f| f.secret && !f.project));
        assert_eq!(files.iter().filter(|f| !f.project && !f.secret).count(), 3, "the person's own files as before");
        assert_eq!((walked.counts.secret_files, walked.counts.project_files), (0, 0), "nothing of theirs left out");
        assert_eq!((walked.counts.vaults, walked.counts.programs), (1, 6), "vaults and programs stay out");
    }

    #[test]
    fn a_stray_project_file_or_setup_never_takes_a_persons_own_places_for_a_project_or_a_program() {
        let drive = temp_dir("loose-setup");
        let me = pc_with_everything(&drive);
        // Without the person's places, the package.json loose in their home makes it a code project, and the setup
        // makes Downloads a program: neither letter.txt nor anything else of theirs would be read.
        let (files, _) = walk_all(&Plan::full(vec![drive.clone()], None, false, PlanCtx::default()));
        assert!(!names(&files).contains(&"letter.txt".to_string()));
        let ctx = PlanCtx {
            personal: vec![me.join("Downloads")],
            ..PlanCtx::default()
        };
        let (files, _) = walk_all(&Plan::full(vec![drive.clone()], None, false, ctx));
        assert!(!names(&files).contains(&"taxes.txt".to_string()), "the home folder alone, unknown, is a project");
        let ctx = PlanCtx {
            personal: vec![me.clone(), me.join("Downloads")],
            ..PlanCtx::default()
        };
        let (files, _) = walk_all(&Plan::full(vec![drive.clone()], None, false, ctx));
        assert!(names(&files).contains(&"letter.txt".to_string()));
        assert!(names(&files).contains(&"taxes.txt".to_string()));
    }

    #[test]
    fn quick_leaves_secret_files_out_unless_the_developer_switch_is_on() {
        let drive = temp_dir("quick-secrets");
        let me = pc_with_everything(&drive);
        let floor = vec![(me.join("Documents"), "documents".to_string())];
        let (files, walked) = walk_all(&Plan::quick(floor.clone(), None, true, false, PlanCtx::default()));
        assert!(files.is_empty(), "{:?}", names(&files));
        assert_eq!((walked.counts.secret_files, walked.counts.vaults), (2, 1));
        let (files, _) = walk_all(&Plan::quick(floor, None, true, true, PlanCtx::default()));
        let mut read = names(&files);
        read.sort();
        assert_eq!(read, [".env", "server.pem"]);
        assert!(files.iter().all(|f| f.secret));
    }

    /// A developer's home folder as a first Full scan met it: the person's own two files, and around them what an
    /// app, a build tool or an AI coding tool wrote for itself, each full of things that read like details.
    fn a_developers_home(drive: &Path) -> PathBuf {
        let me = drive.join("Users").join("me");
        let put = |rel: &str| {
            let path = me.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        };
        put("Documents/notes.txt");
        put("Desktop/Trip/plan.txt");
        // Cargo's build output, outside any project, marked by the standard cache tag.
        put("AppData/Local/Tools/cargo-target-a/CACHEDIR.TAG");
        put("AppData/Local/Tools/cargo-target-a/debug/.fingerprint/lib-x/lib-x.json");
        put("Desktop/cache-of-mine/CACHEDIR.TAG");
        put("Desktop/cache-of-mine/thumbs.json");
        // An AI coding tool's own folder and its config beside it.
        put(".claude/projects/C--proj/abc.jsonl");
        put(".claude/.credentials.json");
        put(".claude.json");
        put(".codex/sessions/2026/rollout.jsonl");
        put("Desktop/site/.aider.chat.history.md");
        // App logs, temp files and a browser profile's storage.
        put("AppData/Local/Temp/AppInstaller-2026-10-15.log");
        put("AppData/Local/Temp/kotlin-daemon.2026-10-15.log");
        put("AppData/Local/Packages/Installer/LocalState/DiagOutputDir/App-20261015.log");
        put("AppData/Roaming/Code/logs/20261015/main.log");
        put("AppData/Local/claude-cli-nodejs/Cache/entry.json");
        for f in ["CURRENT", "LOCK", "MANIFEST-000001", "000003.log"] {
            put(&format!(
                "AppData/Local/Browser/User Data/Default/Local Storage/leveldb/{f}"
            ));
        }
        // A folder of scripts with no .git: a Node single-executable build, and a backup copy of only its tests.
        put("Desktop/Project Tools/source/sea-config.json");
        put("Desktop/Project Tools/source/check-runtime.js");
        put("Desktop/Project Tools/source.bak-1/sea-config.json");
        put("Desktop/Project Tools/source.bak-1/launcher.js");
        put("Desktop/Project Tools/presync/smoke-test.js");
        put("Desktop/Project Tools/presync/v3.html");
        // An app's own sign-in, in its own folder: GitHub's command line.
        put(".config/gh/hosts.yml");
        // Folders and files of the person's own that only share a word with the rules.
        put("Documents/Logs/workout.txt");
        put("Documents/Temp/draft.txt");
        put("Documents/my-test.txt");
        me
    }

    fn home_ctx(me: &Path) -> PlanCtx {
        PlanCtx {
            personal: vec![me.to_path_buf(), me.join("Desktop"), me.join("Documents")],
            ..PlanCtx::default()
        }
    }

    #[test]
    fn a_full_scan_leaves_out_caches_ai_tools_data_app_logs_and_script_folders() {
        let drive = temp_dir("dev-home");
        let me = a_developers_home(&drive);
        let (files, walked) = walk_all(&Plan::full(vec![me.clone()], None, false, home_ctx(&me)));
        assert_eq!(
            names(&files),
            ["draft.txt", "my-test.txt", "notes.txt", "plan.txt", "workout.txt"],
            "only the person's own files"
        );
        let c = walked.counts;
        // Outside AppData: the tagged cache on the Desktop, .claude and .codex, .claude.json and aider's history.
        // Everything else named above sits inside AppData, left out as a whole in one step (app_storage) instead
        // of each being counted as its own app_data folder.
        assert_eq!(c.app_data, 5);
        assert_eq!(c.app_storage, 1, "the whole of AppData: the tagged cargo cache, Temp, DiagOutputDir, Code's logs, the CLI's Cache and the browser's Local Storage all inside it");
        assert_eq!(c.code_projects, 3, "source, its backup and the folder of tests");
        assert_eq!(c.secret_files, 1, "GitHub's sign-in");

        // The developer switch reads code projects and secret files, never an app's own data.
        let (files, walked) = walk_all(&Plan::full(vec![me.clone()], None, true, home_ctx(&me)));
        assert_eq!(
            names(&files).len(),
            5 + 7,
            "the person's five, the three projects' six files and hosts.yml"
        );
        assert_eq!(walked.counts.app_data, 11);
    }

    /// Local model runners get the same treatment as any other AI tool's folder (16 Oct 2026): not just for the
    /// model weights Clotr never reads anyway, but for the key or the history file beside them.
    #[test]
    fn local_ai_model_tools_own_folders_are_left_out_like_any_other_ai_tool() {
        let drive = temp_dir("local-ai-tools");
        let me = drive.join("Users").join("me");
        let put = |rel: &str| {
            let path = me.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        };
        put("Documents/notes.txt");
        // Ollama's own folder: the SSH-style key it signs pushed models with, beside the model blobs themselves.
        put(".ollama/id_ed25519");
        put(".ollama/models/manifests/registry.ollama.ai/library/llama3/latest");
        // LM Studio's own folder: its chat history beside the models it downloaded.
        put(".lmstudio/conversations/2026-10-15.json");
        put(".lmstudio/models/some-model/weights.gguf");
        // Hugging Face's and LM Studio's own caches: already left out whole, inside the already-skipped `.cache`.
        put(".cache/huggingface/hub/token");
        put(".cache/lm-studio/models/some-model.json");
        let (files, walked) = walk_all(&Plan::full(vec![me.clone()], None, false, home_ctx(&me)));
        assert_eq!(names(&files), ["notes.txt"], "only the person's own file");
        assert_eq!(walked.counts.app_data, 2, ".ollama and .lmstudio, each counted once");
        assert_eq!(walked.counts.dev_folders, 1, ".cache counted once, never opened to see what's inside it");
    }

    /// A changes-only Full scan leaves a cache-tagged folder out exactly as a fresh
    /// one does: a cargo build's own files inside it never reach `file()`, baseline or not.
    #[test]
    fn a_changes_only_full_still_leaves_out_a_cache_tagged_folder() {
        let drive = temp_dir("changes-only-cache");
        fs::write(drive.join("mine.txt"), "x").unwrap();
        let target = drive.join("AppData").join("Local").join("Clotr").join("cargo-target-a");
        fs::create_dir_all(target.join("release").join("deps")).unwrap();
        fs::write(target.join("CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55").unwrap();
        fs::write(target.join("release").join("deps").join("engine.json"), "x").unwrap();
        let ctx = PlanCtx {
            salt: "salt3".into(),
            ..PlanCtx::default()
        };
        let first = walk_all(&Plan::full(vec![drive.clone()], None, false, ctx.clone()));
        assert_eq!(names(&first.0), ["mine.txt"], "the cache-tagged folder is left out on a fresh Full too");
        let baseline = Arc::new(Baseline::new(1, no_flags(first.1.records.clone())));
        fs::write(drive.join("new.txt"), "y").unwrap();
        let (files, _) = walk_all(&Plan::full(vec![drive.clone()], Some(baseline), false, ctx));
        assert_eq!(
            names(&files),
            ["new.txt"],
            "a changes-only Full must leave the cache-tagged folder out too, not just a fresh one"
        );
    }

    /// The same, but the cache-tagged folder itself is new since the baseline (a cargo build that ran between the
    /// two Fulls), as a cargo-target-* folder created between scans would be.
    #[test]
    fn a_changes_only_full_leaves_out_a_cache_tagged_folder_created_since_the_baseline() {
        let drive = temp_dir("changes-only-new-cache");
        fs::write(drive.join("mine.txt"), "x").unwrap();
        let ctx = PlanCtx {
            salt: "salt4".into(),
            ..PlanCtx::default()
        };
        let first = walk_all(&Plan::full(vec![drive.clone()], None, false, ctx.clone()));
        assert_eq!(names(&first.0), ["mine.txt"]);
        let baseline = Arc::new(Baseline::new(1, no_flags(first.1.records.clone())));
        let target = drive.join("AppData").join("Local").join("Clotr").join("cargo-target-b");
        fs::create_dir_all(target.join("release").join("deps")).unwrap();
        fs::write(target.join("CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55").unwrap();
        fs::write(target.join("release").join("deps").join("engine.json"), "x").unwrap();
        let (files, _) = walk_all(&Plan::full(vec![drive.clone()], Some(baseline), false, ctx));
        assert_eq!(
            names(&files),
            Vec::<String>::new(),
            "a cache-tagged folder built since the last Full is left out too"
        );
    }

    /// A baseline carrying a flagged bit from before this rule existed (an older Full, or an older build) must not
    /// force a re-read of a file whose folder the walker now leaves out: "re-read it anyway" is a file-level
    /// shortcut inside `file()`, which a folder skipped at `folder()` never reaches.
    #[test]
    fn an_old_flagged_bit_never_pulls_a_cache_tagged_folders_file_back_in() {
        let drive = temp_dir("changes-only-stale-flag");
        fs::write(drive.join("mine.txt"), "x").unwrap();
        let target = drive.join("AppData").join("Local").join("Clotr").join("cargo-target-a");
        fs::create_dir_all(target.join("release").join("deps")).unwrap();
        fs::write(target.join("CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55").unwrap();
        let inner_file = target.join("release").join("deps").join("engine.json");
        fs::write(&inner_file, "x").unwrap();
        let ctx = PlanCtx {
            salt: "salt5".into(),
            ..PlanCtx::default()
        };
        let flagged_key = baseline_key("salt5", &inner_file);
        let stamp = baseline_stamp(1, 0);
        let baseline = Arc::new(Baseline::new(1, vec![(flagged_key, stamp, true)]));
        let (files, _) = walk_all(&Plan::full(vec![drive.clone()], Some(baseline), false, ctx));
        assert_eq!(
            names(&files),
            ["mine.txt"],
            "a stale flagged bit must not re-read a file whose folder is now left out"
        );
    }

    #[test]
    fn every_file_is_placed_where_a_person_would_look_for_it_never_just_by_its_drive() {
        let drive = temp_dir("places");
        let me = drive.join("Users").join("me");
        let put = |rel: &str| {
            let path = drive.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        };
        put("Users/me/Desktop/Trip/plan.txt");
        put("Users/me/Desktop/Projects/Family Archive/Research/Notes/Deep/deep.txt");
        put("Users/me/Documents/notes.txt");
        put("Users/me/AppData/Roaming/Notes App/backup/old.txt");
        put("Users/me/letter.txt");
        put("Games/Space/readme.txt");
        put("top.txt");
        let ctx = PlanCtx {
            personal: vec![me.clone(), me.join("Desktop"), me.join("Documents")],
            places: vec![
                (me.join("Desktop"), "desktop".into()),
                (me.join("Documents"), "documents".into()),
            ],
            home: Some(me.clone()),
            ..PlanCtx::default()
        };
        let label = drive.to_string_lossy().trim_end_matches('\\').to_string();
        let placed = |files: &[Candidate]| {
            let mut out: Vec<String> = files
                .iter()
                .map(|f| format!("{} | {} | {}", f.name, f.folder, f.place.join(" › ")))
                .collect();
            out.sort();
            out
        };
        let (files, _) = walk_all(&Plan::full(vec![drive.clone()], None, false, ctx.clone()));
        assert_eq!(
            placed(&files),
            [
                "deep.txt | desktop | Projects › Family Archive › … › Deep".to_string(),
                "letter.txt | me | ".to_string(),
                "notes.txt | documents | ".to_string(),
                "plan.txt | desktop | Trip".to_string(),
                format!("readme.txt | {label} › Games | Space"),
                format!("top.txt | {label} | "),
            ],
            "AppData is left out as a whole, the developer switch off"
        );
        // Quick's places are their own tops, the same way.
        let floor = vec![(me.join("Desktop"), "desktop".to_string())];
        let (files, _) = walk_all(&Plan::quick(floor, None, true, false, ctx));
        assert_eq!(
            placed(&files),
            [
                "deep.txt | desktop | Projects › Family Archive › … › Deep",
                "plan.txt | desktop | Trip"
            ]
        );
    }

    #[test]
    fn below_and_full_walk_handle_multibyte_names_at_every_known_folder_length() {
        let fixture = temp_dir("multibyte-places");
        let known = [
            ("home", 8),
            ("desktop", 7),
            ("documents", 9),
            ("downloads", 9),
            ("pictures", 8),
        ];
        for (place, length) in known {
            for alphabet in ["É", "Я"] {
                let root = fixture.join(format!("{place}-{alphabet}"));
                let base = root.join("b".repeat(length));
                let directory = root.join(format!("{}{alphabet}", "a".repeat(length - 1)));
                let child = directory.join("child");
                fs::create_dir_all(&child).unwrap();
                fs::write(child.join("note.txt"), b"fixture").unwrap();

                assert_eq!(below(&base, &directory), None, "{place} {alphabet}");

                let ctx = PlanCtx {
                    places: vec![(base, place.to_string())],
                    home: (place == "home").then(|| root.join("b".repeat(length))),
                    ..PlanCtx::default()
                };
                let plan = Plan::full(vec![root.clone()], None, false, ctx);
                let (files, walked) = walk_all(&plan);
                assert!(walked.complete, "{place} {alphabet}");
                assert!(files.iter().any(|file| file.name == "note.txt"), "{place} {alphabet}");
            }
        }
    }

    #[test]
    fn an_apps_own_sign_in_file_is_marked_as_one_and_a_key_a_person_made_is_not() {
        let drive = temp_dir("app-signin");
        let put = |rel: &str| {
            let path = drive.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        };
        put(".config/gh/hosts.yml");
        put(".aws/credentials");
        put(".myapp/.credentials.json");
        put("shop/.credentials.json");
        put(".ssh/id_ed25519");
        put("shop/.env");
        // Folders I choose reads secret files, so each shows how it should be talked about.
        let (files, _) = walk_all(&Plan::chosen(vec![(drive.clone(), "home".into())], PlanCtx::default()));
        let mut signin: Vec<String> = files
            .iter()
            .map(|f| format!("{}/{} {}", f.parent, f.name, f.app_signin))
            .collect();
        signin.sort();
        assert_eq!(
            signin,
            [
                ".aws/credentials true",
                ".myapp/.credentials.json true",
                ".ssh/id_ed25519 false",
                "gh/hosts.yml true",
                "shop/.credentials.json false",
                "shop/.env false",
            ]
        );
        assert!(files.iter().all(|f| f.secret));
    }

    #[test]
    fn a_later_full_scan_reads_only_what_changed_and_keeps_the_rest_in_its_record() {
        let drive = temp_dir("full-again");
        fs::write(drive.join("old.txt"), "x").unwrap();
        fs::write(drive.join("kept.txt"), "x").unwrap();
        let ctx = PlanCtx {
            salt: "salt".into(),
            ..PlanCtx::default()
        };
        let first = walk_all(&Plan::full(vec![drive.clone()], None, false, ctx.clone())).1;
        assert_eq!(first.records.len(), 2);
        let baseline = Arc::new(Baseline::new(1, no_flags(first.records.clone())));
        fs::write(drive.join("new.txt"), "x").unwrap();
        let (files, again) = walk_all(&Plan::full(vec![drive.clone()], Some(baseline.clone()), false, ctx.clone()));
        assert_eq!(names(&files), ["new.txt"], "only what's new or changed is read");
        assert_eq!(again.records.len(), 3, "the unchanged two stay in the record, unread");
        // Read everything again: no record to go by.
        let (files, _) = walk_all(&Plan::full(vec![drive.clone()], None, false, ctx));
        assert_eq!(files.len(), 3);
    }

    #[test]
    fn a_later_full_scan_rereads_an_unchanged_file_flagged_worth_a_look_but_not_a_plain_unchanged_one() {
        let drive = temp_dir("full-earlier");
        fs::write(drive.join("plain.txt"), "x").unwrap();
        fs::write(drive.join("flagged.txt"), "y").unwrap();
        let ctx = PlanCtx {
            salt: "salt2".into(),
            ..PlanCtx::default()
        };
        let first = walk_all(&Plan::full(vec![drive.clone()], None, false, ctx.clone())).1;
        assert_eq!(first.records.len(), 2);
        let flagged_key = baseline_key("salt2", &drive.join("flagged.txt"));
        let flagged_entries = first
            .records
            .iter()
            .map(|(k, s)| (*k, *s, *k == flagged_key))
            .collect();
        let baseline = Arc::new(Baseline::new(1, flagged_entries));
        // Nothing on disk changed, but the flagged file comes back anyway, and the plain one still doesn't.
        let (files, again) = walk_all(&Plan::full(vec![drive.clone()], Some(baseline), false, ctx));
        assert_eq!(names(&files), ["flagged.txt"], "only the flagged file is read again");
        assert!(files[0].earlier, "the page knows it wasn't new or changed");
        assert_eq!(again.records.len(), 2, "both files still carry a record either way");
    }

    // By hand only, for a real PC's Full scan reach: walks every fixed drive (or CLOTR_MEASURE_DRIVES, `;` between)
    // the way a Full scan does but opens no file at all, a zip included (it counts as one file), and writes the
    // totals, the skip counts and the busiest folders at each depth to CLOTR_MEASURE_OUT. Paths stay in that file.
    // `cargo test measure_full_reach -- --ignored --nocapture`.
    #[test]
    #[ignore = "walks this PC's drives"]
    fn measure_full_reach() {
        let Some(out) = std::env::var_os("CLOTR_MEASURE_OUT") else {
            return;
        };
        let drives = match std::env::var("CLOTR_MEASURE_DRIVES") {
            Ok(list) => list.split(';').filter(|d| !d.is_empty()).map(PathBuf::from).collect(),
            Err(_) => fixed_drives(),
        };
        // As the app would: Clotr's own data folder skipped, the person's own places known, and the developer
        // switch as CLOTR_MEASURE_DEV says.
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default();
        let ctx = PlanCtx {
            skip: vec![local.join("Clotr").join("Desktop")],
            personal: personal_places(),
            ..PlanCtx::default()
        };
        let dev = std::env::var_os("CLOTR_MEASURE_DEV").is_some();
        let plan = Plan::full(drives, None, dev, ctx);
        let began = std::time::Instant::now();
        let mut by: HashMap<String, (u64, u64)> = HashMap::new();
        let (mut files, mut bytes, mut zips) = (0u64, 0u64, 0u64);
        let mut kinds: HashMap<String, (u64, u64)> = HashMap::new();
        let walked = walk_with(&plan, &AtomicBool::new(false), None, false, |c| {
            files += 1;
            bytes += c.check_bytes();
            zips += u64::from(c.kind == "zip");
            let k = kinds.entry(c.ext.clone()).or_default();
            k.0 += 1;
            k.1 += c.check_bytes();
            let parts: Vec<String> = c
                .path
                .parent()
                .map(|p| {
                    p.components()
                        .filter(|x| !matches!(x, std::path::Component::RootDir))
                        .map(|x| x.as_os_str().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default();
            for depth in 1..=parts.len().min(10) {
                let e = by.entry(parts[..depth].join("\\")).or_default();
                e.0 += 1;
                e.1 += c.check_bytes();
            }
            true
        });
        let mut rows: Vec<(String, (u64, u64))> = by.into_iter().filter(|(_, (n, _))| *n >= 1000).collect();
        rows.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
        let mut kinds: Vec<(String, (u64, u64))> = kinds.into_iter().collect();
        kinds.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
        let report = serde_json::json!({
            "ms": began.elapsed().as_millis() as u64,
            "files": files,
            "bytes": bytes,
            "zips": zips,
            "complete": walked.complete,
            "counts": walked.counts,
            "kinds": kinds.iter().take(40).map(|(e, (n, b))| serde_json::json!([e, n, b])).collect::<Vec<_>>(),
            "folders": rows.iter().map(|(p, (n, b))| serde_json::json!([p, n, b])).collect::<Vec<_>>(),
        });
        fs::write(out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
        println!("files {files}, zips {zips}, {} ms", began.elapsed().as_millis());
    }

    /// What a Full scan of one folder would hand over, sorted into the kinds of file a first Full on a developer's
    /// PC flagged that weren't the person's own: names and folder listings only, never a file's contents. Run by
    /// hand before and after a change to the skip rules (`CLOTR_MEASURE_OUT=out.json CLOTR_MEASURE_DRIVES=C:\Users\me\
    /// cargo test measure_scope_kinds -- --ignored --nocapture`); the difference per kind is what a rule removed.
    #[test]
    #[ignore = "walks a folder on this PC"]
    fn measure_scope_kinds() {
        let Some(out) = std::env::var_os("CLOTR_MEASURE_OUT") else {
            return;
        };
        let drives: Vec<PathBuf> = std::env::var("CLOTR_MEASURE_DRIVES")
            .map(|list| list.split(';').filter(|d| !d.is_empty()).map(PathBuf::from).collect())
            .unwrap_or_default();
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default();
        let ctx = PlanCtx {
            skip: vec![local.join("Clotr").join("Desktop")],
            personal: personal_places(),
            ..PlanCtx::default()
        };
        let dev = std::env::var_os("CLOTR_MEASURE_DEV").is_some();
        let plan = Plan::full(drives, None, dev, ctx);
        let mut memo: HashMap<(PathBuf, &'static str), bool> = HashMap::new();
        let mut has = |dir: &Path, what: &'static str| -> bool {
            *memo.entry((dir.to_path_buf(), what)).or_insert_with(|| match what {
                "tag" => dir.join("CACHEDIR.TAG").is_file(),
                "leveldb" => {
                    dir.join("CURRENT").is_file()
                        && fs::read_dir(dir).is_ok_and(|mut it| {
                            it.any(|e| e.is_ok_and(|e| e.file_name().to_string_lossy().starts_with("MANIFEST-")))
                        })
                }
                _ => ["sea-config.json", "package.json", "jsconfig.json", "tsconfig.json"]
                    .iter()
                    .any(|n| dir.join(n).is_file()),
            })
        };
        const AI: &[&str] = &[
            ".claude",
            ".codex",
            ".gemini",
            ".cursor",
            ".windsurf",
            ".codeium",
            ".continue",
            ".copilot",
        ];
        let mut kinds: HashMap<&'static str, u64> = HashMap::new();
        let mut files = 0u64;
        let walked = walk_with(&plan, &AtomicBool::new(false), None, false, |c| {
            files += 1;
            let lower = c.path.to_string_lossy().to_lowercase();
            let segs: Vec<&str> = lower.split('\\').collect();
            let dirs: Vec<PathBuf> = c.path.ancestors().skip(1).map(Path::to_path_buf).collect();
            let kind = if dirs.iter().any(|d| has(d, "tag")) {
                "cachedir_tag"
            } else if segs.iter().any(|s| AI.contains(s)) || c.name.to_lowercase().starts_with(".claude.json") {
                "ai_tool_data"
            } else if lower.contains("\\appdata\\local\\temp\\") {
                "temp"
            } else if dirs.first().is_some_and(|d| has(d, "leveldb")) {
                "leveldb"
            } else if lower.contains("\\appdata\\") && segs.iter().any(|s| matches!(*s, "logs" | "log")) {
                "app_logs"
            } else if dirs.iter().take(6).any(|d| has(d, "project")) {
                "projects_without_git"
            } else {
                "other"
            };
            *kinds.entry(kind).or_default() += 1;
            true
        });
        let report =
            serde_json::json!({ "files": files, "complete": walked.complete, "counts": walked.counts, "kinds": kinds });
        fs::write(out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
        println!("files {files}");
    }

    #[test]
    fn a_batch_read_several_at_once_hands_each_file_its_own_bytes_in_the_walks_order() {
        let dir = temp_dir("readers");
        for i in 0..200 {
            // Every file different, and every fifth one a copy of the file before it.
            let text = format!("file {}", i - i % 5 * usize::from(i % 5 == 4) / 4);
            fs::write(dir.join(format!("{i:03}.txt")), text).unwrap();
        }
        for readers in [1, READERS] {
            let run = ScanRun::start_with(Plan::chosen(vec![(dir.clone(), "chosen".into())], PlanCtx::default()), readers);
            let mut seen = Vec::new();
            let mut settled = Vec::new();
            loop {
                let batch = run.batch(&settled, &[], Duration::from_secs(5)).unwrap();
                settled = batch.files.iter().map(|f| f.index).collect();
                for f in &batch.files {
                    let bytes = run.read(f.index).unwrap().unwrap();
                    seen.push((f.name.clone(), String::from_utf8(bytes).unwrap(), f.dup_of.is_some()));
                }
                if batch.done {
                    break;
                }
            }
            let names: Vec<&str> = seen.iter().map(|(n, _, _)| n.as_str()).collect();
            let mut sorted = names.clone();
            sorted.sort();
            assert_eq!(names, sorted, "in the walk's order with {readers} readers");
            assert_eq!(seen.len(), 200);
            let copies = seen.iter().filter(|(_, _, dup)| *dup).count();
            let distinct: std::collections::HashSet<&str> = seen.iter().map(|(_, t, _)| t.as_str()).collect();
            assert_eq!(copies, 200 - distinct.len(), "a copy is still known as one");
            for (name, text, _) in &seen {
                let on_disk = fs::read_to_string(dir.join(name)).unwrap();
                assert_eq!(text, &on_disk, "{name} got its own bytes");
            }
        }
    }

    // By hand only, for how fast a run hands files over on a real disk: reads every file under CLOTR_PROFILE_ROOT
    // through ScanRun the way the page does (a batch, then each file's bytes), with CLOTR_PROFILE_READERS readers
    // (8 when unset), and prints files a second. Pick a folder of program files nobody opened lately, since a file
    // read once is quick the second time. `cargo test profile_reads -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads a real folder"]
    fn profile_reads() {
        let Some(root) = std::env::var_os("CLOTR_PROFILE_ROOT") else {
            return;
        };
        let readers = std::env::var("CLOTR_PROFILE_READERS").ok().and_then(|n| n.parse().ok()).unwrap_or(READERS);
        let run = ScanRun::start_with(Plan::chosen(vec![(PathBuf::from(root), "chosen".into())], PlanCtx::default()), readers);
        let began = std::time::Instant::now();
        let (mut files, mut bytes, mut in_batch) = (0u64, 0u64, Duration::ZERO);
        let mut settled = Vec::new();
        loop {
            let asked = std::time::Instant::now();
            let batch = run.batch(&settled, &[], Duration::from_secs(5)).unwrap();
            in_batch += asked.elapsed();
            settled = batch.files.iter().map(|f| f.index).collect();
            for f in &batch.files {
                if let Some(Ok(b)) = run.read(f.index) {
                    bytes += b.len() as u64;
                }
                files += 1;
            }
            if batch.done {
                break;
            }
        }
        let secs = began.elapsed().as_secs_f64();
        println!(
            "readers {readers}: {files} files, {:.1} MB in {secs:.1} s, {:.0} files/s, {:.1} s waiting on batches",
            bytes as f64 / 1e6,
            files as f64 / secs,
            in_batch.as_secs_f64()
        );
    }

    #[test]
    fn a_batchs_bytes_are_read_once_and_handed_over_once_then_read_fresh() {
        let dir = temp_dir("held");
        fs::write(dir.join("a.txt"), "first").unwrap();
        let run = ScanRun::start(Plan::chosen(vec![(dir.clone(), "chosen".into())], PlanCtx::default()));
        let batch = run.batch(&[], &[], Duration::from_secs(5)).unwrap();
        let index = batch.files[0].index;
        // Changed after the batch read it: the page's first read gets the batch's bytes (what was hashed), any
        // later read (Save a copy) gets the file as it is now.
        fs::write(dir.join("a.txt"), "second").unwrap();
        assert_eq!(run.read(index).unwrap().unwrap(), b"first");
        assert_eq!(run.read(index).unwrap().unwrap(), b"second");
    }

    #[test]
    fn what_the_person_left_out_is_never_opened_and_is_counted() {
        let dir = temp_dir("excluded");
        messy_desktop(&dir);
        let store_dir = temp_dir("excluded-store");
        let mut store = crate::store::Store::open(&store_dir).unwrap();
        store.add_exclusion("folder", &dir.join("ap-one").to_string_lossy()).unwrap();
        store.add_exclusion("file", &dir.join("tool").join("main.py").to_string_lossy()).unwrap();
        store.add_exclusion("type", "json").unwrap();
        let ctx = PlanCtx {
            excluded: Arc::new(store.exclusions()),
            ..PlanCtx::default()
        };
        let (files, walked) = walk_all(&Plan::chosen(vec![(dir.clone(), "desktop".into())], ctx.clone()));
        assert_eq!(names(&files), [".env", "notes.txt", "notes.txt", "notes.txt"]);
        assert_eq!(walked.counts.excluded, 3, "a folder, a file and package.json by its type");
        // A chosen folder inside one that's left out stays out.
        let (inside, _) = walk_all(&Plan::chosen(vec![(dir.join("ap-one"), "ap-one".into())], ctx));
        assert!(inside.is_empty());
    }

    #[test]
    fn leave_out_from_a_result_names_its_folder_or_its_type_by_index() {
        let dir = temp_dir("exclude-from");
        fs::create_dir_all(dir.join("fixtures")).unwrap();
        fs::write(dir.join("fixtures").join("corpus.jsonl"), "x").unwrap();
        let (files, _) = walk(&[(dir.clone(), "chosen".into())], &WalkLimits::default());
        let run = ScanRun::listed(files);
        let (kind, value) = run.exclusion_for(0, "folder").unwrap();
        assert_eq!(kind, "folder");
        assert!(same_path(Path::new(&value), &dir.join("fixtures")));
        assert_eq!(run.exclusion_for(0, "type"), Some(("type", "jsonl".to_string())));
        assert_eq!(run.exclusion_for(0, "drive"), None);
        assert_eq!(run.exclusion_for(9, "folder"), None, "an index this run never handed over");
    }
}
