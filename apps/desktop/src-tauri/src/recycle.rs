//! Moves one scanned file to the Recycle Bin, with Undo (research 4-10): the scan itself only ever reads, and a
//! file changes only once the person presses a button that names what it does. `trash` carries out the move
//! through Windows' own Recycle Bin (`IFileOperation`, the same path Explorer's own Delete uses), never a
//! permanent delete, and keeps enough to put the file straight back. Open to every kind Results shows a look at
//! not only a text file's own password, code or key find: the one guard that matters here is the same one
//! `move_private.rs` uses, a file that changed size or modified time since the scan recorded it.

use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::Path;
use trash::{os_limited, TrashItem};

/// Sends one file to the Recycle Bin and hands back the item `restore` needs. The item is found by its own
/// original path, picking the most recently deleted match, since this call is itself what just put it there.
/// Refuses a file that changed size or modified time since the scan recorded it (`recorded`, from
/// `ScanRun::stamp_of`): the scan's own list might not match what's really there anymore.
pub fn recycle(path: &Path, recorded: (u64, u64)) -> Result<TrashItem, String> {
    let meta = fs::metadata(path).map_err(|_| "not-found".to_string())?;
    if (meta.len(), meta.last_write_time()) != recorded {
        return Err("changed".to_string());
    }
    trash::delete(path).map_err(|_| "not-moved".to_string())?;
    os_limited::list()
        .map_err(|_| "not-moved".to_string())?
        .into_iter()
        .filter(|item| item.original_path() == path)
        .max_by_key(|item| item.time_deleted)
        .ok_or_else(|| "not-moved".to_string())
}

/// Puts a recycled item back exactly where it came from.
pub fn restore(item: TrashItem) -> Result<(), String> {
    os_limited::restore_all([item]).map_err(|_| "not-restored".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("clotr-recycle-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn stamp(path: &Path) -> (u64, u64) {
        let meta = fs::metadata(path).unwrap();
        (meta.len(), meta.last_write_time())
    }

    #[test]
    fn a_recycled_file_leaves_its_own_place_and_undo_puts_it_straight_back() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("passwords.csv");
        fs::write(&path, "site,password\nbank,hunter2").unwrap();
        let recorded = stamp(&path);

        let item = recycle(&path, recorded).expect("sent to the Recycle Bin");
        assert!(!path.exists(), "the file leaves its own place once it's in the Recycle Bin");

        restore(item).expect("Undo puts it back");
        assert!(path.exists(), "Undo puts it back where it was");
        assert_eq!(fs::read_to_string(&path).unwrap(), "site,password\nbank,hunter2");

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_path_that_was_never_there_is_never_sent_anywhere() {
        let dir = temp_dir("missing");
        let path = dir.join("not-really-here.txt");
        assert!(recycle(&path, (0, 0)).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    // *Move to the Recycle Bin* now opens to every kind, not only a text file's own key or password find, so
    // this guard is what keeps every one of them from acting on a file the scan's list no longer matches.
    #[test]
    fn a_file_changed_since_the_scan_is_refused_with_a_reason_never_recycled() {
        let dir = temp_dir("changed");
        let path = dir.join("id.jpg");
        fs::write(&path, "the scan saw this").unwrap();
        let recorded = stamp(&path);

        fs::write(&path, "and then it changed before the button was pressed").unwrap();

        assert_eq!(recycle(&path, recorded).unwrap_err(), "changed");
        assert!(path.exists(), "refused: never sent to the Recycle Bin");

        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir_all(&dir);
    }
}
