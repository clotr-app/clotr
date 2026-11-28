use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::menu::MenuItem;
use tauri::WebviewWindow;

use crate::ai_apps::{ai_app_list, window_program};
use crate::check_my_files::{self, move_somewhere_private};
use crate::saved_data::store_file;
use crate::tray::tray_menu::FlyoutAnchor;
use crate::tray::tray_words;
use crate::watching::clipboard_check_rules;

// ---------- The app's state ----------

pub(crate) const LOG: &str = "[Clotr]";

/// The lock, taken even after a thread panicked while holding it.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct Clotr {
    pub(crate) apps: Vec<ai_app_list::AiApp>,
    /// Every maker the built-in list names, whether or not an app currently claims it -- the safety net
    /// `front_of` checks once `ai_app_list::find` already came up empty.
    pub(crate) makers: Vec<ai_app_list::Maker>,
    pub(crate) terminals: Vec<ai_app_list::AiApp>,
    pub(crate) store: Mutex<store_file::Store>,
    pub(crate) brain: Mutex<clipboard_check_rules::Brain>,
    pub(crate) locale: String,
    pub(crate) webview_dir: PathBuf,
    pub(crate) browser_args: String,
    pub(crate) card_ready: AtomicBool,
    pub(crate) pending: Mutex<Option<Value>>,
    pub(crate) size: Mutex<(f64, f64)>,
    pub(crate) chosen: Mutex<Vec<PathBuf>>,
    pub(crate) scan: Mutex<Option<Arc<check_my_files::scan_run::ScanRun>>>,
    /// *Move to the Recycle Bin*'s own undo (4-10): the trash item for each index recycled by the scan now on
    /// screen, cleared the moment a new one starts (the same index can't outlive the run it came from).
    pub(crate) recycled: Mutex<std::collections::HashMap<usize, trash::TrashItem>>,
    /// *Move it somewhere private*'s own undo: where each moved index came from and where it landed, cleared
    /// the moment a new scan starts, the same as `recycled`.
    pub(crate) moved: Mutex<std::collections::HashMap<usize, move_somewhere_private::Moved>>,
    /// The folder *Move it somewhere private* picked last, by `move_pick_folder`, kept here rather than handed to
    /// the page: Results only ever sees the folder's own name, never its path.
    pub(crate) move_dest: Mutex<Option<PathBuf>>,
    /// Home's status (home_status.rs): false only when Clotr's copy check can't run at all. Nothing in the trial flips
    /// this yet; it's forced true for tests until a later piece wires a real trigger to it.
    pub(crate) running: AtomicBool,
    /// True once something from the last weekly check still waits for the person (home_status.rs's "look"), set in
    /// weekly_check_done and carried over a restart through the store's own lastWeeklyFind.
    pub(crate) worth_a_look: AtomicBool,
    /// When a timed pause (the tray flyout's "Pause for an hour") ends, in milliseconds since the epoch; None
    /// for an indefinite pause or no pause at all. Saved with the pause (the store's pausedUntil), so a restart
    /// within the hour picks it up again.
    pub(crate) paused_until: Mutex<Option<i64>>,
    /// The flyout's own real size, reported by flyout.js once its page has laid out; FLYOUT_GUESS until then.
    /// Used to place it (flyout_position) the same way on every open, not just the first.
    pub(crate) flyout_size: Mutex<(f64, f64)>,
    /// The tray icon's rect the flyout was last opened from, kept so `flyout_fit` can reposition it once the real
    /// size comes in, without Windows handing Clotr a fresh click.
    pub(crate) flyout_rect: Mutex<Option<FlyoutAnchor>>,
    /// The tray menu's own items, kept so their words can follow the pause and Settings' Language (`retell_tray`).
    /// None until `tray()` builds the menu.
    pub(crate) tray_items: Mutex<Option<TrayItems>>,
    /// Home's first-run line, which says Clotr doesn't start with Windows until it's switched on. True for
    /// the whole of the first start, so the line stays put once its switch is flipped, and false from then on.
    pub(crate) start_line: bool,
    /// One weekly check at a time: set the moment the scheduler starts one (before its hidden window even
    /// exists), cleared by `weekly_check_done` or, if that never comes, the watchdog in `start_weekly_check`.
    pub(crate) weekly_running: AtomicBool,
    /// The program in front right now, if it's signed by (or packaged under) a known AI maker but matched no app:
    /// its own file name and the maker's name, never a path. `None` once the front changes to anything else.
    /// Never written to disk -- it's read fresh on every foreground change.
    pub(crate) unmatched_maker: Mutex<Option<(String, String)>>,
    /// What the typing check just read, waiting for the card's page to take it (once): its check's number and the
    /// text. Replaced by the next read, emptied when the typing check stops. Never written anywhere.
    pub(crate) typed_text: Mutex<Option<(u32, String)>>,
    /// The typed checks' own numbers, from 2^31 up, so they never look like a clipboard sequence number.
    pub(crate) typed_seq: AtomicU32,
    /// The AI apps whose message box Clotr couldn't read this run, by id: Home and the flyout say so. Cleared for
    /// an app once its box is read again.
    pub(crate) blind: Mutex<Vec<String>>,
    /// The last moment `card_window` ran -- an AI app or terminal surface was in front, or a check needed the
    /// card -- so the idle watchdog (CARD_IDLE_DESTROY) only ever gives the card's hidden window's memory back
    /// once nothing has actually needed it for a good while, never mid-session just because it hasn't had to
    /// show itself. None until the card has ever been built.
    pub(crate) card_last_needed: Mutex<Option<std::time::Instant>>,
}

pub(crate) struct TrayItems {
    pub(crate) open: MenuItem<tauri::Wry>,
    pub(crate) pause: MenuItem<tauri::Wry>,
    pub(crate) quit: MenuItem<tauri::Wry>,
}

impl Clotr {
    /// The language every window and the tray speak right now: Settings' Language, or Windows' own.
    pub(crate) fn locale_now(&self) -> String {
        tray_words::effective_locale(lock(&self.store).language().as_deref(), &self.locale)
    }

    /// The AI apps Home and the flyout count as covered: on this PC by their Store package, or seen in front.
    pub(crate) fn covered_apps(&self, store: &store_file::Store) -> Vec<&ai_app_list::AiApp> {
        let seen = store.seen_apps();
        self.apps
            .iter()
            .filter(|app| ai_app_list::covered(app, &mut window_program::package_installed, &seen))
            .collect()
    }

    pub(crate) fn app_ids(&self) -> Vec<String> {
        self.apps.iter().map(|app| app.id.clone()).collect()
    }

    pub(crate) fn paused_apps(&self, store: &store_file::Store) -> Vec<String> {
        self.apps
            .iter()
            .filter(|app| store.app_paused(&app.id))
            .map(|app| app.id.clone())
            .collect()
    }
}

// ---------- Where things live ----------

/// %LOCALAPPDATA%\Clotr\Desktop: this computer only (never the roaming profile), and a folder of its own that a
/// test can point at a test folder instead.
pub(crate) fn data_dir() -> PathBuf {
    #[cfg(feature = "dk-test-app")]
    if let Some(dir) = std::env::var_os("CLOTR_DESKTOP_DATA") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("Clotr").join("Desktop")
}

/// Every command's window check: "not-allowed" unless the call came from the window named `label`.
pub(crate) fn only(window: &WebviewWindow, label: &str) -> Result<(), String> {
    (window.label() == label)
        .then_some(())
        .ok_or_else(|| "not-allowed".to_string())
}
