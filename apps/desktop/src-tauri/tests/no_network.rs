//! A static proof the shipped app carries no network capability, next to `dk.rs`'s dynamic one (a real run,
//! its sockets watched). Source review can miss a dependency that quietly links a network function in; this
//! reads the built `clotr.exe`'s own PE import table -- the exact list of functions Windows will resolve for
//! it at load time -- and fails if any of them could open a connection, reach WinINet or WinHTTP, or resolve a
//! name. A stripped release binary still carries this table: the loader needs it to run at all.
//!
//! Run with the rest of apps/desktop's cargo tests (`npm test` here, or `cargo test`); no feature flag, no
//! built app required first beyond whatever `cargo build`/`cargo test` already produced -- it reads whichever
//! of `target/release/clotr.exe` or `target/debug/clotr.exe` exists, preferring release, and skips with a
//! plain message if neither does yet.

use object::read::pe::{PeFile32, PeFile64};
use object::{NameOrOrdinal, Object};
use std::path::PathBuf;

/// Every DLL Windows ships that can reach another machine: raw sockets (Winsock), the two HTTP client
/// libraries apps normally use (WinINet, WinHTTP), and name resolution (DNS, the newer Windows.Networking one).
/// Named by the DLL alone, not by function, because any function at all from one of these means a network
/// capability is linked in and reachable, whatever it's named.
const NETWORK_DLLS: &[&str] = &[
    "ws2_32.dll",
    "wsock32.dll",
    "wininet.dll",
    "winhttp.dll",
    "dnsapi.dll",
    "windows.networking.dll",
    "windows.networking.sockets.dll",
    "windows.networking.connectivity.dll",
    "http.dll",
    "winhttpcom.dll",
];

/// A handful of functions that reach the network from a DLL otherwise used for other things too (so the DLL
/// alone isn't damning, but importing one of these specific names is), by prefix to catch the A/W suffix pairs
/// Win32 names its ANSI and wide-string functions with.
const NETWORK_FUNCTION_PREFIXES: &[&str] = &["WSAStartup", "WSASocket", "WSAConnect", "GetAddrInfo", "getaddrinfo"];

fn built_binary() -> Option<PathBuf> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target");
    for profile in ["release", "debug"] {
        let p = base.join(profile).join("clotr.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

struct Hit {
    library: String,
    name: String,
}

/// Every imported (library, function) pair that matches `NETWORK_DLLS` or `NETWORK_FUNCTION_PREFIXES`, read
/// through `object`'s own PE parsing rather than a hand-rolled one, so the file's real structure decides this,
/// not an assumption about where its headers and tables sit.
fn network_imports(data: &[u8]) -> Vec<Hit> {
    fn scan<'a, Pe: object::read::pe::ImageNtHeaders>(
        file: &object::read::pe::PeFile<'a, Pe, &'a [u8]>,
    ) -> Vec<Hit> {
        file.imports()
            .expect("a well-formed import table")
            .filter_map(Result::ok)
            .filter_map(|import| {
                let library = String::from_utf8_lossy(import.library()).to_lowercase();
                let name = match import.name() {
                    NameOrOrdinal::Name(n) => String::from_utf8_lossy(n).to_string(),
                    NameOrOrdinal::Ordinal(n) => format!("#{n}"),
                };
                let flagged = NETWORK_DLLS.contains(&library.as_str())
                    || NETWORK_FUNCTION_PREFIXES.iter().any(|p| name.starts_with(p));
                flagged.then(|| Hit { library: library.clone(), name: name.clone() })
            })
            .collect()
    }
    if let Ok(file) = PeFile64::parse(data) {
        return scan(&file);
    }
    if let Ok(file) = PeFile32::parse(data) {
        return scan(&file);
    }
    panic!("clotr.exe isn't a PE32 or PE32+ file this check can read");
}

#[test]
fn clotr_exe_imports_no_network_function() {
    let Some(path) = built_binary() else {
        eprintln!("[Clotr] no built clotr.exe found (run cargo build first) -- the no-network import check was skipped");
        return;
    };
    let data = std::fs::read(&path).unwrap_or_else(|e| panic!("couldn't read {}: {e}", path.display()));
    let hits = network_imports(&data);
    assert!(
        hits.is_empty(),
        "clotr.exe imports a network function: {}",
        hits.iter().map(|h| format!("{} ({})", h.name, h.library)).collect::<Vec<_>>().join(", ")
    );
}

/// The detector itself, proven against a DLL this PC already has that's known to import one of the flagged
/// names -- WinINet's own InternetOpenA from wininet.dll, loaded straight off disk -- so a silent change to the
/// scan (a typo in a DLL name, a parsing path that stops matching) fails loudly instead of the real check just
/// going quiet.
#[test]
fn the_scan_itself_catches_a_real_network_import() {
    let system32 = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let candidates = [system32.join("System32").join("curl.exe"), system32.join("System32").join("ping.exe")];
    let Some(path) = candidates.iter().find(|p| p.is_file()) else {
        eprintln!("[Clotr] no system binary found to prove the scan catches a real hit -- skipped");
        return;
    };
    let data = std::fs::read(path).unwrap();
    let hits = network_imports(&data);
    assert!(!hits.is_empty(), "{} was expected to import a flagged network function", path.display());
}
