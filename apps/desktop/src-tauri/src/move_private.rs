//! *Move it somewhere private*: moves one scanned file into
//! a folder the person chose with Windows' own folder picker, defaulting to OneDrive's Personal Vault when this PC
//! has one. The scan itself only ever reads; a file changes only once the person presses a button that names what
//! it does, the same rule `recycle.rs` follows. Undoable: `move_back` returns a moved file to exactly the path it
//! came from.

use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use windows::Win32::Foundation::{GENERIC_READ, HANDLE};
use windows::Win32::Storage::FileSystem::{
    FileDispositionInfo, FileRenameInfo, GetFileInformationByHandle, SetFileInformationByHandle,
    BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ADD_FILE, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_RENAME_INFO,
};

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// A reparse point (a symbolic link, a junction, a mount point): never trusted as either end of a move, since
/// what it really points at isn't what the person sees in the picker or in Results.
fn is_link(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(meta) => meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        // Can't be read at all: treated the same as a link, since it can't be told apart from one here.
        Err(_) => true,
    }
}

/// OneDrive's Personal Vault, when this PC has one: Microsoft's own apps only ever create it as `Personal Vault`
/// directly inside OneDrive's own folder, so this is the one place it's worth looking. A guess, not a guarantee --
/// it only changes which folder the picker opens on, never which folder a move trusts.
pub fn personal_vault() -> Option<PathBuf> {
    for var in ["OneDriveConsumer", "OneDrive"] {
        let Ok(root) = std::env::var(var) else { continue };
        let vault = PathBuf::from(root).join("Personal Vault");
        if vault.is_dir() {
            return Some(vault);
        }
    }
    None
}

/// What `move_back` needs to undo one move: where the file came from, and where it ended up.
#[derive(Debug, PartialEq)]
pub struct Moved {
    pub from: PathBuf,
    pub to: PathBuf,
}

/// A name already taken in `dir` gets " (2)", " (3)" and so on before its extension, the same shape Windows' own
/// copy dialog uses, so a move never overwrites anything already there.
fn unique_name(dir: &Path, name: &OsStr) -> PathBuf {
    let name = Path::new(name);
    if !dir.join(name).exists() {
        return name.to_path_buf();
    }
    let stem = name.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = name.extension().and_then(|s| s.to_str());
    for n in 2u32.. {
        let candidate = match ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        if !dir.join(&candidate).exists() {
            return PathBuf::from(candidate);
        }
    }
    unreachable!("a folder can't hold u32::MAX files of the same name")
}

/// Where `name` would land inside `dir`: refuses anything that doesn't resolve to a direct child of `dir` (a `..`
/// or a separator smuggled into the name, or `dir` not being a real, already-existing folder), so a move can never
/// land somewhere the person didn't pick. `name` is always a destination file's own name only, never a path the
/// page or a scanned file's own name could steer elsewhere.
fn destination_for(dir: &Path, name: &OsStr) -> Result<PathBuf, String> {
    let dest = dir.join(unique_name(dir, name));
    if dest.parent() != Some(dir) {
        return Err("outside".to_string());
    }
    Ok(dest)
}

/// Moves `path` into `dest_dir`, a folder the person already chose through the system's own picker. Refuses:
/// `dest_dir` missing or not a real folder, either end being a link, a computed destination that doesn't stay
/// directly inside `dest_dir`, or `path` having changed size or modified time since the scan recorded it
/// (`recorded`, from `ScanRun::stamp_of`). It opens the source without following reparse points, checks that handle,
/// and then moves that same file object. Same-volume moves rename by handle; cross-volume moves copy from the handle
/// and mark that handle for deletion only after the destination copy has the expected size. Any failure is closed.
pub fn move_into(dest_dir: &Path, path: &Path, recorded: (u64, u64)) -> Result<Moved, String> {
    move_into_with_seam(dest_dir, path, recorded, || {})
}

fn move_into_with_seam<F: FnOnce()>(
    dest_dir: &Path,
    path: &Path,
    recorded: (u64, u64),
    after_check: F,
) -> Result<Moved, String> {
    let dest_meta = fs::metadata(dest_dir).map_err(|_| "not-found".to_string())?;
    if !dest_meta.is_dir() {
        return Err("not-found".to_string());
    }
    if is_link(dest_dir) {
        return Err("linked".to_string());
    }
    let source = OpenOptions::new()
        .read(true)
        .access_mode(GENERIC_READ.0 | DELETE.0)
        .share_mode(
            windows::Win32::Storage::FileSystem::FILE_SHARE_READ.0
                | windows::Win32::Storage::FileSystem::FILE_SHARE_DELETE.0,
        )
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0 | FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(path)
        .map_err(|_| "not-found".to_string())?;
    let meta = source.metadata().map_err(|_| "not-moved".to_string())?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !meta.is_file() {
        return Err("linked".to_string());
    }
    if (meta.len(), meta.last_write_time()) != recorded {
        return Err("changed".to_string());
    }
    after_check();
    let dir = OpenOptions::new()
        .read(true)
        .access_mode(GENERIC_READ.0 | FILE_ADD_FILE.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(dest_dir)
        .map_err(|_| "not-found".to_string())?;
    let dir_meta = dir.metadata().map_err(|_| "not-found".to_string())?;
    if !dir_meta.is_dir() || dir_meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("linked".to_string());
    }
    let name = path.file_name().ok_or_else(|| "not-found".to_string())?;
    let dest = destination_for(dest_dir, name)?;
    let source_info = handle_info(&source)?;
    let dest_info = handle_info(&dir)?;
    if source_info.dwVolumeSerialNumber == dest_info.dwVolumeSerialNumber {
        rename_by_handle(&source, &dest)?;
    } else {
        let mut output = OpenOptions::new()
            .write(true)
            .share_mode(windows::Win32::Storage::FileSystem::FILE_SHARE_READ.0)
            .create_new(true)
            .open(&dest)
            .map_err(|_| "not-moved".to_string())?;
        let result = copy_and_remove(&source, &mut output, meta.len());
        if result.is_err() {
            drop(output);
            let _ = fs::remove_file(&dest);
        }
        result?;
    }
    Ok(Moved {
        from: path.to_path_buf(),
        to: dest,
    })
}

fn handle_info(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION, String> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle() as *mut _), &mut info) }
        .map_err(|_| "not-moved".to_string())?;
    Ok(info)
}

fn rename_by_handle(file: &File, dest: &Path) -> Result<(), String> {
    let wide: Vec<u16> = dest.as_os_str().encode_wide().collect();
    let bytes = std::mem::offset_of!(FILE_RENAME_INFO, FileName) + wide.len() * 2;
    let mut storage = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).RootDirectory = HANDLE::default();
        (*info).FileNameLength = (wide.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(wide.as_ptr(), (*info).FileName.as_mut_ptr(), wide.len());
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle() as *mut _),
            FileRenameInfo,
            info.cast(),
            bytes as u32,
        )
    }
    .map_err(|_| "not-moved".to_string())
}

fn copy_and_remove(source: &File, output: &mut File, expected: u64) -> Result<(), String> {
    let mut input = source.try_clone().map_err(|_| "not-moved".to_string())?;
    let copied = std::io::copy(&mut input, output).map_err(|_| "not-moved".to_string())?;
    output.flush().map_err(|_| "not-moved".to_string())?;
    if copied != expected || output.metadata().map_err(|_| "not-moved".to_string())?.len() != expected {
        return Err("not-moved".to_string());
    }
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    unsafe {
        SetFileInformationByHandle(
            HANDLE(source.as_raw_handle() as *mut _),
            FileDispositionInfo,
            (&disposition as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    }
    .map_err(|_| "not-moved".to_string())
}

/// Puts a moved file back exactly where it came from. Refuses if another file has since taken that name, the same
/// never-overwrite rule the move itself followed.
pub fn move_back(moved: &Moved) -> Result<(), String> {
    if moved.from.exists() {
        return Err("not-restored".to_string());
    }
    fs::rename(&moved.to, &moved.from).or_else(|_| {
        fs::copy(&moved.to, &moved.from).map_err(|_| "not-restored".to_string())?;
        fs::remove_file(&moved.to).map_err(|_| "not-restored".to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("clotr-move-private-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn stamp(path: &Path) -> (u64, u64) {
        let meta = fs::metadata(path).unwrap();
        (meta.len(), meta.last_write_time())
    }

    #[test]
    fn a_moved_file_leaves_its_own_place_and_undo_puts_it_straight_back() {
        let from_dir = temp_dir("roundtrip-from");
        let to_dir = temp_dir("roundtrip-to");
        let path = from_dir.join("passport.jpg");
        fs::write(&path, b"not a real photo").unwrap();
        let recorded = stamp(&path);

        let moved = move_into(&to_dir, &path, recorded).expect("moved");
        assert!(!path.exists(), "the file leaves its own place once it's moved");
        assert!(moved.to.exists(), "and lands in the chosen folder");
        assert_eq!(moved.to.file_name().unwrap(), "passport.jpg");

        move_back(&moved).expect("Undo puts it back");
        assert!(path.exists(), "Undo puts it back where it was");
        assert_eq!(fs::read(&path).unwrap(), b"not a real photo");

        let _ = fs::remove_dir_all(&from_dir);
        let _ = fs::remove_dir_all(&to_dir);
    }

    #[test]
    fn a_name_already_taken_gets_a_number_never_overwritten() {
        let from_dir = temp_dir("dup-from");
        let to_dir = temp_dir("dup-to");
        fs::write(to_dir.join("id.jpg"), b"already here").unwrap();
        let path = from_dir.join("id.jpg");
        fs::write(&path, b"the new one").unwrap();
        let recorded = stamp(&path);

        let moved = move_into(&to_dir, &path, recorded).expect("moved");
        assert_eq!(moved.to.file_name().unwrap(), "id (2).jpg");
        assert_eq!(
            fs::read(to_dir.join("id.jpg")).unwrap(),
            b"already here",
            "the original is untouched"
        );
        assert_eq!(fs::read(&moved.to).unwrap(), b"the new one");

        let _ = fs::remove_dir_all(&from_dir);
        let _ = fs::remove_dir_all(&to_dir);
    }

    #[test]
    fn a_folder_that_was_never_there_refuses_the_move() {
        let from_dir = temp_dir("missing-from");
        let path = from_dir.join("a.txt");
        fs::write(&path, "x").unwrap();
        let recorded = stamp(&path);
        let nowhere = from_dir.join("never-made");
        assert_eq!(move_into(&nowhere, &path, recorded), Err("not-found".to_string()));
        assert!(path.exists(), "refused: nothing moved");
        let _ = fs::remove_dir_all(&from_dir);
    }

    // A directory junction needs no elevation (mklink /J), unlike a symbolic link, so this runs on any Windows
    // account, the same way scan.rs's own junction test does.
    #[test]
    fn a_destination_that_is_really_a_link_refuses_the_move() {
        let from_dir = temp_dir("link-from");
        let real_dir = temp_dir("link-real");
        let path = from_dir.join("a.txt");
        fs::write(&path, "x").unwrap();
        let recorded = stamp(&path);
        let link_dir = from_dir.join("via-link");
        let status = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                link_dir.to_str().unwrap(),
                real_dir.to_str().unwrap(),
            ])
            .status()
            .expect("mklink");
        assert!(status.success(), "mklink /J needs no elevation");

        assert_eq!(move_into(&link_dir, &path, recorded), Err("linked".to_string()));
        assert!(path.exists(), "refused: nothing moved");

        let _ = fs::remove_dir_all(&from_dir);
        let _ = fs::remove_dir_all(&real_dir);
    }

    #[test]
    fn a_file_changed_since_the_scan_is_refused_with_a_reason() {
        let from_dir = temp_dir("changed-from");
        let to_dir = temp_dir("changed-to");
        let path = from_dir.join("a.txt");
        fs::write(&path, "the scan saw this").unwrap();
        let recorded = stamp(&path);

        fs::write(&path, "and then it changed before the button was pressed").unwrap();

        assert_eq!(move_into(&to_dir, &path, recorded), Err("changed".to_string()));
        assert!(path.exists(), "refused: nothing moved");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "and then it changed before the button was pressed"
        );

        let _ = fs::remove_dir_all(&from_dir);
        let _ = fs::remove_dir_all(&to_dir);
    }

    #[test]
    fn replacing_the_source_after_validation_does_not_move_the_replacement() {
        let from_dir = temp_dir("race-from");
        let to_dir = temp_dir("race-to");
        let real_dir = temp_dir("race-target");
        fs::write(real_dir.join("sentinel.txt"), b"junction target").unwrap();
        let path = from_dir.join("a.txt");
        fs::write(&path, b"scanned file").unwrap();
        let recorded = stamp(&path);

        let displaced = from_dir.join("displaced.txt");
        let moved = move_into_with_seam(&to_dir, &path, recorded, || {
            fs::rename(&path, &displaced).unwrap();
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J", path.to_str().unwrap(), real_dir.to_str().unwrap()])
                .status()
                .expect("mklink");
            assert!(status.success(), "mklink /J needs no elevation");
        })
        .expect("the opened file handle can still be moved");

        assert_eq!(fs::read(&moved.to).unwrap(), b"scanned file");
        assert!(!displaced.exists());
        assert_eq!(fs::read(path.join("sentinel.txt")).unwrap(), b"junction target");
        let _ = std::process::Command::new("cmd")
            .args(["/C", "rmdir", path.to_str().unwrap()])
            .status();
        let _ = fs::remove_dir_all(&from_dir);
        let _ = fs::remove_dir_all(&to_dir);
        let _ = fs::remove_dir_all(&real_dir);
    }

    #[test]
    fn a_name_that_tries_to_climb_out_of_the_chosen_folder_is_refused() {
        let dir = temp_dir("outside");
        // destination_for only ever sees a file's own name component in real use (path.file_name() can never
        // itself carry a separator), but the guard is tested directly here, defense in depth, the way the move
        // itself would be defended if that ever stopped being true.
        assert_eq!(
            destination_for(&dir, OsStr::new("..\\evil.txt")),
            Err("outside".to_string())
        );
        assert_eq!(
            destination_for(&dir, OsStr::new("sub\\evil.txt")),
            Err("outside".to_string())
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
