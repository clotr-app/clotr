//! A regression guard for blocked executable names in the Store certification kit. The kit scans the finished
//! executable's strings, so this test scans the finished executable too. Detection data that needs a blocked name
//! lives beside the executable in the MSIX and is loaded at startup, never embedded in this binary.

use std::path::PathBuf;

/// Executable names the kit reported or that are in blocked_executables.rs. Full executable spellings avoid
/// matching unrelated registry API names such as RegGetValueW.
const BLOCKED_STRINGS: &[&str] = &[
    "cmd.exe",
    "powershell",
    "wscript.exe",
    "cscript.exe",
    "mshta.exe",
    "reg.exe",
    "regedit.exe",
    "schtasks.exe",
    "explorer.exe",
    "rundll32.exe",
    "regsvr32.exe",
    "msiexec.exe",
    "wmic.exe",
];

fn built_binary() -> Option<PathBuf> {
    let base = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"));
    // The newest build, so a stale release binary left from an earlier build never stands in for today's code.
    ["release", "debug"]
        .iter()
        .map(|profile| base.join(profile).join("clotr.exe"))
        .filter(|p| p.is_file())
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
}

/// Whether `haystack` holds `needle` anywhere, ASCII case-insensitively: a plain substring scan, the same shape a
/// certification kit's own string-table check would use, so this test never reports more than the kit itself could.
fn contains_ci(haystack: &[u8], needle: &str) -> bool {
    let needle = needle.as_bytes();
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w.eq_ignore_ascii_case(needle))
}

/// Every blocked executable spelling that appears anywhere in the executable bytes.
fn blocked_hits(data: &[u8]) -> Vec<&'static str> {
    BLOCKED_STRINGS
        .iter()
        .copied()
        .filter(|needle| contains_ci(data, needle))
        .collect()
}

/// Names that come from libraries Clotr builds on, not from Clotr's own code or data: Rust's standard library holds
/// "cmd.exe" for running .bat files through `Command`, and the notification library holds a PowerShell app identity
/// as its fallback for unpackaged development builds. Neither is ever started by Clotr. The Store's kit lists them
/// under an optional test; patching or forking those libraries to hide the names would cost upstream security fixes,
/// so they're named here instead, and anything else still fails this test.
const FROM_DEPENDENCIES: &[&str] = &["cmd.exe", "powershell"];

#[test]
fn clotr_exe_never_holds_an_unexplained_blocked_string() {
    let path = built_binary().expect("build clotr.exe before checking its blocked strings");
    let data = std::fs::read(&path).unwrap_or_else(|e| panic!("couldn't read {}: {e}", path.display()));
    let hits: Vec<&str> = blocked_hits(&data)
        .into_iter()
        .filter(|h| !FROM_DEPENDENCIES.contains(h))
        .collect();
    assert!(
        hits.is_empty(),
        "clotr.exe holds a Store-certification-blocked executable name: {}",
        hits.join(", ")
    );
}

#[test]
fn the_scan_catches_each_blocked_executable_name() {
    assert_eq!(blocked_hits(b"nothing of interest here"), Vec::<&str>::new());
    for name in BLOCKED_STRINGS {
        assert_eq!(blocked_hits(name.as_bytes()), vec![*name]);
    }
}

#[test]
fn the_match_is_case_insensitive_and_a_substring_is_still_a_hit() {
    assert!(contains_ci(b"a path ending in CMD.EXE", "cmd.exe"));
    assert!(contains_ci(b"PowerShell.exe", "powershell.exe"));
    assert!(!contains_ci(b"command prompt", "cmd.exe"));
}

/// Rust writes the build machine's folders into a program's error messages. tools/rust.js maps them to neutral names
/// (--remap-path-prefix), so the user's own folder name never ships in clotr.exe. This fails if a build skips that.
#[test]
fn clotr_exe_never_carries_the_build_machines_home_folder() {
    let Some(home) = std::env::var_os("USERPROFILE") else {
        return;
    };
    let home = home.to_string_lossy().to_string();
    let Some(user) = std::path::Path::new(&home)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
    else {
        return;
    };
    // The release build is what ships; a debug build also records its own symbol file's path, which never ships.
    let base = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"));
    let path = base.join("release").join("clotr.exe");
    if !path.is_file() {
        return;
    }
    let data = std::fs::read(&path).unwrap_or_else(|e| panic!("couldn't read {}: {e}", path.display()));
    let needle = format!(r"\Users\{user}\");
    assert!(
        !contains_ci(&data, &needle),
        "clotr.exe holds the build machine's home folder ({needle}): build it through npm run build, which remaps paths"
    );
}
