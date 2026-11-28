use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::capped_reading::{cap_of, read_capped, read_with, read_zip_entry, OpenZip};
use super::folder_walker::walk_plan;
use super::scan_plan::Plan;
use super::scan_rules::{Candidate, Counts, JPEG_HEAD};
use crate::store_file::baseline_key;

// ---------- One scan, streamed ----------

static NEXT_SCAN_GENERATION: AtomicU64 = AtomicU64::new(1);

/// How many files one `batch` hands the page, and how many the walker may run ahead of it.
pub(crate) const BATCH: usize = 64;
const AHEAD: usize = 256;
/// The most one batch reads ahead and holds for the page, by the sizes the walker counted: a batch stops short
/// once its files add up to this, so a folder of big documents never holds more than about this much in memory
/// (one file bigger than this goes in a batch of its own).
const BATCH_BYTES: u64 = 16 * 1024 * 1024;
/// How many of a batch's files are read at once. Opening a file Windows hasn't touched in a while is slow (the
/// disk, and an antivirus checking it on open), and one at a time a batch of 64 cold files kept the page's
/// checks waiting for over a second. Eight cuts that wait several times over and holds no more bytes than before.
pub(crate) const READERS: usize = 8;

/// The lock, taken even after a thread panicked while holding it.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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

impl Listed {
    /// A file just read, handed over under the next index: live, with its bytes held, until the page
    /// settles it.
    fn hand_over(&mut self, candidate: Candidate, bytes: std::io::Result<Vec<u8>>) -> Shown {
        let index = self.next;
        self.next += 1;
        // Only a whole file has a content key: two photos can share their first quarter megabyte.
        let whole_file = bytes.as_ref().ok().filter(|_| !candidate.head_only());
        let key = whole_file.and_then(|whole_file| content_key(&candidate.ext, whole_file));
        let dup_of = key.and_then(|key| self.first_index_of(key, index));
        let shown = Shown {
            index,
            name: candidate.name.clone(),
            folder: candidate.folder.clone(),
            place: candidate.place.clone(),
            parent: candidate.parent.clone(),
            ext: candidate.ext.clone(),
            size: candidate.size,
            kind: candidate.kind,
            dup_of,
            project: candidate.project,
            secret: candidate.secret,
            app_signin: candidate.app_signin,
            earlier: candidate.earlier,
            reads: candidate.check_bytes(),
        };
        self.live.insert(index, candidate);
        self.held.insert(index, bytes);
        shown
    }

    /// The index the same content was first handed over under, or None the first time, when `index` is noted.
    fn first_index_of(&mut self, key: (u64, [u8; 16]), index: usize) -> Option<usize> {
        if let Some(&first) = self.first.get(&key) {
            return Some(first);
        }
        self.first.insert(key, index);
        None
    }
}

// ---------- What the page sees of a file ----------

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
fn read_candidate(candidate: &Candidate) -> std::io::Result<Vec<u8>> {
    let path = &candidate.path;
    match &candidate.zip_entry {
        Some(entry_name) => read_zip_entry(path, entry_name, candidate.size),
        None => fs::File::open(path).and_then(|file| read_capped(file, cap_of(candidate.kind))),
    }
}

/// What the check reads of a candidate: a JPEG's head, everything else in full. Save a copy reads it fresh and whole.
pub(crate) fn read_for_check(candidate: &Candidate) -> std::io::Result<Vec<u8>> {
    if !candidate.head_only() {
        return read_candidate(candidate);
    }
    let mut bytes = Vec::new();
    fs::File::open(&candidate.path)?.take(JPEG_HEAD).read_to_end(&mut bytes)?;
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

// ---------- The run ----------

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
    /// Each reader's open zip, kept between batches while the walk hands over more entries from it.
    zips: Mutex<Vec<Option<OpenZip>>>,
}

impl ScanRun {
    // ---------- Starting ----------

    pub fn start(plan: Plan) -> ScanRun {
        Self::start_with(plan, READERS)
    }

    pub(crate) fn start_with(plan: Plan, readers: usize) -> ScanRun {
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
    pub(crate) fn start_panicking(plan: Plan) -> ScanRun {
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

        // The walk that hands each file it finds to the page.
        let shared = progress.clone();
        std::thread::spawn(move || {
            let walked = guard_walker(&shared, || {
                #[cfg(test)]
                if panic_walkers {
                    panic!("synthetic walker panic");
                }
                walk_plan(&plan, &shared.cancel, Some(&shared.counts), |candidate| tx.send(candidate).is_ok())
            });
            if let Some(walked) = walked {
                *lock(&shared.records) = walked.records;
                shared.complete.store(walked.complete, Ordering::SeqCst);
            }
            shared.walked.store(true, Ordering::SeqCst);
            drop(tx); // only now: the page's next batch hears the walk is over, with its counts already in place
        });

        // The walk that only counts, for the progress bar and the time left.
        let shared = progress.clone();
        std::thread::spawn(move || {
            let walked = guard_walker(&shared, || {
                #[cfg(test)]
                if panic_walkers {
                    panic!("synthetic walker panic");
                }
                walk_plan(&counting, &shared.cancel, None, |candidate| {
                    shared.counted_files.fetch_add(1, Ordering::Relaxed);
                    shared.counted_bytes.fetch_add(candidate.check_bytes(), Ordering::Relaxed);
                    true
                })
            });
            let Some(walked) = walked else { return };
            if walked.complete || walked.counts.capped_files {
                shared.counted.store(true, Ordering::SeqCst);
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
            zips: Mutex::new((0..readers.max(1)).map(|_| None).collect()),
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

    // ---------- Batches ----------

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
        self.settle(settled, keep);
        let (got, done) = self.receive(wait);
        if self.progress.failed.load(Ordering::SeqCst) {
            self.cancel();
            return Err("scan-failed");
        }
        // Each file is read here, once, outside every lock (a Stop never waits on a read), and hashed on the way:
        // the page's own read then takes these same bytes, and a later copy of a file already handed over says so.
        let read = self.read_all(got);
        if done || read.is_empty() {
            self.let_go_of_zips(); // no more entries are on their way just now
        }
        let mut listed = lock(&self.listed);
        let files = read
            .into_iter()
            .map(|(candidate, bytes)| listed.hand_over(candidate, bytes))
            .collect();
        let progress = &self.progress;
        Ok(Batch {
            files,
            done,
            counts: *lock(&progress.counts),
            total: Total {
                files: progress.counted_files.load(Ordering::Relaxed),
                bytes: progress.counted_bytes.load(Ordering::Relaxed),
                counted: progress.counted.load(Ordering::SeqCst),
            },
        })
    }

    /// Lets go of the files the page has finished checking, bytes and all, but keeps the ones in `keep`
    /// for Results.
    fn settle(&self, settled: &[usize], keep: &[usize]) {
        let mut listed = lock(&self.listed);
        for index in settled {
            listed.held.remove(index);
            let Some(candidate) = listed.live.remove(index) else {
                continue;
            };
            if keep.contains(index) {
                listed.kept.insert(*index, candidate);
            }
        }
    }

    /// Up to BATCH files from the walk, waiting at most `wait` for the first and stopping short at
    /// BATCH_BYTES, and whether the walk is over.
    fn receive(&self, wait: Duration) -> (Vec<Candidate>, bool) {
        let channel = lock(&self.rx);
        let Some(rx) = channel.as_ref() else {
            return (Vec::new(), true);
        };
        let mut got = Vec::new();
        let first = match rx.recv_timeout(wait) {
            Ok(candidate) => candidate,
            Err(RecvTimeoutError::Timeout) => return (got, false),
            Err(RecvTimeoutError::Disconnected) => return (got, true),
        };
        let mut bytes = first.size;
        got.push(first);
        while got.len() < BATCH && bytes < BATCH_BYTES {
            match rx.try_recv() {
                Ok(candidate) => {
                    bytes += candidate.size;
                    got.push(candidate);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return (got, true),
            }
        }
        (got, false)
    }

    /// A batch's files read several at once, each still read whole by one thread, and handed back in the order the
    /// walk found them.
    /// Each reader keeps its own open zip from one batch to the next (`zips`, one slot per reader), so a big zip's
    /// list is read about once per reader rather than once per entry.
    fn read_all(&self, got: Vec<Candidate>) -> Vec<(Candidate, std::io::Result<Vec<u8>>)> {
        let read_one = |candidate: &Candidate, open: &mut Option<OpenZip>| {
            if self.is_cancelled() {
                Err(std::io::Error::other("stopped"))
            } else {
                read_with(candidate, open)
            }
        };
        let take_zip = |reader: usize| lock(&self.zips).get_mut(reader).and_then(Option::take);
        let put_zip = |reader: usize, open: Option<OpenZip>| {
            if let Some(slot) = lock(&self.zips).get_mut(reader) {
                *slot = open;
            }
        };
        let threads = self.readers.min(got.len());
        let mut bytes: Vec<Option<std::io::Result<Vec<u8>>>> = (0..got.len()).map(|_| None).collect();
        if threads <= 1 {
            let mut open = take_zip(0);
            for (slot, candidate) in bytes.iter_mut().zip(&got) {
                *slot = Some(read_one(candidate, &mut open));
            }
            put_zip(0, open);
        } else {
            let next = AtomicUsize::new(0);
            std::thread::scope(|scope| {
                let handles: Vec<_> = (0..threads)
                    .map(|reader| {
                        let (next, got, read_one) = (&next, &got, &read_one);
                        let (take_zip, put_zip) = (&take_zip, &put_zip);
                        scope.spawn(move || {
                            let mut open = take_zip(reader);
                            let mut mine = Vec::new();
                            loop {
                                let index = next.fetch_add(1, Ordering::Relaxed);
                                let Some(candidate) = got.get(index) else { break };
                                mine.push((index, read_one(candidate, &mut open)));
                            }
                            put_zip(reader, open);
                            mine
                        })
                    })
                    .collect();
                for handle in handles {
                    // A reader that panicked leaves its files unread, never the whole scan stopped.
                    for (index, read) in handle.join().unwrap_or_default() {
                        bytes[index] = Some(read);
                    }
                }
            });
        }
        got.into_iter()
            .zip(bytes)
            .map(|(candidate, read)| {
                let read = read.unwrap_or_else(|| Err(std::io::Error::other("not read")));
                (candidate, read)
            })
            .collect()
    }

    // ---------- A file by its index ----------

    fn with<T>(&self, index: usize, action: impl FnOnce(&Candidate) -> T) -> Option<T> {
        let listed = lock(&self.listed);
        listed.live.get(&index).or_else(|| listed.kept.get(&index)).map(action)
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
        let candidate = self.with(index, |file| Candidate {
            path: file.path.clone(),
            name: String::new(),
            folder: String::new(),
            place: Vec::new(),
            parent: String::new(),
            ext: String::new(),
            size: file.size,
            kind: file.kind,
            zip_entry: file.zip_entry.clone(),
            project: file.project,
            secret: file.secret,
            app_signin: false,
            on_disk_size: 0,
            modified: 0,
            earlier: file.earlier,
        })?;
        Some(read_candidate(&candidate))
    }

    /// The real file's size and modified time as the scan itself saw them (the zip's, for an entry inside one):
    /// what *Move it somewhere private* and *Move to the Recycle Bin* compare against before they touch anything,
    /// so a file that changed since the scan looked at it is refused rather than acted on blind.
    pub fn stamp_of(&self, index: usize) -> Option<(u64, u64)> {
        self.with(index, |file| (file.on_disk_size, file.modified))
    }

    /// What *Leave this folder out* and *Leave files like this out* would leave out, for a handed-over file: its
    /// folder's path (the one holding the zip, for an entry inside one) or its type, never anything the page sent.
    pub fn exclusion_for(&self, index: usize, what: &str) -> Option<(&'static str, String)> {
        self.with(index, |file| match what {
            "folder" => file.path.parent().map(|folder| ("folder", folder.to_string_lossy().into_owned())),
            "type" if !file.ext.is_empty() => Some(("type", file.ext.clone())),
            _ => None,
        })
        .flatten()
    }

    /// A handed-over file's own path, by its index (*Open the folder*, *Ignore* and *Save a copy...* all act by
    /// index, never a path the page handed back).
    pub fn path_of(&self, index: usize) -> Option<PathBuf> {
        self.with(index, |file| file.path.clone())
    }

    // ---------- Stop, and the Full scan record ----------

    /// Stop: both walks halt at their next file, and no further file is read.
    pub fn cancel(&self) {
        self.progress.cancel.store(true, Ordering::SeqCst);
        lock(&self.rx).take(); // a walker waiting on a full channel hears it close and stops there
        lock(&self.listed).held.clear(); // bytes the page will never take now
        self.let_go_of_zips();
    }

    fn let_go_of_zips(&self) {
        lock(&self.zips).iter_mut().for_each(|slot| *slot = None);
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
        let progress = &self.progress;
        let whole = self.keeps_record
            && !self.is_cancelled()
            && !progress.failed.load(Ordering::SeqCst)
            && progress.walked.load(Ordering::SeqCst)
            && progress.complete.load(Ordering::SeqCst);
        if !whole {
            return None;
        }
        let unread_keys = self.record_keys(unread);
        let flagged_keys = self.record_keys(flagged);
        let records = std::mem::take(&mut *lock(&progress.records));
        Some(
            records
                .into_iter()
                .filter(|(key, _)| !unread_keys.contains(key))
                .map(|(key, stamp)| (key, stamp, flagged_keys.contains(&key)))
                .collect(),
        )
    }

    /// The record keys of the handed-over files at `indexes`.
    fn record_keys(&self, indexes: &[usize]) -> std::collections::HashSet<u64> {
        indexes
            .iter()
            .filter_map(|&index| self.path_of(index))
            .map(|path| baseline_key(&self.salt, &path))
            .collect()
    }

    /// The tests' own run: `files` already listed, at indexes 0, 1, 2...
    #[cfg(test)]
    pub fn listed(files: Vec<Candidate>) -> ScanRun {
        let mut listed = Listed::default();
        for candidate in files {
            listed.live.insert(listed.next, candidate);
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
            zips: Mutex::new((0..READERS).map(|_| None).collect()),
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
