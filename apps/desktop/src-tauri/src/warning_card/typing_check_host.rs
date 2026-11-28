use super::card_window::act;
use super::typing_check;
use crate::main_window::settings_commands::settings_view;
use crate::watching::clipboard_check_rules;
use crate::{lock, Clotr, LOG};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

// ---------- The typing check (typing_check.rs) ----------

/// typing_check.rs's questions, each answered by the brain, so the same rules that gate the clipboard gate the box.
pub(crate) struct TypingHost {
    pub(crate) app: AppHandle,
}

impl TypingHost {
    fn clotr(&self) -> Arc<Clotr> {
        self.app.state::<Arc<Clotr>>().inner().clone()
    }
}

impl typing_check::Host for TypingHost {
    fn may_watch(&self, hwnd: isize, shape: typing_check::Shape) -> bool {
        let shape = match shape {
            typing_check::Shape::Chat => clipboard_check_rules::BoxShape::Chat,
            typing_check::Shape::Password => clipboard_check_rules::BoxShape::Password,
            typing_check::Shape::NotChat | typing_check::Shape::Unreadable => clipboard_check_rules::BoxShape::Other,
        };
        lock(&self.clotr().brain)
            .on_box(hwnd, shape)
            .contains(&clipboard_check_rules::Do::WatchBox)
    }

    fn may_read(&self, hwnd: isize) -> bool {
        lock(&self.clotr().brain).on_typed(hwnd).contains(&clipboard_check_rules::Do::ReadBox)
    }

    fn read(&self, hwnd: isize, text: String) {
        let clotr = self.clotr();
        let seq = clotr.typed_seq.fetch_add(1, Ordering::SeqCst);
        let todo = lock(&clotr.brain).typed(seq, hwnd, text.trim().is_empty());
        if todo.iter().any(|step| matches!(step, clipboard_check_rules::Do::CheckTyped { .. })) {
            *lock(&clotr.typed_text) = Some((seq, text));
        }
        act(&self.app, &clotr, todo);
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
                list.retain(|listed| listed != &id);
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
    fn looked(&self, look: &typing_check::Look) {
        trace_typing(&format!("look {:?}", typing_check::shape_of(look)));
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
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// The names of the AI apps whose box Clotr couldn't read, for Home and the flyout.
pub(crate) fn blind_names(clotr: &Clotr) -> Vec<String> {
    let blind = lock(&clotr.blind);
    clotr.apps
        .iter()
        .filter(|app| blind.contains(&app.id))
        .map(|app| app.name.clone())
        .collect()
}
