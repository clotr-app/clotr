use std::path::PathBuf;

use super::skiplist;

use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{
    SHGetKnownFolderPath, FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music, FOLDERID_Pictures,
    FOLDERID_Profile, FOLDERID_Videos, KF_FLAG_DEFAULT,
};

// ---------- Attributes (Microsoft Learn, "File Attribute Constants") ----------

pub(crate) const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
pub(crate) const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
pub(crate) const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
pub(crate) const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
pub(crate) const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
pub(crate) const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x40000;
pub(crate) const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x400000;
const ONLINE_ONLY: u32 = FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

pub(crate) fn is_dir(attributes: u32) -> bool {
    attributes & FILE_ATTRIBUTE_DIRECTORY != 0
}

pub(crate) fn is_link(attributes: u32) -> bool {
    attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

pub(crate) fn is_hidden_or_system(attributes: u32) -> bool {
    attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
}

pub(crate) fn is_online_only(attributes: u32) -> bool {
    attributes & ONLINE_ONLY != 0
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

pub(crate) const TEXT_CAP: u64 = 2 * 1024 * 1024;
pub(crate) const DOC_CAP: u64 = 20 * 1024 * 1024;
pub(crate) const PICTURE_CAP: u64 = 20 * 1024 * 1024;

// Zip budget (4.8): the most a single scan will ever unpack out of every .zip it meets, combined. A real export
// (Google Takeout, a backup, an AI chat export) rarely holds more than a few hundred megabytes once you look at
// what Clotr would actually read from it (text, documents, pictures, each already capped above); a zip bomb's
// whole point is a tiny file ballooning far past that once unpacked. 256 MiB is roomy enough for a real export
// and still a hard ceiling against a crafted one, applied once across the whole scan rather than per zip.
pub(crate) const ZIP_BUDGET: u64 = 256 * 1024 * 1024;

/// What a file's extension reads as ("text", "doc" or "picture") and the size past which it's "too big to read",
/// or `None` for a format Clotr doesn't know how to read (not counted at all: it was never something Clotr could
/// find a detail in).
pub(crate) fn category(ext: &str) -> Option<(&'static str, u64)> {
    let lower = ext.to_ascii_lowercase();
    let ext = lower.as_str();
    if TEXT_EXTS.contains(&ext) || KEY_FILE_EXTS.contains(&ext) {
        return Some(("text", TEXT_CAP));
    }
    if DOC_EXTS.contains(&ext) {
        return Some(("doc", DOC_CAP));
    }
    if PICTURE_EXTS.contains(&ext) {
        return Some(("picture", PICTURE_CAP));
    }
    None
}

/// A `.env` file itself, or one of its variants (`.env.local`, `.env.production`): Rust's own `extension()` reads
/// the part after a later dot as the extension (so `.env.local`'s is "local", not "env"), which is why this checks
/// the name directly instead of going through `category()`.
fn is_env_variant(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".env" || lower.starts_with(".env.")
}

/// Like `category()`, but also recognizes a key or sign-in file by its exact name when it has no extension of
/// its own (`id_rsa`) or when its extension alone wouldn't say what it is (`.env.local`).
pub(crate) fn category_for(name: &str, ext: &str) -> Option<(&'static str, u64)> {
    let lower = name.to_ascii_lowercase();
    let is_key_name = ext.is_empty() && KEY_FILE_NAMES.contains(&lower.as_str());
    if is_key_name || skiplist::SECRET_NAMES.contains(&lower.as_str()) {
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

pub(crate) fn skip_dir_name(name: &str) -> bool {
    SKIP_DIR_NAMES.contains(&name.to_ascii_lowercase().as_str())
}

/// A Full scan's own, much shorter list: only the folders Windows itself owns at a drive's root -- the system,
/// the installed programs, the Recycle Bin, restore points, recovery and update leftovers. Everything else on a
/// fixed drive is opened, AppData and project folders included, the way an antivirus scan reaches.
pub(crate) const DRIVE_ROOT_SKIPS: &[&str] = &[
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
pub(crate) const DRIVE_ANYWHERE_SKIPS: &[&str] = &["$recycle.bin", "system volume information"];

/// The page, swap and hibernation files, at a drive's root. They're hidden system files in a format Clotr doesn't
/// read anyway; named here so a Full scan never opens one even on a PC where those attributes were changed.
pub(crate) const DRIVE_ROOT_FILE_SKIPS: &[&str] = &["pagefile.sys", "hiberfil.sys", "swapfile.sys"];

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

// ---------- What the walker hands over, and what it counts ----------

/// How much of a JPEG the check reads: its place (EXIF) sits in the first segments, so the rest of the photo is
/// never carried to the page. A name that says it's an ID needs no bytes at all.
pub(crate) const JPEG_HEAD: u64 = 256 * 1024;

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

impl Candidate {
    pub(crate) fn head_only(&self) -> bool {
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
