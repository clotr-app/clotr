//! Check my files: the scan, what it leaves alone, Results' actions on a file, and the weekly check.
//!
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

pub mod capped_reading;
pub mod folder_walker;
pub mod move_somewhere_private;
pub mod recycle_bin;
pub mod results_commands;
pub mod scan_commands;
pub mod scan_plan;
pub mod scan_rules;
pub mod scan_run;
#[cfg(test)]
mod scan_tests;
pub mod skiplist;
pub mod weekly_check;
