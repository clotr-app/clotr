//! Clotr for Windows (the desktop trial): while an AI app is in front, what you copy is checked with
//! Clotr's own engine, and a card beside the app warns you before you paste a personal detail there. Clot this leak in
//! what you copied, or leave it alone. 100% local: no network code, a web view kept offline, nothing detected stored.
//!
//! The parts: watch.rs listens to Windows (the window in front, the clipboard), brain.rs decides when to check and
//! what the card does, clip.rs reads and writes the clipboard, card.rs places the card's window, store.rs is the one
//! writer, apps.rs knows the AI apps. The pages (ui/) run the engine and draw the card and the main window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(windows))]
compile_error!("Clotr for Windows builds on Windows only; a Mac build isn't planned yet.");

mod apps;
mod brain;
mod card;
mod clip;
mod extensions;
#[allow(dead_code)]
mod feature_gates;
#[cfg(feature = "one-clotr")]
mod install;
mod move_private;
#[cfg(feature = "one-clotr")]
mod one_clotr_pipe;
#[cfg(feature = "one-clotr")]
mod one_clotr_protocol;
mod paste;
mod program;
mod recycle;
mod scan;
mod skiplist;
mod startup;
mod status;
mod store;
mod surfaces;
mod typing;
mod watch;
mod webview;
mod words;

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, Rect, RunEvent, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

const LOG: &str = "[Clotr]";

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct Clotr {
    apps: Vec<apps::AiApp>,
    /// Every maker the built-in list names, whether or not an app currently claims it -- the safety net
    /// `front_of` checks once `apps::find` already came up empty.
    makers: Vec<apps::Maker>,
    terminals: Vec<apps::AiApp>,
    store: Mutex<store::Store>,
    brain: Mutex<brain::Brain>,
    locale: String,
    webview_dir: PathBuf,
    browser_args: String,
    card_ready: AtomicBool,
    pending: Mutex<Option<Value>>,
    size: Mutex<(f64, f64)>,
    chosen: Mutex<Vec<PathBuf>>,
    scan: Mutex<Option<Arc<scan::ScanRun>>>,
    /// *Move to the Recycle Bin*'s own undo (4-10): the trash item for each index recycled by the scan now on
    /// screen, cleared the moment a new one starts (the same index can't outlive the run it came from).
    recycled: Mutex<std::collections::HashMap<usize, trash::TrashItem>>,
    /// *Move it somewhere private*'s own undo: where each moved index came from and where it landed, cleared
    /// the moment a new scan starts, the same as `recycled`.
    moved: Mutex<std::collections::HashMap<usize, move_private::Moved>>,
    /// The folder *Move it somewhere private* picked last, by `move_pick_folder`, kept here rather than handed to
    /// the page: Results only ever sees the folder's own name, never its path.
    move_dest: Mutex<Option<PathBuf>>,
    /// Home's status (status.rs): false only when Clotr's copy check can't run at all. Nothing in the trial flips
    /// this yet; it's forced true for tests until a later piece wires a real trigger to it.
    running: AtomicBool,
    /// True once something from the last weekly check still waits for the person (status.rs's "look"), set in
    /// weekly_check_done and carried over a restart through the store's own lastWeeklyFind.
    worth_a_look: AtomicBool,
    /// When a timed pause (the tray flyout's "Pause for an hour") ends, in milliseconds since the epoch; None
    /// for an indefinite pause or no pause at all. Never written to disk: it starts over on a restart.
    paused_until: Mutex<Option<i64>>,
    /// The flyout's own real size, reported by flyout.js once its page has laid out; FLYOUT_GUESS until then.
    /// Used to place it (flyout_position) the same way on every open, not just the first.
    flyout_size: Mutex<(f64, f64)>,
    /// The tray icon's rect the flyout was last opened from, kept so `flyout_fit` can reposition it once the real
    /// size comes in, without Windows handing Clotr a fresh click.
    flyout_rect: Mutex<Option<FlyoutAnchor>>,
    /// The tray menu's own items, kept so their words can follow the pause and Settings' Language (`retell_tray`).
    /// None until `tray()` builds the menu.
    tray_items: Mutex<Option<TrayItems>>,
    /// Home's first-run line, which says Clotr doesn't start with Windows until it's switched on. True for
    /// the whole of the first start, so the line stays put once its switch is flipped, and false from then on.
    start_line: bool,
    /// One weekly check at a time: set the moment the scheduler starts one (before its hidden window even
    /// exists), cleared by `weekly_check_done` or, if that never comes, the watchdog in `start_weekly_check`.
    weekly_running: AtomicBool,
    /// The program in front right now, if it's signed by (or packaged under) a known AI maker but matched no app:
    /// its own file name and the maker's name, never a path. `None` once the front changes to anything else.
    /// Never written to disk -- it's read fresh on every foreground change.
    unmatched_maker: Mutex<Option<(String, String)>>,
    /// What the typing check just read, waiting for the card's page to take it (once): its check's number and the
    /// text. Replaced by the next read, emptied when the typing check stops. Never written anywhere.
    typed_text: Mutex<Option<(u32, String)>>,
    /// The typed checks' own numbers, from 2^31 up, so they never look like a clipboard sequence number.
    typed_seq: AtomicU32,
    /// The AI apps whose message box Clotr couldn't read this run, by id: Home and the flyout say so. Cleared for
    /// an app once its box is read again.
    blind: Mutex<Vec<String>>,
    /// The last moment `card_window` ran -- an AI app or terminal surface was in front, or a check needed the
    /// card -- so the idle watchdog (CARD_IDLE_DESTROY) only ever gives the card's hidden window's memory back
    /// once nothing has actually needed it for a good while, never mid-session just because it hasn't had to
    /// show itself. None until the card has ever been built.
    card_last_needed: Mutex<Option<std::time::Instant>>,
}

struct TrayItems {
    open: MenuItem<tauri::Wry>,
    pause: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

impl Clotr {
    /// The language every window and the tray speak right now: Settings' Language, or Windows' own.
    fn locale_now(&self) -> String {
        words::effective_locale(lock(&self.store).language().as_deref(), &self.locale)
    }

    /// The AI apps Home and the flyout count as covered: on this PC by their Store package, or seen in front.
    fn covered_apps(&self, store: &store::Store) -> Vec<&apps::AiApp> {
        let seen = store.seen_apps();
        self.apps
            .iter()
            .filter(|a| apps::covered(a, &mut program::package_installed, &seen))
            .collect()
    }

    fn app_ids(&self) -> Vec<String> {
        self.apps.iter().map(|a| a.id.clone()).collect()
    }

    fn paused_apps(&self, store: &store::Store) -> Vec<String> {
        self.apps
            .iter()
            .filter(|a| store.app_paused(&a.id))
            .map(|a| a.id.clone())
            .collect()
    }
}

// ---------- Where things live ----------

/// %LOCALAPPDATA%\Clotr\Desktop: this computer only (never the roaming profile), and a folder of its own that a
/// test can point at a test folder instead.
fn data_dir() -> PathBuf {
    #[cfg(feature = "dk-test-app")]
    if let Some(dir) = std::env::var_os("CLOTR_DESKTOP_DATA") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("Clotr").join("Desktop")
}

// ---------- The card ----------

/// How long nothing may need the card -- no AI app or terminal surface in front, no check pending -- before the
/// idle watchdog (in `main`'s setup) gives its hidden window's memory back: long enough that it never fires
/// mid-conversation just because nothing happened to need a check for a few minutes, short enough that the
/// memory doesn't sit unused for the rest of the day once someone's actually left every AI app.
/// CLOTR_CARD_IDLE_DESTROY_MS (dk-test-app only, never shipped): shortens this for a test that can't wait ten
/// real minutes to see the watchdog fire.
fn card_idle_destroy() -> std::time::Duration {
    #[cfg(feature = "dk-test-app")]
    if let Ok(ms) = std::env::var("CLOTR_CARD_IDLE_DESTROY_MS") {
        if let Ok(ms) = ms.parse() {
            return std::time::Duration::from_millis(ms);
        }
    }
    std::time::Duration::from_secs(600)
}

/// The card's window, made when the first AI app comes to the front (the web view starts then) and kept, until
/// the idle watchdog destroys a long-unneeded one and the next AI app in front builds it fresh again here, the
/// same way the very first one did. Windows are made on the main thread, so a call from elsewhere waits for it
/// there.
fn card_window(app: &AppHandle, c: &Arc<Clotr>) -> bool {
    *lock(&c.card_last_needed) = Some(std::time::Instant::now());
    if app.get_webview_window("card").is_some() {
        return true;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let (a, cc) = (app.clone(), c.clone());
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(make_card(&a, &cc));
        })
        .is_err()
    {
        return false;
    }
    rx.recv_timeout(std::time::Duration::from_secs(30)).unwrap_or(false)
}

fn make_card(app: &AppHandle, c: &Clotr) -> bool {
    if app.get_webview_window("card").is_some() {
        return true;
    }
    let Some(builder) = webview::window(app, &c.webview_dir, &c.browser_args, &c.locale, "card", "card.html") else {
        eprintln!("{LOG} the web view couldn't start");
        return false;
    };
    let built = builder
        .title("Clotr")
        .visible(false)
        .focused(false)
        .focusable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .inner_size(480.0, 720.0)
        .build();
    match built {
        Ok(w) => {
            if let Ok(h) = w.hwnd() {
                card::make_quiet(card::hwnd(h.0 as isize));
            }
            // Built hidden: let WebView2 trim it right away, the same as every other moment nobody's looking.
            webview::set_memory_target(&w, true);
            true
        }
        Err(_) => {
            eprintln!("{LOG} the card's window couldn't start");
            false
        }
    }
}

fn card_hwnd(app: &AppHandle) -> Option<isize> {
    app.get_webview_window("card")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
}

fn place_card(app: &AppHandle, c: &Clotr, beside: isize) -> bool {
    let Some(w) = app.get_webview_window("card") else {
        return false;
    };
    let Ok(card) = w.hwnd().map(|h| h.0 as isize) else {
        return false;
    };
    // Asked for first, so WebView2 is already working at full speed by the time the card is on screen.
    webview::set_memory_target(&w, false);
    let (width, height) = *lock(&c.size);
    let shown = card::show(card::hwnd(card), card::hwnd(beside), width, height);
    if shown {
        watch::post(watch::WM_SHORTCUT, 1);
        watch::follow_window(beside);
    }
    shown
}

fn hide_card(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("card") {
        if let Ok(h) = w.hwnd() {
            card::hide(card::hwnd(h.0 as isize));
        }
        // Hidden again until the next copy or typed check: let it go back to costing as little as it can.
        webview::set_memory_target(&w, true);
    }
    watch::post(watch::WM_SHORTCUT, 0);
    watch::follow_window(0);
}

fn act(app: &AppHandle, c: &Arc<Clotr>, todo: Vec<brain::Do>) {
    for d in todo {
        match d {
            brain::Do::Check { seq, app: id } => {
                let ask = json!({ "seq": seq, "app": id });
                if card_window(app, c) && c.card_ready.load(Ordering::SeqCst) {
                    let _ = app.emit_to("card", "clip", ask);
                } else {
                    *lock(&c.pending) = Some(ask);
                }
            }
            brain::Do::CheckSurface { seq, kind } => {
                let ask = json!({ "seq": seq, "surface": kind });
                if card_window(app, c) && c.card_ready.load(Ordering::SeqCst) {
                    let _ = app.emit_to("card", "clip", ask);
                } else {
                    *lock(&c.pending) = Some(ask);
                }
            }
            brain::Do::CheckTyped { seq, app: id } => {
                let ask = json!({ "seq": seq, "app": id, "typed": true });
                if card_window(app, c) && c.card_ready.load(Ordering::SeqCst) {
                    let _ = app.emit_to("card", "typed", ask);
                } else {
                    *lock(&c.pending) = Some(ask);
                }
            }
            brain::Do::TypingOn { hwnd } => typing::watch(program::real_owner(card::hwnd(hwnd)), hwnd),
            brain::Do::TypingOff => {
                typing::stop();
                *lock(&c.typed_text) = None;
            }
            // Answered to typing.rs directly, through TypingHost below.
            brain::Do::WatchBox | brain::Do::ReadBox => {}
            brain::Do::Show { hwnd } => {
                place_card(app, c, hwnd);
            }
            brain::Do::Hide => hide_card(app),
            brain::Do::Drop => {
                hide_card(app);
                *lock(&c.pending) = None;
                let _ = app.emit_to("card", "hide", ());
            }
        }
    }
}

// ---------- The typing check (typing.rs) ----------

/// typing.rs's questions, each answered by the brain, so the same rules that gate the clipboard gate the box.
struct TypingHost {
    app: AppHandle,
}

impl TypingHost {
    fn clotr(&self) -> Arc<Clotr> {
        self.app.state::<Arc<Clotr>>().inner().clone()
    }
}

impl typing::Host for TypingHost {
    fn may_watch(&self, hwnd: isize, shape: typing::Shape) -> bool {
        let shape = match shape {
            typing::Shape::Chat => brain::BoxShape::Chat,
            typing::Shape::Password => brain::BoxShape::Password,
            typing::Shape::NotChat | typing::Shape::Unreadable => brain::BoxShape::Other,
        };
        lock(&self.clotr().brain)
            .on_box(hwnd, shape)
            .contains(&brain::Do::WatchBox)
    }

    fn may_read(&self, hwnd: isize) -> bool {
        lock(&self.clotr().brain).on_typed(hwnd).contains(&brain::Do::ReadBox)
    }

    fn read(&self, hwnd: isize, text: String) {
        let c = self.clotr();
        let seq = c.typed_seq.fetch_add(1, Ordering::SeqCst);
        let todo = lock(&c.brain).typed(seq, hwnd, text.trim().is_empty());
        if todo.iter().any(|d| matches!(d, brain::Do::CheckTyped { .. })) {
            *lock(&c.typed_text) = Some((seq, text));
        }
        act(&self.app, &c, todo);
    }

    fn blind(&self, hwnd: isize, blind: bool) {
        let c = self.clotr();
        let Some(id) = lock(&c.brain).ai_at(hwnd) else { return };
        let changed = {
            let mut list = lock(&c.blind);
            let had = list.contains(&id);
            if blind && !had {
                list.push(id.clone());
            } else if !blind && had {
                list.retain(|a| a != &id);
            }
            had != blind
        };
        if changed {
            if blind {
                eprintln!("{LOG} the typing check can't read the box in {id}");
            }
            let _ = self.app.emit_to("main", "history", settings_view(&c));
        }
    }

    #[cfg(feature = "dk-test-app")]
    fn looked(&self, look: &typing::Look) {
        trace_typing(&format!("look {:?}", typing::shape_of(look)));
    }

    #[cfg(feature = "dk-test-app")]
    fn timed(&self, units: usize, _took: std::time::Duration) {
        trace_typing(&format!("read {units}"));
    }

    #[cfg(feature = "dk-test-app")]
    fn watching(&self, on: bool) {
        trace_typing(if on { "watch" } else { "unwatch" });
    }
}

/// CLOTR_TRACE_TYPING (dk-test-app only, never shipped): a line per look, subscription and read, appended to the
/// file it names, so the DK checks can see a password box was never subscribed to. A shape, a word and a length,
/// never the text.
#[cfg(feature = "dk-test-app")]
fn trace_typing(line: &str) {
    use std::io::Write;
    let Some(path) = std::env::var_os("CLOTR_TRACE_TYPING") else {
        return;
    };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// The names of the AI apps whose box Clotr couldn't read, for Home and the flyout.
fn blind_names(c: &Clotr) -> Vec<String> {
    let blind = lock(&c.blind);
    c.apps
        .iter()
        .filter(|a| blind.contains(&a.id))
        .map(|a| a.name.clone())
        .collect()
}

// ---------- What's in front ----------

/// CLOTR_TRACE_FRONT (dk-test-app only, never shipped): one line to stderr each time the window in front changes,
/// with exactly what `find` was given and settled on -- so a real app's own matching can be read without a
/// debugger. Asks the signer itself, past what `find`'s lazy closure needed, so the line is the same whether or not
/// a package family already decided it.
#[cfg(feature = "dk-test-app")]
fn trace_front(info: &program::Info, matched: Option<&str>) {
    use std::sync::OnceLock;
    static ON: OnceLock<bool> = OnceLock::new();
    if !*ON.get_or_init(|| std::env::var_os("CLOTR_TRACE_FRONT").is_some()) {
        return;
    }
    let by = program::signer(&info.exe_path);
    eprintln!(
        "{LOG} trace-front: exe={} family={} publisher={} id={}",
        info.exe_path,
        info.package_family.as_deref().unwrap_or("(none)"),
        by.as_deref().unwrap_or("(unsigned, or not asked)"),
        matched.unwrap_or("(no match)")
    );
}

/// An AI app Clotr just recognised in front counts as covered from now on, even with no Store package to find
/// (`apps::covered`). The main window hears about it the first time only, with the same view settings_hello gives.
fn note_seen(app: &AppHandle, c: &Clotr, id: &str) {
    let new = lock(&c.store).note_app_seen(id).unwrap_or(false);
    if new {
        let _ = app.emit_to("main", "history", settings_view(c));
    }
}

fn front_of(app: &AppHandle, c: &Clotr, h: isize) -> brain::Front {
    if h == 0 {
        return brain::Front::Other;
    }
    if card_hwnd(app) == Some(h) {
        return brain::Front::Card;
    }
    let hwnd = card::hwnd(h);
    if program::pid_of(hwnd) == std::process::id() {
        return brain::Front::Other; // Clotr's main window
    }
    let Some(info) = program::info(hwnd) else {
        return brain::Front::Other;
    };
    let program = apps::Program {
        exe_path: &info.exe_path,
        package_family: info.package_family.as_deref(),
    };
    let found = apps::find(&c.apps, &program, &mut || program::signer(&info.exe_path));
    // The safety net: a program signed by a known AI maker that matched no app, named on Home so this would have
    // said so about Codex on day one. With every built-in maker already claimed by an app, this mostly can't fire
    // for OpenAI or Anthropic any more -- it's here for a future maker entry added ahead of its product.
    *lock(&c.unmatched_maker) = if found.is_none() {
        apps::unmatched_maker_name(&c.makers, &program, &mut || program::signer(&info.exe_path))
    } else {
        None
    };
    #[cfg(feature = "dk-test-app")]
    trace_front(&info, found.map(|a| a.id.as_str()));
    if let Some(ai) = found {
        note_seen(app, c, &ai.id);
    }
    match found {
        Some(ai) => brain::Front::Ai(brain::FrontApp {
            hwnd: h,
            id: ai.id.clone(),
        }),
        None => match surfaces::find(
            &surfaces::Window {
                class: &program::class_of(hwnd),
                owner_exe: &info.exe_path,
                package_family: info.package_family.as_deref(),
            },
            &c.terminals,
            clip::owner_exe().as_deref(),
            &mut || program::signer(&info.exe_path),
        ) {
            Some(kind) => brain::Front::Surface(brain::FrontSurface {
                hwnd: h,
                kind: kind.to_string(),
            }),
            None => brain::Front::Other,
        },
    }
}

/// Whether the current clipboard copy belongs to a built-in AI app, using the same file, package and signer rules
/// that identify an AI app in front. The sequence checks keep a clipboard update during owner lookup from pairing
/// one copy with another copy's owner.
fn copied_in_ai_app(c: &Clotr, seq: u32) -> bool {
    if clip::sequence() != seq {
        return false;
    }
    let Some(owner) = clip::owner_info() else {
        return false;
    };
    if clip::sequence() != seq {
        return false;
    }
    let program = apps::Program {
        exe_path: &owner.exe_path,
        package_family: owner.package_family.as_deref(),
    };
    apps::find(&c.apps, &program, &mut || program::signer(&owner.exe_path)).is_some()
}

fn hear(app: &AppHandle, c: &Arc<Clotr>, heard: watch::Heard) {
    let todo = match heard {
        watch::Heard::Front(h) => {
            let front = front_of(app, c, h);
            if matches!(front, brain::Front::Ai(_) | brain::Front::Surface(_)) {
                card_window(app, c); // the web view starts when the first AI app or surface comes to the front
            }
            let seq = clip::sequence();
            let copied_in_ai_app = copied_in_ai_app(c, seq);
            lock(&c.brain).on_front_with_copy_origin(front, seq, copied_in_ai_app)
        }
        watch::Heard::Clipboard => {
            let seq = clip::sequence();
            let copied_in_ai_app = copied_in_ai_app(c, seq);
            lock(&c.brain).on_clipboard_with_copy_origin(seq, copied_in_ai_app)
        }
        watch::Heard::Moved(h) => {
            if lock(&c.brain).showing() == Some(h) {
                place_card(app, c, h);
            }
            vec![]
        }
        watch::Heard::Shortcut => {
            reach_card(app, c);
            vec![]
        }
    };
    act(app, c, todo);
}

/// Alt+Shift+C (held only while the card shows): the card takes the keyboard, on purpose. Esc gives it back.
fn reach_card(app: &AppHandle, c: &Clotr) {
    if lock(&c.brain).showing().is_none() {
        return;
    }
    let Some(w) = app.get_webview_window("card") else {
        return;
    };
    if let Ok(h) = w.hwnd() {
        let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(card::hwnd(h.0 as isize)) };
    }
    let _ = w.set_focus();
    let _ = app.emit_to("card", "reach", ());
}

/// Tells one window's page whether anyone can actually see it right now (tauri.js, theme.css): minimized or
/// hidden, a page's own CSS animations are the opposite of free, since AWAKE_ARGS keeps the whole web view
/// rendering at full rate no matter what Windows thinks of the window.
fn set_visible(app: &AppHandle, label: &str, visible: bool) {
    let _ = app.emit_to(label, "visible", visible);
}

// ---------- The card's commands (capabilities/card.json) ----------

fn only(window: &WebviewWindow, label: &str) -> Result<(), String> {
    (window.label() == label)
        .then_some(())
        .ok_or_else(|| "not-allowed".to_string())
}

#[tauri::command]
async fn card_hello(window: WebviewWindow, c: State<'_, Arc<Clotr>>) -> Result<Value, String> {
    only(&window, "card")?;
    c.card_ready.store(true, Ordering::SeqCst);
    let settings = lock(&c.store).settings();
    // Settings' Language when one was picked; the system's own as well, so the card can follow a later change of
    // Language from the "settings" event alone.
    Ok(json!({
        "settings": settings,
        "locale": c.locale_now(),
        "systemLocale": c.locale,
        "pending": lock(&c.pending).take(),
    }))
}

/// The copy being checked, while its AI app or surface is in front: its text, "private" (marked so by the app it
/// came from: not read), "nothing" (no text) or "stale" (another copy, or it isn't in front). Clotr keeps no copy
/// of it.
#[tauri::command]
async fn read_clip(window: WebviewWindow, c: State<'_, Arc<Clotr>>, seq: u32) -> Result<Value, String> {
    only(&window, "card")?;
    let brain = lock(&c.brain);
    if !brain.may_read(seq, clip::sequence()) {
        return Ok(json!({ "kind": "stale" }));
    }
    Ok(match clip::read(watch::window()) {
        clip::Clip::Text(text) => json!({ "kind": "text", "text": text }),
        clip::Clip::Private => json!({ "kind": "private" }),
        clip::Clip::Nothing => json!({ "kind": "nothing" }),
    })
}

#[tauri::command]
async fn show_card(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    app: AppHandle,
    seq: u32,
    width: f64,
    height: f64,
) -> Result<bool, String> {
    only(&window, "card")?;
    *lock(&c.size) = (width.clamp(200.0, 700.0), height.clamp(80.0, 1200.0));
    let focus = paste::capture_focus();
    let beside = lock(&c.brain).ready(seq, clip::sequence(), focus);
    Ok(match beside {
        Some(h) => place_card(&app, &c, h),
        None => false,
    })
}

#[tauri::command]
async fn resize_card(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    app: AppHandle,
    width: f64,
    height: f64,
) -> Result<(), String> {
    only(&window, "card")?;
    *lock(&c.size) = (width.clamp(200.0, 700.0), height.clamp(80.0, 1200.0));
    let beside = lock(&c.brain).showing();
    if let Some(h) = beside {
        place_card(&app, &c, h);
    }
    Ok(())
}

#[tauri::command]
async fn card_done(window: WebviewWindow, c: State<'_, Arc<Clotr>>, app: AppHandle, seq: u32) -> Result<(), String> {
    only(&window, "card")?;
    if lock(&c.brain).done(seq) {
        hide_card(&app);
    }
    Ok(())
}

/// Clot this leak: the safe version replaces the copy, if it's still the same copy with its AI app in
/// front. Clotr's own copy is never checked again.
#[tauri::command]
async fn hide_in_clipboard(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    seq: u32,
    text: String,
) -> Result<Value, String> {
    only(&window, "card")?;
    let mut brain = lock(&c.brain);
    if !brain.may_read(seq, clip::sequence()) {
        return Ok(json!({ "ok": false }));
    }
    match clip::write(watch::window(), &text) {
        Ok(new) => {
            brain.wrote(seq, new);
            Ok(json!({ "ok": true, "seq": new, "history": clip::history_on() }))
        }
        Err(_) => Ok(json!({ "ok": false })),
    }
}

/// What the typing check read for this typed check, taken once: `stale` if it's no longer this check's, or the
/// box's app isn't in front and watched. Clotr keeps no copy once the page has it.
#[tauri::command]
async fn read_typed(window: WebviewWindow, c: State<'_, Arc<Clotr>>, seq: u32) -> Result<Value, String> {
    only(&window, "card")?;
    let taken = lock(&c.typed_text).take_if(|(s, _)| *s == seq);
    let may = lock(&c.brain).may_read_typed(seq);
    Ok(match taken {
        Some((_, text)) if may => json!({ "kind": "text", "text": text }),
        _ => json!({ "kind": "stale" }),
    })
}

/// "Clot this leak and copy": the box read once more, now, for the page to swap the details for labels. Only for the
/// typed card on screen, its app in front and its box still watched.
#[tauri::command]
async fn read_box_again(window: WebviewWindow, c: State<'_, Arc<Clotr>>, seq: u32) -> Result<Value, String> {
    only(&window, "card")?;
    if !lock(&c.brain).may_read_typed(seq) {
        return Ok(json!({ "kind": "stale" }));
    }
    Ok(match typing::read_now() {
        Some(text) => json!({ "kind": "text", "text": text }),
        None => json!({ "kind": "nothing" }),
    })
}

/// "Clot this leak and copy", second half: the safe text on the clipboard, never checked as a copy. Clotr never
/// writes into the box itself; the card tells the person to paste over their message.
#[tauri::command]
async fn copy_safe(window: WebviewWindow, c: State<'_, Arc<Clotr>>, seq: u32, text: String) -> Result<Value, String> {
    only(&window, "card")?;
    let mut brain = lock(&c.brain);
    if !brain.may_read_typed(seq) {
        return Ok(json!({ "ok": false }));
    }
    match clip::write(watch::window(), &text) {
        Ok(new) => {
            brain.wrote_typed(new);
            Ok(json!({ "ok": true, "history": clip::history_on() }))
        }
        Err(_) => Ok(json!({ "ok": false })),
    }
}

/// The first typed card carried its one-line note; it isn't shown again.
#[tauri::command]
async fn typed_note_seen(window: WebviewWindow, c: State<'_, Arc<Clotr>>) -> Result<(), String> {
    only(&window, "card")?;
    lock(&c.store)
        .set_typed_note_seen()
        .map_err(|_| "not-saved".to_string())
}

/// "Ask someone first" on *Is this a scam?*, the main window's own result (not a card, and not something Clotr
/// read a clipboard copy to get to): a plain clipboard write of the note extension/ask-someone.js built, with
/// none of hide_in_clipboard's sequence tracking, since there's no pending clipboard read on this window to
/// keep in step with. The note is fixed text built from sign names only, never a value.
#[tauri::command]
async fn copy_note(window: WebviewWindow, text: String) -> Result<bool, String> {
    only(&window, "main")?;
    Ok(clip::write(watch::window(), &text).is_ok())
}

/// Paste it, with a real Ctrl+V: only into the text box the card first appeared over, and only if that box still
/// has the keyboard. Clotr never brings anything to the front for this (the AI app already has it); if the check
/// fails, the text stays on the clipboard and the card says so instead.
#[tauri::command]
async fn paste_clip(window: WebviewWindow, c: State<'_, Arc<Clotr>>, seq: u32) -> Result<bool, String> {
    only(&window, "card")?;
    let focus = paste::capture_focus();
    let may = focus
        .as_ref()
        .is_some_and(|f| lock(&c.brain).may_paste(seq, clip::sequence(), f));
    let Some(focus) = focus.filter(|_| may) else {
        return Ok(false);
    };
    Ok(paste::send_if_focus_unchanged(
        &focus,
        paste::capture_focus,
        paste::send_ctrl_v,
    ))
}

/// Recorded elsewhere (a card, on whatever AI app the person's in), so the main window's History and Home counts
/// update the moment it happens, not the next time it's opened: the same view `settings_hello` would hand
/// back, emitted to "main" so main.js's `show` redraws both from it, no reopening needed.
#[tauri::command]
async fn record(
    window: WebviewWindow,
    app: AppHandle,
    c: State<'_, Arc<Clotr>>,
    events: Value,
) -> Result<usize, String> {
    only(&window, "card")?;
    let n = lock(&c.store)
        .record(&events, &c.app_ids())
        .map_err(|_| "not-saved".to_string())?;
    if n > 0 {
        let _ = app.emit_to("main", "history", settings_view(&c));
    }
    Ok(n)
}

/// A finished scan or Look back read, from the main window alone (a scan never runs behind the card): one row
/// for History's scan list, with the fresh view back so it can redraw without asking again.
#[tauri::command]
async fn record_scan(window: WebviewWindow, c: State<'_, Arc<Clotr>>, row: Value) -> Result<Value, String> {
    only(&window, "main")?;
    lock(&c.store).record_scan(&row).map_err(|_| "not-saved".to_string())?;
    Ok(settings_view(&c))
}

#[tauri::command]
async fn set_responses(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    app: AppHandle,
    kinds: Value,
    response: String,
) -> Result<usize, String> {
    if window.label() != "card" && window.label() != "main" {
        return Err("not-allowed".into());
    }
    let n = lock(&c.store)
        .set_responses(&kinds, &response)
        .map_err(|_| "not-saved".to_string())?;
    tell_settings(&app, &c);
    Ok(n)
}

#[tauri::command]
async fn back_to_app(window: WebviewWindow, c: State<'_, Arc<Clotr>>) -> Result<(), String> {
    only(&window, "card")?;
    let hwnd = lock(&c.brain).front_hwnd();
    if let Some(hwnd) = hwnd {
        let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(card::hwnd(hwnd)) };
    }
    Ok(())
}

/// "Wrong? Report a false alarm": a prefilled issue on Clotr's own repository (kinds only, never a detail), opened
/// in the person's browser. Any other address is refused.
pub fn report_link_ok(url: &str) -> bool {
    const START: &str = "https://github.com/clotr-app/clotr/issues/new?template=false-alarm.yml&title=";
    let Some(rest) = url.strip_prefix(START) else {
        return false;
    };
    url.len() < 1000
        && url.bytes().all(|b| b.is_ascii_graphic())
        && !decoded(rest).chars().any(|ch| ch.is_ascii_digit())
}

/// %XX escapes back to the text they stand for (what the link would show), as far as they read.
fn decoded(part: &str) -> String {
    let bytes = part.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(a), Some(b)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((a * 16 + b) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
async fn open_report(window: WebviewWindow, url: String) -> Result<bool, String> {
    only(&window, "card")?;
    if !report_link_ok(&url) {
        return Ok(false);
    }
    let wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        windows::Win32::UI::Shell::ShellExecuteW(
            None,
            windows::core::w!("open"),
            windows::core::PCWSTR(wide.as_ptr()),
            None,
            None,
            windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        );
    }
    Ok(true)
}

/// "Open the chat" (Look back): the same shape `chatLinkOk()` checks in lookback-core.js, so
/// Clotr for Windows opens only a real chat address, never an id or a title an export's own JSON could carry a
/// hostile one of, before `ShellExecuteW`. The shared cases both sides must agree on live in
/// tests/fixtures/chat-link-cases.json. `lookback_link_ok` wraps this for the one command both "Open the
/// chat" and the step pages share.
pub fn chat_link_ok(url: &str) -> bool {
    const GEMINI_URL: &str = "https://myactivity.google.com/product/gemini";
    if url == GEMINI_URL {
        return true;
    }
    for prefix in ["https://chatgpt.com/c/", "https://claude.ai/chat/"] {
        if let Some(id) = url.strip_prefix(prefix) {
            if is_uuid(id) {
                return true;
            }
        }
    }
    false
}

/// `########-####-####-####-############` in hex, case-insensitive (lookback-core.js's UUID_RE). `url` already
/// carries nothing past the id (chat_link_ok checks the whole remaining string), so no `$` anchor is needed here.
fn is_uuid(s: &str) -> bool {
    let bytes = s.as_bytes();
    let groups: [usize; 5] = [8, 4, 4, 4, 12];
    let mut i = 0;
    for (g, len) in groups.iter().enumerate() {
        for _ in 0..*len {
            if !bytes.get(i).is_some_and(u8::is_ascii_hexdigit) {
                return false;
            }
            i += 1;
        }
        if g < groups.len() - 1 {
            if bytes.get(i) != Some(&b'-') {
                return false;
            }
            i += 1;
        }
    }
    i == bytes.len()
}

// ---------- Look back ----------

/// The fixed addresses "Open ChatGPT", "Open Claude", "Open Google Takeout", their help pages, and
/// each company's own privacy-request page ever open: never built from anything the export or the page
/// sends, the same shape as `report_link_ok`'s own fixed start.
const LOOKBACK_TOOL_LINKS: [&str; 8] = [
    "https://chatgpt.com/",
    "https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data",
    "https://privacy.openai.com",
    "https://claude.ai/",
    "https://privacy.claude.com/en/articles/9450526-export-your-claude-data",
    "https://takeout.google.com/",
    "https://support.google.com/gemini/answer/16920332",
    "https://support.google.com/legal/troubleshooter/1114905",
];

/// Everything the Look back screen is allowed to open: a real chat address (`chat_link_ok`) or one of the fixed
/// company pages above. Nothing else, however an export's own JSON or a hostile id might try to shape it.
pub fn lookback_link_ok(url: &str) -> bool {
    chat_link_ok(url) || LOOKBACK_TOOL_LINKS.contains(&url)
}

#[tauri::command]
async fn open_lookback_link(window: WebviewWindow, url: String) -> Result<bool, String> {
    only(&window, "main")?;
    if !lookback_link_ok(&url) {
        return Ok(false);
    }
    let wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        windows::Win32::UI::Shell::ShellExecuteW(
            None,
            windows::core::w!("open"),
            windows::core::PCWSTR(wide.as_ptr()),
            None,
            None,
            windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        );
    }
    Ok(true)
}

/// Where "Get the browser extension" goes: the site's own extension page, which links every browser's store. Fixed
/// here, so the page never says where to go.
const EXTENSION_PAGE: &str = "https://clotr.app/extension.html";

/// Home's and Protection's "Get the browser extension", in the browser the person normally uses. Clotr for Windows
/// covers only the AI apps on this PC, so this is how someone using an AI site in a browser gets covered too.
#[tauri::command]
async fn open_extension_page(window: WebviewWindow) -> Result<bool, String> {
    only(&window, "main")?;
    let wide: Vec<u16> = EXTENSION_PAGE.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        windows::Win32::UI::Shell::ShellExecuteW(
            None,
            windows::core::w!("open"),
            windows::core::PCWSTR(wide.as_ptr()),
            None,
            None,
            windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        );
    }
    Ok(true)
}

/// Testing only: hands back a fixture export's bytes directly (the same ArrayBuffer shape the web view's own file
/// input would), so a test can drive "Choose my export" without automating Windows' real Open File dialog. A
/// real build (no `dk-test-app` feature) always refuses; a dk-test-app build with no `CLOTR_LOOKBACK_FIXTURE` set
/// refuses too. Rust still never parses an export: this only ever hands through the bytes of the one fixed
/// path a test named, exactly as `scan_next` hands through a counted file's bytes.
#[tauri::command]
async fn lookback_dk_fixture(window: WebviewWindow) -> Result<tauri::ipc::Response, String> {
    only(&window, "main")?;
    #[cfg(feature = "dk-test-app")]
    {
        let path = std::env::var("CLOTR_LOOKBACK_FIXTURE").map_err(|_| "not-allowed".to_string())?;
        let bytes = std::fs::read(&path).map_err(|_| "not-read".to_string())?;
        return Ok(tauri::ipc::Response::new(bytes));
    }
    #[cfg(not(feature = "dk-test-app"))]
    Err("not-allowed".to_string())
}

// ---------- The main window's commands (capabilities/main.json) ----------

fn tell_settings(app: &AppHandle, c: &Clotr) {
    let settings = lock(&c.store).settings();
    let _ = app.emit_to("card", "settings", settings.clone());
    let _ = app.emit_to("main", "settings", settings);
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// A timed pause lifts itself once its hour is up, the moment anything next asks Clotr for its state (the one-shot
/// timer in pause_for_hour does the same the moment it wakes; this is the fallback if the PC was asleep).
fn expire_pause(c: &Clotr) {
    let due = {
        let until = lock(&c.paused_until);
        matches!(*until, Some(ms) if now_ms() >= ms)
    };
    if due {
        *lock(&c.paused_until) = None;
        let _ = lock(&c.store).set_paused_all(false);
    }
}

/// Home's status (status.rs), given whether Clotr is paused right now: the one place that turns the Clotr struct's
/// own bits (running, worth_a_look) plus the store's paused flag into the word Home, the flyout and the tray agree
/// on.
fn current_status(c: &Clotr, paused: bool) -> status::Status {
    status::status(status::StatusInput {
        watching: c.running.load(Ordering::SeqCst),
        paused,
        worth_a_look: c.worth_a_look.load(Ordering::SeqCst),
    })
}

/// The version the Store listing and this build agree on (tauri.conf.json's own, which Cargo.toml mirrors):
/// Cargo sets this at compile time, so there's no second read that could ever drift from it.
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Windows' own "ProductName" plus "DisplayVersion" (e.g. "Windows 11 Pro, 23H2"), pure so a build without a
/// display version, or without either, is still worded sensibly -- the registry read itself is windows_version_string.
fn format_windows_version(product: Option<String>, display: Option<String>) -> String {
    let product = product.unwrap_or_else(|| "Windows".to_string());
    match display {
        Some(v) if !v.is_empty() => format!("{product}, {v}"),
        _ => product,
    }
}

/// Read straight from the registry, the same place Windows' own Settings app reads "About" from, so "Report a
/// problem" names the same Windows a person would read there. A read that fails just leaves the word that
/// didn't come back out, never a guess.
fn windows_version_string() -> String {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    fn read(name: &str) -> Option<String> {
        let key: Vec<u16> = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let mut buf = vec![0u16; 256];
        let mut size = (buf.len() * 2) as u32;
        let got = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                PCWSTR(key.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr() as *mut _),
                Some(&mut size),
            )
        };
        if got.is_err() {
            return None;
        }
        let len = (size as usize / 2).saturating_sub(1).min(buf.len());
        let value = String::from_utf16_lossy(&buf[..len]);
        (!value.is_empty()).then_some(value)
    }
    format_windows_version(read("ProductName"), read("DisplayVersion"))
}

fn settings_view(c: &Clotr) -> Value {
    expire_pause(c);
    let store = lock(&c.store);
    let covered: Vec<&str> = c.covered_apps(&store).iter().map(|a| a.id.as_str()).collect();
    // Every app on the list, each marked covered or not, so Protection can say "Not installed" for the rest.
    let apps: Vec<Value> = c
        .apps
        .iter()
        .map(|a| json!({ "id": a.id, "name": a.name, "covered": covered.contains(&a.id.as_str()) }))
        .collect();
    let paused = store.paused_all();
    let unmatched_maker = lock(&c.unmatched_maker)
        .as_ref()
        .map(|(file, maker)| json!({ "file": file, "maker": maker }));
    json!({
        "settings": store.settings(),
        "events": store.events(),
        "scans": store.scans(),
        "fullScan": full_scan_view(&store),
        "apps": apps,
        "locale": c.locale,
        "paused": paused,
        "status": current_status(c, paused).as_str(),
        "pausedUntil": *lock(&c.paused_until),
        "startupTaskState": startup::state().as_str(),
        "startLine": c.start_line,
        "scanExcluded": store.exclusions_view(),
        "accuracy": store.accuracy_answers(),
        "unmatchedMaker": unmatched_maker,
        "typingBlind": blind_names(c),
        "appVersion": app_version(),
        "osVersion": windows_version_string(),
    })
}

#[tauri::command]
async fn settings_hello(window: WebviewWindow, c: State<'_, Arc<Clotr>>) -> Result<Value, String> {
    only(&window, "main")?;
    Ok(settings_view(&c))
}

#[tauri::command]
#[cfg(feature = "one-clotr")]
async fn one_clotr_status(window: WebviewWindow) -> Result<Value, String> {
    only(&window, "main")?;
    Ok(one_clotr_protocol::connection_status())
}

#[tauri::command]
#[cfg(feature = "one-clotr")]
async fn one_clotr_consent(window: WebviewWindow, accepted: bool) -> Result<Value, String> {
    only(&window, "main")?;
    one_clotr_protocol::set_consent(accepted);
    if accepted {
        install::register_for_current_user();
    }
    Ok(one_clotr_protocol::connection_status())
}

#[tauri::command]
#[cfg(feature = "one-clotr")]
async fn one_clotr_disconnect(window: WebviewWindow) -> Result<Value, String> {
    only(&window, "main")?;
    one_clotr_protocol::disconnect();
    install::unregister_for_current_user();
    Ok(one_clotr_protocol::connection_status())
}

/// The flyout's own narrow hello: the status and how many AI apps are checked, never the apps' names or any
/// history (the main window's settings_hello carries that, for the main window alone).
#[tauri::command]
async fn flyout_hello(window: WebviewWindow, c: State<'_, Arc<Clotr>>) -> Result<Value, String> {
    only(&window, "flyout")?;
    expire_pause(&c);
    let store = lock(&c.store);
    let paused = store.paused_all();
    let covered = c.covered_apps(&store);
    let checked = covered.iter().filter(|a| !store.app_paused(&a.id)).count();
    let language = store.language();
    Ok(json!({
        "locale": words::effective_locale(language.as_deref(), &c.locale),
        "look": store.settings().get("look").and_then(Value::as_str).unwrap_or("system"),
        "status": current_status(&c, paused).as_str(),
        "checked": checked,
        "covered": covered.len(),
        "paused": paused,
        // Only a timed pause (this flyout's own button) has a when; Home's plain "Turn it back on" doesn't --
        // the flyout still says "Resume now" either way, just without the "until" words.
        "pausedUntil": *lock(&c.paused_until),
        "typingBlind": blind_names(&c),
    }))
}

fn apply_pause(app: &AppHandle, c: &Arc<Clotr>) {
    let (paused, apps) = {
        let store = lock(&c.store);
        (store.paused_all(), c.paused_apps(&store))
    };
    let todo = lock(&c.brain).set_paused(paused, apps);
    act(app, c, todo);
    let typing = lock(&c.store).typing_check();
    let todo = lock(&c.brain).set_typing(typing);
    act(app, c, todo);
}

#[tauri::command]
async fn save_settings(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    app: AppHandle,
    mut settings: Value,
) -> Result<Value, String> {
    only(&window, "main")?;
    // Settings asked Windows to start Clotr with it or not; what actually happens is what gets stored, since
    // Task Manager or a policy can hold the task off no matter what was asked (startup::request's own doc).
    if let Some(ask) = settings.get("startWithWindows").and_then(Value::as_bool) {
        let real = startup::request(ask).enabled();
        settings["startWithWindows"] = json!(real);
    }
    lock(&c.store)
        .save_settings(&settings, store::From::Settings)
        .map_err(|_| "not-saved".to_string())?;
    apply_pause(&app, &c);
    tell_settings(&app, &c);
    // Settings' Language may have just changed, and the tray has no page of its own to follow it.
    retell_tray(&app, &c);
    Ok(settings_view(&c))
}

#[tauri::command]
async fn import_settings(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    app: AppHandle,
    settings: Value,
) -> Result<Value, String> {
    only(&window, "main")?;
    let before = lock(&c.store).settings();
    lock(&c.store)
        .save_settings(&settings, store::From::MoveFile)
        .map_err(|_| "not-saved".to_string())?;
    let after = lock(&c.store).settings();
    apply_pause(&app, &c);
    tell_settings(&app, &c);
    // Settings' Language may have just changed, and the tray has no page of its own to follow it.
    retell_tray(&app, &c);
    let mut view = settings_view(&c);
    // What the move file actually changed, in counts and names, for the settings page's own success message.
    if let Some(obj) = view.as_object_mut() {
        obj.insert("brought".into(), store::brought_summary(&before, &after));
    }
    Ok(view)
}

#[tauri::command]
async fn clear_history(window: WebviewWindow, c: State<'_, Arc<Clotr>>) -> Result<Value, String> {
    only(&window, "main")?;
    lock(&c.store).clear_history().map_err(|_| "not-saved".to_string())?;
    Ok(settings_view(&c))
}

/// *Show them again*, in Settings: clears the whole ignored list, so every file a scan was ever told to skip
/// gets counted the next time.
#[tauri::command]
async fn clear_scan_ignored(window: WebviewWindow, c: State<'_, Arc<Clotr>>) -> Result<Value, String> {
    only(&window, "main")?;
    lock(&c.store)
        .clear_scan_ignored()
        .map_err(|_| "not-saved".to_string())?;
    Ok(settings_view(&c))
}

/// *Was this right?* on a file in Results or the workbench: never the file, its name, its place or the
/// value, only the kind of detail and which of the four place tiers it was in.
#[tauri::command]
async fn accuracy_answer(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    kind: String,
    tier: String,
    yes: bool,
) -> Result<Value, String> {
    only(&window, "main")?;
    lock(&c.store)
        .record_accuracy_answer(&kind, &tier, yes)
        .map_err(|_| "not-saved".to_string())?;
    Ok(settings_view(&c))
}

/// Settings' own *Clear* beside Accuracy answers.
#[tauri::command]
async fn clear_accuracy_answers(window: WebviewWindow, c: State<'_, Arc<Clotr>>) -> Result<Value, String> {
    only(&window, "main")?;
    lock(&c.store)
        .clear_accuracy_answers()
        .map_err(|_| "not-saved".to_string())?;
    Ok(settings_view(&c))
}

// ---------- Leave out of scans: kept in Rust, shown to the page by name and parent only ----------

/// Settings' *Add a folder* and *Add a file*: Windows' own picker, each pick kept in the store by its path (the person
/// chose it). The page hears back only the settings view, whose list names each one and its parent.
#[tauri::command]
async fn scan_exclude_pick(
    window: WebviewWindow,
    app: AppHandle,
    c: State<'_, Arc<Clotr>>,
    kind: String,
) -> Result<Value, String> {
    only(&window, "main")?;
    let picked = match kind.as_str() {
        "folder" => app.dialog().file().blocking_pick_folders(),
        "file" => app.dialog().file().blocking_pick_files(),
        _ => return Err("not-allowed".to_string()),
    };
    let paths: Vec<PathBuf> = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .collect();
    {
        let mut store = lock(&c.store);
        for path in paths {
            store
                .add_exclusion(&kind, &path.to_string_lossy())
                .map_err(|_| "not-saved".to_string())?;
        }
    }
    Ok(settings_view(&c))
}

/// Settings' *Add a type*: ".log", "csv" and the like (the store checks it's a dot and letters or digits).
#[tauri::command]
async fn scan_exclude_type(window: WebviewWindow, c: State<'_, Arc<Clotr>>, ext: String) -> Result<Value, String> {
    only(&window, "main")?;
    let added = lock(&c.store)
        .add_exclusion("type", &ext)
        .map_err(|_| "not-saved".to_string())?;
    added.ok_or_else(|| "not-allowed".to_string())?;
    Ok(settings_view(&c))
}

/// *Leave this folder out* and *Leave files like this out*, on a file the last scan handed over: by its index,
/// never a path from the page. Hands back the new entry's id (for Undo) and its name and parent.
#[tauri::command]
async fn scan_exclude_from(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    index: usize,
    generation: u64,
    what: String,
) -> Result<Value, String> {
    only(&window, "main")?;
    let (kind, value) = {
        let run = scan_for_generation(&c, generation)?;
        run.exclusion_for(index, &what)
            .ok_or_else(|| "not-allowed".to_string())?
    };
    let id = lock(&c.store)
        .add_exclusion(kind, &value)
        .map_err(|_| "not-saved".to_string())?
        .ok_or_else(|| "not-allowed".to_string())?;
    let (name, parent) = if kind == "type" {
        (format!(".{}", value.trim_start_matches('.')), String::new())
    } else {
        store::name_and_parent(Path::new(&value))
    };
    Ok(json!({ "id": id, "kind": kind, "name": name, "parent": parent }))
}

/// Settings' *Remove* on one entry, and *Undo* right after a Leave out on a Results card.
#[tauri::command]
async fn scan_unexclude(window: WebviewWindow, c: State<'_, Arc<Clotr>>, id: String) -> Result<Value, String> {
    only(&window, "main")?;
    lock(&c.store)
        .remove_exclusion(&id)
        .map_err(|_| "not-saved".to_string())?;
    Ok(settings_view(&c))
}

// ---------- Check my files: the page never sees a path ----------

/// Windows' own folder picker, for "Folders I choose". Only the chosen folders' own names go back to the page;
/// their paths stay here, kept for the "chosen" scan that follows.
#[tauri::command]
async fn scan_pick_folders(
    window: WebviewWindow,
    app: AppHandle,
    c: State<'_, Arc<Clotr>>,
) -> Result<Vec<String>, String> {
    only(&window, "main")?;
    let Some(picked) = app.dialog().file().blocking_pick_folders() else {
        return Ok(vec![]);
    };
    let mut names = Vec::new();
    let mut paths = Vec::new();
    for p in picked {
        if let Ok(path) = p.into_path() {
            names.push(
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            );
            paths.push(path);
        }
    }
    *lock(&c.chosen) = paths;
    Ok(names)
}

/// When the last Full scan finished and how many files it kept, for Settings and the Scan screen; null before
/// the first one (or once History was cleared).
fn full_scan_view(store: &store::Store) -> Value {
    match store.baseline_summary() {
        Some((at, files)) => json!({ "at": at, "files": files }),
        None => Value::Null,
    }
}

/// Starts a scan of `kind` ("quick", "full" or "chosen") and hands back only whether a Full scan has run yet: the
/// files themselves come from `scan_batch`, a batch at a time, by index, never a path. Quick reads Downloads,
/// Desktop, Documents and Pictures with code projects left out, and only what's new or changed there once a Full
/// scan has run; Full reads every fixed drive but Windows' own folders; Chosen reads the folders from Windows' own
/// picker.
/// Clotr's own data folder is never read, whatever the kind.
#[tauri::command]
async fn scan_start(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    kind: String,
    again: Option<bool>,
) -> Result<Value, String> {
    only(&window, "main")?;
    // Testing only: CLOTR_SCAN_ROOT points every kind at one fixture folder, so a check is deterministic on
    // whatever PC runs it; CLOTR_SCAN_DRIVES and CLOTR_SCAN_FLOOR stand in for the fixed drives and Quick's floor.
    #[cfg(feature = "dk-test-app")]
    let test_dir = |name: &str| std::env::var_os(name).map(PathBuf::from);
    #[cfg(not(feature = "dk-test-app"))]
    let test_dir = |_: &str| None::<PathBuf>;
    let drives = || {
        test_dir("CLOTR_SCAN_DRIVES")
            .map(|d| vec![d])
            .unwrap_or_else(scan::fixed_drives)
    };
    let floor = || {
        test_dir("CLOTR_SCAN_FLOOR")
            .map(|d| vec![(d, "downloads".to_string())])
            .unwrap_or_else(scan::floor)
    };
    let (ctx, baseline, full_scan, dev) = {
        let store = lock(&c.store);
        let ctx = scan::PlanCtx {
            salt: store.scan_salt(),
            // Ignore: a file is only ever left out here, by its own fingerprint, never remembered as "clean" or
            // carried as a path.
            ignored: Arc::new(store.ignored_files()),
            // Leave out of scans: the folders, files and types the person chose, in Settings or on a Results card.
            excluded: Arc::new(store.exclusions()),
            skip: vec![data_dir(), c.webview_dir.clone()],
            personal: scan::personal_places(),
            places: scan::floor(),
            home: scan::home(),
        };
        // A later Full scan reads only what's new or changed, like Quick, unless the person chose to read
        // everything again.
        let baseline = match kind.as_str() {
            "quick" => store.baseline().map(Arc::new),
            "full" if again != Some(true) => store.baseline().map(Arc::new),
            _ => None,
        };
        // The developer switch, off unless turned on: code projects and secret files in Quick and Full both.
        let dev = store.settings().get("scanDevFiles") == Some(&Value::Bool(true));
        (ctx, baseline, full_scan_view(&store), dev)
    };
    // A run that reads only what changed says so, with when the record it goes by was made.
    let mut since = baseline.as_ref().map(|b| b.at);
    let plan = match (kind.as_str(), test_dir("CLOTR_SCAN_ROOT")) {
        (_, Some(root)) => {
            since = None;
            scan::Plan::chosen(scan::chosen_roots(&[root]), ctx)
        }
        ("quick", None) => scan::Plan::quick(floor(), baseline, !dev, dev, ctx),
        ("full", None) => scan::Plan::full(drives(), baseline, dev, ctx),
        ("chosen", None) => scan::Plan::chosen(scan::chosen_roots(&lock(&c.chosen)), ctx),
        _ => return Err("not-allowed".to_string()),
    };
    // The run before this one stops (its walks halt the moment it's dropped) and its indices are gone.
    let run = Arc::new(scan::ScanRun::start(plan));
    let generation = run.generation();
    *lock(&c.scan) = Some(run);
    // A new scan's indices start over, so yesterday's recycled or moved files can't be confused with today's.
    lock(&c.recycled).clear();
    lock(&c.moved).clear();
    Ok(json!({ "fullScan": full_scan, "since": since, "generation": generation }))
}

/// The next files the walk found, up to a batch, with what it has skipped so far and the counting walk's total.
/// `settled` names the files the page has finished checking since it last asked, and `keep` the ones among them it
/// still needs (finds, and files it couldn't read); every other settled file is let go, so a scan of a whole drive
/// never holds more than a couple of batches of paths.
#[tauri::command]
async fn scan_batch(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    settled: Vec<usize>,
    keep: Vec<usize>,
) -> Result<Value, String> {
    only(&window, "main")?;
    let run = lock(&c.scan).clone().ok_or_else(|| "not-allowed".to_string())?;
    let wait = std::time::Duration::from_millis(250);
    let batch = tauri::async_runtime::spawn_blocking(move || run.batch(&settled, &keep, wait))
        .await
        .map_err(|_| "not-allowed".to_string())?;
    let batch = batch.map_err(str::to_string)?;
    serde_json::to_value(batch).map_err(|_| "not-allowed".to_string())
}

/// The page read every file the walk handed over (`completed`), or stopped early. A Full scan that got through
/// every drive leaves its record here for the next Quick or Full one, without the files named in `unread`, and with
/// the ones in `flagged` (worth a look this time) carrying that bit forward.
#[tauri::command]
async fn scan_end(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    completed: bool,
    unread: Vec<usize>,
    flagged: Vec<usize>,
) -> Result<Value, String> {
    only(&window, "main")?;
    let run = lock(&c.scan).clone();
    if let (true, Some(run)) = (completed, run) {
        if let Some(records) = run.full_record(&unread, &flagged) {
            let baseline = store::Baseline::new(now_ms().max(0) as u64, records);
            lock(&c.store)
                .save_baseline(&baseline)
                .map_err(|_| "not-saved".to_string())?;
        }
    }
    Ok(json!({ "fullScan": full_scan_view(&lock(&c.store)) }))
}

/// A file's bytes, by the index `scan_batch` handed it over under (never a path from the page). Fails soft: an
/// unreadable file comes back as "locked" (4.3), never silently empty or "clean" -- the walker already found it,
/// so a read failing here almost always means another program has it open.
#[tauri::command]
async fn scan_next(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    index: usize,
) -> Result<tauri::ipc::Response, String> {
    only(&window, "main")?;
    let run = lock(&c.scan).clone().ok_or_else(|| "not-allowed".to_string())?;
    match run.read(index) {
        Some(Ok(bytes)) => Ok(tauri::ipc::Response::new(bytes)),
        Some(Err(_)) => Err("locked".to_string()),
        None => Err("not-allowed".to_string()),
    }
}

/// Stop: no further file is read, however much of the scan was left.
#[tauri::command]
async fn scan_cancel(window: WebviewWindow, c: State<'_, Arc<Clotr>>) -> Result<(), String> {
    only(&window, "main")?;
    if let Some(run) = lock(&c.scan).as_ref() {
        run.cancel();
    }
    Ok(())
}

// ---------- Results and its actions: by index into the last scan_start, never a path ----------

/// The single gate for every by-index Results action: stale cards keep their old generation when a new scan starts.
fn scan_for_generation(c: &Clotr, generation: u64) -> Result<Arc<scan::ScanRun>, String> {
    let current = lock(&c.scan);
    let run = current.as_ref().ok_or_else(|| "not-allowed".to_string())?;
    if !run.accepts_generation(generation) {
        return Err("not-allowed".to_string());
    }
    Ok(run.clone())
}

/// *Open the folder*: File Explorer, with the file selected, from the scan's own list. The page names an index,
/// never a path; the one path this command is allowed to read goes straight to the shell, through
/// `SHOpenFolderAndSelectItems`, so Clotr never starts `explorer.exe` as a process (the Store's certification kit
/// blocks a reference to that, with arguments, as a launched executable).
#[tauri::command]
async fn scan_reveal(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    index: usize,
    generation: u64,
) -> Result<bool, String> {
    only(&window, "main")?;
    let path = {
        let state = scan_for_generation(&c, generation)?;
        state.path_of(index).ok_or_else(|| "not-allowed".to_string())?
    };
    reveal_in_explorer(&path).map_err(|_| "not-opened".to_string())?;
    Ok(true)
}

/// Selects `path` in its parent folder's open Explorer window (or opens one), without starting any process:
/// `ILCreateFromPathW` turns the path into a PIDL and `SHOpenFolderAndSelectItems` hands that straight to the
/// shell. Needs COM on the calling thread, which Tauri's async commands can run on any of, so it's opened here
/// the same careful way `webview.rs` and `startup.rs` already do (ignoring a changed-mode result: COM already
/// being up on this thread, just not by this call, is still fine for a plain shell call like this one).
fn reveal_in_explorer(path: &Path) -> windows::core::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems};

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let pidl = ILCreateFromPathW(PCWSTR(wide.as_ptr()));
        if pidl.is_null() {
            return Err(windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL));
        }
        let result = SHOpenFolderAndSelectItems(pidl, None, 0);
        ILFree(Some(pidl));
        result
    }
}

/// *Ignore*: Clotr won't bring this file up again (a salted fingerprint, never the path itself).
#[tauri::command]
async fn scan_ignore(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    index: usize,
    generation: u64,
) -> Result<bool, String> {
    only(&window, "main")?;
    let path = {
        let state = scan_for_generation(&c, generation)?;
        state
            .path_of(index)
            .ok_or_else(|| "not-allowed".to_string())?
            .to_string_lossy()
            .into_owned()
    };
    lock(&c.store)
        .ignore_scan_item("file", &path)
        .map_err(|_| "not-saved".to_string())?;
    Ok(true)
}

/// *Save a copy with them hidden* and *Save a copy without the place*: `bytes` is already redacted or redrawn (the
/// engine, in the scan worker); this only places it through Windows' own Save dialog and refuses the
/// original's own path (`scan::write_copy`). `{ "saved": false }` when the person closes the dialog without
/// choosing anywhere, never an error.
#[tauri::command]
async fn scan_save_copy(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    app: AppHandle,
    index: usize,
    generation: u64,
    bytes: Vec<u8>,
    suggested_name: String,
) -> Result<Value, String> {
    only(&window, "main")?;
    let original = {
        let state = scan_for_generation(&c, generation)?;
        state.path_of(index).ok_or_else(|| "not-allowed".to_string())?
    };
    let Some(dest) = app.dialog().file().set_file_name(&suggested_name).blocking_save_file() else {
        return Ok(json!({ "saved": false }));
    };
    let dest = dest.into_path().map_err(|_| "not-saved".to_string())?;
    scan::write_copy(&dest, &original, &bytes).map_err(|_| "not-saved".to_string())?;
    Ok(json!({ "saved": true }))
}

/// *Move to the Recycle Bin* (4-10; every kind, not only a text file's own password, code or key find).
/// The scan stays read-only up to this one button; refuses once the scan is cancelled, since a stopped run's list
/// might not match what's really there anymore, unlike Reveal or Ignore, and refuses a file that changed size or
/// modified time since the scan recorded it (`recycle::recycle`'s own guard).
#[tauri::command]
async fn scan_recycle(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    index: usize,
    generation: u64,
) -> Result<bool, String> {
    only(&window, "main")?;
    let (path, recorded) = {
        let state = scan_for_generation(&c, generation)?;
        if state.is_cancelled() {
            return Err("not-allowed".to_string());
        }
        let path = state.path_of(index).ok_or_else(|| "not-allowed".to_string())?;
        let recorded = state.stamp_of(index).ok_or_else(|| "not-allowed".to_string())?;
        (path, recorded)
    };
    let item = recycle::recycle(&path, recorded)?;
    lock(&c.recycled).insert(index, item);
    Ok(true)
}

/// *Undo*, right after *Move to the Recycle Bin* on the same card: puts the file back exactly where it was.
#[tauri::command]
async fn scan_unrecycle(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    index: usize,
    generation: u64,
) -> Result<bool, String> {
    only(&window, "main")?;
    let _run = scan_for_generation(&c, generation)?;
    let item = lock(&c.recycled)
        .remove(&index)
        .ok_or_else(|| "not-allowed".to_string())?;
    recycle::restore(item)?;
    Ok(true)
}

/// *Move it somewhere private*'s own folder picker: Windows' own dialog, opened on OneDrive's Personal Vault
/// when this PC has one. Only the chosen folder's own name goes back to the page; its path stays here, kept for
/// `scan_move`, the same shape `scan_pick_folders` already uses for "Folders I choose".
#[tauri::command]
async fn move_pick_folder(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    only(&window, "main")?;
    let mut dialog = app.dialog().file();
    if let Some(vault) = move_private::personal_vault() {
        dialog = dialog.set_directory(vault);
    }
    let Some(picked) = dialog.blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|_| "not-allowed".to_string())?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    *lock(&c.move_dest) = Some(path);
    Ok(Some(name))
}

/// *Move it somewhere private*: moves every index in `indices` into the folder `move_pick_folder` already
/// chose, one call for a whole bundle, each file tried and reported on its own so one refusal never stops the
/// rest. Never a path back to the page, only whether each one moved and, if not, why.
#[tauri::command]
async fn scan_move(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    indices: Vec<usize>,
    generation: u64,
) -> Result<Vec<Value>, String> {
    only(&window, "main")?;
    let dest = lock(&c.move_dest).clone().ok_or_else(|| "not-allowed".to_string())?;
    let run = scan_for_generation(&c, generation)?;
    let mut results = Vec::with_capacity(indices.len());
    for index in indices {
        let attempt = (|| -> Result<move_private::Moved, String> {
            if run.is_cancelled() {
                return Err("not-allowed".to_string());
            }
            let path = run.path_of(index).ok_or_else(|| "not-allowed".to_string())?;
            let recorded = run.stamp_of(index).ok_or_else(|| "not-allowed".to_string())?;
            move_private::move_into(&dest, &path, recorded)
        })();
        results.push(match attempt {
            Ok(moved) => {
                lock(&c.moved).insert(index, moved);
                json!({ "index": index, "moved": true })
            }
            Err(reason) => json!({ "index": index, "moved": false, "reason": reason }),
        });
    }
    Ok(results)
}

/// *Undo*, right after *Move it somewhere private* on the same card: puts the file back exactly where it was.
#[tauri::command]
async fn scan_unmove(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    index: usize,
    generation: u64,
) -> Result<bool, String> {
    only(&window, "main")?;
    let _run = scan_for_generation(&c, generation)?;
    let moved = lock(&c.moved).remove(&index).ok_or_else(|| "not-allowed".to_string())?;
    move_private::move_back(&moved)?;
    Ok(true)
}

/// *Save a summary*: `html` is already built in the web view (summary.js's `summaryPage`, folders, kind names
/// and counts only, never a value); this only places it through Windows' own Save dialog, a plain page with no
/// original to refuse. `{ "saved": false }` when the person closes the dialog without choosing anywhere.
#[tauri::command]
async fn save_summary(window: WebviewWindow, app: AppHandle, html: String) -> Result<Value, String> {
    only(&window, "main")?;
    let Some(dest) = app
        .dialog()
        .file()
        .set_file_name("clotr-summary.html")
        .blocking_save_file()
    else {
        return Ok(json!({ "saved": false }));
    };
    let dest = dest.into_path().map_err(|_| "not-saved".to_string())?;
    std::fs::write(&dest, html.as_bytes()).map_err(|_| "not-saved".to_string())?;
    Ok(json!({ "saved": true }))
}

/// Settings' Accuracy answers *Export*: the page already built the text (settings.js's own
/// `accuracyExportRows`, kind/tier/yes/no only); this only asks where to put it.
#[tauri::command]
async fn save_accuracy_export(window: WebviewWindow, app: AppHandle, text: String) -> Result<Value, String> {
    only(&window, "main")?;
    let Some(dest) = app
        .dialog()
        .file()
        .set_file_name("clotr-accuracy.json")
        .blocking_save_file()
    else {
        return Ok(json!({ "saved": false }));
    };
    let dest = dest.into_path().map_err(|_| "not-saved".to_string())?;
    std::fs::write(&dest, text.as_bytes()).map_err(|_| "not-saved".to_string())?;
    Ok(json!({ "saved": true }))
}

/// "Email it" (the note for your helper) and "Report a problem"
/// (Settings, and Results near "Was this right?"): a `mailto:` built only in results-note.js, from fixed words
/// (Report a problem) or the note's own subject and body (Email it), never anything a page could shape into
/// another scheme. The address is either none at all (Email it, so it goes wherever the person already mails
/// their helper) or this app's own fixed support address (Report a problem): never an address a page chose. The
/// query may hold only `subject` and `body`, once each: nothing else gets a door out.
pub fn mailto_ok(url: &str) -> bool {
    let Some(query) = url
        .strip_prefix("mailto:?")
        .or_else(|| url.strip_prefix("mailto:support@clotr.app?"))
    else {
        return false;
    };
    let mut seen = std::collections::HashSet::new();
    for pair in query.split('&') {
        let Some((key, _)) = pair.split_once('=') else {
            return false;
        };
        if key != "subject" && key != "body" {
            return false;
        }
        if !seen.insert(key) {
            return false;
        }
    }
    !seen.is_empty()
}

#[tauri::command]
async fn open_mailto(window: WebviewWindow, url: String) -> Result<bool, String> {
    only(&window, "main")?;
    if !mailto_ok(&url) {
        return Ok(false);
    }
    let wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        windows::Win32::UI::Shell::ShellExecuteW(
            None,
            windows::core::w!("open"),
            windows::core::PCWSTR(wide.as_ptr()),
            None,
            None,
            windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        );
    }
    Ok(true)
}

// ---------- Extension check ----------

/// Every browser extension on this PC that `extensions.rs` can see, read only from each browser's own files.
/// `extcheck-core.js`'s `checkExtensions()`, in the scan worker, decides reach and worth-a-look from this;
/// nothing here does.
#[tauri::command]
async fn ext_check(window: WebviewWindow) -> Result<Vec<extensions::ExtensionRecord>, String> {
    only(&window, "main")?;
    // Testing only: points the read at a fixture profile tree instead of the real %LOCALAPPDATA%/%APPDATA%, so the
    // check is deterministic on whatever PC runs it (the same idea as scan_start's CLOTR_SCAN_ROOT).
    #[cfg(feature = "dk-test-app")]
    let fixture = std::env::var("CLOTR_EXT_LOCALAPPDATA").ok().map(|local| {
        (
            PathBuf::from(local),
            PathBuf::from(std::env::var("CLOTR_EXT_APPDATA").unwrap_or_default()),
        )
    });
    #[cfg(not(feature = "dk-test-app"))]
    let fixture: Option<(PathBuf, PathBuf)> = None;
    Ok(match fixture {
        Some((local, roaming)) => extensions::check_all_in(&local, &roaming),
        None => extensions::check_all(),
    })
}

/// A Chromium extension id: 32 letters, each `a`-`p` (the alphabet every Chromium browser's own ids use), never
/// anything a page could use to smuggle a stray argument to the browser it launches.
fn is_chromium_ext_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

/// *Show me where to remove it* (5.6): each Chromium browser keeps its own extensions page at this address.
/// Firefox has none a companion app can open, so the page never calls this for a Firefox entry.
fn ext_page_url(id: &str) -> Option<String> {
    is_chromium_ext_id(id).then(|| format!("chrome://extensions/?id={id}"))
}

/// Where each Chromium browser's own executable usually lives (a system install under Program Files, or a
/// per-user one under the local app data folder): launching that browser by name, rather than handing the address
/// to `ShellExecuteW` alone, means it opens the browser the extension is actually in, not whichever one Windows
/// happens to default to. `None` when Windows can't find it there: the page falls back to the steps in words,
/// exactly as if no address existed (5.6) — this never guesses, and never searches the whole disk.
fn chromium_exe(browser: &str, program_files: &[PathBuf], local_app_data: &Path) -> Option<PathBuf> {
    let rel: &[&str] = match browser {
        "Chrome" => &[r"Google\Chrome\Application\chrome.exe"],
        "Edge" => &[r"Microsoft\Edge\Application\msedge.exe"],
        "Brave" => &[r"BraveSoftware\Brave-Browser\Application\brave.exe"],
        "Vivaldi" => &[r"Vivaldi\Application\vivaldi.exe"],
        "Opera" => &[r"Programs\Opera\launcher.exe", r"Programs\Opera\opera.exe"],
        _ => return None,
    };
    let roots = program_files.iter().cloned().chain([local_app_data.to_path_buf()]);
    for root in roots {
        for r in rel {
            let p = root.join(r);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

#[tauri::command]
async fn ext_reveal(window: WebviewWindow, browser: String, id: String) -> Result<bool, String> {
    only(&window, "main")?;
    let Some(url) = ext_page_url(&id) else {
        return Ok(false);
    };
    let program_files: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(|k| std::env::var_os(k).map(PathBuf::from))
        .collect();
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let Some(exe) = chromium_exe(&browser, &program_files, &local_app_data) else {
        return Ok(false);
    };
    let exe_wide: Vec<u16> = exe.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    let url_wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        windows::Win32::UI::Shell::ShellExecuteW(
            None,
            windows::core::w!("open"),
            windows::core::PCWSTR(exe_wide.as_ptr()),
            windows::core::PCWSTR(url_wide.as_ptr()),
            None,
            windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        );
    }
    Ok(true)
}

#[cfg(test)]
mod ext_reveal_tests {
    use super::*;

    #[test]
    fn only_a_real_chromium_id_gets_an_address_never_an_arbitrary_string() {
        assert_eq!(
            ext_page_url("abcdefghijklmnopabcdefghijklmnop"),
            Some("chrome://extensions/?id=abcdefghijklmnopabcdefghijklmnop".to_string())
        );
        assert_eq!(ext_page_url(""), None);
        assert_eq!(ext_page_url("not-an-id"), None);
        // One character past 'p', or a digit: never a Chromium id, even at the right length.
        assert_eq!(ext_page_url(&"q".repeat(32)), None);
        assert_eq!(ext_page_url(&"a".repeat(31)), None);
        // A page could try to smuggle another launch argument in: still refused, length and alphabet both hold.
        assert_eq!(ext_page_url("abcdefghijklmnop&start-fullscreen="), None);
    }

    #[test]
    fn an_unknown_browser_or_a_missing_exe_is_none_not_a_guess() {
        let dir = std::env::temp_dir().join(format!("clotr-chromium-exe-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(chromium_exe("Internet Explorer", &[dir.clone()], &dir), None);
        assert_eq!(
            chromium_exe("Chrome", &[dir.clone()], &dir),
            None,
            "chrome.exe isn't actually there"
        );
        let app = dir.join("Google").join("Chrome").join("Application");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("chrome.exe"), b"").unwrap();
        assert_eq!(
            chromium_exe("Chrome", &[dir.clone()], &dir),
            Some(app.join("chrome.exe"))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// "Turn it back on" (Home's paused state). A plain, indefinite pause: it clears any timed pause from the
/// tray's "Pause for an hour" so the two never fight over when to lift.
#[tauri::command]
async fn set_paused(
    window: WebviewWindow,
    c: State<'_, Arc<Clotr>>,
    app: AppHandle,
    on: bool,
) -> Result<Value, String> {
    only(&window, "main")?;
    *lock(&c.paused_until) = None;
    set_paused_all_and_notify(&app, on);
    Ok(settings_view(&c))
}

/// Protection's own Tourniquet switch: a chosen preset or "Off", from the main window alone. Always the fresh
/// view back, the same as `save_settings`, so the switch and anything it holds firmly redraw together.
#[tauri::command]
async fn set_tourniquet(window: WebviewWindow, c: State<'_, Arc<Clotr>>, tourniquet: Value) -> Result<Value, String> {
    only(&window, "main")?;
    lock(&c.store)
        .set_tourniquet(&tourniquet)
        .map_err(|_| "not-saved".to_string())?;
    Ok(settings_view(&c))
}

/// Every way the flyout stops being shown goes through here. It closes the window rather than hiding it,
/// because a web view's browser process keeps costing processor time for as long as any window built on it
/// still exists, hidden or not (measured, tests/cpu.rs: a few tenths of a core, forever, for a flyout merely
/// kept around between opens). toggle_flyout already rebuilds it from nothing on the next open, which the
/// shared, already-warm environment (webview.rs) makes cheap.
fn hide_flyout(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("flyout") {
        let _ = w.close();
    }
}

/// Esc, from flyout.js: the one way the flyout closes itself without taking an action.
#[tauri::command]
async fn close_flyout(window: WebviewWindow) -> Result<(), String> {
    only(&window, "flyout")?;
    hide_flyout(window.app_handle());
    Ok(())
}

/// flyout.js's own ResizeObserver, reporting the panel's real size: the window is set to exactly that and
/// placed from the tray icon rect `toggle_flyout` kept, so it's never taller than its content and never further
/// from the icon than the real size needs.
#[tauri::command]
async fn flyout_fit(window: WebviewWindow, c: State<'_, Arc<Clotr>>, width: f64, height: f64) -> Result<(), String> {
    only(&window, "flyout")?;
    let size = (width.clamp(240.0, 420.0), height.clamp(120.0, 480.0));
    *lock(&c.flyout_size) = size;
    if let Some(anchor) = *lock(&c.flyout_rect) {
        let (x, y) = flyout_position(anchor, size);
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(size.0, size.1)));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
    }
    Ok(())
}

#[tauri::command]
async fn flyout_open(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, "flyout")?;
    hide_flyout(&app);
    open_main_to(&app, "home");
    Ok(())
}

#[tauri::command]
async fn flyout_scan(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, "flyout")?;
    hide_flyout(&app);
    // "scan-quick": the Scan screen, with a Quick scan started there (main.js), since that's what the button says.
    open_main_to(&app, "scan-quick");
    Ok(())
}

/// "Pause for an hour" / "Resume now": toggles, rather than always pausing, so the same button undoes a
/// pause it just started. Doesn't hide the flyout itself -- flyout.js shows a brief confirmation first, in the
/// window already open, never a new one, and closes it a moment later.
#[tauri::command]
async fn flyout_pause(window: WebviewWindow, c: State<'_, Arc<Clotr>>, app: AppHandle) -> Result<Value, String> {
    only(&window, "flyout")?;
    if lock(&c.store).paused_all() {
        *lock(&c.paused_until) = None;
        set_paused_all_and_notify(&app, false);
        Ok(json!({ "paused": false }))
    } else {
        pause_for_hour(&app, &c.inner().clone());
        Ok(json!({ "paused": true, "pausedUntil": *lock(&c.paused_until) }))
    }
}

#[tauri::command]
async fn flyout_quit(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, "flyout")?;
    app.exit(0);
    Ok(())
}

/// The main window's size, in logical pixels (at 150% scaling the minimum still fits a 1366 x 768 screen).
const MAIN_SIZE: (f64, f64) = (1280.0, 800.0);
const MAIN_MIN: (f64, f64) = (900.0, 600.0);

/// The main window's size on a screen with `room` for windows (the taskbar aside, logical pixels): MAIN_SIZE when
/// it fits with the window's frame, smaller when it doesn't, never below MAIN_MIN.
fn main_size(room: (f64, f64)) -> (f64, f64) {
    let (frame_w, frame_h) = (16.0, 48.0); // the borders and Windows' title bar, with a little room
    (
        MAIN_SIZE.0.min(room.0 - frame_w).max(MAIN_MIN.0),
        MAIN_SIZE.1.min(room.1 - frame_h).max(MAIN_MIN.1),
    )
}

/// The main window: Home, Scan, Results, Protection, History and Settings. Opened from the tray or the
/// flyout; closing it leaves Clotr by the clock. `screen` is where it should land: a freshly built window starts
/// there (`main.html#<screen>`), one already open is sent there through the same "go" event main.js already
/// listens on for its own navigation.
fn open_main_to(app: &AppHandle, screen: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        set_visible(app, "main", true);
        let _ = app.emit_to("main", "go", screen);
        return;
    }
    let c = app.state::<Arc<Clotr>>().inner().clone();
    let size = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let (area, scale) = (m.work_area(), m.scale_factor());
            main_size((area.size.width as f64 / scale, area.size.height as f64 / scale))
        })
        .unwrap_or(MAIN_SIZE);
    let page = format!("main.html#{screen}");
    let built = webview::window(app, &c.webview_dir, &c.browser_args, &c.locale, "main", &page).map(|b| {
        b.title("Clotr")
            .inner_size(size.0, size.1)
            .min_inner_size(MAIN_MIN.0, MAIN_MIN.1)
            .center()
            .build()
    });
    if let Some(Ok(w)) = &built {
        // Minimizing fires a Resized(0, 0) on Windows before anything else notices; is_minimized() confirms it
        // rather than trusting the size alone, so a plain small resize never gets mistaken for one.
        let handle = app.clone();
        w.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                if let Some(w) = handle.get_webview_window("main") {
                    set_visible(&handle, "main", !w.is_minimized().unwrap_or(false));
                }
            }
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let visible = handle
                    .get_webview_window("main")
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false);
                first_close_toast(&handle, visible);
            }
        });
    }
    if !matches!(built, Some(Ok(_))) {
        eprintln!("{LOG} the main window couldn't open");
    }
}

fn open_main(app: &AppHandle) {
    open_main_to(app, "home");
}

/// Whether closing the main window should bring the one toast saying Clotr is still on by the clock: only a window
/// the person could see (the weekly check's hidden one closes itself), and only the first time ever.
fn close_toast_due(visible: bool, shown_before: bool) -> bool {
    visible && !shown_before
}

/// Closing the window keeps Clotr running by the clock, and Windows 11 tucks a new tray icon under ^, so the first
/// close says where it went. Once only (store::Once::CloseToast), never a window of its own.
fn first_close_toast(app: &AppHandle, visible: bool) {
    let c = app.state::<Arc<Clotr>>().inner().clone();
    if !close_toast_due(visible, lock(&c.store).once(store::Once::CloseToast)) {
        return;
    }
    if lock(&c.store).set_once(store::Once::CloseToast).is_err() {
        eprintln!("{LOG} couldn't save that the close note showed");
    }
    let w = words::Words::new(&c.locale_now());
    let _ = app.notification().builder().title("Clotr").body(w.t("ws.closedToast")).show();
}

// ---------- The weekly check: a Quick scan on its own, once a week, while Clotr runs ----------

const WEEK_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Never run yet, or the last run was a full week or more ago. Simplified from the suite's own "Sunday at
/// noon" wording to a plain seven-day interval: the local date and clock Windows would need for the exact day
/// and hour aren't worth carrying for one background check, and "about once a week, while the PC is on" is
/// what the person actually gets either way.
fn weekly_check_due(now_ms: u64, last: Option<u64>) -> bool {
    match last {
        None => true,
        Some(last) => now_ms.saturating_sub(last) >= WEEK_MS,
    }
}

/// Starts a Quick scan with nobody watching: a hidden window on the same "main" label the real window uses
/// (so it's allowed every command `scan_start`/`scan_next`/`record_scan` need, and so a person opening Clotr
/// mid-check simply sees their own weekly scan running rather than two windows fighting for the name), pointed
/// at `main.html?weekly=1#scan`, which `main.js` reads once on load to start the scan itself and report back
/// through `weekly_check_done`. Skipped entirely if a real main window is already open -- the next hourly tick
/// tries again, and a week's slack means missing one evening never matters.
fn start_weekly_check(app: &AppHandle, c: &Arc<Clotr>) {
    if app.get_webview_window("main").is_some() {
        c.weekly_running.store(false, Ordering::SeqCst);
        return;
    }
    let page = "main.html?weekly=1#scan";
    let built = webview::window(app, &c.webview_dir, &c.browser_args, &c.locale, "main", page).map(|b| {
        b.inner_size(MAIN_MIN.0, MAIN_MIN.1)
            .visible(false)
            .decorations(false)
            .skip_taskbar(true)
            .build()
    });
    if !matches!(built, Some(Ok(_))) {
        eprintln!("{LOG} the weekly check's window couldn't open");
        c.weekly_running.store(false, Ordering::SeqCst);
        return;
    }
    // A watchdog, not the normal path: if the page never calls back (a worker that hangs, a scan over the file
    // cap taking longer than expected), the hidden window and the "one at a time" flag would otherwise never
    // clear, and the check would silently stop running forever.
    let (app2, c2) = (app.clone(), c.clone());
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(600));
        if c2.weekly_running.swap(false, Ordering::SeqCst) {
            if let Some(w) = app2.get_webview_window("main") {
                if !w.is_visible().unwrap_or(true) {
                    let _ = w.close();
                }
            }
        }
    });
}

/// `files`: the worth-a-look files this weekly run found, as `[{ "index": usize, "kinds": [String] }]` --
/// scan.js's own `isWorthALook` already filtered out the lemon-only ones (4-1), so a repeat email address never
/// counts as new here either. Each is checked against the store's own "seen" fingerprints (4-4: the same
/// mechanism as Ignore, by path and kinds, never a value) before the hidden window closes, so the notice -- and
/// Results, once opened -- speak only to what's actually new since last time.
#[tauri::command]
async fn weekly_check_done(window: WebviewWindow, c: State<'_, Arc<Clotr>>, files: Value) -> Result<Value, String> {
    only(&window, "main")?;
    let _ = lock(&c.store).set_last_weekly_check(now_ms() as u64);
    c.weekly_running.store(false, Ordering::SeqCst);

    let entries: Vec<(usize, Vec<String>)> = files
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let index = e.get("index")?.as_u64()? as usize;
                    let kinds = e
                        .get("kinds")?
                        .as_array()?
                        .iter()
                        .filter_map(|k| k.as_str().map(String::from))
                        .collect();
                    Some((index, kinds))
                })
                .collect()
        })
        .unwrap_or_default();
    let with_paths: Vec<(usize, String, Vec<String>)> = {
        let scan = lock(&c.scan);
        let state = scan.as_ref();
        entries
            .into_iter()
            .filter_map(|(index, kinds)| {
                let path = state?.path_of(index)?.to_string_lossy().into_owned();
                Some((index, path, kinds))
            })
            .collect()
    };
    let total = with_paths.len() as u64;
    let new_indices: Vec<usize> = {
        let mut store = lock(&c.store);
        with_paths
            .into_iter()
            .filter_map(|(index, path, kinds)| store.note_scan_find(&path, &kinds).unwrap_or(false).then_some(index))
            .collect()
    };

    let new_count = new_indices.len() as u64;
    let still_count = total.saturating_sub(new_count);
    let _ = lock(&c.store).set_weekly_find(new_count, still_count);
    // Home's own status word (status.rs's "look"): anything from this run that still waits for the person, new
    // or already seen before, not only the brand-new ones -- the tray icon catches up next time it redraws.
    c.worth_a_look.store(total > 0, Ordering::SeqCst);
    let notify = lock(&c.store).settings().get("notifyFind") != Some(&Value::Bool(false));
    if new_count > 0 && notify {
        let w = words::Words::new(&c.locale_now());
        let body = if new_count == 1 {
            w.t("ws.notifyOne")
        } else {
            w.t1("ws.notify", new_count)
        };
        let _ = window
            .app_handle()
            .notification()
            .builder()
            .title("Clotr")
            .body(body)
            .show();
    }
    if new_count > 0 {
        // New finds with the ability to open the full findings report: rather than close the hidden window
        // (nothing new, the usual path below), show it, land it on Results, and let scan.js mark the new ones --
        // it already has every file's own kinds in memory, this command only ever sees an index and a path.
        let _ = window.emit("go", "results");
        let _ = window.show();
        let _ = window.set_focus();
    } else if !window.is_visible().unwrap_or(true) {
        let _ = window.close();
    }
    Ok(json!({ "newIndices": new_indices }))
}

// ---------- The tray and its flyout ----------

/// The tray icon's state: a pause the person chose matters more to show than something merely worth a look (which
/// has no icon of its own beyond this dot yet).
fn tray_icon_for(paused: bool, worth_a_look: bool) -> &'static str {
    if paused {
        "off"
    } else if worth_a_look {
        "look"
    } else {
        "on"
    }
}

fn tray_icon_image(state: &str) -> tauri::image::Image<'static> {
    match state {
        "off" => tauri::include_image!("icons/tray-off.png"),
        "look" => tauri::include_image!("icons/tray-look.png"),
        _ => tauri::include_image!("icons/tray-on.png"),
    }
}

fn set_paused_all(app: &AppHandle, on: bool) {
    let c = app.state::<Arc<Clotr>>().inner().clone();
    if lock(&c.store).set_paused_all(on).is_err() {
        eprintln!("{LOG} couldn't save the pause");
    }
    apply_pause(app, &c);
    if let Some(tray) = app.tray_by_id("clotr") {
        let state = tray_icon_for(on, c.worth_a_look.load(Ordering::SeqCst));
        let _ = tray.set_icon(Some(tray_icon_image(state)));
    }
    retell_tray(app, &c);
    let _ = app.emit_to("main", "paused", on);
}

fn paused_now(app: &AppHandle) -> bool {
    let c = app.state::<Arc<Clotr>>().inner().clone();
    let paused = lock(&c.store).paused_all();
    paused
}

/// The tray's words in the language every window speaks now (Settings' Language, or Windows' own): its three menu
/// items and its tooltip, the pause item and the tooltip following the pause too. Run again whenever either changes.
fn retell_tray(app: &AppHandle, c: &Clotr) {
    let w = words::Words::new(&c.locale_now());
    let paused = lock(&c.store).paused_all();
    if let Some(tray) = app.tray_by_id("clotr") {
        let _ = tray.set_tooltip(Some(w.t(tooltip_word(paused))));
    }
    if let Some(items) = lock(&c.tray_items).as_ref() {
        let _ = items.open.set_text(w.t("ws.trayOpen"));
        let _ = items.pause.set_text(w.t(pause_word(paused)));
        let _ = items.quit.set_text(w.t("tray.quit"));
    }
}

/// Home and the native tray menu change an indefinite pause. The timed flyout already confirms in place; its
/// automatic resume has no open page, so it uses this same Windows toast path.
fn set_paused_all_and_notify(app: &AppHandle, on: bool) {
    let c = app.state::<Arc<Clotr>>().inner().clone();
    // A pause or resume from here is the person's own, so a timed pause's hour no longer applies (the tray menu's
    // item reaches here with one still running; the other callers have cleared it already).
    *lock(&c.paused_until) = None;
    set_paused_all(app, on);
    let w = words::Words::new(&c.locale_now());
    let body = w.t(if on { "ws.pausedConfirm" } else { "ws.resumedConfirm" });
    let _ = app.notification().builder().title("Clotr").body(body).show();
}

const PAUSE_HOUR_MS: i64 = 60 * 60 * 1000;

/// The tray flyout's "Pause for an hour": a plain pause (so every other window agrees Clotr is paused) with its own
/// deadline, lifted by itself. A later, unrelated "Turn it back on" clears `paused_until` first (`set_paused`), so
/// when this timer wakes it finds a deadline that isn't its own and leaves the (by-then-different) pause alone.
fn pause_for_hour(app: &AppHandle, c: &Arc<Clotr>) {
    set_paused_all(app, true);
    let until = now_ms() + PAUSE_HOUR_MS;
    *lock(&c.paused_until) = Some(until);
    let (app, c) = (app.clone(), c.clone());
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(PAUSE_HOUR_MS as u64));
        if *lock(&c.paused_until) == Some(until) {
            *lock(&c.paused_until) = None;
            set_paused_all_and_notify(&app, false);
        }
    });
}

/// Above the tray icon, right-aligned to it, never covering it or running off the screen's usable area. Every
/// input and the result are logical pixels, already converted for whatever scale the screen is at (100% or 150%):
/// the one function covers both.
fn flyout_spot(icon_right: f64, icon_top: f64, work: (f64, f64, f64, f64), width: f64, height: f64) -> (f64, f64) {
    const MARGIN: f64 = 8.0;
    let (work_left, work_top, work_right, work_bottom) = work;
    let x = (icon_right - width).min(work_right - width).max(work_left);
    let y = (icon_top - height - MARGIN).min(work_bottom - height).max(work_top);
    (x, y)
}

/// Where the tray icon sits, in the primary screen's logical pixels: resolved once from whatever Windows gave the
/// click event (physical or logical), and kept (Clotr's `flyout_rect`) so the flyout can be placed again, at its
/// real size, the moment flyout.js reports it (`flyout_fit`) without needing a fresh click.
#[derive(Clone, Copy, Debug)]
struct FlyoutAnchor {
    icon_right: f64,
    icon_top: f64,
    work: (f64, f64, f64, f64),
}

fn flyout_anchor(app: &AppHandle, rect: Rect) -> FlyoutAnchor {
    let monitor = app.primary_monitor().ok().flatten();
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let work = monitor
        .map(|m| {
            let a = m.work_area();
            let (left, top) = (a.position.x as f64 / scale, a.position.y as f64 / scale);
            (
                left,
                top,
                left + a.size.width as f64 / scale,
                top + a.size.height as f64 / scale,
            )
        })
        .unwrap_or((0.0, 0.0, 1920.0, 1040.0));
    let position = rect.position.to_logical::<f64>(scale);
    let size = rect.size.to_logical::<f64>(scale);
    FlyoutAnchor {
        icon_right: position.x + size.width,
        icon_top: position.y,
        work,
    }
}

fn flyout_position(anchor: FlyoutAnchor, size: (f64, f64)) -> (f64, f64) {
    flyout_spot(anchor.icon_right, anchor.icon_top, anchor.work, size.0, size.1)
}

/// Before flyout.js has measured the panel (the very first open): close to the real content, so the
/// first paint is already near its final spot and size. `flyout_fit` corrects it a moment later.
const FLYOUT_GUESS: (f64, f64) = (320.0, 290.0);

/// Borderless, always-on-top and never in the taskbar, the same as the card: Windows doesn't hand a window like
/// that the keyboard just because it's shown, so (like `reach_card`) it gets the same push to the front before
/// Tauri's own `set_focus` can hold it. Without this, Esc never reaches flyout.js's listener.
fn focus_flyout(w: &WebviewWindow) {
    if let Ok(h) = w.hwnd() {
        let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(card::hwnd(h.0 as isize)) };
    }
    let _ = w.set_focus();
}

/// Left click on the tray icon: the flyout, above the icon, closing on a second click (the open one) and
/// (through `on_window_event` below) the moment it loses focus, since any other click is "elsewhere". Esc closes
/// it too, through `close_flyout`, called from flyout.js.
fn toggle_flyout(app: &AppHandle, rect: Rect) {
    let c = app.state::<Arc<Clotr>>().inner().clone();
    let anchor = flyout_anchor(app, rect);
    *lock(&c.flyout_rect) = Some(anchor);
    if let Some(w) = app.get_webview_window("flyout") {
        if w.is_visible().unwrap_or(false) {
            hide_flyout(app);
        } else {
            // The size flyout.js already measured (or the guess, the very first time): placed the same way every
            // open, never stretched back out to a size nothing asked for.
            let (x, y) = flyout_position(anchor, *lock(&c.flyout_size));
            let _ = w.set_position(LogicalPosition::new(x, y));
            let _ = w.show();
            focus_flyout(&w);
            set_visible(app, "flyout", true);
        }
        return;
    }
    let Some(builder) = webview::window(app, &c.webview_dir, &c.browser_args, &c.locale, "flyout", "flyout.html")
    else {
        eprintln!("{LOG} the flyout couldn't start");
        return;
    };
    let (x, y) = flyout_position(anchor, FLYOUT_GUESS);
    let built = builder
        .title("Clotr")
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .inner_size(FLYOUT_GUESS.0, FLYOUT_GUESS.1)
        .position(x, y)
        .build();
    match built {
        Ok(w) => {
            focus_flyout(&w);
            let closer = app.clone();
            w.on_window_event(move |event| {
                match event {
                    // Activation can land after the window is already built (Windows grants a brand-new process's
                    // first window the front on its own time); set_focus right away can be too early to take, so
                    // it's asked for again the moment the window is truly active, which is when Esc needs it.
                    tauri::WindowEvent::Focused(true) => {
                        if let Some(w) = closer.get_webview_window("flyout") {
                            focus_flyout(&w);
                        }
                    }
                    tauri::WindowEvent::Focused(false) => {
                        hide_flyout(&closer);
                    }
                    _ => {}
                }
            });
        }
        Err(_) => eprintln!("{LOG} the flyout couldn't start"),
    }
}

/// The tray menu's pause item says what a click does next: "Pause until I turn it back on" (the flyout's own
/// button is the timed one) or "Resume Clotr". A plain item, never a checkmark.
fn pause_word(paused: bool) -> &'static str {
    if paused {
        "tray.resume"
    } else {
        "tray.pause"
    }
}

fn tooltip_word(paused: bool) -> &'static str {
    if paused {
        "tray.paused"
    } else {
        "tray.on"
    }
}

fn tray(app: &AppHandle, c: &Clotr) -> tauri::Result<()> {
    let w = words::Words::new(&c.locale_now());
    let paused = lock(&c.store).paused_all();
    let open = MenuItem::with_id(app, "open", w.t("ws.trayOpen"), true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", w.t(pause_word(paused)), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", w.t("tray.quit"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pause, &PredefinedMenuItem::separator(app)?, &quit])?;
    *lock(&c.tray_items) = Some(TrayItems {
        open: open.clone(),
        pause: pause.clone(),
        quit: quit.clone(),
    });
    TrayIconBuilder::with_id("clotr")
        .icon(tray_icon_image(tray_icon_for(
            paused,
            c.worth_a_look.load(Ordering::SeqCst),
        )))
        .tooltip(w.t(tooltip_word(paused)))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => open_main(app),
            // The item flips whatever the pause is now, timed or not, the same as Home's own button.
            "pause" => set_paused_all_and_notify(app, !paused_now(app)),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_flyout(tray.app_handle(), rect);
            }
        })
        .build(app)?;
    Ok(())
}

// ---------- Start ----------

/// One Clotr at a time: a second start leaves quietly.
fn first_instance() -> bool {
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;
    let name = if cfg!(feature = "dk-test-app") {
        windows::core::w!("Local\\ClotrForWindowsDK")
    } else {
        windows::core::w!("Local\\ClotrForWindows")
    };
    let made = unsafe { CreateMutexW(None, true, name) };
    match made {
        Ok(handle) => {
            let _ = handle; // kept open for as long as Clotr runs
            let last = unsafe { GetLastError() };
            last != ERROR_ALREADY_EXISTS
        }
        Err(_) => true,
    }
}

// One source of command names feeds both Tauri's live handler and the test that inspects that exact handler list.
// The optional One Clotr entries are supplied only by the feature-gated invocation below.
macro_rules! app_commands {
    ($consumer:ident $(, $one_clotr:ident)* $(,)?) => {
        $consumer!([
            card_hello,
            read_clip,
            show_card,
            resize_card,
            card_done,
            hide_in_clipboard,
            read_typed,
            read_box_again,
            copy_safe,
            typed_note_seen,
            copy_note,
            paste_clip,
            record,
            record_scan,
            set_responses,
            set_tourniquet,
            back_to_app,
            open_report,
            settings_hello,
            save_settings,
            import_settings,
            clear_history,
            clear_scan_ignored,
            accuracy_answer,
            clear_accuracy_answers,
            save_accuracy_export,
            scan_exclude_pick,
            scan_exclude_type,
            scan_exclude_from,
            scan_unexclude,
            scan_pick_folders,
            scan_start,
            scan_batch,
            scan_end,
            scan_next,
            scan_cancel,
            scan_reveal,
            scan_ignore,
            scan_save_copy,
            scan_recycle,
            scan_unrecycle,
            move_pick_folder,
            scan_move,
            scan_unmove,
            save_summary,
            open_mailto,
            ext_check,
            ext_reveal,
            open_lookback_link,
            open_extension_page,
            lookback_dk_fixture,
            set_paused,
            flyout_hello,
            close_flyout,
            flyout_fit,
            flyout_open,
            flyout_scan,
            flyout_pause,
            flyout_quit,
            weekly_check_done,
            $($one_clotr),*
        ]);
    };
}

macro_rules! define_app_handler {
    ([$($command:ident),* $(,)?]) => {
        fn app_invoke_handler() -> Box<tauri::ipc::InvokeHandler<tauri::Wry>> {
            Box::new(tauri::generate_handler![$($command),*])
        }

        #[cfg(test)]
        fn app_registered_commands() -> &'static [&'static str] {
            &[$(stringify!($command)),*]
        }
    };
}

#[cfg(feature = "one-clotr")]
app_commands!(define_app_handler, one_clotr_status, one_clotr_consent, one_clotr_disconnect);
#[cfg(not(feature = "one-clotr"))]
app_commands!(define_app_handler);

fn main() {
    if !first_instance() {
        return;
    }
    let data = data_dir();
    let webview_dir = data.join("webview");
    webview::clear_crash_reports(&webview_dir);
    let mut store = match store::Store::open(&data) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("{LOG} couldn't open its data folder");
            return;
        }
    };
    // Home's first-run line shows for the whole of this first start and never again.
    let start_line = !store.once(store::Once::StartLine);
    if start_line && store.set_once(store::Once::StartLine).is_err() {
        eprintln!("{LOG} couldn't save that the first-run line showed");
    }
    // Testing only: forces Home's status past a real trigger (worth_a_look) or a real outage (running) to drive it.
    #[cfg_attr(not(feature = "dk-test-app"), allow(unused_mut))]
    let mut running = true;
    // A weekly check's last result survives a restart (store.rs's own write), so Home doesn't forget what still
    // waits for the person just because Clotr was closed and opened again.
    #[cfg_attr(not(feature = "dk-test-app"), allow(unused_mut))]
    let mut worth_a_look = store.weekly_find_total() > 0;
    #[cfg(feature = "dk-test-app")]
    if let Ok(force) = std::env::var("CLOTR_FORCE_STATUS") {
        match force.as_str() {
            "look" => worth_a_look = true,
            "notRunning" => running = false,
            "paused" => {
                let _ = store.set_paused_all(true);
            }
            _ => {}
        }
    }
    let apps = apps::built_in();
    let brain = brain::Brain {
        paused: store.paused_all(),
        paused_apps: apps
            .iter()
            .filter(|a| store.app_paused(&a.id))
            .map(|a| a.id.clone())
            .collect(),
        typing: store.typing_check(),
        ..Default::default()
    };
    let clotr = Arc::new(Clotr {
        apps,
        makers: apps::built_in_makers(),
        terminals: surfaces::built_in_terminals(),
        store: Mutex::new(store),
        brain: Mutex::new(brain),
        locale: words::system_locale(),
        webview_dir,
        browser_args: webview::browser_args(),
        card_ready: AtomicBool::new(false),
        pending: Mutex::new(None),
        size: Mutex::new((372.0, 200.0)),
        chosen: Mutex::new(Vec::new()),
        scan: Mutex::new(None),
        recycled: Mutex::new(std::collections::HashMap::new()),
        moved: Mutex::new(std::collections::HashMap::new()),
        move_dest: Mutex::new(None),
        running: AtomicBool::new(running),
        worth_a_look: AtomicBool::new(worth_a_look),
        paused_until: Mutex::new(None),
        flyout_size: Mutex::new(FLYOUT_GUESS),
        flyout_rect: Mutex::new(None),
        tray_items: Mutex::new(None),
        start_line,
        weekly_running: AtomicBool::new(false),
        unmatched_maker: Mutex::new(None),
        typed_text: Mutex::new(None),
        typed_seq: AtomicU32::new(1 << 31),
        blind: Mutex::new(Vec::new()),
        card_last_needed: Mutex::new(None),
    });
    let invoke_handler = app_invoke_handler();
    // One Clotr's grants come in only with its commands. capabilities/ is read by every build, and a grant there for
    // a command the build doesn't register stops Tauri's build step.
    #[cfg(feature = "one-clotr")]
    let context = tauri::generate_context!(capabilities = ["one-clotr-capabilities/one-clotr.json"]);
    #[cfg(not(feature = "one-clotr"))]
    let context = tauri::generate_context!();

    let shared = clotr.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(clotr)
        .invoke_handler(invoke_handler)
        .setup(move |app| {
            let handle = app.handle().clone();
            #[cfg(feature = "one-clotr")]
            {
                let pipe_app = handle.clone();
                std::thread::Builder::new()
                    .name("one-clotr-pipe".into())
                    .spawn(move || {
                        one_clotr_pipe::serve(move |request| {
                            let answer = one_clotr_protocol::reply(&request);
                            if request["type"] == "pair_request" && answer["type"] == "pair_pending" {
                                let app = pipe_app.clone();
                                let _ = pipe_app.run_on_main_thread(move || {
                                    open_main_to(&app, "settings");
                                    let _ = app.emit_to("main", "one-clotr-changed", ());
                                });
                            }
                            answer
                        });
                    })?;
            }
            tray(&handle, &shared)?;
            // A person launching Clotr (its shortcut, or a taskbar pin) sees the main window open, the same
            // as any other app; only the weekly check's own hidden window (start_weekly_check) and the
            // automated test harness below stay in the tray on purpose, and so does a start at sign-in, which
            // shouldn't throw a window in front of someone who just logged in.
            #[cfg(not(feature = "dk-test-app"))]
            if !startup::launched_at_startup(std::env::args()) {
                open_main(&handle);
            }
            #[cfg(feature = "dk-test-app")]
            if std::env::var_os("CLOTR_OPEN_MAIN").is_some() {
                open_main(&handle);
            }
            // Testing only, for the idle-memory check (tests/cpu.rs): opens the main window the same way a
            // person does, then closes it the same way a real close does, without ever needing the screen.
            #[cfg(feature = "dk-test-app")]
            if std::env::var_os("CLOTR_OPEN_MAIN_THEN_CLOSE").is_some() {
                open_main(&handle);
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if let Some(w) = h.get_webview_window("main") {
                        let _ = w.close();
                    }
                });
            }
            // Testing only, for the idle-memory check (tests/cpu.rs): builds the card's own hidden window the
            // same way the first AI app coming to the front does (card_window), without needing a real AI app
            // or the screen -- the card stays hidden either way, so this is the same window a real run leaves
            // behind once someone has opened an AI app even once.
            #[cfg(feature = "dk-test-app")]
            if std::env::var_os("CLOTR_OPEN_CARD").is_some() {
                card_window(&handle, &shared);
            }
            // Testing only: opens the flyout the same way a test opens the main window, above where a tray icon
            // would be at the work area's bottom right, since telling this test's tray icon apart from a real
            // running trial's (same name, same tray) isn't safe to automate on a shared PC.
            #[cfg(feature = "dk-test-app")]
            if std::env::var_os("CLOTR_OPEN_FLYOUT").is_some() {
                let (x, y) = handle
                    .primary_monitor()
                    .ok()
                    .flatten()
                    .map(|m| {
                        let a = m.work_area();
                        (
                            a.position.x + a.size.width as i32 - 40,
                            a.position.y + a.size.height as i32 - 40,
                        )
                    })
                    .unwrap_or((1880, 1000));
                let rect = Rect {
                    position: tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)),
                    size: tauri::Size::Physical(tauri::PhysicalSize::new(16, 16)),
                };
                toggle_flyout(&handle, rect);
            }
            // Testing only, for the idle-processor check (tests/cpu.rs): builds the flyout invisible from the
            // first frame (so there's no window to flash on screen regardless of timing), then closes it the
            // same way a real close does, to check that closing actually leaves nothing behind running. The
            // init script sets the paused state before flyout.js or shield.css ever runs, since the Rust
            // "visible" event (tauri.js) needs the page already loaded to catch it, and a window that's never
            // shown gives it no chance to.
            #[cfg(feature = "dk-test-app")]
            if std::env::var_os("CLOTR_OPEN_FLYOUT_THEN_CLOSE").is_some() {
                let c = handle.state::<Arc<Clotr>>().inner().clone();
                let built = webview::window(
                    &handle,
                    &c.webview_dir,
                    &c.browser_args,
                    &c.locale,
                    "flyout",
                    "flyout.html",
                )
                .map(|b| {
                    b.title("Clotr")
                        .decorations(false)
                        .transparent(true)
                        .shadow(true)
                        .resizable(false)
                        .always_on_top(true)
                        .skip_taskbar(true)
                        .inner_size(FLYOUT_GUESS.0, FLYOUT_GUESS.1)
                        .visible(false)
                        .initialization_script("document.documentElement.setAttribute('data-visible','false')")
                        .build()
                });
                if matches!(built, Some(Ok(_))) {
                    // Give WebView2 time to actually finish loading the page before closing it, so the check
                    // this feeds (tests/cpu.rs) proves a flyout that really ran stops costing anything, not
                    // just one closed before its browser process had a chance to start.
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    hide_flyout(&handle);
                } else {
                    eprintln!("{LOG} the flyout couldn't start");
                }
            }
            // Testing only, for the scan check in tests/cpu.rs: the main window hidden from its first frame, the
            // way the weekly check opens it, on "Run a quick scan" (main.html#scan-quick), so a whole scan runs
            // and then sits idle with nothing on screen. Unlike the weekly check, it stays open afterwards, so the
            // check can see what the finished page still holds.
            #[cfg(feature = "dk-test-app")]
            if std::env::var_os("CLOTR_SCAN_HIDDEN").is_some() {
                let c = handle.state::<Arc<Clotr>>().inner().clone();
                let page = "main.html#scan-quick";
                let built =
                    webview::window(&handle, &c.webview_dir, &c.browser_args, &c.locale, "main", page).map(|b| {
                        b.inner_size(MAIN_SIZE.0, MAIN_SIZE.1)
                            .visible(false)
                            .decorations(false)
                            .skip_taskbar(true)
                            .build()
                    });
                if !matches!(built, Some(Ok(_))) {
                    eprintln!("{LOG} the hidden scan window couldn't open");
                }
            }
            // The weekly check: looked at once an hour, so a check due while Clotr wasn't running starts
            // within the hour of it next being on, rather than waiting for the following week's moment.
            let (weekly_handle, weekly_c) = (handle.clone(), shared.clone());
            std::thread::Builder::new()
                .name("clotr-weekly".into())
                .spawn(move || loop {
                    let due = {
                        let store = lock(&weekly_c.store);
                        let enabled = store.settings().get("weeklyCheck") == Some(&Value::Bool(true));
                        enabled && weekly_check_due(now_ms() as u64, store.last_weekly_check())
                    };
                    if due && !weekly_c.weekly_running.swap(true, Ordering::SeqCst) {
                        start_weekly_check(&weekly_handle, &weekly_c);
                    }
                    std::thread::sleep(std::time::Duration::from_secs(3600));
                })?;
            // The card's own idle watchdog: gives its hidden window's memory back once nothing has needed it
            // for CARD_IDLE_DESTROY, rebuilt fresh (card_window, the same path the very first AI app in front
            // ever used) the next time something does. Never while it's actually on screen.
            let (card_idle_handle, card_idle_c) = (handle.clone(), shared.clone());
            std::thread::Builder::new()
                .name("clotr-card-idle".into())
                .spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(60).min(card_idle_destroy()));
                    let idle_long_enough =
                        lock(&card_idle_c.card_last_needed).is_some_and(|t| t.elapsed() >= card_idle_destroy());
                    let showing = lock(&card_idle_c.brain).showing().is_some();
                    if idle_long_enough && !showing {
                        if let Some(w) = card_idle_handle.get_webview_window("card") {
                            card_idle_c.card_ready.store(false, Ordering::SeqCst);
                            let _ = w.close();
                        }
                        *lock(&card_idle_c.card_last_needed) = None;
                    }
                })?;
            // The typing check's own thread: idle until the brain names an AI app in front.
            typing::start(Box::new(TypingHost { app: handle.clone() }))?;
            let (tx, rx) = std::sync::mpsc::channel();
            watch::start(tx)?;
            let c = shared.clone();
            std::thread::Builder::new().name("clotr-hear".into()).spawn(move || {
                for heard in rx {
                    hear(&handle, &c, heard);
                }
            })?;
            Ok(())
        })
        .build(context);
    match app {
        Ok(app) => app.run(|_, event| {
            // Closing a window never quits Clotr: it keeps watching from the tray until "Quit Clotr".
            if let RunEvent::ExitRequested { api, code: None, .. } = event {
                api.prevent_exit();
            }
        }),
        Err(_) => eprintln!("{LOG} couldn't start"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_first_close_of_a_window_the_person_saw_brings_the_toast() {
        assert!(close_toast_due(true, false));
        assert!(!close_toast_due(true, true), "never a second time");
        assert!(!close_toast_due(false, false), "the weekly check's hidden window closing on its own");
    }

    #[test]
    fn the_tray_says_what_a_click_does_next_in_either_language() {
        let en = words::Words::new("en");
        assert_eq!(en.t(pause_word(false)), "Pause until I turn it back on");
        assert_eq!(en.t(pause_word(true)), "Resume Clotr");
        assert_eq!(en.t(tooltip_word(false)), "Clotr checks what you copy while an AI app is in front");
        let es = words::Words::new(&words::effective_locale(Some("es"), "en-US"));
        assert_eq!(es.t(pause_word(false)), "Pausar hasta que lo vuelva a activar");
        assert_eq!(es.t(pause_word(true)), "Reanudar Clotr");
        assert_eq!(es.t(tooltip_word(false)), "Clotr revisa lo que copias mientras tienes delante una app de IA");
        assert_eq!(en.t("ws.closedToast"), "Clotr is still on, by the clock (look under ^).");
        assert_eq!(es.t("ws.closedToast"), "Clotr sigue activo junto al reloj (búscalo bajo ^).");
    }

    #[test]
    fn the_extension_page_is_the_sites_own_and_the_main_window_alone_may_open_it() {
        assert_eq!(EXTENSION_PAGE, "https://clotr.app/extension.html");
        assert!(app_registered_commands().contains(&"open_extension_page"));
        let main: Value = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert!(main["permissions"].as_array().unwrap().contains(&json!("allow-open-extension-page")));
        for other in ["../capabilities/card.json", "../capabilities/flyout.json"] {
            let text = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(other))
                .unwrap();
            assert!(!text.contains("open-extension-page"), "{other}");
        }
    }

    #[test]
    fn the_registered_handler_contains_only_commands_compiled_for_this_build() {
        let registered_one_clotr: Vec<_> = app_registered_commands()
            .iter()
            .copied()
            .filter(|command| command.starts_with("one_clotr_"))
            .collect();
        let expected: &[&str] = if cfg!(feature = "one-clotr") {
            &["one_clotr_status", "one_clotr_consent", "one_clotr_disconnect"]
        } else {
            &[]
        };
        assert_eq!(registered_one_clotr, expected);
        assert!(app_registered_commands().contains(&"settings_hello"));
    }

    #[test]
    fn the_built_feature_record_matches_the_compiled_application() {
        let record: Value = serde_json::from_str(
            &std::fs::read_to_string(env!("CLOTR_BUILD_FEATURES_PATH")).expect("Cargo feature record exists"),
        )
        .expect("Cargo feature record is valid JSON");
        assert_eq!(record["oneClotr"], cfg!(feature = "one-clotr"));
        assert_eq!(record["scanTimes"], cfg!(feature = "scan-times"));
    }

    #[test]
    fn capabilities_keep_one_clotr_commands_in_their_feature_only_file() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let config: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("tauri.conf.json")).expect("Tauri config exists"),
        )
        .expect("Tauri config is valid JSON");
        let configured = config["app"]["security"]["capabilities"]
            .as_array()
            .expect("default capability names are listed in tauri.conf.json");
        assert!(!configured.iter().any(|name| name == "one-clotr"));

        for name in configured {
            let name = name.as_str().expect("capability name is a string");
            let capability: Value = serde_json::from_str(
                &std::fs::read_to_string(root.join("capabilities").join(format!("{name}.json")))
                    .expect("configured capability file exists"),
            )
            .expect("configured capability file is valid JSON");
            let permissions = capability["permissions"].as_array().expect("permissions are listed");
            assert!(!permissions
                .iter()
                .filter_map(Value::as_str)
                .any(|permission| permission.starts_with("allow-one-clotr-")));
        }

        let one_clotr: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("one-clotr-capabilities/one-clotr.json"))
                .expect("One Clotr capability file exists"),
        )
        .expect("One Clotr capability file is valid JSON");
        assert_eq!(
            one_clotr["permissions"],
            serde_json::json!([
                "allow-one-clotr-status",
                "allow-one-clotr-consent",
                "allow-one-clotr-disconnect"
            ])
        );
    }

    #[test]
    fn the_report_link_names_kinds_only_on_clotrs_own_repository() {
        let ok = "https://github.com/clotr-app/clotr/issues/new?template=false-alarm.yml&title=False%20alarm%3A%20Credit%20Card%20Number&kind=Credit%20Card%20Number";
        assert!(report_link_ok(ok));
        assert!(!report_link_ok("https://example.com/?template=false-alarm.yml"));
        assert!(!report_link_ok(
            "https://github.com/clotr-app/clotr/issues/new?template=false-alarm.yml&title=4111111111111111"
        ));
        assert!(!report_link_ok(
            "https://github.com/someone/clotr/issues/new?template=false-alarm.yml&title=x"
        ));
    }

    #[test]
    fn the_notes_mailto_link_carries_only_a_subject_and_a_body() {
        assert!(mailto_ok("mailto:?subject=A%20note&body=Clotr%20found..."));
        assert!(mailto_ok("mailto:?body=Clotr%20found..."));
        assert!(
            !mailto_ok("mailto:someone@example.com?subject=x&body=y"),
            "no address of its own"
        );
        assert!(
            !mailto_ok("mailto:?subject=x&cc=someone@example.com&body=y"),
            "no field past subject and body"
        );
        assert!(!mailto_ok("mailto:?subject=x&subject=y&body=z"), "no repeated field");
        assert!(!mailto_ok("mailto:?"), "nothing to send isn't a valid note");
        assert!(!mailto_ok("https://example.com/?subject=x&body=y"), "mailto only");
    }

    #[test]
    fn format_windows_version_combines_product_and_display_falling_back_when_either_is_missing() {
        assert_eq!(
            format_windows_version(Some("Windows 11 Pro".to_string()), Some("23H2".to_string())),
            "Windows 11 Pro, 23H2"
        );
        assert_eq!(
            format_windows_version(Some("Windows 11 Pro".to_string()), None),
            "Windows 11 Pro"
        );
        assert_eq!(format_windows_version(None, Some("23H2".to_string())), "Windows, 23H2");
        assert_eq!(format_windows_version(None, None), "Windows");
    }

    #[test]
    fn report_a_problem_may_address_only_clotrs_own_support_account_never_another() {
        assert!(mailto_ok(
            "mailto:support@clotr.app?subject=Clotr&body=What%20happened..."
        ));
        assert!(
            !mailto_ok("mailto:someone@example.com?subject=Clotr&body=x"),
            "not a page's own address"
        );
        assert!(
            !mailto_ok("mailto:support@clotr.app.evil.example?subject=x&body=y"),
            "the address, exactly"
        );
        assert!(
            !mailto_ok("mailto:support@clotr.app?subject=x&cc=someone@example.com&body=y"),
            "still only subject and body"
        );
    }

    /// chat_link_ok() agrees with lookback-core.js's chatLinkOk() on every case in the shared
    /// list (tests/lookback.test.js reads the same file). `null` isn't a case here: Rust has no such value for a
    /// `&str`, so that one stays JS-only.
    #[test]
    fn chat_link_ok_agrees_with_the_extensions_chatlinkok_on_the_shared_cases() {
        let cases: Value = serde_json::from_str(include_str!("../../../../tests/fixtures/chat-link-cases.json"))
            .expect("the shared chat-link cases parse as JSON");
        let cases = cases.as_array().expect("a list of cases");
        assert!(
            cases.len() > 5,
            "the shared list should hold more than a token case or two"
        );
        for case in cases {
            let url = case["url"].as_str().expect("each case names a url");
            let ok = case["ok"].as_bool().expect("each case says ok");
            assert_eq!(chat_link_ok(url), ok, "{url}");
        }
    }

    /// `lookback_link_ok`: a real chat address, or exactly one of the fixed company pages; nothing an
    /// export's own JSON or a stray argument could shape into looking like one.
    #[test]
    fn lookback_link_ok_allows_a_real_chat_or_one_of_the_fixed_company_pages_only() {
        for url in LOOKBACK_TOOL_LINKS {
            assert!(lookback_link_ok(url), "{url}");
        }
        assert!(lookback_link_ok(
            "https://chatgpt.com/c/01234567-89ab-4def-89ab-0123456789ab"
        ));
        assert!(lookback_link_ok(
            "https://claude.ai/chat/01234567-89ab-4def-89ab-0123456789ab"
        ));
        assert!(lookback_link_ok("https://myactivity.google.com/product/gemini"));
        assert!(!lookback_link_ok("https://chatgpt.com/settings"));
        assert!(!lookback_link_ok("https://chatgpt.com.evil.example/"));
        assert!(!lookback_link_ok("javascript:alert(1)"));
        assert!(!lookback_link_ok(""));
    }

    #[test]
    fn the_main_window_is_1280_by_800_when_the_screen_has_room_and_never_below_900_by_600() {
        assert_eq!(main_size((1707.0, 1019.0)), (1280.0, 800.0)); // 2560 x 1600 at 150%
        assert_eq!(main_size((1920.0, 1032.0)), (1280.0, 800.0));
        assert_eq!(main_size((1366.0, 728.0)), (1280.0, 680.0)); // 1366 x 768 at 100%: it fits under the taskbar
        assert_eq!(main_size((1280.0, 680.0)), (1264.0, 632.0));
        assert_eq!(main_size((910.0, 512.0)), (900.0, 600.0)); // 1366 x 768 at 150%: the minimum
    }

    #[test]
    fn the_weekly_check_is_due_the_first_time_and_again_a_week_later_never_sooner() {
        assert!(weekly_check_due(1_700_000_000_000, None));
        let last = 1_700_000_000_000u64;
        assert!(!weekly_check_due(last + WEEK_MS - 1, Some(last)));
        assert!(weekly_check_due(last + WEEK_MS, Some(last)));
        assert!(weekly_check_due(last + WEEK_MS * 3, Some(last)));
    }

    #[test]
    fn the_tray_icon_shows_a_pause_over_worth_a_look_and_on_when_quiet() {
        assert_eq!(tray_icon_for(true, true), "off");
        assert_eq!(tray_icon_for(true, false), "off");
        assert_eq!(tray_icon_for(false, true), "look");
        assert_eq!(tray_icon_for(false, false), "on");
    }

    #[test]
    fn the_flyout_sits_above_the_tray_icon_right_aligned_to_it() {
        let work = (0.0, 0.0, 1920.0, 1040.0);
        assert_eq!(flyout_spot(1900.0, 1020.0, work, 320.0, 360.0), (1580.0, 652.0));
        // The same spot in a screen already in logical pixels at 150% scaling: the function doesn't see the
        // scale at all, only whatever logical numbers its caller already converted.
        let work_150 = (0.0, 0.0, 1280.0, 693.0);
        assert_eq!(flyout_spot(1260.0, 680.0, work_150, 320.0, 360.0), (940.0, 312.0));
    }

    /// A guessed height taller than the flyout's real content used to reserve that much room above the tray
    /// icon too, sitting the flyout further from it than it needed to be (on top of showing as an empty frame).
    /// flyout_fit replaces the guess with flyout.js's measured size, which this pins numerically.
    #[test]
    fn a_too_tall_guess_used_to_sit_the_flyout_further_above_the_icon_than_its_real_content_needs() {
        let work = (0.0, 0.0, 1920.0, 1040.0);
        let icon_top = 1020.0;
        let (_, guessed_y) = flyout_spot(1900.0, icon_top, work, 320.0, 360.0); // the old hardcoded FLYOUT_SIZE
        let (_, real_y) = flyout_spot(1900.0, icon_top, work, 320.0, 290.0); // flyout.js's measured content
        assert!(
            real_y > guessed_y,
            "a shorter, real height sits closer to the icon, not reserved for a guess"
        );
        assert_eq!(real_y, icon_top - 290.0 - 8.0);
    }

    #[test]
    fn the_flyout_stays_on_the_screen() {
        let work = (0.0, 0.0, 1920.0, 1040.0);
        assert_eq!(
            flyout_spot(40.0, 1020.0, work, 320.0, 360.0),
            (0.0, 652.0),
            "an icon near the screen's left edge"
        );
        assert_eq!(
            flyout_spot(1900.0, 20.0, work, 320.0, 360.0),
            (1580.0, 0.0),
            "an icon near the top (a vertical taskbar)"
        );
    }
}
