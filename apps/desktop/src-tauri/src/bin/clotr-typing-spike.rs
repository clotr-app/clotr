//! Test-only program for measuring the Windows typing check with selected desktop apps.
//!
//! For each app brought to the front it watches for 45 seconds. The first 15 seconds touch nothing
//! (the app's own processor time, before), then it runs the typing check itself, the exact typing.rs Clotr
//! ships, for 30 seconds: what the focused element is, whether it's a password box, which of Text and Value it
//! offers, how long each read takes and how long the box was, how many text-changed events fired, and the app's
//! processor time again (after). It never prints, keeps or writes what you typed; each read is counted, timed and
//! dropped.
//!
//! Run: clotr-typing-spike.exe <results file> [how many apps, 3 if not given] [only this program's file name]. Stops
//! after that many apps or after eight minutes. The last argument keeps a run on one program.

#[allow(dead_code)]
#[path = "../program.rs"]
mod program;
// read_now is the card's second read, which this spike has no card for.
#[allow(dead_code)]
#[path = "../typing.rs"]
mod typing;

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{CloseHandle, FILETIME};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

const BEFORE: Duration = Duration::from_secs(15);
const DURING: Duration = Duration::from_secs(30);
const MAX_RUN: Duration = Duration::from_secs(8 * 60);

/// Programs that are never the AI app: the console this runs in, Windows' own shell, Clotr.
const NOT_AN_APP: &[&str] = &[
    "windowsterminal.exe",
    "openconsole.exe",
    "conhost.exe",
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "explorer.exe",
    "shellexperiencehost.exe",
    "startmenuexperiencehost.exe",
    "searchhost.exe",
    "searchapp.exe",
    "lockapp.exe",
    "clotr.exe",
    "clotr-typing-spike.exe",
    "notepad.exe",
];

#[derive(Default)]
struct Stats {
    looks: Vec<typing::Look>,
    shapes: Vec<typing::Shape>,
    blind: bool,
    events: u32,
    reads: Vec<(usize, Duration)>,
}

struct Spike(Arc<Mutex<Stats>>);

impl typing::Host for Spike {
    fn may_watch(&self, _hwnd: isize, shape: typing::Shape) -> bool {
        self.0.lock().unwrap().shapes.push(shape);
        shape == typing::Shape::Chat
    }
    fn may_read(&self, _hwnd: isize) -> bool {
        true
    }
    fn read(&self, _hwnd: isize, text: String) {
        drop(text); // counted and timed in `timed`, never kept
    }
    fn blind(&self, _hwnd: isize, blind: bool) {
        self.0.lock().unwrap().blind = blind;
    }
    fn changed(&self) {
        self.0.lock().unwrap().events += 1;
    }
    fn looked(&self, look: &typing::Look) {
        self.0.lock().unwrap().looks.push(look.clone());
    }
    fn timed(&self, units: usize, took: Duration) {
        self.0.lock().unwrap().reads.push((units, took));
    }
}

fn exe_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_string()
}

/// The front window's program, if it could be the AI app: (its window, the process that owns it, its file name).
fn front_app() -> Option<(isize, u32, String)> {
    let h = unsafe { GetForegroundWindow() };
    if h.is_invalid() {
        return None;
    }
    let pid = program::real_owner(h);
    let info = program::info(h)?;
    let name = exe_name(&info.exe_path);
    (!NOT_AN_APP.contains(&name.to_lowercase().as_str())).then_some((h.0 as isize, pid, name))
}

/// Processor time of a process and what it started, in 100 ns units.
fn cpu_of(pid: u32) -> u64 {
    let ft = |f: FILETIME| (u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime);
    typing::family(pid)
        .into_iter()
        .map(|p| unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, p) else {
                return 0;
            };
            let (mut c, mut e, mut k, mut u) = Default::default();
            let ok = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u).is_ok();
            let _ = CloseHandle(h);
            if ok {
                ft(k) + ft(u)
            } else {
                0
            }
        })
        .sum()
}

fn core_pct(ticks: u64, over: Duration) -> f64 {
    ticks as f64 / 10_000_000.0 / over.as_secs_f64() * 100.0
}

fn control_name(id: i32) -> String {
    match id {
        0 => "none".into(),
        50000 => "Button".into(),
        50004 => "Edit".into(),
        50025 => "Custom".into(),
        50026 => "Group".into(),
        50030 => "Document".into(),
        50032 => "Window".into(),
        50033 => "Pane".into(),
        other => format!("type {other}"),
    }
}

/// Where the element that has the keyboard lives, compared to the app's window: its own process, one it started,
/// or another program.
fn focus_owner(uia: &IUIAutomation, pid: u32) -> &'static str {
    let Ok(el) = (unsafe { uia.GetFocusedElement() }) else {
        return "unknown";
    };
    let p = unsafe { el.CurrentProcessId() }.unwrap_or(0) as u32;
    if p == pid {
        "the app's own process"
    } else if typing::family(pid).contains(&p) {
        "a process the app started"
    } else {
        "another program"
    }
}

fn say(out: &mut std::fs::File, line: &str) {
    println!("{line}");
    let _ = writeln!(out, "{line}");
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "typing-check-results.txt".into());
    let max_apps: usize = std::env::args().nth(2).and_then(|n| n.parse().ok()).unwrap_or(3);
    let only = std::env::args().nth(3).map(|n| n.to_lowercase());
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .expect("the results file opens");
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let uia: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.expect("UI Automation");
    let stats = Arc::new(Mutex::new(Stats::default()));
    typing::start(Box::new(Spike(stats.clone()))).expect("the typing thread starts");

    say(&mut out, "");
    say(
        &mut out,
        &format!("Clotr typing check spike, run at {:?}", std::time::SystemTime::now()),
    );
    println!("Bring the first AI app to the front and click in its message box. Don't press Enter at any point.");
    let started = Instant::now();
    let mut rows: Vec<String> = Vec::new();
    let mut done: Vec<String> = Vec::new();
    while done.len() < max_apps && started.elapsed() < MAX_RUN {
        let Some((hwnd, pid, name)) = front_app() else {
            std::thread::sleep(Duration::from_millis(300));
            continue;
        };
        if done.contains(&name) || only.as_ref().is_some_and(|o| *o != name.to_lowercase()) {
            std::thread::sleep(Duration::from_millis(300));
            continue;
        }
        println!();
        println!("Found {name}. Type in its message box for 45 seconds, until this says stop.");
        // Before: nothing asked of the app, only its processor time read.
        let c0 = cpu_of(pid);
        let t0 = Instant::now();
        std::thread::sleep(BEFORE);
        let before = core_pct(cpu_of(pid).saturating_sub(c0), t0.elapsed());
        // During: the typing check itself.
        *stats.lock().unwrap() = Stats::default();
        let c1 = cpu_of(pid);
        let t1 = Instant::now();
        typing::watch(pid, hwnd);
        let mut left = false;
        while t1.elapsed() < DURING {
            std::thread::sleep(Duration::from_millis(250));
            left |= front_app().is_none_or(|(h, _, _)| h != hwnd);
        }
        let owner = focus_owner(&uia, pid);
        typing::stop();
        let after = core_pct(cpu_of(pid).saturating_sub(c1), t1.elapsed());
        println!("Stop typing. You can clear the box (Ctrl+A, Delete).");

        let s = stats.lock().unwrap();
        // The look that decided: the last chat box found, else the last element looked at.
        let chat = s.shapes.iter().any(|&sh| sh == typing::Shape::Chat);
        let look = s
            .looks
            .iter()
            .rev()
            .find(|l| typing::shape_of(l) == typing::Shape::Chat)
            .or(s.looks.last())
            .cloned()
            .unwrap_or_default();
        let biggest = s.reads.iter().max_by_key(|r| r.0).copied();
        let avg_ms = if s.reads.is_empty() {
            0.0
        } else {
            s.reads.iter().map(|r| r.1.as_secs_f64() * 1000.0).sum::<f64>() / s.reads.len() as f64
        };
        let yes = |b: bool| if b { "yes" } else { "no" };
        say(&mut out, &format!("== {name} =="));
        say(
            &mut out,
            &format!(
                "focused element: {}; IsPassword {}; Text pattern {}; Value pattern {}; read-only {}; send button near it {}",
                control_name(look.control),
                yes(look.password),
                yes(look.text),
                yes(look.value),
                look.read_only.map(yes).unwrap_or("not asked"),
                yes(look.send),
            ),
        );
        say(&mut out, &format!("the box's events came from: {owner}"));
        say(
            &mut out,
            &format!(
                "chat box found: {}; can't-see line would show: {}; looks: {}",
                yes(chat),
                yes(s.blind),
                s.looks.len()
            ),
        );
        say(&mut out, &format!("text-changed events over 30 s: {}", s.events));
        match biggest {
            Some((units, took)) => say(
                &mut out,
                &format!(
                    "reads: {}, average {avg_ms:.1} ms; longest box {units} characters, read in {:.1} ms",
                    s.reads.len(),
                    took.as_secs_f64() * 1000.0
                ),
            ),
            None => say(&mut out, "reads: none"),
        }
        say(
            &mut out,
            &format!("app processor time: {before:.2}% of one core before, {after:.2}% during the typing check"),
        );
        if left {
            say(
                &mut out,
                "note: the app left the front at some point during the 30 seconds",
            );
        }
        let go = chat && !s.reads.is_empty() && s.events > 0;
        let why = if go {
            "go".to_string()
        } else if !chat {
            "no-go: no chat box found".to_string()
        } else if s.events == 0 {
            "no-go: no text-changed events".to_string()
        } else {
            "no-go: no read".to_string()
        };
        rows.push(format!(
            "| {name} | {} | {} | {} | {} | {} | {} | {before:.2}% / {after:.2}% | {why} |",
            control_name(look.control),
            yes(look.password),
            yes(look.text),
            yes(look.value),
            biggest
                .map(|(u, t)| format!("{:.1} ms at {u} chars", t.as_secs_f64() * 1000.0))
                .unwrap_or_else(|| "-".into()),
            s.events,
        ));
        drop(s);
        let _ = out.flush();
        done.push(name);
        if done.len() < max_apps {
            println!("Now bring the next AI app to the front and click in its message box.");
        }
    }
    say(&mut out, "");
    say(&mut out, "Appendix B rows:");
    say(&mut out, "| App | Control type | IsPassword | Text pattern | Value pattern | Read time | TextChanged fires | App CPU before / during | Go |");
    say(&mut out, "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for r in &rows {
        say(&mut out, r);
    }
    println!();
    println!("Done. The results are in {path}.");
}
