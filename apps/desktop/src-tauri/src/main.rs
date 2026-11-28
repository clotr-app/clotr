//! Clotr for Windows (the desktop trial): while an AI app is in front, what you copy is checked with
//! Clotr's own engine, and a card beside the app warns you before you paste a personal detail there. Clot this leak in
//! what you copied, or leave it alone. 100% local: no network code, a web view kept offline, nothing detected stored.
//!
//! The parts: windows_events.rs listens to Windows (the window in front, the clipboard), clipboard_check_rules.rs decides when to check and
//! what the card does, clipboard.rs reads and writes the clipboard, card_placement.rs places the card's window, store_file.rs is the one
//! writer, ai_app_list.rs knows the AI apps. The pages (ui/) run the engine and draw the card and the main window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(windows))]
compile_error!("Clotr for Windows builds on Windows only; a Mac build isn't planned yet.");

mod ai_apps;
mod app_setup;
mod app_state;
mod check_my_files;
mod extension_check;
#[allow(dead_code)]
mod feature_gates;
mod main_window;
#[cfg(feature = "one-clotr")]
mod one_clotr;
mod saved_data;
mod tray;
mod warning_card;
mod watching;

use ai_apps::{ai_app_list, run_box_and_terminals};
use app_setup::offline_web_view;
#[cfg(not(feature = "dk-test-app"))]
use app_setup::start_with_windows;
use app_state::{data_dir, lock, only, Clotr, TrayItems, LOG};
use check_my_files::results_commands::{
    move_pick_folder, open_mailto, save_accuracy_export, save_summary, scan_ignore, scan_move, scan_recycle,
    scan_reveal, scan_save_copy, scan_unmove, scan_unrecycle,
};
use check_my_files::scan_commands::{
    scan_batch, scan_cancel, scan_end, scan_exclude_from, scan_exclude_pick, scan_exclude_type, scan_next,
    scan_pick_folders, scan_start, scan_unexclude,
};
use check_my_files::weekly_check::{start_weekly_check, weekly_check_done, weekly_check_due};
use extension_check::extension_check_commands::{ext_check, ext_reveal};
use main_window::allowed_links::{lookback_dk_fixture, open_extension_page, open_lookback_link, open_report};
#[cfg(feature = "dk-test-app")]
use main_window::open_main_window::MAIN_SIZE;
#[cfg(any(feature = "dk-test-app", feature = "one-clotr"))]
use main_window::open_main_window::open_main_to;
use main_window::open_main_window::open_main;
#[cfg(feature = "one-clotr")]
use main_window::settings_commands::{one_clotr_consent, one_clotr_disconnect, one_clotr_status};
use main_window::settings_commands::{
    accuracy_answer, clear_accuracy_answers, clear_history, clear_scan_ignored, flyout_hello, import_settings, now_ms,
    save_settings, set_paused, set_tourniquet, settings_hello,
};
#[cfg(feature = "one-clotr")]
use one_clotr::{one_clotr_pipe, one_clotr_protocol};
use saved_data::store_file;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(feature = "dk-test-app")]
use tauri::Rect;
#[cfg(feature = "one-clotr")]
use tauri::Emitter;
use tauri::{AppHandle, Manager, RunEvent};
#[cfg(feature = "dk-test-app")]
use tray::flyout_commands::hide_flyout;
use tray::flyout_commands::{close_flyout, flyout_fit, flyout_open, flyout_pause, flyout_quit, flyout_scan};
#[cfg(feature = "dk-test-app")]
use tray::tray_menu::toggle_flyout;
use tray::tray_menu::{lift_pause_at, tray, FLYOUT_GUESS};
use tray::tray_words;
use warning_card::card_commands::{
    back_to_app, card_done, card_hello, copy_note, copy_safe, hide_in_clipboard, paste_clip, read_box_again, read_clip,
    read_typed, record, record_scan, resize_card, set_responses, show_card, typed_note_seen,
};
#[cfg(feature = "dk-test-app")]
use warning_card::card_window::card_window;
use warning_card::card_window::{card_idle_close_due, card_idle_destroy};
use warning_card::typing_check;
use warning_card::typing_check_host::TypingHost;
use watching::front_window::hear;
use watching::{clipboard_check_rules, windows_events};

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

// ---------- Every command, in one list ----------

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

// ---------- main() ----------

fn main() {
    // ---------- One Clotr at a time, and its data ----------
    if !first_instance() {
        return;
    }
    let data = data_dir();
    let webview_dir = data.join("webview");
    offline_web_view::clear_crash_reports(&webview_dir);
    let Ok(mut store) = store_file::Store::open(&data) else {
        eprintln!("{LOG} couldn't open its data folder");
        return;
    };

    // ---------- The app's state ----------
    let start_line = note_start_line(&mut store);
    let (running, worth_a_look) = start_status(&mut store);
    let apps = ai_app_list::built_in();
    // A timed pause from before a restart, still running (Store::open already ended one whose hour passed).
    let paused_until = store.paused_until();
    let brain = starting_brain(&store, &apps);
    let clotr = Arc::new(Clotr {
        apps,
        makers: ai_app_list::built_in_makers(),
        terminals: run_box_and_terminals::built_in_terminals(),
        store: Mutex::new(store),
        brain: Mutex::new(brain),
        locale: tray_words::system_locale(),
        webview_dir,
        browser_args: offline_web_view::browser_args(),
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
        paused_until: Mutex::new(paused_until),
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

    // ---------- Tauri's commands and context ----------
    let invoke_handler = app_invoke_handler();
    // One Clotr's grants come in only with its commands. capabilities/ is read by every build, and a grant there for
    // a command the build doesn't register stops Tauri's build step.
    #[cfg(feature = "one-clotr")]
    let context = tauri::generate_context!(capabilities = ["one-clotr-capabilities/one-clotr.json"]);
    #[cfg(not(feature = "one-clotr"))]
    let context = tauri::generate_context!();

    // ---------- Run, until "Quit Clotr" ----------
    let shared = clotr.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(clotr)
        .invoke_handler(invoke_handler)
        .setup(move |app| set_up_app(app, &shared, paused_until))
        .build(context);
    match app {
        Ok(app) => app.run(on_run_event),
        Err(_) => eprintln!("{LOG} couldn't start"),
    }
}

// ---------- Start-up's steps, in main()'s order ----------

/// Home's first-run line shows for the whole of this first start and never again.
fn note_start_line(store: &mut store_file::Store) -> bool {
    let start_line = !store.once(store_file::Once::StartLine);
    if start_line && store.set_once(store_file::Once::StartLine).is_err() {
        eprintln!("{LOG} couldn't save that the first-run line showed");
    }
    start_line
}

/// Home's status as Clotr starts, as (running, worth_a_look). A weekly check's last result survives a restart
/// (store_file.rs's own write), so Home doesn't forget what still waits for the person just because Clotr was
/// closed and opened again.
fn start_status(store: &mut store_file::Store) -> (bool, bool) {
    let worth_a_look = store.weekly_find_total() > 0;
    forced_status(store, true, worth_a_look)
}

/// Testing only: forces Home's status past a real trigger (worth_a_look) or a real outage (running) to drive
/// it.
#[cfg(feature = "dk-test-app")]
fn forced_status(store: &mut store_file::Store, running: bool, worth_a_look: bool) -> (bool, bool) {
    let Ok(force) = std::env::var("CLOTR_FORCE_STATUS") else {
        return (running, worth_a_look);
    };
    match force.as_str() {
        "look" => (running, true),
        "notRunning" => (false, worth_a_look),
        "paused" => {
            let _ = store.set_paused_all(true);
            (running, worth_a_look)
        }
        _ => (running, worth_a_look),
    }
}

/// Outside the checks, the status is the real one.
#[cfg(not(feature = "dk-test-app"))]
fn forced_status(_: &mut store_file::Store, running: bool, worth_a_look: bool) -> (bool, bool) {
    (running, worth_a_look)
}

/// The brain as Clotr starts: paused as the person left it, all at once or app by app, and the typing check
/// on or off.
fn starting_brain(store: &store_file::Store, apps: &[ai_app_list::AiApp]) -> clipboard_check_rules::Brain {
    clipboard_check_rules::Brain {
        paused: store.paused_all(),
        paused_apps: apps
            .iter()
            .filter(|app| store.app_paused(&app.id))
            .map(|app| app.id.clone())
            .collect(),
        typing: store.typing_check(),
        ..Default::default()
    }
}

// ---------- Once Tauri is up ----------

/// Everything that waits for Tauri: One Clotr's pipe, the tray, a timed pause's end, the first window and
/// Clotr's own threads.
fn set_up_app(
    app: &tauri::App,
    shared: &Arc<Clotr>,
    paused_until: Option<i64>,
) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    #[cfg(feature = "one-clotr")]
    {
        let pipe_app = handle.clone();
        std::thread::Builder::new()
            .name("one-clotr-pipe".into())
            .spawn(move || one_clotr_pipe::serve(move |request| answer_one_clotr(&pipe_app, request)))?;
    }
    tray(&handle, shared)?;
    if let Some(until) = paused_until {
        lift_pause_at(&handle, shared, until);
    }
    open_first_window(&handle);
    #[cfg(feature = "dk-test-app")]
    open_for_tests(&handle, shared);
    start_weekly_thread(&handle, shared)?;
    start_card_idle_watchdog(&handle, shared)?;
    // The typing check's own thread: idle until the brain names an AI app in front.
    typing_check::start(Box::new(TypingHost { app: handle.clone() }))?;
    start_hearing(handle, shared)?;
    Ok(())
}

/// One Clotr's pipe, answered. A pair request still waiting opens Settings and tells it One Clotr changed.
#[cfg(feature = "one-clotr")]
fn answer_one_clotr(pipe_app: &AppHandle, request: Value) -> Value {
    let answer = one_clotr_protocol::reply(&request);
    if request["type"] == "pair_request" && answer["type"] == "pair_pending" {
        let app = pipe_app.clone();
        let _ = pipe_app.run_on_main_thread(move || {
            open_main_to(&app, "settings");
            let _ = app.emit_to("main", "one-clotr-changed", ());
        });
    }
    answer
}

/// A person launching Clotr (its shortcut, or a taskbar pin) sees the main window open, the same as any other
/// app; only the weekly check's own hidden window (start_weekly_check) and the automated test harness stay in
/// the tray on purpose, and so does a start at sign-in, which shouldn't throw a window in front of someone
/// who just logged in.
#[cfg(not(feature = "dk-test-app"))]
fn open_first_window(handle: &AppHandle) {
    if !start_with_windows::launched_at_startup(std::env::args()) {
        open_main(handle);
    }
}

/// Testing only: the main window opens only when a check asks for it, on Check my files or on Home.
#[cfg(feature = "dk-test-app")]
fn open_first_window(handle: &AppHandle) {
    if std::env::var_os("CLOTR_OPEN_SCAN").is_some() {
        open_main_to(handle, "scan");
    } else if std::env::var_os("CLOTR_OPEN_MAIN").is_some() {
        open_main(handle);
    }
}

// ---------- Testing only: windows the checks open without the screen ----------

/// Each window a check asks for by name, opened the way a person or Clotr itself would.
#[cfg(feature = "dk-test-app")]
fn open_for_tests(handle: &AppHandle, shared: &Arc<Clotr>) {
    if std::env::var_os("CLOTR_OPEN_MAIN_THEN_CLOSE").is_some() {
        open_main_then_close(handle);
    }
    // For the idle-memory check (tests/cpu.rs): builds the card's own hidden window the same way the first AI
    // app coming to the front does (card_window), without needing a real AI app or the screen -- the card
    // stays hidden either way, so this is the same window a real run leaves behind once someone has opened an
    // AI app even once.
    if std::env::var_os("CLOTR_OPEN_CARD").is_some() {
        card_window(handle, shared);
    }
    if std::env::var_os("CLOTR_OPEN_FLYOUT").is_some() {
        open_flyout_for_test(handle);
    }
    if std::env::var_os("CLOTR_OPEN_FLYOUT_THEN_CLOSE").is_some() {
        open_flyout_then_close(handle, shared);
    }
    if std::env::var_os("CLOTR_SCAN_HIDDEN").is_some() {
        open_scan_hidden(handle, shared);
    }
}

/// For the idle-memory check (tests/cpu.rs): opens the main window the same way a person does, then closes it
/// the same way a real close does, without ever needing the screen.
#[cfg(feature = "dk-test-app")]
fn open_main_then_close(handle: &AppHandle) {
    open_main(handle);
    let closer = handle.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        if let Some(window) = closer.get_webview_window("main") {
            let _ = window.close();
        }
    });
}

/// Opens the flyout the same way a test opens the main window, above where a tray icon would be at the work
/// area's bottom right, since telling this test's tray icon apart from a real running trial's (same name,
/// same tray) isn't safe to automate on a shared PC.
#[cfg(feature = "dk-test-app")]
fn open_flyout_for_test(handle: &AppHandle) {
    let (x, y) = handle
        .primary_monitor()
        .ok()
        .flatten()
        .map(|primary| {
            let area = primary.work_area();
            (
                area.position.x + area.size.width as i32 - 40,
                area.position.y + area.size.height as i32 - 40,
            )
        })
        .unwrap_or((1880, 1000));
    let rect = Rect {
        position: tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)),
        size: tauri::Size::Physical(tauri::PhysicalSize::new(16, 16)),
    };
    toggle_flyout(handle, rect);
}

/// For the idle-processor check (tests/cpu.rs): builds the flyout invisible from the first frame (so there's
/// no window to flash on screen regardless of timing), then closes it the same way a real close does, to
/// check that closing actually leaves nothing behind running. The init script sets the paused state before
/// flyout.js or shield.css ever runs, since the Rust "visible" event (tauri.js) needs the page already loaded
/// to catch it, and a window that's never shown gives it no chance to.
#[cfg(feature = "dk-test-app")]
fn open_flyout_then_close(handle: &AppHandle, clotr: &Clotr) {
    let built = offline_web_view::window(
        handle,
        &clotr.webview_dir,
        &clotr.browser_args,
        &clotr.locale,
        "flyout",
        "flyout.html",
    )
    .map(|builder| {
        builder
            .title("Clotr")
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
        // Give WebView2 time to actually finish loading the page before closing it, so the check this feeds
        // (tests/cpu.rs) proves a flyout that really ran stops costing anything, not just one closed before
        // its browser process had a chance to start.
        std::thread::sleep(std::time::Duration::from_secs(3));
        hide_flyout(handle);
    } else {
        eprintln!("{LOG} the flyout couldn't start");
    }
}

/// For the scan check in tests/cpu.rs: the main window hidden from its first frame, the way the weekly check
/// opens it, on "Run a quick scan" (main.html#scan-quick), so a whole scan runs and then sits idle with
/// nothing on screen. Unlike the weekly check, it stays open afterwards, so the check can see what the
/// finished page still holds.
#[cfg(feature = "dk-test-app")]
fn open_scan_hidden(handle: &AppHandle, clotr: &Clotr) {
    let page = "main.html#scan-quick";
    let built = offline_web_view::window(handle, &clotr.webview_dir, &clotr.browser_args, &clotr.locale, "main", page)
        .map(|builder| {
            builder
                .inner_size(MAIN_SIZE.0, MAIN_SIZE.1)
                .visible(false)
                .decorations(false)
                .skip_taskbar(true)
                .build()
        });
    if !matches!(built, Some(Ok(_))) {
        eprintln!("{LOG} the hidden scan window couldn't open");
    }
}

// ---------- Clotr's own threads ----------

/// The weekly check: looked at once an hour, so a check due while Clotr wasn't running starts within the hour
/// of it next being on, rather than waiting for the following week's moment.
fn start_weekly_thread(handle: &AppHandle, shared: &Arc<Clotr>) -> std::io::Result<()> {
    let (weekly_handle, weekly_clotr) = (handle.clone(), shared.clone());
    std::thread::Builder::new()
        .name("clotr-weekly".into())
        .spawn(move || loop {
            let due = weekly_check_wanted(&weekly_clotr);
            if due && !weekly_clotr.weekly_running.swap(true, Ordering::SeqCst) {
                start_weekly_check(&weekly_handle, &weekly_clotr);
            }
            std::thread::sleep(std::time::Duration::from_secs(3600));
        })?;
    Ok(())
}

/// Whether the weekly check is switched on and a week has passed since the last one.
fn weekly_check_wanted(clotr: &Clotr) -> bool {
    let store = lock(&clotr.store);
    let enabled = store.settings().get("weeklyCheck") == Some(&Value::Bool(true));
    enabled && weekly_check_due(now_ms() as u64, store.last_weekly_check())
}

/// The card's own idle watchdog: gives its hidden window's memory back once nothing has needed it for
/// CARD_IDLE_DESTROY, rebuilt fresh (card_window, the same path the very first AI app in front ever used) the
/// next time something does. Never while a card is on screen or stepped aside for its app.
fn start_card_idle_watchdog(handle: &AppHandle, shared: &Arc<Clotr>) -> std::io::Result<()> {
    let (card_idle_handle, card_idle_clotr) = (handle.clone(), shared.clone());
    std::thread::Builder::new()
        .name("clotr-card-idle".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(60).min(card_idle_destroy()));
            close_idle_card(&card_idle_handle, &card_idle_clotr);
        })?;
    Ok(())
}

/// The card's window, closed once its idle time is up.
fn close_idle_card(app: &AppHandle, clotr: &Clotr) {
    let last_needed = *lock(&clotr.card_last_needed);
    let due = card_idle_close_due(last_needed, card_idle_destroy(), &lock(&clotr.brain));
    if !due {
        return;
    }
    if let Some(window) = app.get_webview_window("card") {
        clotr.card_ready.store(false, Ordering::SeqCst);
        let _ = window.close();
    }
    // Only the moment this decision read: one written since (card_window) still counts.
    let mut needed = lock(&clotr.card_last_needed);
    if *needed == last_needed {
        *needed = None;
    }
}

/// What the watcher hears (the window in front, a copy, a move, the shortcut), handled on its own thread.
fn start_hearing(handle: AppHandle, shared: &Arc<Clotr>) -> std::io::Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    windows_events::start(tx)?;
    let clotr_for_hear = shared.clone();
    std::thread::Builder::new().name("clotr-hear".into()).spawn(move || {
        for heard in rx {
            hear(&handle, &clotr_for_hear, heard);
        }
    })?;
    Ok(())
}

// ---------- While Clotr runs ----------

/// Clotr's own run: WebView2 let go once no window uses it, and a close never quitting.
fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        // No card, main or flyout is left to use WebView2: drop its environment so the browser process can
        // exit. A new window makes another environment through offline_web_view::window when Clotr needs one again.
        RunEvent::WindowEvent {
            event: tauri::WindowEvent::Destroyed,
            ..
        } if app.webview_windows().is_empty() => offline_web_view::release_environment(),
        // Closing a window never quits Clotr: it keeps watching from the tray until "Quit Clotr".
        RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
}
