use std::fs;
use std::io::Read;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

use super::scan_rules::{desktop, documents, downloads, pictures, Candidate, DOC_CAP, PICTURE_CAP, TEXT_CAP};
use super::scan_run::read_for_check;

use std::os::windows::io::AsRawHandle;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{FileStandardInfo, GetFileInformationByHandleEx, FILE_STANDARD_INFO};

// ---------- Reading a file up to its cap ----------

/// The format's own cap for a candidate's kind ("text", "doc" or "picture"), the same one the walker counted it
/// against.
pub(crate) fn cap_of(kind: &str) -> u64 {
    match kind {
        "doc" => DOC_CAP,
        "picture" => PICTURE_CAP,
        _ => TEXT_CAP,
    }
}

/// Everything `from` holds, as long as that's no more than `limit` bytes; past that it's an error ("not read"),
/// never a file cut short and never more than `limit + 1` bytes held in memory on the way to finding out.
pub(crate) fn read_capped(from: impl Read, limit: u64) -> std::io::Result<Vec<u8>> {
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

/// One entry's bytes out of an open zip (4.8). `by_name`, never `by_index`: the index inside this archive handle
/// isn't guaranteed to land on the same entry `by_index_raw` saw while walking. Held to the size the walker
/// counted: a zip's declared size is only a claim, and its compressed data can unpack to far more, so an entry
/// that runs past what it claimed is "not read" rather than unpacked in full.
fn read_entry(archive: &mut zip::ZipArchive<fs::File>, entry_name: &str, counted: u64) -> std::io::Result<Vec<u8>> {
    let entry = archive.by_name(entry_name)?;
    read_capped(entry, counted)
}

/// One entry's bytes, read out of its zip opened fresh: what a by-index read after the batch uses.
pub(crate) fn read_zip_entry(zip_path: &Path, entry_name: &str, counted: u64) -> std::io::Result<Vec<u8>> {
    let (mut archive, _, _) = open_zip(zip_path)?;
    read_entry(&mut archive, entry_name, counted)
}

// ---------- A zip held open from one batch to the next ----------

/// A file's size and modified time, the stamp an open zip is checked against.
fn stamp(meta: &fs::Metadata) -> (u64, u64) {
    (meta.len(), meta.last_write_time())
}

/// A zip opened and its list read, with a second handle to the same open file and the stamp it had then.
fn open_zip(zip_path: &Path) -> std::io::Result<(zip::ZipArchive<fs::File>, fs::File, (u64, u64))> {
    let file = fs::File::open(zip_path)?;
    let opened = stamp(&file.metadata()?);
    let held = file.try_clone()?;
    Ok((zip::ZipArchive::new(file)?, held, opened))
}

/// Whether the open file has been deleted while it's held open. Windows can still show such a file at its path
/// until the last handle closes, so its path alone can't tell.
fn delete_pending(file: &fs::File) -> bool {
    let mut info = FILE_STANDARD_INFO::default();
    let asked = unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle() as *mut _),
            FileStandardInfo,
            &mut info as *mut FILE_STANDARD_INFO as *mut _,
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        )
    };
    asked.is_err() || info.DeletePending
}

/// The zip one reader has open, kept for a run of entries from it so its list is read once, not once per entry.
/// Nothing about an entry is kept, only the archive. `archive` is None once the zip couldn't be opened, changed
/// size or modified time, or went away: the rest of its entries are then "not read".
pub(crate) struct OpenZip {
    path: PathBuf,
    opened: (u64, u64),
    archive: Option<(zip::ZipArchive<fs::File>, fs::File)>,
}

impl OpenZip {
    fn open(zip_path: &Path) -> (OpenZip, Option<std::io::Error>) {
        let (archive, opened, failed) = match open_zip(zip_path) {
            Ok((archive, held, opened)) => (Some((archive, held)), opened, None),
            Err(error) => (None, (0, 0), Some(error)),
        };
        (OpenZip { path: zip_path.to_path_buf(), opened, archive }, failed)
    }

    /// Still the same file it was when opened: at its path, with the same size and modified time, not deleted.
    fn unchanged(&self) -> bool {
        let Some((_, held)) = &self.archive else { return false };
        fs::metadata(&self.path).is_ok_and(|meta| stamp(&meta) == self.opened) && !delete_pending(held)
    }

    fn read(&mut self, entry_name: &str, counted: u64) -> std::io::Result<Vec<u8>> {
        if !self.unchanged() {
            self.archive = None;
        }
        let changed = || std::io::Error::other("the zip changed during the scan");
        let (archive, _) = self.archive.as_mut().ok_or_else(changed)?;
        read_entry(archive, entry_name, counted)
    }
}

/// What the check reads of a candidate, for one reader: a zip entry out of the zip this reader already has open
/// (opened now if it's another zip), anything else as `read_for_check` reads it, letting go of the open zip.
pub(crate) fn read_with(candidate: &Candidate, open: &mut Option<OpenZip>) -> std::io::Result<Vec<u8>> {
    let Some(entry_name) = &candidate.zip_entry else {
        *open = None;
        return read_for_check(candidate);
    };
    let same_zip = open.as_ref().is_some_and(|zip| zip.path == candidate.path);
    if !same_zip {
        let (zip, failed) = OpenZip::open(&candidate.path);
        *open = Some(zip);
        if let Some(error) = failed {
            return Err(error);
        }
    }
    let Some(zip) = open.as_mut() else {
        return Err(std::io::Error::other("not read"));
    };
    zip.read(entry_name, candidate.size)
}

// ---------- Where a scan starts: Quick's places, chosen folders, the fixed drives ----------

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
        .filter_map(|(path, label)| Some((path?, label.to_string())))
        .collect(),
    )
}

/// Places with any that sit inside another left out (a Pictures folder moved into Documents, say), so no file is
/// read twice in one scan.
pub(crate) fn distinct_places(places: Vec<(PathBuf, String)>) -> Vec<(PathBuf, String)> {
    let keys: Vec<String> = places.iter().map(|(path, _)| place_key(path)).collect();
    places
        .into_iter()
        .enumerate()
        .filter(|(index, _)| !inside_or_repeated(&keys, *index))
        .map(|(_, place)| place)
        .collect()
}

/// A place's path to compare by: lower case, with no backslash at the end.
fn place_key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase().trim_end_matches('\\').to_string()
}

/// Left out when it's inside another place, or the same folder as one listed before it.
fn inside_or_repeated(keys: &[String], index: usize) -> bool {
    let this = &keys[index];
    keys.iter().enumerate().any(|(other_index, other)| {
        let listed_before = other_index < index && other == this;
        listed_before || this.starts_with(&format!("{other}\\"))
    })
}

/// The folders the person chose in Windows' own picker, each named by its own folder name.
pub fn chosen_roots(paths: &[PathBuf]) -> Vec<(PathBuf, String)> {
    paths
        .iter()
        .map(|path| {
            let label = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            (path.clone(), label)
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
        .filter(|letter| mask & (1 << letter) != 0)
        .filter_map(|letter| {
            let root = format!("{}:\\", (b'A' + letter) as char);
            let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            let fixed = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) } == DRIVE_FIXED;
            fixed.then(|| PathBuf::from(root))
        })
        .collect()
}
