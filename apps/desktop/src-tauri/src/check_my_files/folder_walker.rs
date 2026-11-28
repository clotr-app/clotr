use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use super::scan_plan::{Plan, PlanCtx, Reach, Root};
#[cfg(test)]
use super::scan_rules::WalkLimits;
use super::scan_rules::{
    category_for, is_dir, is_hidden_or_system, is_link, is_online_only, skip_dir_name, Candidate, Counts,
    DRIVE_ANYWHERE_SKIPS, DRIVE_ROOT_FILE_SKIPS, DRIVE_ROOT_SKIPS, ZIP_BUDGET,
};
use super::skiplist::{self, Verdict};
use super::scan_run::{lock, same_path};
use crate::store_file::{baseline_key, baseline_stamp};

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

pub(crate) fn walk_with(
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
    if let Some(shared) = published {
        *lock(shared) = walk.counts;
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
        roots: roots.iter().map(|(path, label)| Root::folder(path.clone(), label.clone())).collect(),
        limits: *limits,
        ctx: PlanCtx::default(),
        baseline: None,
        record: false,
        leave_projects: false,
        leave_secrets: false,
    };
    let mut files = Vec::new();
    let walked = walk_plan(&plan, &AtomicBool::new(false), None, |candidate| {
        files.push(candidate);
        true
    });
    (files, walked.counts)
}

// ---------- Where a folder is ----------

/// How many folders below the top place a file's place shows before it's shortened to the first two, "…" and the
/// one the file is in.
const PLACE_PARTS: usize = 3;

/// The folder being listed: its own name as Windows shows it (for the page) and in lower case (for the skip list),
/// and where it is the way a person would look for it (`place_of`).
pub(crate) struct Place {
    pub(crate) lower: String,
    pub(crate) name: String,
    pub(crate) top: String,
    pub(crate) sub: Vec<String>,
}

/// The `Place` of `dir`, inside `root`. A drive's own root has no name of its own, so it goes by the
/// root's label.
fn folder_place(root: &Root, ctx: &PlanCtx, dir: &Path) -> Place {
    let (top, sub) = place_of(root, ctx, dir);
    let lower = dir.file_name().map(|name| name.to_string_lossy().to_lowercase());
    let name = dir.file_name().map(|name| name.to_string_lossy().into_owned());
    Place {
        lower: lower.unwrap_or_default(),
        name: name.unwrap_or_else(|| root.label.clone()),
        top,
        sub,
    }
}

/// The folders from `base` down to `dir`, as Windows shows their names: `Some(vec![])` for `base` itself, `None`
/// when `dir` isn't inside it. Compared without case, the way Windows does.
pub(crate) fn below(base: &Path, dir: &Path) -> Option<Vec<String>> {
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

/// Where `dir` is, the way a person would look for it: its top place and the folders below that. In a folder root
/// (Quick's places, a chosen folder) the top is the root itself. On a drive it's the known folder it sits in, else
/// the first folder below the home folder, else the drive with its first folder; a drive's own root is "C:".
fn place_of(root: &Root, ctx: &PlanCtx, dir: &Path) -> (String, Vec<String>) {
    let (top, sub) = match root.reach {
        Reach::Folder => (root.label.clone(), below(&root.path, dir).unwrap_or_default()),
        Reach::Drive => known_place(ctx, dir)
            .or_else(|| home_place(ctx, dir))
            .unwrap_or_else(|| drive_place(root, dir)),
    };
    (top, shorten_place(sub))
}

/// Inside a known folder: its key ("downloads") and the folders below it.
fn known_place(ctx: &PlanCtx, dir: &Path) -> Option<(String, Vec<String>)> {
    ctx.places.iter().find_map(|(path, key)| below(path, dir).map(|sub| (key.clone(), sub)))
}

/// Inside the home folder: the first folder below it ("AppData"), or the home folder's own name for itself.
fn home_place(ctx: &PlanCtx, dir: &Path) -> Option<(String, Vec<String>)> {
    let home = ctx.home.as_ref()?;
    let mut rest = below(home, dir)?;
    if rest.is_empty() {
        let name = home.file_name()?.to_string_lossy().into_owned();
        return Some((name, rest));
    }
    let first = rest.remove(0);
    Some((first, rest))
}

/// Anywhere else on a drive: the drive with its first folder ("D: › Games"), or the drive alone at its
/// root.
fn drive_place(root: &Root, dir: &Path) -> (String, Vec<String>) {
    let mut rest = below(&root.path, dir).unwrap_or_default();
    if rest.is_empty() {
        return (root.label.clone(), rest);
    }
    let first = rest.remove(0);
    (format!("{} › {first}", root.label), rest)
}

/// Past PLACE_PARTS folders, the first two, "…" and the one the file is in.
fn shorten_place(mut sub: Vec<String>) -> Vec<String> {
    if sub.len() <= PLACE_PARTS {
        return sub;
    }
    let last = sub.pop().unwrap_or_default();
    sub.truncate(PLACE_PARTS - 1);
    sub.push("…".to_string());
    sub.push(last);
    sub
}

// ---------- Walking a root ----------

/// What a folder inherits from the folders around it: it sits inside a code project, inside a folder of sign-in
/// material (`.ssh`, `.aws`), or inside `AppData`, where a folder named `Logs` or `Cache` is an app's own.
#[derive(Clone, Copy, Default)]
struct Mark {
    project: bool,
    secret: bool,
    appdata: bool,
}

/// One entry of a folder's listing: the entry, its metadata, its name as Windows shows it and in lower case.
type ListedEntry = (fs::DirEntry, fs::Metadata, String, String);

/// A folder's listing, read whole, with what it says about the folder: an installed program, an app's
/// own data, or (`project_marker`) a code project.
#[derive(Default)]
struct FolderListing {
    entries: Vec<ListedEntry>,
    installed: skiplist::Installed,
    made: skiplist::AppMade,
    project_marker: bool,
}

/// What the walk knows about the folder it's listing, for each file and folder in it.
struct FolderContext<'r> {
    root: &'r Root,
    place: Place,
    mark: Mark,
    /// Inside a code project the scan leaves out: its files are counted, never read.
    left_out: bool,
    at_drive_root: bool,
}

pub(crate) struct Walk<'a, F: FnMut(Candidate) -> bool> {
    pub(crate) plan: &'a Plan,
    pub(crate) cancel: &'a AtomicBool,
    pub(crate) published: Option<&'a Mutex<Counts>>,
    pub(crate) counts: Counts,
    /// Off only for the by-hand count of a real PC, which never opens a file: a zip is handed over as itself.
    pub(crate) open_zips: bool,
    pub(crate) zip_budget: u64,
    pub(crate) emitted: usize,
    pub(crate) records: Vec<(u64, u64)>,
    pub(crate) sink: F,
}

impl<F: FnMut(Candidate) -> bool> Walk<'_, F> {
    // ---------- Roots and folders ----------

    fn run(&mut self) -> bool {
        let plan = self.plan;
        let mut subfolders = Vec::with_capacity(plan.roots.len());
        for root in &plan.roots {
            let mut dirs = Vec::new();
            // A chosen folder inside one the person left out stays out too.
            if plan.ctx.excluded.folder(&root.path) {
                self.counts.excluded += 1;
                subfolders.push(dirs);
                continue;
            }
            if !self.folder(root, &root.path, 0, Mark::default(), &mut dirs) {
                return false;
            }
            subfolders.push(dirs);
        }
        for (root, dirs) in plan.roots.iter().zip(subfolders) {
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
        let personal = depth == 0 || self.plan.ctx.personal.iter().any(|place| same_path(place, dir));
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
        let place = folder_place(root, &self.plan.ctx, dir);
        let Some(listing) = self.read_listing(entries) else {
            return false;
        };
        // A program or a code project is never taken from a stray file in a personal place either: a home folder
        // often holds a stray package.json, and Downloads a setup's .exe with its .dll files.
        if !personal && self.left_whole(&listing, mark) {
            return true;
        }
        let project = mark.project || (!personal && listing.project_marker);
        let left_out = project && self.plan.leave_projects;
        if left_out && !mark.project {
            self.counts.code_projects += 1;
        }
        let mark = Mark { project, ..mark };
        let folder = FolderContext {
            root,
            place,
            mark,
            left_out,
            at_drive_root,
        };
        let mut siblings = skiplist::Siblings::default();
        let mut subdirs = Vec::new();
        if !self.hand_over_files(&folder, listing.entries, &mut siblings, &mut subdirs) {
            return false;
        }
        self.queue_subfolders(&folder, subdirs, &siblings, dirs);
        if let Some(shared) = self.published {
            *lock(shared) = self.counts;
        }
        true
    }

    /// The folder's listing, read whole, noting on the way what it says about the folder. None when the
    /// scan is cancelled partway.
    fn read_listing(&self, entries: fs::ReadDir) -> Option<FolderListing> {
        let mut listing = FolderListing::default();
        for entry in entries.flatten() {
            if self.cancel.load(Ordering::Relaxed) {
                return None;
            }
            // DirEntry::metadata never follows a reparse point (a link's target, or a loop back to an ancestor),
            // and on Windows it comes with the listing itself, so a drive's worth of files costs no extra calls.
            let Ok(meta) = entry.metadata() else { continue };
            if is_link(meta.file_attributes()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let lower = name.to_ascii_lowercase();
            let is_folder = is_dir(meta.file_attributes());
            listing.installed.note(&lower, is_folder);
            listing.made.saw(&lower, is_folder);
            listing.project_marker |= skiplist::project_marker(&lower, is_folder);
            listing.entries.push((entry, meta, name, lower));
        }
        Some(listing)
    }

    /// A folder never opened further, by what its own listing holds, counted unless it sits in a code
    /// project the scan leaves out. A cache marked as one, or an app's page storage, inside a project or
    /// not. Or an installed program or game (an uninstaller, a game store's files, an .exe with its
    /// libraries); a code project never counts as one.
    fn left_whole(&mut self, listing: &FolderListing, mark: Mark) -> bool {
        let in_left_out_project = mark.project && self.plan.leave_projects;
        if listing.made.is_app_data() {
            if !in_left_out_project {
                self.counts.app_data += 1;
            }
            return true;
        }
        if !listing.project_marker && listing.installed.is_program() {
            if !in_left_out_project {
                self.counts.programs += 1;
            }
            return true;
        }
        false
    }

    /// The folder's own files, handed over in listing order. Its subfolders a walk may open go into
    /// `subdirs`, and every file's name into `siblings`, for the subfolders' turn.
    fn hand_over_files(
        &mut self,
        folder: &FolderContext,
        entries: Vec<ListedEntry>,
        siblings: &mut skiplist::Siblings,
        subdirs: &mut Vec<(PathBuf, String)>,
    ) -> bool {
        for (entry, meta, name, lower) in entries {
            if self.cancel.load(Ordering::Relaxed) {
                return false;
            }
            if self.at_cap() {
                self.counts.capped_files = true;
                return false;
            }
            let attributes = meta.file_attributes();
            if is_dir(attributes) {
                if self.opens(folder.root, &lower, folder.at_drive_root) {
                    subdirs.push((entry.path(), lower));
                }
                continue;
            }
            siblings.note(&lower);
            let is_drive_file = folder.at_drive_root && DRIVE_ROOT_FILE_SKIPS.contains(&lower.as_str());
            if is_hidden_or_system(attributes) || is_drive_file {
                continue;
            }
            if folder.left_out {
                self.count_project_file(&lower, &folder.place);
                continue;
            }
            if !self.file(folder, entry.path(), name, &lower, &meta) {
                return false;
            }
        }
        true
    }

    /// Each subfolder, judged now that the whole listing is known: into `dirs` to walk, or counted by why
    /// it's left closed.
    fn queue_subfolders(
        &mut self,
        folder: &FolderContext,
        subdirs: Vec<(PathBuf, String)>,
        siblings: &skiplist::Siblings,
        dirs: &mut Vec<(PathBuf, Mark)>,
    ) {
        let mark = folder.mark;
        for (path, lower) in subdirs {
            if self.plan.ctx.skip.iter().any(|skipped| same_path(skipped, &path)) {
                continue;
            }
            let verdict = if skiplist::app_folder(&lower, mark.appdata) {
                Verdict::AppData
            } else {
                skiplist::folder(&lower, &folder.place.lower, siblings, &path)
            };
            let inner = Mark {
                appdata: mark.appdata || lower == "appdata",
                ..mark
            };
            match verdict {
                // Inside a project left out, what's skipped anyway isn't counted twice.
                Verdict::Dev | Verdict::Program | Verdict::AppData if folder.left_out => {}
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
    }

    /// A file inside a code project a scan leaves out: counted when it's one Clotr would have read, never opened.
    fn count_project_file(&mut self, lower: &str, place: &Place) {
        let ext = Path::new(lower).extension().and_then(|ext| ext.to_str()).unwrap_or("");
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

    // ---------- Files ----------

    fn at_cap(&self) -> bool {
        self.emitted + self.counts.too_big >= self.plan.limits.max_files
    }

    fn emit(&mut self, candidate: Candidate) -> bool {
        self.emitted += 1;
        (self.sink)(candidate)
    }

    /// A file the skip list keeps closed (a vault, a lock file or template, an app's own data), counted by
    /// why. False for any other verdict, which leaves the file to the scan.
    fn skipped_by_list(&mut self, verdict: Verdict) -> bool {
        match verdict {
            Verdict::Vault => self.counts.vaults += 1,
            Verdict::Dev => self.counts.dev_files += 1,
            Verdict::AppData => self.counts.app_data += 1,
            _ => return false,
        }
        true
    }

    /// One plain file: left out unless it's a format Clotr reads (or a .zip); counted as online-only or too big
    /// rather than opened; on Quick's pass across the drives, left out when the Full scan saw it just as it is. A
    /// Full scan records only a file it hands over to be read, so one it never opened is new to the next Quick one.
    fn file(
        &mut self,
        folder: &FolderContext,
        path: PathBuf,
        name: String,
        lower: &str,
        meta: &fs::Metadata,
    ) -> bool {
        let place = &folder.place;
        let ext = lower_ext(&path);
        if self.skipped_by_list(skiplist::file(lower, &ext, &place.lower, &path)) {
            return true;
        }
        let is_zip = ext == "zip";
        let category = category_for(&name, &ext);
        if !is_zip && category.is_none() {
            return true;
        }
        let secret = !is_zip && (folder.mark.secret || skiplist::secret_file(lower, &ext, &place.lower));
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
        if self.plan.record || folder.root.changed_only {
            let key = baseline_key(&self.plan.ctx.salt, &path);
            let stamp = baseline_stamp(size, meta.last_write_time());
            let last_full = self.plan.baseline.as_ref();
            let unchanged =
                folder.root.changed_only && last_full.is_some_and(|last| last.unchanged(key, stamp));
            // A Full scan re-reads an unchanged file anyway when its last record said it had something worth a
            // look, so Results can show whether that's still true; everything else unchanged is kept in
            // the new record without a second read.
            earlier = unchanged && self.plan.record && last_full.is_some_and(|last| last.flagged(key));
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
            return self.zip_entries(&path, &name, place, folder.mark.project, earlier);
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
            project: folder.mark.project,
            secret,
            app_signin: secret && skiplist::app_signin(lower, &place.lower),
            on_disk_size: size,
            modified: meta.last_write_time(),
            earlier,
        })
    }

    // ---------- Zips ----------

    /// Every entry inside one `.zip` that Clotr knows how to read (4.8), counted the same careful way a plain file
    /// is: this only reads the zip's own directory listing (`by_index_raw`, which never decompresses or checks a
    /// password), so "counts first, no bytes read" still holds. A folder entry is skipped; an entry whose name
    /// doesn't match a format Clotr reads is left out exactly like it would be outside a zip, which is also why
    /// another `.zip` nested inside is never opened: nothing here recurses into one. An encrypted entry is still
    /// counted here (its name and declared size cost nothing to read) and only fails once something actually tries
    /// to read its bytes, the same "not read" path a locked file already takes. `zip_budget` is shared across every
    /// zip this whole scan meets, so one large zip can't spend what the next one needed.
    pub(crate) fn zip_entries(&mut self, zip_path: &Path, zip_name: &str, place: &Place, project: bool, earlier: bool) -> bool {
        // The zip's own size and modified time, never an entry's declared size: the changed-since-scan guard acts
        // on the real file at `path`, which for an entry inside a zip is the zip itself.
        let Ok(zip_meta) = fs::metadata(zip_path) else {
            return true;
        };
        let zip_size = zip_meta.len();
        let zip_modified = zip_meta.last_write_time();
        let Ok(file) = fs::File::open(zip_path) else { return true };
        let Ok(mut archive) = zip::ZipArchive::new(file) else {
            return true;
        };
        for index in 0..archive.len() {
            if self.cancel.load(Ordering::Relaxed) {
                return false;
            }
            if self.at_cap() {
                self.counts.capped_files = true;
                return false;
            }
            let Ok(entry) = archive.by_index_raw(index) else { continue };
            if entry.is_dir() {
                continue;
            }
            let Ok(entry_name) = entry.name() else { continue };
            let entry_name = entry_name.into_owned();
            let base_name = Path::new(&entry_name)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| entry_name.clone());
            let ext = lower_ext(Path::new(&base_name));
            let Some((kind, cap)) = category_for(&base_name, &ext) else {
                continue;
            };
            // Inside a zip only a single file's own rules apply: its lock files and templates, its secret files,
            // and the types the person left out. A vault zipped up is still counted as one, never opened.
            let lower = base_name.to_lowercase();
            if self.skipped_by_list(skiplist::file(&lower, &ext, "", zip_path)) {
                continue;
            }
            let secret = skiplist::secret_file(&lower, &ext, "");
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

/// A file's extension in lower case, or "" when it has none.
fn lower_ext(path: &Path) -> String {
    path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase()
}
