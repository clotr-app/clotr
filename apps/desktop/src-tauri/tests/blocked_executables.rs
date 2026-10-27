//! A regression guard for the Store certification kit's "blocked executables" check: it fails a package whose
//! binary starts, or names as something to start, a program from its own list (cmd.exe, powershell.exe,
//! reg.exe, wscript.exe and the rest). `main.rs`'s old `scan_reveal` used to start `explorer.exe` with a
//! `/select,` argument for "open the folder"; it now goes through the shell's `SHOpenFolderAndSelectItems`
//! instead, and this test is here so the next time someone reaches for `std::process::Command` to open or run
//! something, the scan catches the blocked name before a build ever reaches the kit again.
//!
//! Scans every file whole, test fixtures included, rather than guessing where a `#[cfg(test)]` block starts or
//! ends. The known, reviewed exceptions -- `scan.rs`'s and `move_private.rs`'s own test fixtures, which shell out
//! to `cmd /C mklink` to build a junction on disk -- are named explicitly below rather than skipped by pattern,
//! since none of that test-only code ships in the built app the kit actually certifies.

use std::path::{Path, PathBuf};

/// The base names (no path, no extension) the app's blocked list and the report names.
const BLOCKED_EXECUTABLES: &[&str] =
    &["cmd", "powershell", "reg", "regedit", "wscript", "cscript", "mshta", "schtasks", "explorer"];

/// (file, target) pairs allowed to start a blocked name: each is test-only code that never ships, reviewed by
/// hand rather than detected by pattern. Add to this list only for another test fixture, never for shipped code.
const ALLOWED: &[(&str, &str)] = &[("scan.rs", "cmd"), ("move_private.rs", "cmd")];

/// `Command::new("...")`'s own literal argument, whatever quote style it used, so the scan doesn't need a full
/// Rust parser to find what program a call would start.
fn command_new_targets(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let needle = "Command::new(";
    let mut rest = text;
    while let Some(start) = rest.find(needle) {
        let after = &rest[start + needle.len()..];
        let quote = after.chars().next();
        if let Some(q) = quote {
            if q == '"' || q == '\'' {
                if let Some(end) = after[1..].find(q) {
                    out.push(after[1..1 + end].to_string());
                }
            }
        }
        rest = &after[1..];
    }
    out
}

/// A `Command::new` target blocked if its base name (path and `.exe` stripped, lowercased) matches the list.
fn blocked_target(target: &str) -> bool {
    let name = target.rsplit(['\\', '/']).next().unwrap_or(target).to_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    BLOCKED_EXECUTABLES.contains(&name)
}

fn source_hits(src_dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(src_dir).expect("src dir reads").filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        for target in command_new_targets(&text) {
            if blocked_target(&target) && !ALLOWED.contains(&(name.as_str(), target.to_lowercase().as_str())) {
                out.push(format!("{name}: Command::new(\"{target}\")"));
            }
        }
    }
    out
}

#[test]
fn the_shipped_source_never_starts_a_blocked_executable() {
    let src_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let hits = source_hits(&src_dir);
    assert!(
        hits.is_empty(),
        "a source file's production code starts a program the Store's certification kit blocks: {}",
        hits.join(", ")
    );
}

#[test]
fn the_scan_itself_catches_a_planted_call_and_only_the_named_allowance_escapes_it() {
    let dir = std::env::temp_dir().join(format!("clotr-blocked-exe-src-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("sneaky.rs"),
        "fn f() { std::process::Command::new(\"powershell.exe\").status().ok(); }\n",
    )
    .unwrap();
    // The exact (file, target) pair ALLOWED names: a planted stand-in for scan.rs's own fixture, escapes.
    std::fs::write(
        dir.join("scan.rs"),
        "#[cfg(test)]\nmod tests {\n    #[test]\n    fn fixture() { std::process::Command::new(\"cmd\").status().ok(); }\n}\n",
    )
    .unwrap();
    // The same blocked target, in a test block, under a different file name: still caught -- a `#[cfg(test)]`
    // body is never exempt just for being one, only the one pair ALLOWED names by file is.
    std::fs::write(
        dir.join("other.rs"),
        "#[cfg(test)]\nmod tests {\n    #[test]\n    fn fixture() { std::process::Command::new(\"cmd\").status().ok(); }\n}\n",
    )
    .unwrap();
    let hits = source_hits(&dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(hits.len(), 2, "{hits:?}");
    assert!(hits.iter().any(|h| h.contains("sneaky.rs") && h.contains("powershell.exe")));
    assert!(hits.iter().any(|h| h.contains("other.rs") && h.contains("cmd")));
    assert!(!hits.iter().any(|h| h.contains("scan.rs")));
}

#[test]
fn a_harmless_command_is_never_flagged() {
    assert!(!blocked_target("attrib"));
    assert!(!blocked_target("notepad.exe"));
    assert!(command_new_targets("Command::new(\"attrib\")") == vec!["attrib".to_string()]);
}
