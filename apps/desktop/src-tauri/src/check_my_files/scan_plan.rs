use std::path::PathBuf;
use std::sync::Arc;

use super::scan_rules::{WalkLimits, MAX_DEPTH_FULL, MAX_FILES};
use crate::store_file::{Baseline, Exclusions, IgnoredFiles};

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
            roots: folders.into_iter().map(|(path, label)| Root::folder(path, label)).collect(),
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
            roots: drives.into_iter().map(|drive| Root::drive(drive, changed_only)).collect(),
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
            .map(|(path, label)| Root {
                changed_only,
                ..Root::folder(path, label)
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
