//! Checks that need a real Windows desktop: Clotr for Windows itself (a debug build with the dk-test-app feature,
//! its data in a test folder), a stand-in "AI app" in front, the real clipboard, a real click.
//!
//!   dk_desktop_trial   a key copied while the AI app is in front: the card shows within 500 ms; Clot this leak
//!                      and paste leaves the clipboard holding the safe version; no process of Clotr's (the app and
//!                      its web view's) ever opens a socket, and the web view's own network log shows no request, no
//!                      name lookup and no connection; a card number and a phone number through a warn, Clot this
//!                      leak and paste / Leave it and paste cycle leave neither in any file of the data folder, in
//!                      any form (digits only, UTF-16 too); the card never takes focus -- the AI app stays in front,
//!                      its text box keeps the keyboard, even after a click
//!   dk_main_window     1280 x 800 when the screen has room, never smaller than 900 x 600, each section's name
//!                      there for a screen reader even when the sidebar shrinks to icons, the keyboard reaching
//!                      every section in order, closing it leaves Clotr running; and no socket opens with the main
//!                      window open either
//!   dk_home_status     each of status()'s four states shows its own title, each still true with Windows'
//!                      Animation effects setting off (restored after, since this runs on a real desktop) --
//!                      confirming WebView2 follows it the way Edge does; the ember actually holding still is a
//!                      screenshot check (TESTING.md), since nothing here can read a CSS animation's state
//!   dk_tray_flyout     content present, positioned on the screen, "Pause for an hour" shows its own confirmation
//!                      rather than a new window, Esc hides it (from the confirmation too), no socket opens.
//!                      Left-clicking the real tray icon isn't driven here -- a real running trial sits in the
//!                      same tray, and telling the two icons apart from outside is too easy to get wrong on a
//!                      shared PC -- so this opens the flyout the same way dk_main_window opens the main window,
//!                      with CLOTR_OPEN_FLYOUT. The right-click menu's own "Pause until I turn it back on" /
//!                      "Resume Clotr" words are a manual check for the same reason
//!   dk_quick_scan      a real Quick scan: CLOTR_SCAN_ROOT points it at a fixture folder instead of the real
//!                      Downloads and Desktop, so the result is the same on any PC; it reaches Done, the progress at
//!                      100%, files read and worth a look both above zero (the fixtures hold findings), and no
//!                      socket opens throughout
//!   dk_stop_mid_scan   pressed against a throwaway folder of thousands of tiny files (so the read loop is slow
//!                      enough to press it before the scan finishes on its own), the screen reaches Stopped, not
//!                      Done, and the files-read count holds still afterwards -- scan_cancel actually halted the
//!                      walker, not just the page
//!   dk_scan_t6_19      the report that Quick scan did nothing: one file holding a test key, "Run a quick scan"
//!                      clicked once, and the scan has to reach Done with that file worth a look, its card on
//!                      Results naming the kind and never the key, and no socket opens throughout
//!   dk_full_then_quick a Full scan of a stand-in drive (CLOTR_SCAN_DRIVES), then a Quick one (its floor is
//!                      CLOTR_SCAN_FLOOR): before any Full scan Quick says it reads its floor only; Full reads the
//!                      key in AppData and skips the one under Windows; after a new file lands, Quick reads its
//!                      floor and that new file only, and no socket opens throughout
//!   dk_live_history    the main window open on History, a key copied and hidden on the stand-in AI app, the
//!                      empty state gone without touching the main window again
//!   dk_lookback        Look back on a fixture export: still a stub -- this is the screen that picks the export
//!                      and shows its results, with no screen or command to drive yet beyond the reader and
//!                      chat_link_ok() behind it
//!   dk_results_copy_without_place   a real Quick scan of the fixture folder, the Results screen reached from the
//!                      sidebar, the vacation photo's card found, "Save a copy without the place" driven through
//!                      the real Save As dialog to a known destination -- read back directly (never through
//!                      Clotr), proving the copy carries no EXIF at all, the made-up Eiffel Tower place included
//!   dk_extension_check CLOTR_EXT_LOCALAPPDATA points a fixture Vivaldi "User Data" folder (one plain extension
//!                      that reads ChatGPT, one sideloaded one that's off) in place of the real browsers installed
//!                      on this PC; the Results screen's Extension check section shows the headline count and
//!                      names the extension, and "Show me where to remove it" falls back to the word steps since
//!                      Vivaldi itself isn't installed to open
//!   dk_plain_window_never_shows_a_card   the card's window exists (the stand-in AI app brought it up once), then
//!                      a plain, untracked window comes to the front and a credential is copied: the card stays
//!                      hidden the whole time, since nothing on no app or terminal list is ever watched
//!   dk_typing_check    a fake card number typed in the stand-in AI app's chat box: the card within 500 ms of
//!                      the pause, the keyboard left where it was; "Clot this leak and copy" puts the message with it
//!                      hidden on the clipboard and leaves the box as typed; emptying the box ends the card; the
//!                      password box beside it is never subscribed to or read; the plain window's box is never
//!                      even looked at (CLOTR_TRACE_TYPING lists shapes, subscriptions and read lengths, no text)
//!   dk_typing_check_paused_or_off   paused, or with "Check what I type in AI apps" off: nothing looked at, no card
//!
//! Run: npm run test:dk in apps/desktop (cargo test --features dk-test-app --test dk -- --ignored --nocapture
//! --test-threads=1: one Clotr at a time). It takes the front window, the clipboard (restored afterwards), the
//! keyboard and mouse, and Windows' Animation effects setting (restored after) for a moment, so leave the PC
//! alone for the minute it runs.

#![cfg(feature = "dk-test-app")]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::core::{w, BSTR, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HGLOBAL, HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, MIB_UDP6ROW_OWNER_PID,
    MIB_UDPROW_OWNER_PID, TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
};
use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::Win32::System::ProcessStatus::{
    GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationInvokePattern, IUIAutomationScrollItemPattern,
    IUIAutomationValuePattern, TreeScope_Descendants, UIA_AutomationIdPropertyId, UIA_EditControlTypeId,
    UIA_InvokePatternId, UIA_NamePropertyId, UIA_ScrollItemPatternId, UIA_ValuePatternId,
};
use windows::Win32::UI::HiDpi::{
    GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEINPUT, VIRTUAL_KEY, VK_ESCAPE, VK_MENU, VK_RETURN, VK_SHIFT, VK_TAB,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowW, GetClientRect, GetCursorPos, GetForegroundWindow, GetGUIThreadInfo, GetWindowLongPtrW,
    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsWindow, IsWindowVisible, PostMessageW, SetCursorPos,
    SetForegroundWindow, SystemParametersInfoW, GUITHREADINFO, GWL_EXSTYLE, SPI_GETCLIENTAREAANIMATION,
    SPI_SETCLIENTAREAANIMATION, SPIF_SENDCHANGE, WM_CLOSE, WS_EX_NOACTIVATE, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};

const KEY: &str = "AKIA4HPQ7XZ2R6TWLJ3N";
const CARD: &str = "4111 1111 1111 1111";
const PHONE: &str = "(415) 555-0132";

fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

/// Removes a test's own temp folder when it drops, panic or not. Windows can hold a file open for a moment after
/// the child process that had it just exited, so this retries briefly before giving up quietly: a test's own
/// assertions are what should fail a run, not a leftover folder it couldn't remove in time.
struct TempBase(PathBuf);

impl Drop for TempBase {
    fn drop(&mut self) {
        remove_dir_retrying(&self.0);
    }
}

impl TempBase {
    /// Hands the path to a new owner (typing_run's caller) without removing it here: the guard that follows
    /// still removes it once that owner is done, panic or not.
    fn keep(self) -> PathBuf {
        let path = self.0.clone();
        std::mem::forget(self);
        path
    }
}

fn remove_dir_retrying(path: &Path) {
    for attempt in 0..5 {
        if std::fs::remove_dir_all(path).is_ok() || !path.exists() {
            return;
        }
        if attempt < 4 {
            sleep(200);
        }
    }
}

// ---------- The clipboard, as any program would use it ----------

fn clip_set(text: &str) {
    let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        for _ in 0..50 {
            if OpenClipboard(None).is_ok() {
                break;
            }
            sleep(10);
        }
        let _ = EmptyClipboard();
        let global = GlobalAlloc(GMEM_MOVEABLE, units.len() * 2).unwrap();
        let ptr = GlobalLock(global) as *mut u16;
        std::ptr::copy_nonoverlapping(units.as_ptr(), ptr, units.len());
        let _ = GlobalUnlock(global);
        SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(global.0))).unwrap();
        let _ = CloseClipboard();
    }
}

fn clip_get() -> Option<String> {
    unsafe {
        IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32).ok()?;
        for _ in 0..50 {
            if OpenClipboard(None).is_ok() {
                break;
            }
            sleep(10);
        }
        let out = (|| {
            let h = GetClipboardData(CF_UNICODETEXT.0 as u32).ok()?;
            let global = HGLOBAL(h.0);
            let ptr = GlobalLock(global) as *const u16;
            let units = GlobalSize(global) / 2;
            let slice = std::slice::from_raw_parts(ptr, units);
            let end = slice.iter().position(|&c| c == 0).unwrap_or(units);
            let s = String::from_utf16_lossy(&slice[..end]);
            let _ = GlobalUnlock(global);
            Some(s)
        })();
        let _ = CloseClipboard();
        out
    }
}

// ---------- Windows and processes ----------

fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// Every process started by `root`, and theirs, and so on (the web view's browser, renderer, GPU, network and
/// crash processes are all under Clotr).
fn tree(root: u32) -> HashSet<u32> {
    let mut parents: HashMap<u32, u32> = HashMap::new();
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

fn top_windows_of(pid: u32) -> Vec<HWND> {
    struct Find {
        pid: u32,
        found: Vec<HWND>,
    }
    unsafe extern "system" fn each(h: HWND, data: LPARAM) -> windows::core::BOOL {
        let f = &mut *(data.0 as *mut Find);
        if pid_of(h) == f.pid {
            f.found.push(h);
        }
        true.into()
    }
    let mut f = Find { pid, found: vec![] };
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut f as *mut _ as isize));
    }
    f.found
}

/// The card: Clotr's window that never activates and stays on top (not the hidden helper windows, which are
/// see-through to clicks).
fn card_window(pid: u32) -> Option<HWND> {
    top_windows_of(pid).into_iter().find(|&h| {
        let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) } as u32;
        ex & WS_EX_NOACTIVATE.0 != 0 && ex & WS_EX_TOPMOST.0 != 0 && ex & WS_EX_TRANSPARENT.0 == 0
    })
}

fn visible(h: HWND) -> bool {
    unsafe { IsWindowVisible(h) }.as_bool()
}

fn wait_for(ms: u64, mut ok: impl FnMut() -> bool) -> Option<Duration> {
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(ms) {
        if ok() {
            return Some(start.elapsed());
        }
        sleep(5);
    }
    None
}

fn tap_alt() {
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
    unsafe {
        SendInput(
            &[key(Default::default()), key(KEYEVENTF_KEYUP)],
            std::mem::size_of::<INPUT>() as i32,
        )
    };
}

/// Brings a window to the front the way a person's Alt+click would (Windows lets a program that just had input do
/// it).
fn to_front(h: HWND) -> bool {
    for _ in 0..20 {
        tap_alt();
        let _ = unsafe { SetForegroundWindow(h) };
        sleep(50);
        if unsafe { GetForegroundWindow() } == h {
            return true;
        }
    }
    false
}

fn focus_of(h: HWND) -> HWND {
    let thread = unsafe { GetWindowThreadProcessId(h, None) };
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    let _ = unsafe { GetGUIThreadInfo(thread, &mut info) };
    info.hwndFocus
}

// ---------- The card's buttons, found the way a screen reader finds them ----------

fn button(
    card: HWND,
    names: &[&str],
) -> Option<(IUIAutomation, windows::Win32::UI::Accessibility::IUIAutomationElement)> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        for _ in 0..100 {
            let root = uia.ElementFromHandle(card).ok()?;
            for name in names {
                let variant = windows::Win32::System::Variant::VARIANT::from(*name);
                let cond = uia.CreatePropertyCondition(UIA_NamePropertyId, &variant).ok()?;
                if let Ok(found) = root.FindFirst(TreeScope_Descendants, &cond) {
                    return Some((uia, found));
                }
            }
            sleep(50);
        }
        // Not found: say what the card holds, to see why.
        if let Ok(root) = uia.ElementFromHandle(card) {
            if let Ok(all) = root.FindAll(TreeScope_Descendants, &uia.CreateTrueCondition().ok()?) {
                for i in 0..all.Length().unwrap_or(0) {
                    if let Ok(e) = all.GetElement(i) {
                        println!(
                            "     card element: {:?} {:?}",
                            e.CurrentControlType().ok(),
                            e.CurrentName().ok()
                        );
                    }
                }
            }
        }
        None
    }
}

/// A real left click at the middle of the element, the mouse put back after. Scrolled into view first: a card
/// further down Results sits below the window's edge, where a click at its middle would land on nothing.
fn click(el: &windows::Win32::UI::Accessibility::IUIAutomationElement) {
    unsafe {
        if let Ok(scroll) = el.GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId) {
            if scroll.ScrollIntoView().is_ok() {
                sleep(250); // the page's smooth scroll settles
            }
        }
        let r: RECT = el.CurrentBoundingRectangle().unwrap();
        let (x, y) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        let mut was = POINT::default();
        let _ = GetCursorPos(&mut was);
        let _ = SetCursorPos(x, y);
        sleep(30);
        let m = |flags| INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        };
        SendInput(
            &[m(MOUSEEVENTF_LEFTDOWN), m(MOUSEEVENTF_LEFTUP)],
            std::mem::size_of::<INPUT>() as i32,
        );
        sleep(60);
        let _ = SetCursorPos(was.x, was.y);
    }
}

fn invoke(el: &windows::Win32::UI::Accessibility::IUIAutomationElement) {
    unsafe {
        let p: IUIAutomationInvokePattern = el.GetCurrentPatternAs(UIA_InvokePatternId).unwrap();
        p.Invoke().unwrap();
    }
}

// ---------- Sockets of Clotr's processes, sampled through the whole run ----------

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Socket {
    pid: u32,
    what: String,
}

fn sockets(pids: &HashSet<u32>) -> Vec<Socket> {
    let mut out = vec![];
    unsafe fn table(get: impl Fn(Option<*mut core::ffi::c_void>, *mut u32) -> u32) -> Vec<u8> {
        let mut size = 0u32;
        get(None, &mut size);
        let mut buf = vec![0u8; size as usize + 4096];
        size = buf.len() as u32;
        if get(Some(buf.as_mut_ptr() as *mut _), &mut size) != 0 {
            return vec![];
        }
        buf
    }
    unsafe fn rows<T: Copy>(buf: &[u8]) -> Vec<T> {
        if buf.len() < 4 {
            return vec![];
        }
        let n = u32::from_ne_bytes(buf[..4].try_into().unwrap()) as usize;
        let align = std::mem::align_of::<T>().max(4);
        let first = buf.as_ptr().add(align) as *const T;
        (0..n).map(|i| std::ptr::read_unaligned(first.add(i))).collect()
    }
    unsafe {
        let t4 = table(|p, s| GetExtendedTcpTable(p, s, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0));
        for r in rows::<MIB_TCPROW_OWNER_PID>(&t4) {
            if pids.contains(&r.dwOwningPid) {
                out.push(Socket {
                    pid: r.dwOwningPid,
                    what: format!("tcp4 state {} remote {:08x}", r.dwState, r.dwRemoteAddr),
                });
            }
        }
        let t6 = table(|p, s| GetExtendedTcpTable(p, s, false, AF_INET6.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0));
        for r in rows::<MIB_TCP6ROW_OWNER_PID>(&t6) {
            if pids.contains(&r.dwOwningPid) {
                out.push(Socket {
                    pid: r.dwOwningPid,
                    what: format!("tcp6 state {}", r.dwState),
                });
            }
        }
        let u4 = table(|p, s| GetExtendedUdpTable(p, s, false, AF_INET.0 as u32, UDP_TABLE_OWNER_PID, 0));
        for r in rows::<MIB_UDPROW_OWNER_PID>(&u4) {
            if pids.contains(&r.dwOwningPid) {
                out.push(Socket {
                    pid: r.dwOwningPid,
                    what: format!("udp4 port {}", u16::from_be((r.dwLocalPort & 0xffff) as u16)),
                });
            }
        }
        let u6 = table(|p, s| GetExtendedUdpTable(p, s, false, AF_INET6.0 as u32, UDP_TABLE_OWNER_PID, 0));
        for r in rows::<MIB_UDP6ROW_OWNER_PID>(&u6) {
            if pids.contains(&r.dwOwningPid) {
                out.push(Socket {
                    pid: r.dwOwningPid,
                    what: "udp6".into(),
                });
            }
        }
    }
    out
}

struct Watch {
    stop: Arc<AtomicBool>,
    seen: Arc<Mutex<HashSet<Socket>>>,
    samples: Arc<Mutex<u64>>,
    pids: Arc<Mutex<HashSet<u32>>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

fn watch_sockets(root: u32) -> Watch {
    let stop = Arc::new(AtomicBool::new(false));
    let seen = Arc::new(Mutex::new(HashSet::new()));
    let samples = Arc::new(Mutex::new(0u64));
    let all_pids = Arc::new(Mutex::new(HashSet::new()));
    let (s, se, sa, ap) = (stop.clone(), seen.clone(), samples.clone(), all_pids.clone());
    let thread = std::thread::spawn(move || {
        let mut pids = tree(root);
        let mut last = Instant::now();
        while !s.load(Ordering::Relaxed) {
            if last.elapsed() > Duration::from_millis(40) {
                pids = tree(root);
                ap.lock().unwrap().extend(pids.iter().copied());
                last = Instant::now();
            }
            for sock in sockets(&pids) {
                se.lock().unwrap().insert(sock);
            }
            *sa.lock().unwrap() += 1;
            sleep(2);
        }
    });
    Watch {
        stop,
        seen,
        samples,
        pids: all_pids,
        thread: Some(thread),
    }
}

// ---------- The web view's own network log ----------

/// What the web view's network part did, from its own log.
struct NetLog {
    /// It saw Clotr's own pages load, so it was listening: a quiet log means a quiet web view.
    listening: bool,
    /// Anything that could reach another computer: a request for anything but Clotr's own files, a name looked up,
    /// a TCP, TLS or QUIC connection tried, a byte sent or received on any socket.
    problems: Vec<String>,
    /// Chromium's IPv6 route checks: a UDP socket pointed at an address so Windows says whether a route exists. No
    /// byte is ever sent on it (a byte would be a problem above).
    route_checks: usize,
}

fn netlog(file: &Path) -> NetLog {
    let fail = |why: &str| NetLog {
        listening: false,
        problems: vec![why.into()],
        route_checks: 0,
    };
    let Ok(raw) = std::fs::read_to_string(file) else {
        return fail("no network log was written");
    };
    // A log cut off when the app was stopped ends mid-list: close it.
    let log = serde_json::from_str::<serde_json::Value>(&raw).or_else(|_| {
        let cut = format!("{}]}}", raw.trim_end().trim_end_matches(','));
        serde_json::from_str::<serde_json::Value>(&cut)
    });
    let Ok(log) = log else {
        return fail("the network log doesn't read");
    };
    let names: HashMap<u64, String> = log["constants"]["logEventTypes"]
        .as_object()
        .map(|m| m.iter().filter_map(|(k, v)| Some((v.as_u64()?, k.clone()))).collect())
        .unwrap_or_default();
    let (mut problems, mut own, mut route_checks, mut udp_connects) = (vec![], 0, 0, 0);
    for e in log["events"].as_array().cloned().unwrap_or_default() {
        let name = e["type"]
            .as_u64()
            .and_then(|t| names.get(&t))
            .cloned()
            .unwrap_or_default();
        let url = e["params"]["url"].as_str().unwrap_or("");
        // Clotr's own pages, and Tauri's IPC (its commands, handed by WebView2 straight to Clotr, never sent out).
        if url.starts_with("http://tauri.localhost/") || url.starts_with("http://ipc.localhost/") {
            own += 1;
        } else if !url.is_empty() && (name.starts_with("URL_REQUEST") || name.starts_with("REQUEST_ALIVE")) {
            problems.push(format!("{name} {url}"));
        }
        match name.as_str() {
            "HOST_RESOLVER_MANAGER_IPV6_REACHABILITY_CHECK" => route_checks += 1,
            "UDP_CONNECT" if e["params"].get("address").is_some() => udp_connects += 1,
            "TCP_CONNECT"
            | "TCP_CONNECT_ATTEMPT"
            | "SSL_CONNECT"
            | "QUIC_SESSION"
            | "HOST_RESOLVER_DNS_TASK"
            | "HOST_RESOLVER_SYSTEM_TASK"
            | "DNS_TRANSACTION"
            | "DOH_URL_REQUEST" => problems.push(name.clone()),
            n if n.contains("BYTES_SENT") || n.contains("BYTES_RECEIVED") => problems.push(name.clone()),
            _ => {}
        }
    }
    if udp_connects > route_checks {
        problems.push(format!(
            "{udp_connects} UDP sockets pointed somewhere, {route_checks} of them route checks"
        ));
    }
    problems.sort();
    problems.dedup();
    NetLog {
        listening: own > 0,
        problems,
        route_checks,
    }
}

/// Each process's part in the web view ("browser", "renderer", "utility network.mojom.NetworkService", …), read
/// from its command line.
fn roles(pids: &HashSet<u32>) -> HashMap<u32, String> {
    let ids: Vec<String> = pids.iter().map(|p| p.to_string()).collect();
    let script = format!(
        "Get-CimInstance Win32_Process | Where-Object {{ @({}) -contains $_.ProcessId }} | ForEach-Object {{ [string]$_.ProcessId + ' ' + $_.CommandLine }}",
        ids.join(",")
    );
    let out = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output();
    let listing = out
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let flag = |line: &str, name: &str| {
        line.split_whitespace()
            .find_map(|w| w.strip_prefix(name))
            .map(|v| v.trim_matches('"').to_string())
    };
    listing
        .lines()
        .filter_map(|line| {
            let (pid, rest) = line.trim().split_once(' ')?;
            let role = match (flag(rest, "--type="), flag(rest, "--utility-sub-type=")) {
                (Some(t), Some(s)) => format!("{t} {s}"),
                (Some(t), None) => t,
                _ if rest.contains("msedgewebview2") => "browser".into(),
                _ => "clotr".into(),
            };
            Some((pid.parse().ok()?, role))
        })
        .collect()
}

// ---------- The planted values in any form ----------

fn forms() -> Vec<(&'static str, Vec<u8>)> {
    let mut out = vec![];
    for (name, s) in [
        ("card as typed", CARD.to_string()),
        ("card digits", CARD.replace(' ', "")),
        ("phone as typed", PHONE.to_string()),
        ("phone digits", "4155550132".to_string()),
        ("phone dashed", "415-555-0132".to_string()),
        ("key", KEY.to_string()),
    ] {
        out.push((name, s.as_bytes().to_vec()));
        out.push((name, s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()));
    }
    out
}

fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    if let Ok(list) = std::fs::read_dir(dir) {
        for e in list.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(files_under(&p));
            } else {
                out.push(p);
            }
        }
    }
    out
}

fn planted_in(dir: &Path) -> Vec<String> {
    let mut found = vec![];
    for f in files_under(dir) {
        let Ok(bytes) = std::fs::read(&f) else { continue };
        for (name, needle) in forms() {
            if bytes.windows(needle.len()).any(|w| w == needle.as_slice()) {
                found.push(format!("{}: {name}", f.strip_prefix(dir).unwrap_or(&f).display()));
            }
        }
    }
    found.sort();
    found.dedup();
    found
}

// ---------- Memory ----------

fn memory_mb(pids: &HashSet<u32>) -> (f64, f64) {
    let (mut private, mut working) = (0usize, 0usize);
    for &pid in pids {
        unsafe {
            let Ok(h) = OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            ) else {
                continue;
            };
            let mut c = PROCESS_MEMORY_COUNTERS_EX {
                cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
                ..Default::default()
            };
            if GetProcessMemoryInfo(h, &mut c as *mut _ as *mut PROCESS_MEMORY_COUNTERS, c.cb).is_ok() {
                private += c.PrivateUsage;
                working += c.WorkingSetSize;
            }
            let _ = CloseHandle(h);
        }
    }
    (private as f64 / 1048576.0, working as f64 / 1048576.0)
}

// ---------- The run ----------

struct Run {
    clotr: Child,
    ai: Child,
    saved_clip: Option<String>,
}

impl Drop for Run {
    fn drop(&mut self) {
        let _ = self.ai.kill();
        let _ = self.clotr.kill();
        if let Some(t) = self.saved_clip.take() {
            clip_set(&t);
        }
    }
}

#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_desktop_trial() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let base = std::env::temp_dir().join(format!("clotr-dk-{}", std::process::id()));
    let data = base.join("data");
    let netlog_file = base.join("netlog.json");
    std::fs::create_dir_all(&data).unwrap();
    let _cleanup = TempBase(base);

    let clotr = Command::new(env!("CARGO_BIN_EXE_clotr"))
        .env("CLOTR_DESKTOP_DATA", &data)
        .env("CLOTR_NETLOG", &netlog_file)
        .spawn()
        .expect("Clotr starts");
    let clotr_pid = clotr.id();
    let net = watch_sockets(clotr_pid);
    let ai = Command::new(env!("CARGO_BIN_EXE_clotr-dk-ai"))
        .spawn()
        .expect("the stand-in AI app starts");
    let mut run = Run {
        clotr,
        ai,
        saved_clip: clip_get(),
    };

    let ai_window = {
        let mut h = HWND::default();
        wait_for(5000, || {
            h = unsafe { FindWindowW(w!("ClotrDkAi"), PCWSTR::null()) }.unwrap_or_default();
            !h.is_invalid()
        })
        .expect("the stand-in's window appears");
        h
    };
    assert!(to_front(ai_window), "the stand-in comes to the front");
    // As in the typing checks: Esc leaves the menu mode to_front's Alt tap can start, so the box (not the menu bar)
    // is what has the keyboard when the card notes it.
    press(VK_ESCAPE, false);
    let mut edit = HWND::default();
    wait_for(3000, || {
        edit = focus_of(ai_window);
        !edit.is_invalid() && edit != ai_window
    })
    .expect("the stand-in's text box has the keyboard");

    // The web view starts when the first AI app comes to the front; give its page time to load.
    let card = {
        let mut c = None;
        wait_for(10000, || {
            c = card_window(clotr_pid);
            c.is_some()
        })
        .expect("Clotr makes its card's window when an AI app comes to the front");
        c.unwrap()
    };
    sleep(2500);
    clip_set("nothing to see here, just a note");
    sleep(800);
    assert!(!visible(card), "nothing found, no card");

    // A key on the clipboard, the card within 500 ms.
    clip_set(&format!("here is my key {KEY} and I might close this card"));
    let shown = wait_for(3000, || visible(card));
    let ms = shown.map(|d| d.as_millis()).unwrap_or(u128::MAX);
    println!("card shown {ms} ms after the copy");
    assert!(ms < 500, "the card within 500 ms (took {ms} ms)");

    // The AI app is still in front with its text box focused, and the card can't be activated.
    let ex = unsafe { GetWindowLongPtrW(card, GWL_EXSTYLE) } as u32;
    assert!(ex & WS_EX_NOACTIVATE.0 != 0, "the card's window never activates");
    assert_eq!(
        unsafe { GetForegroundWindow() },
        ai_window,
        "the AI app stays in front when the card shows"
    );
    assert_eq!(
        focus_of(ai_window),
        edit,
        "the AI app's text box keeps the keyboard"
    );
    let mut r = RECT::default();
    let _ = unsafe { GetWindowRect(card, &mut r) };
    println!(
        "card at {},{} size {}x{}; front window unchanged",
        r.left,
        r.top,
        r.right - r.left,
        r.bottom - r.top
    );

    // Close is a real, consequence-free choice: no history, clipboard change or paste.
    let clip_before_close = clip_get();
    let edit_before_close = edit_text(edit);
    let store_before_close = std::fs::read(data.join("store.json")).unwrap_or_default();
    let (_u_close, dismiss) = button(card, &["Close", "Cerrar"]).expect("the card's Close button");
    click(&dismiss);
    assert!(wait_for(3000, || !visible(card)).is_some(), "Close hides the card");
    assert_eq!(clip_get(), clip_before_close, "Close leaves the clipboard exactly as it was");
    assert_eq!(edit_text(edit), edit_before_close, "Close pastes nothing into the AI app");
    assert_eq!(
        std::fs::read(data.join("store.json")).unwrap_or_default(),
        store_before_close,
        "Close records nothing in history"
    );

    // A new copy still gets its own warning after the previous card was dismissed.
    clip_set(&format!("here is my key {KEY} for the build"));
    assert!(wait_for(3000, || visible(card)).is_some(), "a new copy shows a new card");

    // A real click on Clot this leak and paste.
    let (_uia, hide) = button(card, &["Clot this leak", "Taponar esta fuga"])
        .expect("the card's Clot this leak button");
    click(&hide);
    let hidden = wait_for(3000, || clip_get().is_some_and(|t| !t.contains(KEY)));
    let now = clip_get().unwrap_or_default();
    println!("clipboard after Clot this leak: {:?}", now.replace(KEY, "<the key>"));
    assert!(hidden.is_some(), "the key is gone from the clipboard");
    assert!(
        now.starts_with("here is my key ") && now.ends_with(" for the build"),
        "the rest of the copy is kept"
    );
    assert_eq!(
        unsafe { GetForegroundWindow() },
        ai_window,
        "the AI app stays in front after a click on the card"
    );
    assert_eq!(focus_of(ai_window), edit, "and its text box keeps the keyboard");
    // Clot this leak also puts the safe copy into the box the card appeared over, with a real Ctrl+V --
    // the same box just confirmed still has the keyboard.
    assert!(
        wait_for(3000, || edit_text(edit).contains(&now)).is_some(),
        "the safe copy was pasted, not just left on the clipboard"
    );
    println!("the safe copy was pasted into the box the card appeared over");
    let gone = wait_for(3000, || !visible(card));
    if gone.is_none() {
        // Windows' clipboard history is on: the card says how to clear it, with one button.
        let (_u, close) = button(card, &["Close", "Cerrar"]).expect("the clipboard history note's Close button");
        invoke(&close);
        assert!(wait_for(3000, || !visible(card)).is_some(), "the note closes");
        println!("the clipboard history note showed and closed with its Close button");
    }

    // A card number and a phone number, hidden once and left in once.
    let planted = format!("My card is {CARD} and my phone is {PHONE}, thanks");
    clip_set(&planted);
    assert!(
        wait_for(3000, || visible(card)).is_some(),
        "the card warns about the card and phone numbers"
    );
    let (_u2, hide2) = button(card, &["Clot this leak", "Taponar esta fuga"]).unwrap();
    invoke(&hide2);
    assert!(
        wait_for(3000, || clip_get().is_some_and(|t| !t.contains("4111"))).is_some(),
        "hidden"
    );
    if wait_for(1500, || !visible(card)).is_none() {
        let (_u, close) = button(card, &["Close", "Cerrar"]).expect("the clipboard history note's Close button");
        invoke(&close);
    }
    sleep(300);
    clip_set(&planted);
    assert!(
        wait_for(3000, || visible(card)).is_some(),
        "warned again for a new copy"
    );
    let (_u3, leave) =
        button(card, &["Leave it alone", "Dejarlo así"]).expect("the card's Leave it alone button");
    invoke(&leave);
    assert!(
        wait_for(3000, || !visible(card)).is_some(),
        "Leave it alone closes the card"
    );
    assert_eq!(
        clip_get().as_deref(),
        Some(planted.as_str()),
        "Leave it alone leaves the copy alone"
    );
    // The card closing above already means the real paste landed (leaveAndPaste only closes once it does);
    // this confirms it pasted the copy itself, unchanged.
    assert!(
        edit_text(edit).contains(&planted),
        "Leave it alone pastes the copy, unchanged, into the box the card appeared over"
    );
    assert_eq!(
        unsafe { GetForegroundWindow() },
        ai_window,
        "the AI app stayed in front the whole time"
    );

    sleep(1000);
    let pids = net.pids.lock().unwrap().clone();
    let now = tree(clotr_pid);
    let (private, working) = memory_mb(&now);
    println!(
        "     memory: {private:.0} MB private, {working:.0} MB working set, {} processes",
        now.len()
    );
    let parts = roles(&pids);
    for pid in &now {
        let (p, w) = memory_mb(&HashSet::from([*pid]));
        let role = parts.get(pid).map(String::as_str).unwrap_or("?");
        println!("       {role}: {p:.0} MB private, {w:.0} MB working set");
    }

    // Stop Clotr, then read what it left behind.
    let _ = run.clotr.kill();
    let _ = run.clotr.wait();
    sleep(1500); // the web view's processes leave after their host

    let mut net = net;
    net.stop.store(true, Ordering::Relaxed);
    net.thread.take().unwrap().join().unwrap();
    let seen: Vec<Socket> = net.seen.lock().unwrap().iter().cloned().collect();
    let samples = *net.samples.lock().unwrap();
    let log = netlog(&netlog_file);
    let mut kinds: Vec<&str> = parts.values().map(|role| role.as_str()).collect();
    kinds.sort_unstable();
    kinds.dedup();
    println!(
        "{samples} samples of the sockets of {} processes ({}): {} seen",
        pids.len(),
        kinds.join(", "),
        seen.len()
    );
    for s in &seen {
        println!(
            "     socket: {} ({})",
            s.what,
            parts.get(&s.pid).map(String::as_str).unwrap_or("?")
        );
    }
    println!(
        "web view network log: listening {}; route checks {}; problems {}",
        log.listening,
        log.route_checks,
        log.problems.len()
    );
    for p in &log.problems {
        println!("     {p}");
    }
    // A UDP socket in the table is fine only as the network service's route check, with nothing sent on it (the
    // log says so); anything else (any TCP socket, a socket of another process) is a connection.
    let network_service = |pid: u32| parts.get(&pid).is_some_and(|r| r.contains("NetworkService"));
    let connections: Vec<&Socket> = seen
        .iter()
        .filter(|s| !(s.what.starts_with("udp") && network_service(s.pid) && log.route_checks > 0))
        .collect();

    let store = std::fs::read_to_string(data.join("store.json")).unwrap_or_default();
    let found = planted_in(&data);
    println!(
        "{} files in the data folder; planted values found: {}",
        files_under(&data).len(),
        found.len()
    );
    for f in &found {
        println!("     {f}");
    }

    assert!(
        pids.len() >= 3,
        "the web view's processes were watched too ({} processes)",
        pids.len()
    );
    assert!(
        connections.is_empty(),
        "no connection from any of Clotr's processes: {connections:?}"
    );
    assert!(
        log.listening,
        "the web view's network log saw Clotr's own pages load"
    );
    assert!(
        log.problems.is_empty(),
        "no request, lookup, connection or byte: {:?}",
        log.problems
    );
    assert!(found.is_empty(), "no planted value in the data folder: {found:?}");
    for action in ["\"redacted\"", "\"allowed\""] {
        assert!(
            store.contains(action),
            "the history has a {action} record (kinds and fingerprints only)"
        );
    }
    assert!(
        store.contains("\"credit_card\"") && store.contains("\"phone_number\""),
        "the kinds are recorded"
    );
    drop(run);
}

struct RunPlain {
    clotr: Child,
    ai: Child,
    plain: Child,
    saved_clip: Option<String>,
}

impl Drop for RunPlain {
    fn drop(&mut self) {
        let _ = self.plain.kill();
        let _ = self.ai.kill();
        let _ = self.clotr.kill();
        if let Some(t) = self.saved_clip.take() {
            clip_set(&t);
        }
    }
}

/// A copy with an untracked window in front (Notepad) shows no card, even once the
/// card's window already exists from an earlier AI app visit.
#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_plain_window_never_shows_a_card() {
    let base = std::env::temp_dir().join(format!("clotr-dk-plain-{}", std::process::id()));
    let data = base.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let _cleanup = TempBase(base);

    let clotr = Command::new(env!("CARGO_BIN_EXE_clotr"))
        .env("CLOTR_DESKTOP_DATA", &data)
        .spawn()
        .expect("Clotr starts");
    let clotr_pid = clotr.id();
    let ai = Command::new(env!("CARGO_BIN_EXE_clotr-dk-ai"))
        .spawn()
        .expect("the stand-in AI app starts");
    let plain = Command::new(env!("CARGO_BIN_EXE_clotr-dk-plain"))
        .spawn()
        .expect("the stand-in plain window starts");
    let run = RunPlain {
        clotr,
        ai,
        plain,
        saved_clip: clip_get(),
    };

    let ai_window = {
        let mut h = HWND::default();
        wait_for(5000, || {
            h = unsafe { FindWindowW(w!("ClotrDkAi"), PCWSTR::null()) }.unwrap_or_default();
            !h.is_invalid()
        })
        .expect("the stand-in AI app's window appears");
        h
    };
    assert!(to_front(ai_window), "the stand-in AI app comes to the front once, so the card's window exists");
    let card = {
        let mut c = None;
        wait_for(10000, || {
            c = card_window(clotr_pid);
            c.is_some()
        })
        .expect("Clotr makes its card's window when an AI app comes to the front");
        c.unwrap()
    };
    sleep(1000); // the card's page finishes its own ready handshake

    let plain_window = {
        let mut h = HWND::default();
        wait_for(5000, || {
            h = unsafe { FindWindowW(w!("ClotrDkPlain"), PCWSTR::null()) }.unwrap_or_default();
            !h.is_invalid()
        })
        .expect("the stand-in plain window appears");
        h
    };
    assert!(to_front(plain_window), "the plain window comes to the front");
    sleep(300);

    clip_set(&format!("here is my key {KEY} for the build"));
    let shown = wait_for(1500, || visible(card));
    assert!(
        shown.is_none(),
        "no card over an untracked window, even with a credential freshly on the clipboard"
    );
    assert_eq!(
        unsafe { GetForegroundWindow() },
        plain_window,
        "the plain window stayed in front the whole time"
    );

    drop(run);
}

// ---------- The typing check ----------

/// Types `text` into whatever has the keyboard, a character at a time the way a person's keys arrive (Unicode
/// key events, so no keyboard layout gets in the way), `gap_ms` apart.
fn type_text(text: &str, gap_ms: u64) {
    use windows::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_UNICODE;
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
        unsafe {
            SendInput(
                &[key(Default::default()), key(KEYEVENTF_KEYUP)],
                std::mem::size_of::<INPUT>() as i32,
            )
        };
        sleep(gap_ms);
    }
}

/// Empties a text box the way a person does: everything selected, then a real Delete key.
fn clear_box(edit: HWND) {
    use windows::Win32::UI::Input::KeyboardAndMouse::VK_DELETE;
    use windows::Win32::UI::WindowsAndMessaging::SendMessageW;
    const EM_SETSEL: u32 = 0x00B1; // winuser.h; its own crate feature (Win32_UI_Controls) isn't needed for one constant
    unsafe { SendMessageW(edit, EM_SETSEL, Some(WPARAM(0)), Some(LPARAM(-1))) };
    press(VK_DELETE, false);
}

/// Gives the keyboard to one of the stand-in's boxes by its control id, the way a screen reader moves focus.
fn focus_box(window: HWND, id: &str) -> bool {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(uia) = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER) else {
            return false;
        };
        let Ok(root) = uia.ElementFromHandle(window) else { return false };
        let variant = windows::Win32::System::Variant::VARIANT::from(id);
        let Ok(cond) = uia.CreatePropertyCondition(UIA_AutomationIdPropertyId, &variant) else {
            return false;
        };
        root.FindFirst(TreeScope_Descendants, &cond).and_then(|el| el.SetFocus()).is_ok()
    }
}

/// The typing trace's lines (CLOTR_TRACE_TYPING): shapes, subscriptions and read lengths, never text.
fn trace_lines(file: &Path) -> Vec<String> {
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

/// The person's own check, made before every step: the PC has to stay the test's for the whole run, so if anyone
/// brings another window to the front, the check stops rather than typing into it.
fn still_ours(window: HWND) {
    assert_eq!(
        unsafe { GetForegroundWindow() },
        window,
        "another window came to the front (someone's at the PC?): stopping before typing anywhere else"
    );
}

/// One Clotr with the stand-in AI app in front, its data folder seeded with `store` (pausedAll, typingCheck), the
/// card's window made and its page ready (paused, Clotr may never make it). Returns the run, the card, the AI
/// app's window, its chat box and the trace file.
fn typing_run(tag: &str, store: Option<&str>) -> (Run, Option<HWND>, HWND, HWND, PathBuf, PathBuf) {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let base = std::env::temp_dir().join(format!("clotr-dk-typing-{tag}-{}", std::process::id()));
    remove_dir_retrying(&base);
    let data = base.join("data");
    std::fs::create_dir_all(&data).unwrap();
    if let Some(json) = store {
        std::fs::write(data.join("store.json"), json).unwrap();
    }
    let trace = base.join("typing-trace.txt");
    let cleanup = TempBase(base);
    let clotr = Command::new(env!("CARGO_BIN_EXE_clotr"))
        .env("CLOTR_DESKTOP_DATA", &data)
        .env("CLOTR_LOCALE", "en-US")
        .env("CLOTR_TRACE_TYPING", &trace)
        .spawn()
        .expect("Clotr starts");
    let clotr_pid = clotr.id();
    let ai = Command::new(env!("CARGO_BIN_EXE_clotr-dk-ai"))
        .spawn()
        .expect("the stand-in AI app starts");
    let run = Run {
        clotr,
        ai,
        saved_clip: clip_get(),
    };
    let ai_window = {
        let mut h = HWND::default();
        wait_for(5000, || {
            h = unsafe { FindWindowW(w!("ClotrDkAi"), PCWSTR::null()) }.unwrap_or_default();
            !h.is_invalid()
        })
        .expect("the stand-in's window appears");
        h
    };
    assert!(to_front(ai_window), "the stand-in comes to the front");
    // to_front's Alt tap can leave the window in menu mode (focus on its menu bar) until the next key: Esc leaves
    // it, the way a person would, so the check starts with the chat box focused.
    press(VK_ESCAPE, false);
    let mut chat = HWND::default();
    wait_for(3000, || {
        chat = focus_of(ai_window);
        !chat.is_invalid() && chat != ai_window
    })
    .expect("the stand-in's chat box has the keyboard");
    let mut card = None;
    wait_for(if store.is_none() { 10000 } else { 4000 }, || {
        card = card_window(clotr_pid);
        card.is_some()
    });
    sleep(2500); // the card's page loads and says it's ready
    (run, card, ai_window, chat, trace, cleanup.keep())
}

/// The typing check against the stand-ins: a fake card number typed in the AI app's chat box shows the card soon
/// after the pause, without taking the keyboard; "Clot this leak and copy" puts a copy with it hidden on the clipboard
/// and leaves the box as typed; emptying the box ends the card; the password box beside it is looked at, never
/// subscribed to or read; the plain window's box is never looked at.
#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_typing_check() {
    let (run, card, ai_window, chat, trace, base) = typing_run("on", None);
    let _cleanup = TempBase(base.clone());
    let card = card.expect("Clotr makes its card's window when an AI app comes to the front");
    let watched = wait_for(3000, || trace_lines(&trace).iter().any(|l| l == "watch"));
    assert!(watched.is_some(), "the chat box is subscribed to: {:?}", trace_lines(&trace));
    assert!(!visible(card), "an empty box, no card");

    // A fake card number typed, then a pause.
    still_ours(ai_window);
    type_text(&format!("my card is {CARD} ok"), 20);
    let paused_at = Instant::now();
    let shown = wait_for(3000, || visible(card));
    let ms = shown.map(|_| paused_at.elapsed().as_millis()).unwrap_or(u128::MAX);
    println!("typed card shown {ms} ms after the last key (the check waits 400 ms of quiet first)");
    assert!(ms < 400 + 500, "the card within 500 ms of the pause (took {ms} ms after the last key)");
    assert_eq!(unsafe { GetForegroundWindow() }, ai_window, "the AI app stays in front");
    assert_eq!(focus_of(ai_window), chat, "the chat box keeps the keyboard");
    let reads: Vec<String> = trace_lines(&trace).into_iter().filter(|l| l.starts_with("read ")).collect();
    assert!(!reads.is_empty(), "the box was read: {:?}", trace_lines(&trace));

    // "Clot this leak and copy": the clipboard gets the message with it hidden; the box itself is never rewritten.
    let before = clip_get();
    let (_uia, hide) = button(card, &["Clot this leak and copy", "Taponar esta fuga y copiar"])
        .expect("the card's Clot this leak and copy");
    invoke(&hide);
    let copied = wait_for(3000, || clip_get() != before);
    assert!(copied.is_some(), "Clot this leak and copy put something on the clipboard");
    let now = clip_get().unwrap_or_default();
    println!("clipboard after Clot this leak and copy: {:?}", now.replace(CARD, "<the card>"));
    assert!(!now.contains(CARD) && !now.contains("4111"), "the copy has the card number hidden");
    assert!(now.contains("my card is"), "the rest of the message is there to paste over it");
    let in_box = edit_text(chat);
    assert!(
        in_box.contains(CARD),
        "the box itself is left as typed: Clotr never rewrites it (it holds {:?})",
        in_box.replace(CARD, "<the card>")
    );
    assert!(button(card, &["✓ Copied, with it hidden", "✓ Copiado, con esto oculto"]).is_some(), "the card says so");
    assert_eq!(unsafe { GetForegroundWindow() }, ai_window, "the AI app stays in front after the click");

    // Emptying the box (the message sent, in real life) ends the card.
    still_ours(ai_window);
    clear_box(chat);
    let gone = wait_for(3000, || !visible(card));
    assert!(gone.is_some(), "an emptied box ends the typed card");

    // Closing a typed card dismisses it without changing the copied text, the message box or its history.
    still_ours(ai_window);
    type_text(&format!("my card is {CARD} ok"), 20);
    assert!(wait_for(3000, || visible(card)).is_some(), "the typed card shows again");
    let clip_before_close = clip_get();
    let box_before_close = edit_text(chat);
    let store_before_close = std::fs::read(base.join("data").join("store.json")).unwrap_or_default();
    let (_u_close, dismiss) = button(card, &["Close", "Cerrar"]).expect("the typed card's Close button");
    invoke(&dismiss);
    assert!(wait_for(3000, || !visible(card)).is_some(), "Close hides the typed card");
    assert_eq!(clip_get(), clip_before_close, "closing the typed card leaves the clipboard alone");
    assert_eq!(edit_text(chat), box_before_close, "closing the typed card leaves the message alone");
    assert_eq!(
        std::fs::read(base.join("data").join("store.json")).unwrap_or_default(),
        store_before_close,
        "closing the typed card records nothing"
    );

    // The password box: looked at once it has the keyboard, never subscribed to, never read.
    assert!(focus_box(ai_window, "102"), "the password box takes the keyboard");
    sleep(800);
    let mark = trace_lines(&trace).len();
    still_ours(ai_window);
    type_text(CARD, 20);
    sleep(1500);
    let after: Vec<String> = trace_lines(&trace).into_iter().skip(mark).collect();
    let all = trace_lines(&trace);
    assert!(
        all.iter().any(|l| l == "look Password"),
        "the password box was seen as one: {all:?}"
    );
    assert!(
        !after.iter().any(|l| l == "watch" || l.starts_with("read ")),
        "nothing subscribed to or read in the password box: {after:?}"
    );
    assert!(!visible(card), "no card for the password box");

    // Back to the chat box: subscribed again (and nothing in it, so no card).
    assert!(focus_box(ai_window, "101"), "the chat box takes the keyboard back");
    let back = wait_for(3000, || trace_lines(&trace).iter().skip(mark).any(|l| l == "watch"));
    assert!(back.is_some(), "the chat box is watched again");

    // The plain window: its box (beside a Send button) is never looked at, nothing subscribed, no card.
    let plain = Command::new(env!("CARGO_BIN_EXE_clotr-dk-plain"))
        .spawn()
        .expect("the stand-in plain window starts");
    let mut plain = Stop(plain);
    let plain_window = {
        let mut h = HWND::default();
        wait_for(5000, || {
            h = unsafe { FindWindowW(w!("ClotrDkPlain"), PCWSTR::null()) }.unwrap_or_default();
            !h.is_invalid()
        })
        .expect("the stand-in plain window appears");
        h
    };
    assert!(to_front(plain_window), "the plain window comes to the front");
    let unwatched = wait_for(2000, || trace_lines(&trace).last().is_some_and(|l| l == "unwatch"));
    assert!(unwatched.is_some(), "leaving the AI app removes the subscription: {:?}", trace_lines(&trace));
    let mark = trace_lines(&trace).len();
    still_ours(plain_window);
    type_text(&format!("my card is {CARD}"), 20);
    sleep(1500);
    let after: Vec<String> = trace_lines(&trace).into_iter().skip(mark).collect();
    assert!(after.is_empty(), "nothing in the plain window was even looked at: {after:?}");
    assert!(!visible(card), "no card over the plain window");
    let _ = plain.0.kill();

    drop(run);
}

/// Paused, or with "Check what I type in AI apps" off: the chat box is never subscribed to, and a fake card number
/// typed there shows no card.
#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_typing_check_paused_or_off() {
    for (tag, store) in [("paused", r#"{"pausedAll":true}"#), ("off", r#"{"typingCheck":false}"#)] {
        let (run, card, ai_window, _chat, trace, base) = typing_run(tag, Some(store));
        let _cleanup = TempBase(base);
        still_ours(ai_window);
        type_text(&format!("my card is {CARD} ok"), 20);
        sleep(1500);
        let lines = trace_lines(&trace);
        println!("{tag}: trace {lines:?}");
        assert!(lines.is_empty(), "{tag}: the box is never looked at: {lines:?}");
        assert!(!card.is_some_and(visible), "{tag}: no card");
        drop(run);
    }
}

// ---------- The main window ----------

/// The main window: Clotr's window that can take the keyboard (the card never can), named Clotr in its title bar.
fn main_window(pid: u32) -> Option<HWND> {
    top_windows_of(pid).into_iter().find(|&h| {
        let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) } as u32;
        visible(h) && ex & WS_EX_NOACTIVATE.0 == 0 && title_of(h) == "Clotr"
    })
}

fn title_of(h: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetWindowTextW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

/// A text box's own text, as `WM_GETTEXT` reads it (the stand-in's edit control is plain enough that it never
/// holds more than this). Sent as a message on purpose: `GetWindowTextW` on another process's window returns the
/// caption Windows stored, not what's in the box now.
fn edit_text(h: HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_GETTEXT};
    let mut buf = [0u16; 4096];
    let n = unsafe {
        SendMessageW(h, WM_GETTEXT, Some(WPARAM(buf.len())), Some(LPARAM(buf.as_mut_ptr() as isize)))
    };
    String::from_utf16_lossy(&buf[..(n.0.max(0) as usize).min(buf.len())])
}

/// The window's scaling: 1 at 100%, 1.5 at 150%.
fn scale_of(h: HWND) -> f64 {
    unsafe { GetDpiForWindow(h) }.max(96) as f64 / 96.0
}

/// The size the page lays itself out in (logical pixels).
fn page_size(h: HWND) -> (f64, f64) {
    let mut r = RECT::default();
    let _ = unsafe { GetClientRect(h, &mut r) };
    let s = scale_of(h);
    ((r.right - r.left) as f64 / s, (r.bottom - r.top) as f64 / s)
}

/// The screen's room for windows, the taskbar aside (logical pixels).
fn screen_room(h: HWND) -> (f64, f64) {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let _ = unsafe { GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mut info) };
    let (r, s) = (info.rcWork, scale_of(h));
    ((r.right - r.left) as f64 / s, (r.bottom - r.top) as f64 / s)
}

/// One key, as a person presses it (with Shift held when asked).
fn press(vk: VIRTUAL_KEY, shift: bool) {
    let key = |vk, flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    let mut keys = vec![];
    if shift {
        keys.push(key(VK_SHIFT, Default::default()));
    }
    keys.push(key(vk, Default::default()));
    keys.push(key(vk, KEYEVENTF_KEYUP));
    if shift {
        keys.push(key(VK_SHIFT, KEYEVENTF_KEYUP));
    }
    unsafe { SendInput(&keys, std::mem::size_of::<INPUT>() as i32) };
    sleep(150);
}

/// A mouse drag, as a person makes it: press at `from`, move in steps to `to`, let go (the pointer put back after).
fn drag(from: (i32, i32), to: (i32, i32)) {
    let button = |flags| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    let mut was = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut was);
        let _ = SetCursorPos(from.0, from.1);
        sleep(100);
        SendInput(&[button(MOUSEEVENTF_LEFTDOWN)], std::mem::size_of::<INPUT>() as i32);
        sleep(100);
        for step in 1..=20 {
            let x = from.0 + (to.0 - from.0) * step / 20;
            let y = from.1 + (to.1 - from.1) * step / 20;
            let _ = SetCursorPos(x, y);
            sleep(25);
        }
        sleep(100);
        SendInput(&[button(MOUSEEVENTF_LEFTUP)], std::mem::size_of::<INPUT>() as i32);
        sleep(100);
        let _ = SetCursorPos(was.x, was.y);
    }
}

/// What has the keyboard, as a screen reader hears it: its name, and its id on the page.
fn focused(uia: &IUIAutomation) -> (String, String) {
    unsafe {
        uia.GetFocusedElement()
            .map(|e| {
                (
                    e.CurrentName().map(|s| s.to_string()).unwrap_or_default(),
                    e.CurrentAutomationId().map(|s| s.to_string()).unwrap_or_default(),
                )
            })
            .unwrap_or_default()
    }
}

/// The sidebar's sections, in order: each one's screen and its name.
const SECTIONS: [(&str, &str); 6] = [
    ("home", "Home"),
    ("scan", "Scan"),
    ("results", "Results"),
    ("protection", "Protection"),
    ("history", "History"),
    ("settings", "Settings"),
];

struct Stop(Child);

impl Drop for Stop {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_main_window() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let base = std::env::temp_dir().join(format!("clotr-dk6-{}", std::process::id()));
    let data = base.join("data");
    let netlog_file = base.join("netlog.json");
    std::fs::create_dir_all(&data).unwrap();
    let _cleanup = TempBase(base);
    let mut clotr = Stop(
        Command::new(env!("CARGO_BIN_EXE_clotr"))
            .env("CLOTR_DESKTOP_DATA", &data)
            .env("CLOTR_NETLOG", &netlog_file)
            .env("CLOTR_OPEN_MAIN", "1")
            .env("CLOTR_LOCALE", "en-US")
            .spawn()
            .expect("Clotr starts"),
    );
    let pid = clotr.0.id();
    let net = watch_sockets(pid);

    let mut win = HWND::default();
    wait_for(15000, || {
        win = main_window(pid).unwrap_or_default();
        !win.is_invalid()
    })
    .expect("Clotr opens its main window");
    sleep(3000); // its page loads

    // 1280 x 800 when the screen has room (the window's frame included), never smaller than 900 x 600.
    let (w, h) = page_size(win);
    let (room_w, room_h) = screen_room(win);
    let want = (
        1280f64.min(room_w - 16.0).max(900.0),
        800f64.min(room_h - 48.0).max(600.0),
    );
    println!(
        "main window {w:.0} x {h:.0} at {:.0}% scaling, on a screen with room for {room_w:.0} x {room_h:.0}",
        scale_of(win) * 100.0
    );
    assert!(
        (w - want.0).abs() <= 2.0 && (h - want.1).abs() <= 2.0,
        "the main window opens at {want:?} (it's {w:.0} x {h:.0})"
    );

    // The keyboard: Tab reaches the six sections in order; Enter opens each, and its heading takes the focus.
    assert!(to_front(win), "the main window comes to the front");
    let uia: IUIAutomation = unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).expect("UI Automation")
    };
    // From the top of the page, Tab reaches the first section's link (after the skip link). Each press waits for
    // UI Automation to hear where the focus went, so a busy PC can't make it skip past.
    for _ in 0..12 {
        if focused(&uia).0 == SECTIONS[0].1 {
            break;
        }
        let before = focused(&uia);
        press(VK_TAB, false);
        wait_for(2000, || focused(&uia) != before);
    }
    let mut reached = vec![focused(&uia).0];
    for _ in 1..SECTIONS.len() {
        let before = focused(&uia);
        press(VK_TAB, false);
        // A busy PC can take a moment to tell UI Automation where the focus went.
        wait_for(2000, || focused(&uia) != before);
        reached.push(focused(&uia).0);
    }
    println!("Tab: {}", reached.join(" > "));
    assert_eq!(
        reached,
        SECTIONS.map(|(_, name)| name.to_string()),
        "Tab reaches the six sections, in order"
    );
    for (id, name) in SECTIONS {
        // Back to the section's link: the sidebar comes before the page, so Shift+Tab finds it.
        let mut on = false;
        for _ in 0..12 {
            if focused(&uia).0 == name {
                on = true;
                break;
            }
            let before = focused(&uia);
            press(VK_TAB, true);
            wait_for(2000, || focused(&uia) != before);
        }
        assert!(on, "the keyboard reaches {name}");
        press(VK_RETURN, false);
        let heading = format!("title-{id}");
        let opened = wait_for(2000, || focused(&uia).1 == heading);
        let (said, at) = focused(&uia);
        println!("{name}: Enter, the focus on {at:?} ({said:?})");
        assert!(
            opened.is_some(),
            "Enter on {name} opens it, with the focus on its heading"
        );
    }

    // As small as a person can make it, dragging its corner: 900 x 600, where the sidebar shrinks to icons and each
    // section keeps its name for a screen reader.
    let mut r = RECT::default();
    let _ = unsafe { GetWindowRect(win, &mut r) };
    drag((r.right - 4, r.bottom - 4), (r.left + 200, r.top + 150));
    sleep(800);
    let (min_w, min_h) = page_size(win);
    println!("its corner dragged to 200 x 150: {min_w:.0} x {min_h:.0}");
    assert!(
        (min_w - 900.0).abs() <= 2.0 && (min_h - 600.0).abs() <= 2.0,
        "never smaller than 900 x 600 (it's {min_w:.0} x {min_h:.0})"
    );
    for (_, name) in SECTIONS {
        assert!(
            button(win, &[name]).is_some(),
            "{name} keeps its name when the sidebar shows icons only"
        );
    }

    // Closing the window keeps Clotr by the clock.
    let pids = net.pids.lock().unwrap().clone();
    let parts = roles(&pids);
    let _ = unsafe { PostMessageW(Some(win), WM_CLOSE, WPARAM(0), LPARAM(0)) };
    assert!(
        wait_for(5000, || !unsafe { IsWindow(Some(win)) }.as_bool()).is_some(),
        "the main window closes"
    );
    sleep(1000);
    assert!(
        clotr.0.try_wait().ok().flatten().is_none(),
        "closing the main window leaves Clotr running"
    );
    println!("the window closed; Clotr is still running");

    // The same no-network check again, the main window's page included.
    let _ = clotr.0.kill();
    let _ = clotr.0.wait();
    sleep(1500);
    let mut net = net;
    net.stop.store(true, Ordering::Relaxed);
    net.thread.take().unwrap().join().unwrap();
    let seen: Vec<Socket> = net.seen.lock().unwrap().iter().cloned().collect();
    let log = netlog(&netlog_file);
    println!(
        "{} sockets seen; web view network log: listening {}, route checks {}, problems {}",
        seen.len(),
        log.listening,
        log.route_checks,
        log.problems.len()
    );
    for s in &seen {
        let role = parts.get(&s.pid).map(String::as_str).unwrap_or("?");
        println!("     socket: {} ({role})", s.what);
    }
    for p in &log.problems {
        println!("     {p}");
    }
    let network_service = |pid: u32| parts.get(&pid).is_some_and(|r| r.contains("NetworkService"));
    let connections: Vec<&Socket> = seen
        .iter()
        .filter(|s| !(s.what.starts_with("udp") && network_service(s.pid) && log.route_checks > 0))
        .collect();
    assert!(
        connections.is_empty(),
        "no connection from any of Clotr's processes: {connections:?}"
    );
    assert!(
        log.listening,
        "the web view's network log saw the main window load"
    );
    assert!(
        log.problems.is_empty(),
        "no request, lookup, connection or byte: {:?}",
        log.problems
    );
}

// ---------- Home's status ----------

fn client_animations_enabled() -> bool {
    let mut enabled: i32 = 1;
    unsafe {
        let _ = SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some(&mut enabled as *mut i32 as *mut core::ffi::c_void),
            Default::default(),
        );
    }
    enabled != 0
}

/// Windows' "Animation effects" setting (Settings > Accessibility > Visual effects), the one WebView2 follows for
/// `prefers-reduced-motion` the way Edge does. Not written to the registry (no
/// SPIF_UPDATEINIFILE): the change lives only for this run, broadcast live so a listening web view sees it too, and
/// the caller restores it when done -- this runs on whatever PC runs it.
fn set_client_animations_enabled(on: bool) {
    unsafe {
        let _ = SystemParametersInfoW(SPI_SETCLIENTAREAANIMATION, on as u32, None, SPIF_SENDCHANGE);
    }
}

/// Home's title for each of status()'s four states (`CLOTR_FORCE_STATUS`; `None` is the default, quiet, state).
const HOME_STATES: [(Option<&str>, &str); 4] = [
    (None, "All quiet"),
    (Some("look"), "Worth a look"),
    (Some("paused"), "Paused"),
    (Some("notRunning"), "Not running"),
];

/// Opens Home once for each status and checks its title, tagging temp folders by `tag` so two calls in the same
/// run (plain, then under forced reduced motion) never collide.
fn home_shows_each_state(tag: &str) {
    for (force, title) in HOME_STATES {
        let base = std::env::temp_dir().join(format!("clotr-dk7-{tag}-{}", force.unwrap_or("quiet")));
        let data = base.join("data");
        let netlog_file = base.join("netlog.json");
        std::fs::create_dir_all(&data).unwrap();
        let _cleanup = TempBase(base);
        let clotr = Stop(
            Command::new(env!("CARGO_BIN_EXE_clotr"))
                .env("CLOTR_DESKTOP_DATA", &data)
                .env("CLOTR_NETLOG", &netlog_file)
                .env("CLOTR_OPEN_MAIN", "1")
                .env("CLOTR_LOCALE", "en-US")
                .envs(force.map(|f| ("CLOTR_FORCE_STATUS", f)))
                .spawn()
                .expect("Clotr starts"),
        );
        let pid = clotr.0.id();
        let mut win = HWND::default();
        wait_for(15000, || {
            win = main_window(pid).unwrap_or_default();
            !win.is_invalid()
        })
        .unwrap_or_else(|| panic!("Clotr ({tag}) opens its main window for {title:?}"));
        sleep(2500); // the page loads

        let found = button(win, &[title]);
        println!("{tag} {title:?}: {}", if found.is_some() { "shown" } else { "not found" });
        assert!(found.is_some(), "Home ({tag}) shows {title:?}");

        drop(clotr);
        sleep(500);
    }
}

#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_home_status() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    home_shows_each_state("motion");

    // The same four states still true with Animation effects off, restored either way.
    let was_enabled = client_animations_enabled();
    set_client_animations_enabled(false);
    let result = std::panic::catch_unwind(|| home_shows_each_state("still"));
    set_client_animations_enabled(was_enabled);
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}

// ---------- The tray flyout ----------

/// The flyout: with no main window opened in this run, it's the only window besides the (never-shown, no AI app
/// in front) card that can take the keyboard, so it's found the same way the main window is.
fn flyout_window(pid: u32) -> Option<HWND> {
    main_window(pid)
}

#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_tray_flyout() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let base = std::env::temp_dir().join(format!("clotr-dk8-{}", std::process::id()));
    let data = base.join("data");
    let netlog_file = base.join("netlog.json");
    std::fs::create_dir_all(&data).unwrap();
    let _cleanup = TempBase(base);
    let mut clotr = Stop(
        Command::new(env!("CARGO_BIN_EXE_clotr"))
            .env("CLOTR_DESKTOP_DATA", &data)
            .env("CLOTR_NETLOG", &netlog_file)
            .env("CLOTR_OPEN_FLYOUT", "1")
            .env("CLOTR_LOCALE", "en-US")
            .spawn()
            .expect("Clotr starts"),
    );
    let pid = clotr.0.id();
    let net = watch_sockets(pid);

    let mut win = HWND::default();
    wait_for(15000, || {
        win = flyout_window(pid).unwrap_or_default();
        !win.is_invalid()
    })
    .expect("the flyout opens");
    sleep(2500); // its page loads
    println!("the flyout opened at {:.0}% scaling", scale_of(win) * 100.0);

    // Content present: the ember's status (quiet, nothing forced) and all four actions, in their own words.
    let mut quit_button = None;
    for name in ["All quiet", "Open Clotr", "Run a quick scan", "Pause for an hour", "Quit Clotr"] {
        let found = button(win, &[name]);
        assert!(found.is_some(), "the flyout shows {name:?}");
        if name == "Quit Clotr" {
            quit_button = found;
        }
    }

    // The window is sized to its content (flyout_fit), not a guess taller than it — no empty frame below the
    // last button. A generous allowance (padding plus the panel's own bottom margin) still catches the old bug,
    // which left a near-full extra panel's worth of empty space.
    {
        let (_, quit) = quit_button.expect("the Quit button was found above");
        let quit_rect = unsafe { quit.CurrentBoundingRectangle().unwrap() };
        let mut win_rect = RECT::default();
        let _ = unsafe { GetWindowRect(win, &mut win_rect) };
        let gap = (win_rect.bottom - quit_rect.bottom) as f64 / scale_of(win);
        println!("{gap:.0}px of logical space below the last button");
        assert!(gap < 60.0, "the flyout window fits its content, not a guess taller than it");
    }

    // On the screen: above where the tray icon sits, never off the usable area (flyout_spot's own unit tests cover
    // the arithmetic itself, at both 100% and a 150%-equivalent, in already-converted logical pixels).
    let mut r = RECT::default();
    let _ = unsafe { GetWindowRect(win, &mut r) };
    let (room_w, room_h) = screen_room(win);
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let _ = unsafe { GetMonitorInfoW(MonitorFromWindow(win, MONITOR_DEFAULTTONEAREST), &mut mi) };
    let s = scale_of(win);
    println!(
        "flyout at {:.0},{:.0}, screen room {room_w:.0} x {room_h:.0}",
        (r.left - mi.rcWork.left) as f64 / s,
        (r.top - mi.rcWork.top) as f64 / s
    );
    assert!(
        r.left >= mi.rcWork.left && r.right <= mi.rcWork.right && r.top >= mi.rcWork.top && r.bottom <= mi.rcWork.bottom,
        "the flyout stays on the screen's usable area"
    );

    // "Pause for an hour" shows a brief confirmation in this same window (never a new one, never taking
    // focus), rather than hiding at once. The tray menu's own "Pause until I turn it back on" / "Resume Clotr"
    // words can't be driven here (telling Clotr's tray icon from the trial's apart from outside is too easy to get
    // wrong on a shared PC), so that part stays a manual check.
    let (_u3, pause_btn) = button(win, &["Pause for an hour"]).expect("the flyout's Pause button");
    click(&pause_btn);
    assert!(
        wait_for(2000, || button(win, &["Paused"]).is_some()).is_some(),
        "the confirmation shows, in the flyout itself"
    );
    println!("the pause confirmation showed in the flyout");

    // Esc hides it (flyout.js, close_flyout in main.rs) -- from the confirmation too, not just the normal view.
    assert!(to_front(win), "the flyout can come to the front");
    press(VK_ESCAPE, false);
    assert!(wait_for(3000, || !visible(win)).is_some(), "Esc hides the flyout");
    println!("Esc hid the flyout");

    // No open socket, as checked for the trial and the main window.
    let _ = clotr.0.kill();
    let _ = clotr.0.wait();
    sleep(1500);
    let mut net = net;
    net.stop.store(true, Ordering::Relaxed);
    net.thread.take().unwrap().join().unwrap();
    let pids = net.pids.lock().unwrap().clone();
    let parts = roles(&pids);
    let seen: Vec<Socket> = net.seen.lock().unwrap().iter().cloned().collect();
    let log = netlog(&netlog_file);
    println!(
        "{} sockets seen; web view network log: listening {}, route checks {}, problems {}",
        seen.len(),
        log.listening,
        log.route_checks,
        log.problems.len()
    );
    for s in &seen {
        let role = parts.get(&s.pid).map(String::as_str).unwrap_or("?");
        println!("     socket: {} ({role})", s.what);
    }
    for p in &log.problems {
        println!("     {p}");
    }
    let network_service = |pid: u32| parts.get(&pid).is_some_and(|r| r.contains("NetworkService"));
    let connections: Vec<&Socket> = seen
        .iter()
        .filter(|s| !(s.what.starts_with("udp") && network_service(s.pid) && log.route_checks > 0))
        .collect();
    assert!(
        connections.is_empty(),
        "no connection from any of Clotr's processes: {connections:?}"
    );
    assert!(log.listening, "the web view's network log saw the flyout load");
    assert!(
        log.problems.is_empty(),
        "no request, lookup, connection or byte: {:?}",
        log.problems
    );
}

// ---------- The Scan screen ----------

/// The fixture folder, committed beside this test: `tests/fixtures/scan` (tools/make-scan-fixtures.js). Most of
/// its files hold something to find (scan-worker.test.js already proves what, file by file); scanning it here
/// proves the walker and the Scan screen reach the same answer together.
fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/scan")
}

/// An element's own accessible text, found by the id main.html gives it (the same id a screen reader's "go to"
/// would use) rather than a fixed label `button()` already finds by name -- for a value the page fills in at run
/// time (a count, a percentage) that can't be known ahead of a click.
fn text_of(window: HWND, automation_id: &str) -> Option<String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let root = uia.ElementFromHandle(window).ok()?;
        let variant = windows::Win32::System::Variant::VARIANT::from(automation_id);
        let cond = uia.CreatePropertyCondition(UIA_AutomationIdPropertyId, &variant).ok()?;
        let found = root.FindFirst(TreeScope_Descendants, &cond).ok()?;
        found.CurrentName().ok().map(|s| s.to_string())
    }
}

/// Opens Clotr's main window, already on the Scan screen's folder override `root` (CLOTR_SCAN_ROOT, dk-test-app
/// only), watching its sockets from the start.
fn open_on_scan(data: &Path, netlog_file: &Path, root: &Path) -> (Stop, Watch, HWND) {
    open_on_scan_with(data, netlog_file, &[("CLOTR_SCAN_ROOT", root)])
}

/// The same, with any of the dk-test-app scan stand-ins: CLOTR_SCAN_ROOT, or CLOTR_SCAN_DRIVES and
/// CLOTR_SCAN_FLOOR.
fn open_on_scan_with(data: &Path, netlog_file: &Path, stand_ins: &[(&str, &Path)]) -> (Stop, Watch, HWND) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_clotr"));
    command
        .env("CLOTR_DESKTOP_DATA", data)
        .env("CLOTR_NETLOG", netlog_file)
        .env("CLOTR_OPEN_MAIN", "1")
        .env("CLOTR_LOCALE", "en-US");
    for (name, dir) in stand_ins {
        command.env(name, dir);
    }
    let clotr = Stop(command.spawn().expect("Clotr starts"));
    let pid = clotr.0.id();
    let net = watch_sockets(pid);
    let mut win = HWND::default();
    wait_for(15000, || {
        win = main_window(pid).unwrap_or_default();
        !win.is_invalid()
    })
    .expect("Clotr opens its main window");
    sleep(2500); // its page loads
    assert!(to_front(win), "the main window comes to the front");
    let (_u, scan_link) = button(win, &["Scan"]).expect("the sidebar's Scan link");
    click(&scan_link);
    (clotr, net, win)
}

/// The same no-open-socket check used by every test here: the watcher stopped and the web view's own network log
/// read, `tag` only naming which test is doing the asking in the printed output.
fn assert_net1(tag: &str, mut net: Watch, netlog_file: &Path) {
    sleep(1500); // the web view's processes leave after their host
    net.stop.store(true, Ordering::Relaxed);
    net.thread.take().unwrap().join().unwrap();
    let pids = net.pids.lock().unwrap().clone();
    let parts = roles(&pids);
    let seen: Vec<Socket> = net.seen.lock().unwrap().iter().cloned().collect();
    let log = netlog(netlog_file);
    println!(
        "{tag}  {} sockets seen ({} processes); web view network log: listening {}, route checks {}, problems {}",
        seen.len(),
        pids.len(),
        log.listening,
        log.route_checks,
        log.problems.len()
    );
    for s in &seen {
        let role = parts.get(&s.pid).map(String::as_str).unwrap_or("?");
        println!("     socket: {} ({role})", s.what);
    }
    for p in &log.problems {
        println!("     {p}");
    }
    let network_service = |pid: u32| parts.get(&pid).is_some_and(|r| r.contains("NetworkService"));
    let connections: Vec<&Socket> = seen
        .iter()
        .filter(|s| !(s.what.starts_with("udp") && network_service(s.pid) && log.route_checks > 0))
        .collect();
    assert!(
        connections.is_empty(),
        "{tag}: no connection from any of Clotr's processes: {connections:?}"
    );
    assert!(log.listening, "{tag}: the web view's network log saw the scan run");
    assert!(
        log.problems.is_empty(),
        "{tag}: no request, lookup, connection or byte: {:?}",
        log.problems
    );
}

#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_quick_scan() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let base = std::env::temp_dir().join(format!("clotr-dk9-{}", std::process::id()));
    let data = base.join("data");
    let netlog_file = base.join("netlog.json");
    std::fs::create_dir_all(&data).unwrap();
    let _cleanup = TempBase(base);

    let (mut clotr, net, win) = open_on_scan(&data, &netlog_file, &fixtures_dir());
    let (_u, start) = button(win, &["Run a quick scan"]).expect("the Scan screen's Run a quick scan button");
    click(&start);

    assert!(
        button(win, &["Scan again"]).is_some(),
        "the scan reaches a finished state (Scan again appears)"
    );
    sleep(300); // the last paint lands
    let Stage { title, files_read, found: worth_a_look } = scan_stage(win);
    println!("{title:?}; files read {files_read:?}; worth a look {worth_a_look:?}");
    assert!(title.starts_with("Done:"), "it finished on its own, not stopped, so the progress is at 100% ({title:?})");
    assert!(
        files_read.replace(',', "").parse::<u32>().is_ok_and(|n| n > 0),
        "it read the fixture's files ({files_read:?})"
    );
    assert!(
        worth_a_look.replace(',', "").parse::<u32>().is_ok_and(|n| n > 0),
        "the fixtures hold something worth a look ({worth_a_look:?})"
    );

    let _ = clotr.0.kill();
    let _ = clotr.0.wait();
    assert_net1("dk_quick_scan", net, &netlog_file);
}

/// The Scan screen's title and its "Files read" and "Worth a look" numbers, as a screen reader hears them. The web
/// view doesn't expose a plain paragraph's or a stat's own id to UI Automation (only its text), so these are found
/// by what they say and where they sit: the title is the first line that starts like one, and each number is the
/// first name after its own label.
struct Stage {
    title: String,
    files_read: String,
    found: String,
}

fn scan_stage(window: HWND) -> Stage {
    let names = all_names(window);
    let after = |label: &str| {
        names
            .iter()
            .skip_while(|n| n.as_str() != label)
            .find(|n| n.as_str() != label)
            .cloned()
            .unwrap_or_default()
    };
    let title = names
        .iter()
        .find(|n| {
            ["Done:", "Nothing worth a look", "Stopped:"]
                .iter()
                .any(|t| n.starts_with(t))
        })
        .cloned()
        .unwrap_or_default();
    Stage {
        files_read: after("Files read"),
        found: after("Worth a look"),
        title,
    }
}

/// Every name a screen reader would hear in `window` right now, in order.
fn all_names(window: HWND) -> Vec<String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(uia) = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER) else {
            return vec![];
        };
        let (Ok(root), Ok(all_cond)) = (uia.ElementFromHandle(window), uia.CreateTrueCondition()) else {
            return vec![];
        };
        let Ok(all) = root.FindAll(TreeScope_Descendants, &all_cond) else {
            return vec![];
        };
        (0..all.Length().unwrap_or(0))
            .filter_map(|i| all.GetElement(i).ok()?.CurrentName().ok().map(|n| n.to_string()))
            .filter(|n| !n.is_empty())
            .collect()
    }
}

/// A scan pick's own name: the whole card's text (its title, its line and its time), found by how it starts.
fn pick_named(window: HWND, starts: &str) -> Option<String> {
    all_names(window).into_iter().find(|n| n.starts_with(starts))
}

#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_scan_t6_19() {
    // A .txt with an AWS key in it, Clotr, Scan, Run a quick scan. Before
    // the fix this stopped at the very first file (its bytes came back as a plain array and the hand-off to the
    // reader threw), so the screen went back to its idle button and nothing was ever found.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let base = std::env::temp_dir().join(format!("clotr-dk-t619-{}", std::process::id()));
    let data = base.join("data");
    let netlog_file = base.join("netlog.json");
    let desk = base.join("desk");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&desk).unwrap();
    std::fs::write(desk.join("aws-key.txt"), format!("my AWS key is {KEY}\n")).unwrap();
    let _cleanup = TempBase(base);

    let (mut clotr, net, win) = open_on_scan(&data, &netlog_file, &desk);
    let (_u, start) = button(win, &["Run a quick scan"]).expect("the Scan screen's Run a quick scan button");
    click(&start);
    assert!(
        button(win, &["Scan again"]).is_some(),
        "the scan reaches a finished state (Scan again appears)"
    );
    sleep(300);
    let Stage {
        title,
        found: worth_a_look,
        ..
    } = scan_stage(win);
    println!("{title:?}; worth a look {worth_a_look:?}");
    assert!(title.starts_with("Done:"), "it finished on its own ({title:?})");
    assert_eq!(worth_a_look, "1", "the one file with the key is worth a look");

    let (_u, see) = button(win, &["See the result"]).expect("the See the result button");
    click(&see);
    sleep(800);
    let names = all_names(win);
    assert!(
        names.iter().any(|n| n.contains("aws-key.txt")),
        "Results names the file: {names:?}"
    );
    assert!(
        names.iter().any(|n| n.contains("AWS Access Key")),
        "and the kind of key in it: {names:?}"
    );
    assert!(!names.iter().any(|n| n.contains(KEY)), "never the key itself");

    let _ = clotr.0.kill();
    let _ = clotr.0.wait();
    assert_net1("dk_scan_t6_19", net, &netlog_file);
}

#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_full_then_quick() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let base = std::env::temp_dir().join(format!("clotr-dk-full-{}", std::process::id()));
    let data = base.join("data");
    let netlog_file = base.join("netlog.json");
    let drive = base.join("drive");
    let floor = drive.join("Users").join("me").join("Downloads");
    let app = drive.join("Users").join("me").join("AppData").join("Roaming").join("app");
    let system = drive.join("Windows").join("System32");
    let documents = drive.join("Users").join("me").join("Documents");
    for dir in [&data, &floor, &app, &system, &documents] {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::write(floor.join("statement.txt"), "Nothing to see in here.\n").unwrap();
    // A code project in Downloads: Quick and Full both leave it out and say so.
    let project = floor.join("shop");
    std::fs::create_dir_all(project.join(".git")).unwrap();
    std::fs::write(project.join("keys.txt"), format!("test key {KEY}\n")).unwrap();
    std::fs::write(app.join("aws.txt"), format!("my AWS key is {KEY}\n")).unwrap();
    std::fs::write(system.join("aws.txt"), format!("my AWS key is {KEY}\n")).unwrap();
    let _cleanup = TempBase(base);

    let (mut clotr, net, win) = open_on_scan_with(
        &data,
        &netlog_file,
        &[("CLOTR_SCAN_DRIVES", &drive), ("CLOTR_SCAN_FLOOR", &floor)],
    );
    let quick_alone = "You haven't run a Full scan yet, so this reads all of Desktop, Downloads, Documents and Pictures. \
                       Code projects and files made to hold a key or password are left out.";
    assert!(button(win, &[quick_alone]).is_some(), "before any Full scan, Quick says it reads its floor only");

    let pick = pick_named(win, "Full scan ").expect("the Full scan pick");
    let (_u, full) = button(win, &[&pick]).expect("the Full scan pick");
    click(&full);
    let (_u, start) = button(win, &["Run a full scan"]).expect("the Run a full scan button");
    click(&start);
    assert!(button(win, &["Scan again"]).is_some(), "the Full scan finishes");
    sleep(300);
    let stage = scan_stage(win);
    println!("Full: {:?}; read {:?}; worth a look {:?}", stage.title, stage.files_read, stage.found);
    assert!(stage.title.starts_with("Done:"), "it finished on its own ({:?})", stage.title);
    assert_eq!(stage.files_read, "2", "the floor's file and AppData's, never the project's or the one under Windows");
    assert_eq!(stage.found, "1", "the key in AppData is worth a look");
    let names = all_names(win);
    assert!(
        names.iter().any(|n| n == "Left out 1 code project with 1 file."),
        "Full names the project it left out: {names:?}"
    );

    std::fs::write(floor.join("new-key.txt"), format!("my AWS key is {KEY}\n")).unwrap();
    std::fs::write(documents.join("elsewhere.txt"), format!("my AWS key is {KEY}\n")).unwrap();
    let pick = pick_named(win, "Quick scan ").expect("the picks are back after a finish");
    let (_u, quick) = button(win, &[&pick]).expect("the Quick scan pick");
    click(&quick);
    let names = all_names(win);
    assert!(
        names.iter().any(|n| n.starts_with("Reads what's new or changed in Desktop, Downloads, Documents and Pictures")),
        "after a Full scan, Quick says what it covers: {names:?}"
    );
    let (_u, start) = button(win, &["Run a quick scan"]).expect("the Run a quick scan button");
    click(&start);
    assert!(button(win, &["Scan again"]).is_some(), "the Quick scan finishes");
    sleep(300);
    let stage = scan_stage(win);
    println!("Quick: {:?}; read {:?}; worth a look {:?}", stage.title, stage.files_read, stage.found);
    assert_eq!(stage.files_read, "1", "only the new file in its places, never the unchanged ones or another folder");
    assert_eq!(stage.found, "1", "the new file's key");
    let names = all_names(win);
    assert!(
        names.iter().any(|n| n == "Left out 1 code project with 1 file."),
        "Quick names the project it left out: {names:?}"
    );

    let _ = clotr.0.kill();
    let _ = clotr.0.wait();
    assert_net1("dk_full_then_quick", net, &netlog_file);
}

/// A throwaway folder with thousands of tiny, harmless text files: slow enough to read, one IPC round trip apiece,
/// that a real UI Automation click on Stop can land before the scan finishes on its own. No fixture content matters
/// here (this test never checks what was found), only that there's enough of it.
fn slow_folder(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    for i in 0..6000 {
        std::fs::write(dir.join(format!("f{i}.txt")), "Clotr test fixture: nothing real here.\n").unwrap();
    }
}

#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_stop_mid_scan() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let base = std::env::temp_dir().join(format!("clotr-dk10-{}", std::process::id()));
    let data = base.join("data");
    let netlog_file = base.join("netlog.json");
    let slow = base.join("slow");
    std::fs::create_dir_all(&data).unwrap();
    slow_folder(&slow);
    let _cleanup = TempBase(base);

    let (mut clotr, net, win) = open_on_scan(&data, &netlog_file, &slow);
    let (_u, start) = button(win, &["Run a quick scan"]).expect("the Scan screen's Run a quick scan button");
    click(&start);

    // Stop, while it's running (the slow folder's thousands of files keep "running" open long enough for this to
    // land before the scan would finish on its own).
    let (_u, stop) = button(win, &["Stop"]).expect("Stop appears once the scan is running");
    click(&stop);

    assert!(
        button(win, &["Scan again"]).is_some(),
        "the screen reaches a finished state after Stop"
    );
    sleep(300);
    let title = scan_stage(win).title;
    println!("{title:?}");
    assert!(title.starts_with("Stopped:"), "Stop ends the scan as Stopped, not Done ({title:?})");

    // scan_cancel actually halted the walker: the files-read count holds still after Stop, not just the page's own
    // "running" flag.
    let after_stop = scan_stage(win).files_read;
    sleep(1500);
    let later = scan_stage(win).files_read;
    println!("files read at Stop {after_stop:?}, 1.5 s later {later:?}");
    assert_eq!(after_stop, later, "no further file is read once cancelled");

    let _ = clotr.0.kill();
    let _ = clotr.0.wait();
    assert_net1("dk_stop_mid_scan", net, &netlog_file);
}

// ---------- Results and its actions ----------

/// The common Save As dialog Tauri's save-file picker opens, found among Clotr's own top-level windows by its
/// English title (CLOTR_LOCALE is always forced to en-US for these checks).
fn save_dialog(pid: u32) -> Option<HWND> {
    top_windows_of(pid).into_iter().find(|&h| visible(h) && title_of(h) == "Save As")
}

/// The dialog's filename field: the one Edit control among its descendants, found by control type rather than a
/// fixed automation id (the common dialog's own ids aren't part of any public contract).
fn dialog_filename_field(
    dialog: HWND,
) -> Option<(IUIAutomation, windows::Win32::UI::Accessibility::IUIAutomationElement)> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let root = uia.ElementFromHandle(dialog).ok()?;
        let all = root.FindAll(TreeScope_Descendants, &uia.CreateTrueCondition().ok()?).ok()?;
        for i in 0..all.Length().unwrap_or(0) {
            let e = all.GetElement(i).ok()?;
            if e.CurrentControlType().map(|c| c.0).unwrap_or(0) == UIA_EditControlTypeId.0 {
                return Some((uia, e));
            }
        }
        None
    }
}

/// Drives the real Save As dialog to `dest`, the way a person types a full path into the filename field and
/// presses Save -- the page never learns this path (`scan_save_copy`, main.rs); the test does, because it's the
/// one who chose it.
fn save_as(pid: u32, dest: &Path, tag: &str) {
    assert!(wait_for(10000, || save_dialog(pid).is_some()).is_some(), "{tag}: the Save As dialog opens");
    let dialog = save_dialog(pid).unwrap();
    let (_u, field) = dialog_filename_field(dialog).unwrap_or_else(|| panic!("{tag}: the dialog's filename field"));
    // A dialog that has only just opened can still turn the first SetValue away ("canceled by the user") while it
    // fills its own folder view in, so this tries again for a moment before giving up.
    let typed = wait_for(5000, || unsafe {
        let set = field
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .and_then(|value| value.SetValue(&BSTR::from(dest.to_string_lossy().to_string())));
        if set.is_err() {
            sleep(200);
        }
        set.is_ok()
    });
    assert!(typed.is_some(), "{tag}: the dialog takes the destination's name");
    let (_u2, save) = button(dialog, &["Save"]).unwrap_or_else(|| panic!("{tag}: the dialog's Save button"));
    invoke(&save);
    assert!(wait_for(10000, || save_dialog(pid).is_none()).is_some(), "{tag}: the dialog closes");
}

#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_results_copy_without_place() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let base = std::env::temp_dir().join(format!("clotr-dk14-{}", std::process::id()));
    let data = base.join("data");
    let netlog_file = base.join("netlog.json");
    let dest = base.join("out.jpg");
    std::fs::create_dir_all(&data).unwrap();
    let _cleanup = TempBase(base);

    // The fixture's own EXIF (a made-up place, the Eiffel Tower, in its EXIF GPS) is the marker: present in
    // the original, gone from the copy because a fresh OffscreenCanvas never had it to carry forward.
    let original = std::fs::read(fixtures_dir().join("vacation-photo.jpg")).unwrap();
    assert!(
        original.windows(4).any(|w| w == b"Exif"),
        "the fixture itself carries EXIF (the place to strip)"
    );

    let (mut clotr, net, win) = open_on_scan(&data, &netlog_file, &fixtures_dir());
    let pid = clotr.0.id();
    let (_u, start) = button(win, &["Run a quick scan"]).expect("the Scan screen's Run a quick scan button");
    click(&start);
    assert!(button(win, &["Scan again"]).is_some(), "the scan reaches a finished state");

    let (_u, results_link) = button(win, &["Results"]).expect("the sidebar's Results link");
    click(&results_link);
    let (_u, strip) = button(win, &["Save a copy without the place"])
        .expect("the vacation photo's card offers Save a copy without the place");
    click(&strip);

    save_as(pid, &dest, "dk_results_copy_without_place");
    assert!(wait_for(5000, || dest.is_file()).is_some(), "the copy lands at the chosen destination");
    let copy = std::fs::read(&dest).unwrap();
    assert!(
        !copy.windows(4).any(|w| w == b"Exif"),
        "the copy carries no EXIF at all, the place included"
    );
    println!(
        "the saved copy ({} bytes) carries no EXIF; the original did ({} bytes)",
        copy.len(),
        original.len()
    );

    let _ = clotr.0.kill();
    let _ = clotr.0.wait();
    assert_net1("dk_results_copy_without_place", net, &netlog_file);
}

// ---------- Extension check on fixture profiles ----------

/// A made-up Chromium `User Data` folder, under a fixture `%LOCALAPPDATA%` (CLOTR_EXT_LOCALAPPDATA, dk-test-app
/// only): one plain extension that can read ChatGPT, one sideloaded one that's off -- the same shape
/// `extensions.rs`'s own fixtures use, laid out the way a real `chromium_roots()` candidate expects
/// (`Vivaldi/User Data/Default`). Vivaldi, not Chrome or Edge: the one Chromium browser this check can be sure
/// isn't actually installed on this PC, so "Show me where to remove it" deterministically falls
/// back to the word steps rather than depending on what else happens to be on the machine.
fn ext_fixture(base: &Path) -> (PathBuf, PathBuf) {
    let local = base.join("local");
    let roaming = base.join("roaming");
    let profile = local.join("Vivaldi").join("User Data").join("Default");
    let write = |rel: &str, content: &str| {
        let path = profile.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    };
    write(
        "Preferences",
        r#"{"extensions":{"settings":{
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{"state":1,"location":1,"withholding_permissions":false,
                "active_permissions":{"explicit_host":["https://chat.openai.com/*"],"scriptable_host":[]}},
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":{"state":0,"location":3,"withholding_permissions":false,
                "active_permissions":{"explicit_host":[],"scriptable_host":[]}}
        }}}"#,
    );
    write(
        "Extensions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1.0_0/manifest.json",
        r#"{"name":"Reads ChatGPT","content_scripts":[{"matches":["https://chat.openai.com/*"]}]}"#,
    );
    write(
        "Extensions/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/2.0_0/manifest.json",
        r#"{"name":"Installed From Outside A Store"}"#,
    );
    std::fs::create_dir_all(&roaming).unwrap();
    (local, roaming)
}

#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_extension_check() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let base = std::env::temp_dir().join(format!("clotr-dk15-{}", std::process::id()));
    let data = base.join("data");
    let netlog_file = base.join("netlog.json");
    std::fs::create_dir_all(&data).unwrap();
    let (local, roaming) = ext_fixture(&base);
    let _cleanup = TempBase(base);

    let mut clotr = Stop(
        Command::new(env!("CARGO_BIN_EXE_clotr"))
            .env("CLOTR_DESKTOP_DATA", &data)
            .env("CLOTR_NETLOG", &netlog_file)
            .env("CLOTR_OPEN_MAIN", "1")
            .env("CLOTR_LOCALE", "en-US")
            .env("CLOTR_EXT_LOCALAPPDATA", &local)
            .env("CLOTR_EXT_APPDATA", &roaming)
            .spawn()
            .expect("Clotr starts"),
    );
    let pid = clotr.0.id();
    let net = watch_sockets(pid);
    let mut win = HWND::default();
    wait_for(15000, || {
        win = main_window(pid).unwrap_or_default();
        !win.is_invalid()
    })
    .expect("Clotr opens its main window");
    sleep(2500); // its page loads
    assert!(to_front(win), "the main window comes to the front");

    let (_u, results_link) = button(win, &["Results"]).expect("the sidebar's Results link");
    click(&results_link);

    // The fixture's plain extension reads ChatGPT: Extension check's headline counts it, and its card in the
    // can-read list names the browser it was found in.
    assert!(
        wait_for(5000, || text_of(win, "res-ext-headline").is_some_and(|t| !t.is_empty())).is_some(),
        "Extension check's headline fills in from the fixture profile"
    );
    let headline = text_of(win, "res-ext-headline").unwrap_or_default();
    println!("{headline:?}");
    assert!(headline.contains('1'), "one of the fixture's two extensions can read an AI site ({headline:?})");
    assert!(
        button(win, &["Reads ChatGPT"]).is_some(),
        "the extension that reads ChatGPT is named on the screen"
    );

    // "Show me where to remove it": Vivaldi isn't installed on this PC, so ext_reveal can't launch it and the
    // button falls back to the word steps rather than guessing a location.
    if let Some((_u2, remove)) = button(win, &["Show me where to remove it"]) {
        click(&remove);
        assert!(
            wait_for(5000, || button(win, &["Type chrome://extensions in the address bar and press Enter."])
                .is_some())
            .is_some(),
            "no installed Vivaldi to open falls back to the typed address, in words"
        );
        println!("no installed browser found; fell back to the word steps");
    }

    let _ = clotr.0.kill();
    let _ = clotr.0.wait();
    assert_net1("dk_extension_check", net, &netlog_file);
}

// ---------- History and Home update live ----------

#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_live_history() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let base = std::env::temp_dir().join(format!("clotr-dk11-{}", std::process::id()));
    let data = base.join("data");
    let netlog_file = base.join("netlog.json");
    std::fs::create_dir_all(&data).unwrap();
    let _cleanup = TempBase(base);
    let clotr = Command::new(env!("CARGO_BIN_EXE_clotr"))
        .env("CLOTR_DESKTOP_DATA", &data)
        .env("CLOTR_NETLOG", &netlog_file)
        .env("CLOTR_OPEN_MAIN", "1")
        .env("CLOTR_LOCALE", "en-US")
        .spawn()
        .expect("Clotr starts");
    let clotr_pid = clotr.id();
    let net = watch_sockets(clotr_pid);
    let ai = Command::new(env!("CARGO_BIN_EXE_clotr-dk-ai"))
        .spawn()
        .expect("the stand-in AI app starts");
    let run = Run {
        clotr,
        ai,
        saved_clip: clip_get(),
    };

    let mut win = HWND::default();
    wait_for(15000, || {
        win = main_window(clotr_pid).unwrap_or_default();
        !win.is_invalid()
    })
    .expect("Clotr opens its main window");
    sleep(2500); // its page loads

    // On History, before anything's recorded: the empty state shows (main.html's "Nothing yet.").
    assert!(to_front(win), "the main window comes to the front");
    let (_u, history_link) = button(win, &["History"]).expect("the History link");
    click(&history_link);
    assert!(
        wait_for(2000, || button(win, &["Nothing yet."]).is_some()).is_some(),
        "History starts empty"
    );

    // The stand-in AI app in front, a key copied, Clot this leak and paste clicked: the same path the trial test
    // drives, with the main window left exactly as it was (no click on it, no reopen) through the whole thing.
    let ai_window = {
        let mut h = HWND::default();
        wait_for(5000, || {
            h = unsafe { FindWindowW(w!("ClotrDkAi"), PCWSTR::null()) }.unwrap_or_default();
            !h.is_invalid()
        })
        .expect("the stand-in's window appears");
        h
    };
    assert!(to_front(ai_window), "the stand-in comes to the front");
    let card = {
        let mut c = None;
        wait_for(10000, || {
            c = card_window(clotr_pid);
            c.is_some()
        })
        .expect("Clotr makes its card's window when an AI app comes to the front");
        c.unwrap()
    };
    sleep(2500); // its page loads
    clip_set(&format!("here is my key {KEY} for the build"));
    assert!(
        wait_for(3000, || visible(card)).is_some(),
        "the card shows for the planted key"
    );
    let (_u2, hide) = button(card, &["Clot this leak", "Taponar esta fuga"])
        .expect("the card's Clot this leak button");
    click(&hide);

    // Without touching the main window again: its History (and, through the same view, Home's "This month" counts)
    // update the moment record() runs, through the "history" event (main.rs's record, main.js's `on("history", ...)`).
    assert!(
        wait_for(3000, || button(win, &["Nothing yet."]).is_none()).is_some(),
        "History updates live, with no reopening"
    );
    println!("History updated the moment it was recorded, no reopen");

    drop(run);
    let mut net = net;
    net.stop.store(true, Ordering::Relaxed);
    net.thread.take().unwrap().join().unwrap();
}

// ---------- Look back on a fixture export ----------

/// The Claude fixture export Node already proves against (`tests/desktop-lookback.test.js`,
/// `tests/fixtures/exports/expected.json`'s "claude" entry): a single `conversations.json`, so the one-file IPC path
/// `lookback_dk_fixture` hands through needs no folder or zip around it.
fn lookback_fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/exports/claude/conversations.json")
}

/// Opens Clotr's main window with `CLOTR_LOOKBACK_FIXTURE` set (dk-test-app only: `lookback_dk_fixture` in main.rs
/// hands back that file's bytes the moment "Choose my export" is clicked, the same substitution
/// `CLOTR_SCAN_ROOT` makes for "Run a quick scan"), already on the Scan screen.
fn open_on_lookback(data: &Path, netlog_file: &Path, fixture: &Path) -> (Stop, Watch, HWND) {
    let clotr = Stop(
        Command::new(env!("CARGO_BIN_EXE_clotr"))
            .env("CLOTR_DESKTOP_DATA", data)
            .env("CLOTR_NETLOG", netlog_file)
            .env("CLOTR_OPEN_MAIN", "1")
            .env("CLOTR_LOCALE", "en-US")
            .env("CLOTR_LOOKBACK_FIXTURE", fixture)
            .spawn()
            .expect("Clotr starts"),
    );
    let pid = clotr.0.id();
    let net = watch_sockets(pid);
    let mut win = HWND::default();
    wait_for(15000, || {
        win = main_window(pid).unwrap_or_default();
        !win.is_invalid()
    })
    .expect("Clotr opens its main window");
    sleep(2500); // its page loads
    assert!(to_front(win), "the main window comes to the front");
    let (_u, scan_link) = button(win, &["Scan"]).expect("the sidebar's Scan link");
    click(&scan_link);
    (clotr, net, win)
}

/// The Look back screen, read the way dk_tray_flyout drives the flyout and dk_quick_scan drives the Scan screen --
/// pick "Look back", pick the Claude tab, click "Choose my export" (the fixture's bytes come back through
/// `lookback_dk_fixture` instead of a real Open File dialog), and read what the Results screen shows against
/// tests/fixtures/exports/expected.json's "claude" entry (2 chats, both with finds, out of 2 read). No open socket
/// throughout.
#[test]
#[ignore = "drives the real desktop: npm run test:dk"]
fn dk_lookback() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let base = std::env::temp_dir().join(format!("clotr-dk13-{}", std::process::id()));
    let data = base.join("data");
    let netlog_file = base.join("netlog.json");
    std::fs::create_dir_all(&data).unwrap();
    let _cleanup = TempBase(base);

    let (mut clotr, net, win) = open_on_lookback(&data, &netlog_file, &lookback_fixture());

    let (_u, pick) = button(
        win,
        &[
            "Look back What you've already told ChatGPT, Claude or Gemini, from your own chat export.",
            "Look back",
        ],
    )
    .expect("the Scan screen's Look back pick");
    click(&pick);

    let (_u, claude_tab) = button(win, &["Claude"]).expect("the Look back card's Claude tab");
    click(&claude_tab);

    let (_u, choose) = button(win, &["Choose my export"]).expect("the Look back card's Choose my export button");
    click(&choose);

    assert!(
        button(win, &["Open another export"]).is_some(),
        "the read reaches a finished state (Open another export appears)"
    );
    sleep(300); // the last paint lands
    let heading = text_of(win, "lb-done-heading").unwrap_or_default();
    println!("{heading:?}");
    assert_eq!(heading, "Found in 2 of 2 chats", "the Claude fixture's 2 chats both held something");

    let (_u, see_found) = button(win, &["See what it found"]).expect("the done card's See what it found link");
    click(&see_found);

    sleep(300); // the Results screen paints
    let found = text_of(win, "res-chats-found").unwrap_or_default();
    let note = text_of(win, "res-chats-note").unwrap_or_default();
    println!("Results: {found:?}; {note:?}");
    assert_eq!(found, "Found in 2 of 2 chats", "the Results screen repeats the same count");
    assert!(note.contains("Claude"), "the note names the tool the export came from ({note:?})");

    let _ = clotr.0.kill();
    let _ = clotr.0.wait();
    assert_net1("dk_lookback", net, &netlog_file);
}
