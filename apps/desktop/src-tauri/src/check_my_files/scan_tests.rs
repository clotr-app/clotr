use crate::check_my_files::capped_reading::*;
use crate::check_my_files::folder_walker::*;
use crate::check_my_files::scan_plan::*;
use crate::check_my_files::scan_rules::*;
use crate::check_my_files::scan_run::*;
use crate::store_file::{baseline_key, baseline_stamp, Baseline};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

// ---------- A run's own guards ----------

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

// ---------- Test folders, removed even when a test panics ----------

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

// ---------- Formats and attributes ----------

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

// ---------- The walk: what it opens, reads, caps and skips ----------

#[test]
fn a_folder_only_windows_makes_is_never_opened() {
    for name in ["Windows", "AppData", "Program Files"] {
        assert!(skip_dir_name(name), "{name}");
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
    let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
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
    let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
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
    let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
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
    let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
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
    assert_eq!(files.iter().map(|file| file.name.as_str()).collect::<Vec<_>>(), ["real.txt"]);
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
    let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
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
    let path = PathBuf::from(r"C:\Users\test\Downloads\tax-notes.txt");
    assert!(same_path(&path, &path));
    assert!(same_path(&path, &PathBuf::from(r"c:\users\TEST\downloads\TAX-NOTES.TXT")));
    assert!(!same_path(&path, &PathBuf::from(r"C:\Users\test\Downloads\other.txt")));
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

// ---------- Quick's places and chosen folders ----------

#[test]
fn quicks_places_are_downloads_desktop_documents_and_pictures_and_a_chosen_folder_keeps_its_name() {
    let floor: Vec<String> = floor().into_iter().map(|(_, label)| label).collect();
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
    let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
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
        sink: |candidate| {
            files.push(candidate);
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
    let central = bytes.windows(4).position(|window| window == b"PK\x01\x02").expect("a central directory record");
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

/// A zip of `count` made-up small text entries, `notes/00000.txt` and on, each holding its own number.
fn write_many_zip(path: &Path, count: usize) {
    let mut zip = ZipWriter::new(fs::File::create(path).unwrap());
    for i in 0..count {
        zip.start_file(format!("notes/{i:05}.txt"), SimpleFileOptions::default()).unwrap();
        zip.write_all(format!("note {i}").as_bytes()).unwrap();
    }
    zip.finish().unwrap();
}

/// Every file a run hands over, read the way the page reads it: (name, bytes), in the walk's order.
fn read_whole_run(run: &ScanRun) -> Vec<(String, std::io::Result<Vec<u8>>)> {
    let mut seen = Vec::new();
    let mut settled = Vec::new();
    loop {
        let batch = run.batch(&settled, &[], Duration::from_secs(5)).unwrap();
        settled = batch.files.iter().map(|file| file.index).collect();
        for file in &batch.files {
            seen.push((file.name.clone(), run.read(file.index).unwrap()));
        }
        if batch.done {
            return seen;
        }
    }
}

// A reader keeps one zip open for a run of its entries. Each entry still has to come out by its own name,
// with its own bytes, whichever reader took it and in whatever order.
#[test]
fn every_entry_of_a_big_zip_reads_its_own_bytes_with_several_readers() {
    let dir = temp_dir("zip-many");
    write_many_zip(&dir.join("export.zip"), 300);
    fs::write(dir.join("loose.txt"), "a plain file beside the zip").unwrap();
    for readers in [1, READERS] {
        let run = ScanRun::start_with(Plan::chosen(vec![(dir.clone(), "chosen".into())], PlanCtx::default()), readers);
        let seen = read_whole_run(&run);
        assert_eq!(seen.len(), 301, "with {readers} readers");
        for (name, bytes) in seen {
            let bytes = bytes.unwrap_or_else(|error| panic!("{name} not read: {error}"));
            if name == "loose.txt" {
                assert_eq!(bytes, b"a plain file beside the zip");
                continue;
            }
            let number: usize = name[..5].parse().unwrap();
            assert_eq!(bytes, format!("note {number}").as_bytes(), "{name} got its own bytes");
        }
    }
}

fn zip_candidate(zip_path: &Path, entry: &str, size: u64) -> Candidate {
    Candidate {
        path: zip_path.to_path_buf(),
        name: entry.into(),
        folder: String::new(),
        place: Vec::new(),
        parent: String::new(),
        ext: "txt".into(),
        size,
        kind: "text",
        zip_entry: Some(entry.into()),
        project: false,
        secret: false,
        app_signin: false,
        on_disk_size: 0,
        modified: 0,
        earlier: false,
    }
}

// The open zip is shared by a run of entries, so the entry is still found by its name every time: asked for
// backwards, each gets its own bytes, and a name the zip doesn't hold is not read.
#[test]
fn a_reader_with_its_zip_open_still_finds_each_entry_by_its_name() {
    let dir = temp_dir("zip-by-name");
    let zip_path = dir.join("export.zip");
    write_zip(&zip_path, &[("a.txt", b"first"), ("b.txt", b"second"), ("c.txt", b"third")]);
    let mut open = None;
    for (name, want) in [("c.txt", &b"third"[..]), ("a.txt", b"first"), ("b.txt", b"second")] {
        let bytes = read_with(&zip_candidate(&zip_path, name, want.len() as u64), &mut open).unwrap();
        assert_eq!(bytes, want, "{name}");
    }
    assert!(read_with(&zip_candidate(&zip_path, "d.txt", 5), &mut open).is_err());
    assert_eq!(read_with(&zip_candidate(&zip_path, "a.txt", 5), &mut open).unwrap(), b"first");
}

// The open zip still holds every entry to the size the walker counted, not the size the zip claims.
#[test]
fn a_reader_with_its_zip_open_still_stops_at_the_counted_size() {
    let dir = temp_dir("zip-open-liar");
    let zip_path = dir.join("liar.zip");
    write_zip(&zip_path, &[("notes.txt", &vec![0u8; (TEXT_CAP * 2) as usize])]);
    lie_about_size(&zip_path, 64);
    let mut open = None;
    assert!(read_with(&zip_candidate(&zip_path, "notes.txt", 64), &mut open).is_err());
    let fair = temp_dir("zip-open-fair");
    let fair_path = fair.join("fair.zip");
    write_zip(&fair_path, &[("notes.txt", b"twelve bytes")]);
    assert!(read_with(&zip_candidate(&fair_path, "notes.txt", 11), &mut open).is_err(), "one byte over");
    assert_eq!(read_with(&zip_candidate(&fair_path, "notes.txt", 12), &mut open).unwrap(), b"twelve bytes");
}

// A zip that's rewritten while a reader has it open: the rest of its entries are not read, never read out of
// a mix of the old and new file, and nothing panics.
#[test]
fn a_zip_that_changes_while_open_leaves_the_rest_of_its_entries_not_read() {
    let dir = temp_dir("zip-changed");
    let zip_path = dir.join("export.zip");
    write_zip(&zip_path, &[("a.txt", b"first"), ("b.txt", b"second")]);
    let mut open = None;
    assert_eq!(read_with(&zip_candidate(&zip_path, "a.txt", 5), &mut open).unwrap(), b"first");
    write_zip(&zip_path, &[("a.txt", b"first"), ("b.txt", b"SECOND"), ("c.txt", b"one more entry")]);
    assert!(read_with(&zip_candidate(&zip_path, "b.txt", 6), &mut open).is_err(), "changed: not read");
    assert!(read_with(&zip_candidate(&zip_path, "a.txt", 5), &mut open).is_err(), "still not read");
}

#[test]
fn a_zip_moved_away_while_open_leaves_the_rest_of_its_entries_not_read() {
    let dir = temp_dir("zip-moved");
    let zip_path = dir.join("export.zip");
    write_zip(&zip_path, &[("a.txt", b"first"), ("b.txt", b"second")]);
    let mut open = None;
    assert_eq!(read_with(&zip_candidate(&zip_path, "a.txt", 5), &mut open).unwrap(), b"first");
    fs::rename(&zip_path, dir.join("moved.zip")).unwrap();
    assert!(read_with(&zip_candidate(&zip_path, "b.txt", 6), &mut open).is_err(), "moved: not read");
    drop(open);
    assert!(read_with(&zip_candidate(&zip_path, "b.txt", 6), &mut None).is_err(), "moved: not read");
}

// Deleted while a reader holds it open: Windows may still show the file at its path until the last handle
// closes, so the open handle is asked too.
#[test]
fn a_zip_deleted_while_open_leaves_the_rest_of_its_entries_not_read() {
    let dir = temp_dir("zip-deleted");
    let zip_path = dir.join("export.zip");
    write_zip(&zip_path, &[("a.txt", b"first"), ("b.txt", b"second")]);
    let mut open = None;
    assert_eq!(read_with(&zip_candidate(&zip_path, "a.txt", 5), &mut open).unwrap(), b"first");
    fs::remove_file(&zip_path).unwrap();
    assert!(read_with(&zip_candidate(&zip_path, "b.txt", 6), &mut open).is_err(), "deleted: not read");
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
    let mut out: Vec<String> = files.iter().map(|file| file.name.clone()).collect();
    out.sort();
    out
}

fn walk_all(plan: &Plan) -> (Vec<Candidate>, Walked) {
    let mut files = Vec::new();
    let walked = walk_plan(plan, &AtomicBool::new(false), None, |candidate| {
        files.push(candidate);
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
    for name in ["pagefile.sys", "hiberfil.sys", "swapfile.sys"] {
        fs::write(dir.join(name), "x").unwrap();
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
    let mut keys: Vec<u64> = walked.records.iter().map(|record| record.0).collect();
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
        let in_projects: Vec<&str> =
            files.iter().filter(|file| file.project).map(|file| file.name.as_str()).collect();
        assert_eq!(in_projects.len(), 7, "{in_projects:?}");
        assert!(in_projects.contains(&"keys.json"), "a subfolder of a project is in it too");
        let own: Vec<&str> = files.iter().filter(|file| !file.project).map(|file| file.name.as_str()).collect();
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
    let labels: Vec<&str> = places.iter().map(|(_, label)| label.as_str()).collect();
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

// ---------- A run, a batch at a time ----------

fn drain(run: &ScanRun, keep_every: usize) -> (Vec<Shown>, Batch) {
    let mut all = Vec::new();
    let mut keep = Vec::new();
    let mut settled = Vec::new();
    for _ in 0..1000 {
        let batch = run.batch(&settled, &keep, Duration::from_secs(5)).unwrap();
        settled = batch.files.iter().map(|file| file.index).collect();
        keep = batch.files.iter().map(|file| file.index).filter(|i| i % keep_every == 0).collect();
        let done = batch.done;
        all.extend(batch.files.iter().map(|file| Shown {
            index: file.index,
            name: file.name.clone(),
            folder: file.folder.clone(),
            place: file.place.clone(),
            parent: file.parent.clone(),
            ext: file.ext.clone(),
            size: file.size,
            kind: file.kind,
            dup_of: file.dup_of,
            project: file.project,
            secret: file.secret,
            app_signin: file.app_signin,
            earlier: file.earlier,
            reads: file.reads,
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
    let indexes: Vec<usize> = files.iter().map(|file| file.index).collect();
    assert_eq!(indexes, (0..150).collect::<Vec<_>>(), "every file once, in order");
    assert!(files.iter().all(|file| file.folder == "chosen" && file.kind == "text"));
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
    let b = files.iter().find(|file| file.name == "b.txt").unwrap().index;
    let a = files.iter().find(|file| file.name == "a.txt").unwrap().index;
    let records = run.full_record(&[b], &[a]).expect("a whole Full walk");
    assert_eq!(records.len(), 2);
    assert!(!records.iter().any(|record| record.0 == baseline_key("s", &dir.join("b.txt"))), "b couldn't be read");
    assert!(
        records.iter().any(|record| record.0 == baseline_key("s", &dir.join("a.txt")) && record.2),
        "a came back worth a look, so its bit is set"
    );
    assert!(
        records.iter().any(|record| record.0 == baseline_key("s", &dir.join("c.txt")) && !record.2),
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
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
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
    let counts = walked.counts;
    assert_eq!(counts.dev_folders, 3, "node_modules, dist (beside package.json) and the venv");
    assert_eq!(counts.vaults, 2, "Bitwarden's data.json and the .kdbx");
    assert_eq!(counts.dev_files, 2, ".env.example and package-lock.json");
}

#[test]
fn the_same_file_in_three_places_is_read_once_each_and_the_copies_point_at_the_first() {
    let dir = temp_dir("dups");
    messy_desktop(&dir);
    let run = ScanRun::start(Plan::chosen(vec![(dir.clone(), "desktop".into())], PlanCtx::default()));
    let (files, last) = drain(&run, 1);
    let notes: Vec<&Shown> = files.iter().filter(|file| file.name == "notes.txt").collect();
    assert_eq!(notes.len(), 4);
    let same: Vec<&&Shown> = notes.iter().filter(|file| file.parent != "other").collect();
    let first = same.iter().find(|file| file.dup_of.is_none()).expect("one of the three is the first");
    let copies: Vec<_> = same.iter().filter(|file| file.dup_of.is_some()).collect();
    assert_eq!(copies.len(), 2);
    assert!(copies.iter().all(|file| file.dup_of == Some(first.index)), "each copy names the first copy's index");
    assert!(copies.iter().all(|file| file.index > first.index), "the first copy was handed over first");
    let different = notes.iter().find(|file| file.parent == "other").unwrap();
    assert_eq!(different.dup_of, None, "a different file with the same name is its own entry");
    let mut parents: Vec<&str> = same.iter().map(|file| file.parent.as_str()).collect();
    parents.sort_unstable();
    assert_eq!(parents, ["ap-one", "ap-two", "clotr"], "each copy's folder by name, never a path");
    assert_eq!(last.counts.vaults, 2);
}

/// A PC with a bit of everything Full leaves out: a code project, secret files loose and in their tools' homes,
/// a vault, a game with its uninstaller and redistributables, a game library, a tool with its libraries, the
/// per-user program folder, an editor's and a browser's extensions. And the person's own files beside them,
/// a setup's .exe and .dll files loose in Downloads included.
fn pc_with_everything(drive: &Path) -> PathBuf {
    let home = drive.join("Users").join("me");
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
    home
}

#[test]
fn full_leaves_out_projects_secret_files_vaults_and_installed_programs_and_games() {
    let drive = temp_dir("full-scope");
    let home = pc_with_everything(&drive);
    let ctx = PlanCtx {
        personal: vec![home.clone(), home.join("Downloads"), home.join("Desktop"), home.join("Documents")],
        ..PlanCtx::default()
    };
    let (files, walked) = walk_all(&Plan::full(vec![drive.clone()], None, false, ctx.clone()));
    let mut read = names(&files);
    read.sort();
    // The package.json loose in the home folder is read like any file: a home folder is never a code project.
    // The attachment in AppData's Temp is an app's working copy, left out with the rest of Temp.
    assert_eq!(read, ["letter.txt", "package.json", "taxes.txt"], "only the person's own files");
    let counts = walked.counts;
    assert_eq!((counts.code_projects, counts.project_files), (1, 2), "package.json and app.py");
    assert_eq!(counts.secret_files, 5, ".env, the .pem, the SSH key, the AWS sign-in and .npmrc");
    assert_eq!(counts.vaults, 1);
    // The game, the game library and the tool: the per-user program folder and the Chrome extensions folder
    // are inside AppData, left out with the rest of it instead of being counted as programs on their own.
    assert_eq!(counts.programs, 4);
    assert_eq!(counts.app_storage, 1, "the whole of AppData, left out in one step");

    // The developer switch: the project and the secret files are read, each under its own mark.
    let (files, walked) = walk_all(&Plan::full(vec![drive.clone()], None, true, ctx));
    let marked = |file: &&Candidate| file.project || file.secret;
    let mut dev: Vec<String> = files.iter().filter(marked).map(|file| file.name.clone()).collect();
    dev.sort();
    assert_eq!(dev, [".env", ".npmrc", "app.py", "credentials", "id_ed25519", "package.json", "server.pem"]);
    assert!(files.iter().filter(|file| file.name == ".env").all(|file| file.secret && !file.project));
    assert_eq!(
        files.iter().filter(|file| !file.project && !file.secret).count(),
        3,
        "the person's own files as before"
    );
    assert_eq!((walked.counts.secret_files, walked.counts.project_files), (0, 0), "nothing of theirs left out");
    assert_eq!((walked.counts.vaults, walked.counts.programs), (1, 6), "vaults and programs stay out");
}

#[test]
fn a_stray_project_file_or_setup_never_takes_a_persons_own_places_for_a_project_or_a_program() {
    let drive = temp_dir("loose-setup");
    let home = pc_with_everything(&drive);
    // Without the person's places, the package.json loose in their home makes it a code project, and the setup
    // makes Downloads a program: neither letter.txt nor anything else of theirs would be read.
    let (files, _) = walk_all(&Plan::full(vec![drive.clone()], None, false, PlanCtx::default()));
    assert!(!names(&files).contains(&"letter.txt".to_string()));
    let ctx = PlanCtx {
        personal: vec![home.join("Downloads")],
        ..PlanCtx::default()
    };
    let (files, _) = walk_all(&Plan::full(vec![drive.clone()], None, false, ctx));
    assert!(!names(&files).contains(&"taxes.txt".to_string()), "the home folder alone, unknown, is a project");
    let ctx = PlanCtx {
        personal: vec![home.clone(), home.join("Downloads")],
        ..PlanCtx::default()
    };
    let (files, _) = walk_all(&Plan::full(vec![drive.clone()], None, false, ctx));
    assert!(names(&files).contains(&"letter.txt".to_string()));
    assert!(names(&files).contains(&"taxes.txt".to_string()));
}

#[test]
fn quick_leaves_secret_files_out_unless_the_developer_switch_is_on() {
    let drive = temp_dir("quick-secrets");
    let home = pc_with_everything(&drive);
    let floor = vec![(home.join("Documents"), "documents".to_string())];
    let (files, walked) = walk_all(&Plan::quick(floor.clone(), None, true, false, PlanCtx::default()));
    assert!(files.is_empty(), "{:?}", names(&files));
    assert_eq!((walked.counts.secret_files, walked.counts.vaults), (2, 1));
    let (files, _) = walk_all(&Plan::quick(floor, None, true, true, PlanCtx::default()));
    let mut read = names(&files);
    read.sort();
    assert_eq!(read, [".env", "server.pem"]);
    assert!(files.iter().all(|file| file.secret));
}

/// A developer's home folder as a first Full scan met it: the person's own two files, and around them what an
/// app, a build tool or an AI coding tool wrote for itself, each full of things that read like details.
fn a_developers_home(drive: &Path) -> PathBuf {
    let home = drive.join("Users").join("me");
    let put = |rel: &str| {
        let path = home.join(rel);
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
    for name in ["CURRENT", "LOCK", "MANIFEST-000001", "000003.log"] {
        put(&format!(
            "AppData/Local/Browser/User Data/Default/Local Storage/leveldb/{name}"
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
    home
}

fn home_ctx(home: &Path) -> PlanCtx {
    PlanCtx {
        personal: vec![home.to_path_buf(), home.join("Desktop"), home.join("Documents")],
        ..PlanCtx::default()
    }
}

#[test]
fn a_full_scan_leaves_out_caches_ai_tools_data_app_logs_and_script_folders() {
    let drive = temp_dir("dev-home");
    let home = a_developers_home(&drive);
    let (files, walked) = walk_all(&Plan::full(vec![home.clone()], None, false, home_ctx(&home)));
    assert_eq!(
        names(&files),
        ["draft.txt", "my-test.txt", "notes.txt", "plan.txt", "workout.txt"],
        "only the person's own files"
    );
    let counts = walked.counts;
    // Outside AppData: the tagged cache on the Desktop, .claude and .codex, .claude.json and aider's history.
    // Everything else named above sits inside AppData, left out as a whole in one step (app_storage) instead
    // of each being counted as its own app_data folder.
    assert_eq!(counts.app_data, 5);
    assert_eq!(counts.app_storage, 1, "the whole of AppData: the tagged cargo cache, Temp, DiagOutputDir, Code's logs, the CLI's Cache and the browser's Local Storage all inside it");
    assert_eq!(counts.code_projects, 3, "source, its backup and the folder of tests");
    assert_eq!(counts.secret_files, 1, "GitHub's sign-in");

    // The developer switch reads code projects and secret files, never an app's own data.
    let (files, walked) = walk_all(&Plan::full(vec![home.clone()], None, true, home_ctx(&home)));
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
    let home = drive.join("Users").join("me");
    let put = |rel: &str| {
        let path = home.join(rel);
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
    let (files, walked) = walk_all(&Plan::full(vec![home.clone()], None, false, home_ctx(&home)));
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

// ---------- Where each file is placed, and what it's marked as ----------

#[test]
fn every_file_is_placed_where_a_person_would_look_for_it_never_just_by_its_drive() {
    let drive = temp_dir("places");
    let home = drive.join("Users").join("me");
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
        personal: vec![home.clone(), home.join("Desktop"), home.join("Documents")],
        places: vec![
            (home.join("Desktop"), "desktop".into()),
            (home.join("Documents"), "documents".into()),
        ],
        home: Some(home.clone()),
        ..PlanCtx::default()
    };
    let label = drive.to_string_lossy().trim_end_matches('\\').to_string();
    let placed = |files: &[Candidate]| {
        let mut out: Vec<String> = files
            .iter()
            .map(|file| format!("{} | {} | {}", file.name, file.folder, file.place.join(" › ")))
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
    let floor = vec![(home.join("Desktop"), "desktop".to_string())];
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
        .map(|file| format!("{}/{} {}", file.parent, file.name, file.app_signin))
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
    assert!(files.iter().all(|file| file.secret));
}

// ---------- A later Full scan ----------

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
        .map(|(k, stamp)| (*k, *stamp, *k == flagged_key))
        .collect();
    let baseline = Arc::new(Baseline::new(1, flagged_entries));
    // Nothing on disk changed, but the flagged file comes back anyway, and the plain one still doesn't.
    let (files, again) = walk_all(&Plan::full(vec![drive.clone()], Some(baseline), false, ctx));
    assert_eq!(names(&files), ["flagged.txt"], "only the flagged file is read again");
    assert!(files[0].earlier, "the page knows it wasn't new or changed");
    assert_eq!(again.records.len(), 2, "both files still carry a record either way");
}

// ---------- Reading a batch ----------

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
            settled = batch.files.iter().map(|file| file.index).collect();
            for file in &batch.files {
                let bytes = run.read(file.index).unwrap().unwrap();
                seen.push((file.name.clone(), String::from_utf8(bytes).unwrap(), file.dup_of.is_some()));
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
        let distinct: std::collections::HashSet<&str> = seen.iter().map(|(_, text, _)| text.as_str()).collect();
        assert_eq!(copies, 200 - distinct.len(), "a copy is still known as one");
        for (name, text, _) in &seen {
            let on_disk = fs::read_to_string(dir.join(name)).unwrap();
            assert_eq!(text, &on_disk, "{name} got its own bytes");
        }
    }
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

// ---------- Leave out of scans ----------

#[test]
fn what_the_person_left_out_is_never_opened_and_is_counted() {
    let dir = temp_dir("excluded");
    messy_desktop(&dir);
    let store_dir = temp_dir("excluded-store");
    let mut store = crate::store_file::Store::open(&store_dir).unwrap();
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

// ---------- By hand only: timings, and measures of a real PC ----------

// By hand only, for how long a zip of many small entries takes to read through a run with eight readers:
// CLOTR_PROFILE_ZIP_ENTRIES made-up entries (2000 when unset), timed from the run's start to its last batch.
// `cargo test profile_zip_reads -- --ignored --nocapture`.
#[test]
#[ignore = "a timing, by hand"]
fn profile_zip_reads() {
    let count = std::env::var("CLOTR_PROFILE_ZIP_ENTRIES").ok().and_then(|n| n.parse().ok()).unwrap_or(2000);
    let dir = temp_dir("zip-profile");
    write_many_zip(&dir.join("export.zip"), count);
    let began = std::time::Instant::now();
    let run = ScanRun::start_with(Plan::chosen(vec![(dir.clone(), "chosen".into())], PlanCtx::default()), READERS);
    let seen = read_whole_run(&run);
    let secs = began.elapsed().as_secs_f64();
    let read = seen.iter().filter(|(_, b)| b.is_ok()).count();
    println!("zip entries {count}, readers {READERS}: {read} read of {} in {secs:.2} s", seen.len());
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
    let millis = began.elapsed().as_millis() as u64;
    let rows: Vec<serde_json::Value> = files
        .iter()
        .map(|file| {
            serde_json::json!({
                "index": file.index,
                "path": run.path_of(file.index).map(|path| path.to_string_lossy().into_owned()),
                "parent": file.parent,
                "dupOf": file.dup_of,
            })
        })
        .collect();
    let report = serde_json::json!({ "ms": millis, "counts": last.counts, "files": rows });
    fs::write(out, report.to_string()).unwrap();
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
        Ok(list) => list.split(';').filter(|drive| !drive.is_empty()).map(PathBuf::from).collect(),
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
    let mut by_folder: HashMap<String, (u64, u64)> = HashMap::new();
    let (mut files, mut bytes, mut zips) = (0u64, 0u64, 0u64);
    let mut kinds: HashMap<String, (u64, u64)> = HashMap::new();
    let walked = walk_with(&plan, &AtomicBool::new(false), None, false, |candidate| {
        files += 1;
        bytes += candidate.check_bytes();
        zips += u64::from(candidate.kind == "zip");
        let ext_totals = kinds.entry(candidate.ext.clone()).or_default();
        ext_totals.0 += 1;
        ext_totals.1 += candidate.check_bytes();
        let parts: Vec<String> = candidate
            .path
            .parent()
            .map(|path| {
                path.components()
                    .filter(|x| !matches!(x, std::path::Component::RootDir))
                    .map(|x| x.as_os_str().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        for depth in 1..=parts.len().min(10) {
            let folder = by_folder.entry(parts[..depth].join("\\")).or_default();
            folder.0 += 1;
            folder.1 += candidate.check_bytes();
        }
        true
    });
    let mut rows: Vec<(String, (u64, u64))> = by_folder.into_iter().filter(|(_, (n, _))| *n >= 1000).collect();
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
        "kinds": kinds.iter().take(40).map(|(ext, (n, b))| serde_json::json!([ext, n, b])).collect::<Vec<_>>(),
        "folders": rows.iter().map(|(path, (n, b))| serde_json::json!([path, n, b])).collect::<Vec<_>>(),
    });
    fs::write(out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    println!("files {files}, zips {zips}, {} ms", began.elapsed().as_millis());
}

/// A file named MANIFEST-..., which marks a LevelDB folder.
fn is_manifest(entry: std::io::Result<fs::DirEntry>) -> bool {
    entry.is_ok_and(|entry| entry.file_name().to_string_lossy().starts_with("MANIFEST-"))
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
        .map(|list| list.split(';').filter(|drive| !drive.is_empty()).map(PathBuf::from).collect())
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
                    && fs::read_dir(dir).is_ok_and(|mut entries| entries.any(is_manifest))
            }
            _ => ["sea-config.json", "package.json", "jsconfig.json", "tsconfig.json"]
                .iter()
                .any(|name| dir.join(name).is_file()),
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
    let walked = walk_with(&plan, &AtomicBool::new(false), None, false, |candidate| {
        files += 1;
        let lower = candidate.path.to_string_lossy().to_lowercase();
        let segs: Vec<&str> = lower.split('\\').collect();
        let dirs: Vec<PathBuf> = candidate.path.ancestors().skip(1).map(Path::to_path_buf).collect();
        let kind = if dirs.iter().any(|dir| has(dir, "tag")) {
            "cachedir_tag"
        } else if segs.iter().any(|segment| AI.contains(segment))
            || candidate.name.to_lowercase().starts_with(".claude.json")
        {
            "ai_tool_data"
        } else if lower.contains("\\appdata\\local\\temp\\") {
            "temp"
        } else if dirs.first().is_some_and(|dir| has(dir, "leveldb")) {
            "leveldb"
        } else if lower.contains("\\appdata\\") && segs.iter().any(|segment| matches!(*segment, "logs" | "log")) {
            "app_logs"
        } else if dirs.iter().take(6).any(|dir| has(dir, "project")) {
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
        settled = batch.files.iter().map(|file| file.index).collect();
        for file in &batch.files {
            if let Some(Ok(b)) = run.read(file.index) {
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
