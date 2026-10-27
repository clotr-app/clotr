//! Guards against the web view's browser process burning processor time while nobody can see it: with
//! `AWAKE_ARGS` (src/webview.rs) keeping the whole shared web view rendering at full rate no matter what
//! Windows thinks of a window, a stray animation or timer left running behind a minimized or hidden window
//! costs a full frame's work forever, not just while it's actually on screen. Needs no screen, keyboard or
//! mouse -- only a background clotr.exe and the per-process processor-time counters Windows already tracks --
//! so unlike tests/dk.rs this isn't `#[ignore]`d: it's meant to run every time, as part of the ordinary suite.
//!
//! Run: npm run test:cpu in apps/desktop (cargo test --features dk-test-app --test cpu; about 7 minutes, five
//! states one after another: the tray, a closed flyout, the main window after a whole Quick scan, the card once
//! nothing has needed it for a while, and the moment after a typing session in the stand-in AI app). That last
//! one does need the screen, so it only runs once nobody has touched the PC for two minutes, and says it
//! skipped otherwise.

#![cfg(feature = "dk-test-app")]

use std::collections::HashSet;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

/// Removes a test's own temp folder when it drops, panic or not. Windows can hold a file open for a moment after
/// the child process that had it just exited, so this retries briefly before giving up quietly: a test's own
/// assertions are what should fail a run, not a leftover folder it couldn't remove in time.
struct TempBase(std::path::PathBuf);

impl Drop for TempBase {
    fn drop(&mut self) {
        remove_dir_retrying(&self.0);
    }
}

fn remove_dir_retrying(path: &std::path::Path) {
    for attempt in 0..5 {
        if std::fs::remove_dir_all(path).is_ok() || !path.exists() {
            return;
        }
        if attempt < 4 {
            sleep(200);
        }
    }
}

/// Every process started by `root`, and theirs, and so on -- the same walk tests/dk.rs uses to find the web
/// view's browser, renderer, GPU and utility processes underneath Clotr.
fn tree(root: u32) -> HashSet<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut parents: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).unwrap();
        let mut e = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                parents.insert(e.th32ProcessID, e.th32ParentProcessID);
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    let mut out = HashSet::from([root]);
    loop {
        let before = out.len();
        for (&pid, &parent) in &parents {
            if out.contains(&parent) && pid != 0 {
                out.insert(pid);
            }
        }
        if out.len() == before {
            return out;
        }
    }
}

/// The one process that is the shared web view's own browser (not a renderer, GPU or utility child of it):
/// `--webview-exe-name=clotr.exe` names it, and it carries no `--type=`, the flag every other web view process
/// has. This is the process AWAKE_ARGS (src/webview.rs) keeps running at full rate forever, hidden or not.
fn browser_pid(root: u32) -> Option<u32> {
    let pids = tree(root);
    let ids: Vec<String> = pids.iter().map(|p| p.to_string()).collect();
    let script = format!(
        "Get-CimInstance Win32_Process | Where-Object {{ @({}) -contains $_.ProcessId }} | ForEach-Object {{ [string]$_.ProcessId + ' ' + $_.CommandLine }}",
        ids.join(",")
    );
    let out = Command::new("powershell").args(["-NoProfile", "-Command", &script]).output().ok()?;
    let listing = String::from_utf8_lossy(&out.stdout).into_owned();
    listing.lines().find_map(|line| {
        let (pid, rest) = line.trim().split_once(' ')?;
        if rest.contains("--webview-exe-name=clotr.exe") && !rest.contains("--type=") {
            pid.parse().ok()
        } else {
            None
        }
    })
}

fn wait_for_browser(root: u32, ms: u64) -> Option<u32> {
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(ms) {
        if let Some(pid) = browser_pid(root) {
            return Some(pid);
        }
        sleep(50);
    }
    None
}

/// Total processor time a process has used since it started, in seconds, from Windows' own per-process
/// counter (not sampled -- the same number Task Manager's "CPU time" column reads).
fn processor_seconds(pid: u32) -> Option<f64> {
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("(Get-Process -Id {pid} -ErrorAction SilentlyContinue).TotalProcessorTime.TotalSeconds"),
        ])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

struct Run(Child);

impl Drop for Run {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

const SETTLE_MS: u64 = 5_000;
const MEASURE_MS: u64 = 60_000;
/// A few percent of one core: generous above whatever a real PC is doing in the background (indexing,
/// antivirus), but two orders of magnitude under the roughly 2 full cores the webview's AWAKE_ARGS regression
/// cost sustained overnight with a window merely idle on screen.
const LIMIT_CORES: f64 = 0.05;

/// Measures the web view's browser process's processor use after `extra_env` has had time to run and settle.
/// `None` means the browser process never appeared at all within the wait -- a pass by construction, not a
/// failure: no browser process costs strictly less than a measured one, and Clotr's tray-only state may
/// legitimately never need to start the web view.
fn measure(label: &str, extra_env: &[(&str, &str)]) {
    let base = std::env::temp_dir().join(format!("clotr-cpu-{label}-{}", std::process::id()));
    let data = base.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let _cleanup = TempBase(base);

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_clotr"));
    cmd.env("CLOTR_DESKTOP_DATA", &data);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let child = cmd.spawn().expect("Clotr starts");
    let root = child.id();
    let run = Run(child);

    let Some(browser) = wait_for_browser(root, 15_000) else {
        println!("{label}: the web view's browser process never started -- nothing to cost anything");
        return;
    };
    sleep(SETTLE_MS); // let startup and the page's own load settle before the clock starts

    // A closed window's browser process can disappear by now, or any time before the second reading (the
    // point of the open-then-close check): that is success, not a reading error, since nothing left running
    // costs nothing.
    let Some(before) = processor_seconds(browser) else {
        println!("{label}: the web view's browser process was already gone after settling");
        return;
    };
    let start = Instant::now();
    sleep(MEASURE_MS);
    let Some(after) = processor_seconds(browser) else {
        println!("{label}: the web view's browser process stopped during the measurement");
        return;
    };
    let elapsed = start.elapsed().as_secs_f64();
    let cores = (after - before) / elapsed;

    drop(run);
    println!("{label}: {cores:.4} cores of processor time over {elapsed:.0}s");
    assert!(
        cores < LIMIT_CORES,
        "{label}: the web view's browser process used {cores:.4} cores while nobody could see it (limit {LIMIT_CORES}); \
         something is animating, ticking or keeping a window alive that nothing needs open any more"
    );
}

/// Clotr running with no window ever opened -- the ordinary state of sitting in the tray.
#[test]
fn tray_only_webview_stays_near_idle() {
    measure("tray-only", &[]);
}

/// Opens the flyout (never shown on screen, so this never flashes anything) and closes it the same way a
/// real close does, then checks the web view's browser process afterward: closing has to actually leave
/// nothing running, not just hide a window that keeps costing processor time forever (what shipped before
/// this fix -- a few tenths of a core, sustained, for every flyout opened once and left closed for the rest
/// of the run).
#[test]
fn flyout_leaves_nothing_running_after_it_closes() {
    measure("flyout-then-close", &[("CLOTR_OPEN_FLYOUT_THEN_CLOSE", "1")]);
}

// ---------- A whole scan, then idle ----------

/// Every web view process under `root` that isn't the browser itself: (pid, its part, processor seconds,
/// private memory in MB), the same counters Task Manager shows.
fn web_view_parts(root: u32) -> Vec<(u32, String, f64, f64)> {
    let pids = tree(root);
    let ids: Vec<String> = pids.iter().map(|p| p.to_string()).collect();
    let script = format!(
        "Get-CimInstance Win32_Process | Where-Object {{ @({}) -contains $_.ProcessId }} | ForEach-Object {{ \
         $g = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; \
         if ($g) {{ $t = if ($_.CommandLine -match '--type=([a-z-]+)') {{ $matches[1] }} elseif ($_.Name -eq 'clotr.exe') {{ 'clotr' }} else {{ 'browser' }}; \
         '{{0}} {{1}} {{2}} {{3}}' -f $_.ProcessId, $t, $g.TotalProcessorTime.TotalSeconds, $g.PrivateMemorySize64 }} }}",
        ids.join(",")
    );
    let Ok(out) = Command::new("powershell").args(["-NoProfile", "-Command", &script]).output() else {
        return vec![];
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut f = line.split_whitespace();
            let pid = f.next()?.parse().ok()?;
            let part = f.next()?.to_string();
            let cpu = f.next()?.replace(',', ".").parse().ok()?;
            let mem: f64 = f.next()?.parse().ok()?;
            Some((pid, part, cpu, mem / 1_048_576.0))
        })
        .collect()
}

/// A made-up folder to scan: `small` text files of a few KB spread over many folders, `medium` text files of about
/// a megabyte, a find in one file in fifty (an access key, so Results has something to keep), and nothing else.
fn scan_fixture(dir: &std::path::Path, small: usize, medium: usize) -> u64 {
    // Made-up words: a run of real English ones can read as a wallet's seed words, and this wants one kind of find.
    let words = ["zorbel", "quintak", "flarn", "vexmo", "drillop", "snorf", "glimbat", "tazzle"];
    let text = |n: usize, i: usize| {
        let mut s = String::with_capacity(n + 64);
        let mut k = i;
        while s.len() < n {
            k = k.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            s.push_str(words[(k >> 16) % words.len()]);
            s.push(if k % 11 == 0 { '\n' } else { ' ' });
        }
        if i % 50 == 7 {
            s.push_str("\naws key AKIA4HPQ7XZ2R6TWLJ3N\n");
        }
        s
    };
    let mut bytes = 0;
    for i in 0..small {
        let folder = dir.join(format!("folder-{}", i % 60)).join(format!("sub-{}", i % 5));
        std::fs::create_dir_all(&folder).unwrap();
        let body = text(1_000 + (i * 7_919) % 7_000, i);
        bytes += body.len() as u64;
        std::fs::write(folder.join(format!("file-{i}.txt")), body).unwrap();
    }
    let big = dir.join("big");
    std::fs::create_dir_all(&big).unwrap();
    for i in 0..medium {
        let body = text(800_000 + (i * 104_729) % 400_000, small + i);
        bytes += body.len() as u64;
        std::fs::write(big.join(format!("big-{i}.log")), body).unwrap();
    }
    bytes
}

/// How many rows History holds (the store's own "scans"): the page records one the moment a scan finishes.
fn scans_recorded(data: &std::path::Path) -> usize {
    std::fs::read_to_string(data.join("store.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("scans")?.as_array().map(Vec::len))
        .unwrap_or(0)
}

/// What the page may hold once a scan is done: its own code, the engine, the Scan screen and Results' short list.
/// An empty main window's renderer is well under half of this; holding every file's bytes, or the text they were
/// carried in, is many times it.
const SCAN_RENDERER_MB: f64 = 400.0;
/// What a finished page may still gain sitting idle: a little, as the garbage collector settles, but not the
/// steady climb a leak or a loop makes.
const SCAN_IDLE_GROWTH_MB: f64 = 25.0;

/// A real Quick scan, in the main window hidden from its first frame (CLOTR_SCAN_HIDDEN), of a made-up folder
/// of a few thousand small files and a few dozen megabyte-sized ones (CLOTR_SCAN_ROOT). Once it's done the page
/// has to let go of every file it read -- only Results' names, kinds and counts stay -- and then do nothing at
/// all: no animation, no timer, no memory climbing while nobody's using it.
#[test]
fn a_finished_scan_holds_little_and_does_nothing() {
    let base = std::env::temp_dir().join(format!("clotr-cpu-scan-{}", std::process::id()));
    let (data, fixture) = (base.join("data"), base.join("files"));
    std::fs::create_dir_all(&data).unwrap();
    let _cleanup = TempBase(base);
    let bytes = scan_fixture(&fixture, 4_000, 60);

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_clotr"));
    cmd.env("CLOTR_DESKTOP_DATA", &data)
        .env("CLOTR_SCAN_HIDDEN", "1")
        .env("CLOTR_SCAN_ROOT", &fixture)
        .env("CLOTR_LOCALE", "en-US");
    let child = cmd.spawn().expect("Clotr starts");
    let root = child.id();
    let run = Run(child);

    let start = Instant::now();
    while scans_recorded(&data) == 0 {
        assert!(start.elapsed() < Duration::from_secs(600), "the scan finishes within ten minutes");
        sleep(1_000);
    }
    let scan_s = start.elapsed().as_secs_f64();
    sleep(SETTLE_MS);

    let before = web_view_parts(root);
    sleep(MEASURE_MS / 2);
    let after = web_view_parts(root);
    let elapsed = (MEASURE_MS / 2) as f64 / 1000.0;
    drop(run);

    let renderer_mb = |parts: &[(u32, String, f64, f64)]| -> f64 {
        parts.iter().filter(|p| p.1 == "renderer").map(|p| p.3).fold(0.0, f64::max)
    };
    let mut cores = 0.0;
    for (pid, part, cpu, _) in &after {
        if part == "clotr" {
            continue;
        }
        if let Some(b) = before.iter().find(|b| b.0 == *pid) {
            cores += (cpu - b.2) / elapsed;
        }
    }
    let (held, grew) = (renderer_mb(&before), renderer_mb(&after) - renderer_mb(&before));
    println!(
        "scan of {:.0} MB: {scan_s:.0}s; the page's renderer then held {held:.0} MB, {grew:+.1} MB over {elapsed:.0}s idle, \
         {cores:.4} cores across the web view",
        bytes as f64 / 1_048_576.0
    );
    assert!(held > 0.0, "the hidden main window's renderer was found");
    assert!(
        held < SCAN_RENDERER_MB,
        "the page held {held:.0} MB after scanning {:.0} MB (limit {SCAN_RENDERER_MB}): it's keeping what it read",
        bytes as f64 / 1_048_576.0
    );
    assert!(
        grew < SCAN_IDLE_GROWTH_MB,
        "the finished page grew {grew:.1} MB in {elapsed:.0}s with nothing to do (limit {SCAN_IDLE_GROWTH_MB})"
    );
    assert!(
        cores < LIMIT_CORES,
        "the web view used {cores:.4} cores after the scan finished (limit {LIMIT_CORES}): something still runs"
    );
}

// ---------- The card, once nothing has needed it for a while ----------

/// Total private memory, in MB, across every process under `root` (clotr.exe and whatever web view parts are
/// still running): nothing left to sum means nothing left running, which costs nothing.
fn total_private_mb(root: u32) -> f64 {
    web_view_parts(root).iter().map(|p| p.3).sum()
}

/// What Clotr may still cost once the main window has been opened and closed and the card has gone unused for
/// a while: at most clotr.exe plus a little slack, nothing of the web view left running. Before the idle
/// watchdog existed, the card was built the moment the first AI app ever came to the front and then kept
/// forever, hidden: its renderer and the GPU and network processes behind it (over 300 MB, measured) sat there
/// for as long as Clotr ran, no matter how long ago anyone last used an AI app.
const IDLE_CARD_UNUSED_MB: f64 = 60.0;

/// Opens the main window and closes it the way a real close does, and separately builds the card the way the
/// first AI app in front does (CLOTR_OPEN_CARD) -- both windows a real session leaves behind. With the idle
/// watchdog's own wait shortened to a couple of seconds (CLOTR_CARD_IDLE_DESTROY_MS) rather than the real ten
/// minutes, this proves the card actually gives its memory back once nothing needs it, not just that it could.
#[test]
fn the_card_gives_its_memory_back_once_nothing_has_needed_it_for_a_while() {
    let base = std::env::temp_dir().join(format!("clotr-cpu-cardidle-{}", std::process::id()));
    let data = base.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let _cleanup = TempBase(base);

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_clotr"));
    cmd.env("CLOTR_DESKTOP_DATA", &data)
        .env("CLOTR_LOCALE", "en-US")
        .env("CLOTR_OPEN_MAIN_THEN_CLOSE", "1")
        .env("CLOTR_OPEN_CARD", "1")
        .env("CLOTR_CARD_IDLE_DESTROY_MS", "8000");
    let child = cmd.spawn().expect("Clotr starts");
    let root = child.id();
    let run = Run(child);

    // Before the watchdog's own wait is up: the card's web view should already be running.
    sleep(5_000);
    let before = total_private_mb(root);
    // Well past the watchdog's wait (8s) and the main window's own open-then-close (3s), with room to spare.
    sleep(8_000);
    let after = total_private_mb(root);
    drop(run);

    println!("card-idle: {before:.0} MB before the watchdog's wait is up, {after:.0} MB after");
    assert!(
        before > IDLE_CARD_UNUSED_MB,
        "the card's web view ({before:.0} MB) hadn't even started by the time this checked for it -- the check \
         itself needs fixing, not the card"
    );
    assert!(
        after < before,
        "Clotr cost as much once the card had gone unused for CLOTR_CARD_IDLE_DESTROY_MS ({after:.0} MB) as it did \
         while actually running ({before:.0} MB): the watchdog isn't giving anything back"
    );
    assert!(
        after < IDLE_CARD_UNUSED_MB,
        "Clotr still cost {after:.0} MB once the card had gone unused for CLOTR_CARD_IDLE_DESTROY_MS (limit \
         {IDLE_CARD_UNUSED_MB}): the card's hidden window isn't giving its memory back"
    );
}

// ---------- After a typing session ----------

/// Seconds since anyone last pressed a key or moved the mouse on this PC.
fn idle_seconds() -> u64 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return 0;
    }
    u64::from(unsafe { GetTickCount() }.wrapping_sub(info.dwTime)) / 1000
}

/// Types `text` a character at a time into whatever has the keyboard (Unicode key events, any keyboard layout).
fn type_text(text: &str, gap_ms: u64) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
    };
    for unit in text.encode_utf16() {
        let key = |flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wScan: unit,
                    dwFlags: KEYEVENTF_UNICODE | flags,
                    ..Default::default()
                },
            },
        };
        unsafe { SendInput(&[key(Default::default()), key(KEYEVENTF_KEYUP)], std::mem::size_of::<INPUT>() as i32) };
        sleep(gap_ms);
    }
}

/// One Esc key press.
fn type_key_escape() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_ESCAPE,
    };
    let key = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_ESCAPE,
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    unsafe { SendInput(&[key(Default::default()), key(KEYEVENTF_KEYUP)], std::mem::size_of::<INPUT>() as i32) };
    sleep(150);
}

/// Brings a window to the front the way a person's Alt+click would.
fn to_front(h: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_MENU,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};
    for _ in 0..20 {
        let key = |flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_MENU,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        };
        unsafe { SendInput(&[key(Default::default()), key(KEYEVENTF_KEYUP)], std::mem::size_of::<INPUT>() as i32) };
        let _ = unsafe { SetForegroundWindow(h) };
        sleep(50);
        if unsafe { GetForegroundWindow() } == h {
            return true;
        }
    }
    false
}

/// The typing check's cost once the session is over: Clotr watches the stand-in AI app's chat box while about
/// fifteen seconds of typing go in (a fake card number among them, so the card shows), then the box is emptied and
/// the app leaves the front. A minute later, the web view and Clotr itself have to be back near idle: no
/// subscription, timer or check left running.
#[test]
fn after_a_typing_session_nothing_keeps_running() {
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetForegroundWindow, ShowWindow, SW_MINIMIZE};
    let idle = idle_seconds();
    if idle < 120 {
        println!("typing session: skipped, someone used this PC {idle} s ago (it needs two quiet minutes)");
        return;
    }
    let base = std::env::temp_dir().join(format!("clotr-cpu-typing-{}", std::process::id()));
    let data = base.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let _cleanup = TempBase(base);
    let child = Command::new(env!("CARGO_BIN_EXE_clotr"))
        .env("CLOTR_DESKTOP_DATA", &data)
        .env("CLOTR_LOCALE", "en-US")
        .spawn()
        .expect("Clotr starts");
    let root = child.id();
    let run = Run(child);
    let ai = Run(Command::new(env!("CARGO_BIN_EXE_clotr-dk-ai")).spawn().expect("the stand-in AI app starts"));

    let start = Instant::now();
    let mut window = Default::default();
    while start.elapsed() < Duration::from_secs(5) {
        window = unsafe { FindWindowW(w!("ClotrDkAi"), PCWSTR::null()) }.unwrap_or_default();
        if !window.is_invalid() {
            break;
        }
        sleep(50);
    }
    assert!(!window.is_invalid(), "the stand-in's window appears");
    assert!(to_front(window), "the stand-in comes to the front");
    // to_front's Alt tap can leave the window in menu mode until the next key; Esc leaves it.
    type_key_escape();
    let browser = wait_for_browser(root, 15_000).expect("the card's web view starts with an AI app in front");
    sleep(SETTLE_MS);

    // About fifteen seconds of typing, in bursts with pauses, so the box is read several times.
    for burst in 0..5 {
        assert_eq!(
            unsafe { GetForegroundWindow() },
            window,
            "another window came to the front (someone's at the PC?): stopping before typing anywhere else"
        );
        let text = if burst == 2 {
            " my card is 4111 1111 1111 1111 thanks"
        } else {
            " here is a little more of my question for you"
        };
        type_text(text, 40);
        sleep(1_000);
    }
    // The box emptied (the message sent, in real life), then the app leaves the front.
    use windows::Win32::UI::WindowsAndMessaging::SendMessageW;
    const WM_SETTEXT: u32 = 0x000C;
    let edit = unsafe { windows::Win32::UI::WindowsAndMessaging::GetDlgItem(Some(window), 101) }.expect("the chat box");
    unsafe { SendMessageW(edit, WM_SETTEXT, None, Some(windows::Win32::Foundation::LPARAM(w!("").as_ptr() as isize))) };
    sleep(1_500);
    let _ = unsafe { ShowWindow(window, SW_MINIMIZE) };
    sleep(SETTLE_MS);

    let before = web_view_parts(root);
    let clotr_before = processor_seconds(root);
    let started = Instant::now();
    sleep(MEASURE_MS);
    let after = web_view_parts(root);
    let clotr_after = processor_seconds(root);
    let elapsed = started.elapsed().as_secs_f64();
    drop(ai);
    drop(run);

    let cpu_of = |parts: &[(u32, String, f64, f64)], pid: u32| parts.iter().find(|p| p.0 == pid).map(|p| p.2);
    let browser_cores = match (cpu_of(&before, browser), cpu_of(&after, browser)) {
        (Some(b), Some(a)) => (a - b) / elapsed,
        _ => 0.0, // gone: nothing left running costs nothing
    };
    let clotr_cores = match (clotr_before, clotr_after) {
        (Some(b), Some(a)) => (a - b) / elapsed,
        _ => 0.0,
    };
    println!(
        "after a typing session: the web view's browser process {browser_cores:.4} cores, clotr.exe {clotr_cores:.4} \
         cores, over {elapsed:.0}s"
    );
    assert!(
        browser_cores < LIMIT_CORES,
        "the web view's browser process used {browser_cores:.4} cores after the typing session (limit {LIMIT_CORES})"
    );
    assert!(
        clotr_cores < LIMIT_CORES,
        "clotr.exe used {clotr_cores:.4} cores after the typing session (limit {LIMIT_CORES}): the typing check left \
         something running"
    );
}
