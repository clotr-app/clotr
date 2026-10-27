//! When Clotr looks at the clipboard, and what happens to the card. No Windows calls here, so every rule is tested:
//!
//! - The clipboard is read only while an AI app or a surface (surfaces.rs: the Run box, a terminal, a browser's
//!   file box) is in front, and each copy is checked once.
//! - Something copied elsewhere is checked when an AI app or a surface comes to the front (that's when it could be
//!   pasted there).
//! - A copy made in a built-in AI app is skipped for credential checks, even if it is later carried to another AI
//!   app. A watched surface can still check it for a pasted command.
//! - The card belongs to one copy in one AI app or surface: it steps aside when another program comes to the
//!   front, comes back if nothing new was copied, and goes for good once the person chooses or copies something
//!   else.
//! - A copy from outside an AI app is checked for a credential there; a surface checks only for a pasted command.
//!   `Do::Check` and `Do::CheckSurface` keep those two reads separate.
//! - Clotr's own "Clot this leak" copy is never checked again.
//! - Paused (all of Clotr, or that app): nothing is read. A surface has no pause switch of its own yet, so it's
//!   read whenever Clotr as a whole isn't paused.
//! - The typing check (typing.rs) runs only on the AI app in front, only while it isn't paused and the switch is
//!   on, watches only a chat box there (never a password box), and reads it only when this says `Do::ReadBox`.
//!   A typed card never replaces a copy's card that's waiting for a choice, and never pastes.

#[derive(Clone, Debug, PartialEq)]
pub struct FrontApp {
    /// The AI app's window, as a number (window handles can't cross threads).
    pub hwnd: isize,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FrontSurface {
    pub hwnd: isize,
    /// "run" today; a terminal and a browser's file box add their own kind in a later build.
    pub kind: String,
}

/// What Clotr is watching right now: an AI app (checked for a credential) or a surface (checked for a pasted
/// command). Never both at once, and never confused for each other.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Watched {
    Ai(FrontApp),
    Surface(FrontSurface),
}

impl Watched {
    fn hwnd(&self) -> isize {
        match self {
            Watched::Ai(a) => a.hwnd,
            Watched::Surface(s) => s.hwnd,
        }
    }

    /// Whichever paused list could silence this (an AI app's own id); a surface doesn't have one yet.
    fn pausable_id(&self) -> Option<&str> {
        match self {
            Watched::Ai(a) => Some(&a.id),
            Watched::Surface(_) => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Card {
    pub seq: u32,
    watched: Watched,
    /// Shown (the page measured it and asked to be shown), or still being checked.
    pub shown: bool,
    /// The text box the card first appeared over (a UI Automation RuntimeId): `None` until shown, and never
    /// refreshed on a later re-show, so a stale mismatch after the person refocuses elsewhere safely stops a paste
    /// rather than risking the wrong target.
    pub focus: Option<Vec<i32>>,
    /// About what was typed in the box, not a copy: `seq` is then the typed check's own number, never the
    /// clipboard's, and the card never reads the clipboard or pastes.
    pub typed: bool,
}

/// What the focused element in the watched AI app is, as far as the brain needs to know (typing.rs looks).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BoxShape {
    Chat,
    Password,
    Other,
}

#[derive(Debug, PartialEq)]
pub enum Do {
    /// Ask the card's page to check this copy for a credential, against this AI app.
    Check { seq: u32, app: String },
    /// Ask the card's page to check this copy for a pasted command, against this surface. Never sent for an AI
    /// app's copy, and never read as a credential check.
    CheckSurface { seq: u32, kind: String },
    /// Show the card again beside this window.
    Show { hwnd: isize },
    /// Step aside: hide the card's window; it comes back with its AI app or surface.
    Hide,
    /// The card is over (a new copy, another AI app or surface, paused): hide it and let its page go.
    Drop,
    /// Start the typing check on this AI app's window: only an AI app, in front, not paused, switch on.
    TypingOn { hwnd: isize },
    /// Stop the typing check: every subscription goes.
    TypingOff,
    /// Subscribe to the focused box's text changes: a chat box in the AI app being watched, never anything else.
    WatchBox,
    /// Read the watched box now, typing having paused.
    ReadBox,
    /// Ask the card's page to check what was typed, against this AI app.
    CheckTyped { seq: u32, app: String },
}

/// What's in front.
#[derive(Clone, Debug, PartialEq)]
pub enum Front {
    Ai(FrontApp),
    Surface(FrontSurface),
    /// Clotr's own card: reached with the keyboard shortcut. Nothing changes.
    Card,
    /// Anything else, Clotr's main window included.
    Other,
}

#[derive(Default, Debug)]
pub struct Brain {
    // pub(crate), not private: main.rs builds a Brain with `..Default::default()`, which needs every field
    // visible at the call site even when it only names a few of them.
    pub(crate) front: Option<Watched>,
    pub(crate) checked: Option<u32>,
    /// A copy made by a built-in AI app; credential checks skip it, while surfaces may still check commands.
    pub(crate) copied_in_ai_app: Option<u32>,
    pub(crate) card: Option<Card>,
    pub paused: bool,
    pub paused_apps: Vec<String>,
    /// "Check what I type in AI apps".
    pub typing: bool,
    /// The AI app window the typing check is on, if it's on.
    pub(crate) typing_at: Option<isize>,
    /// That app's chat box is watched (a WatchBox was given for it).
    pub(crate) boxed: Option<isize>,
}

impl Brain {
    fn watching(&self, w: &Watched) -> bool {
        if self.paused {
            return false;
        }
        match w.pausable_id() {
            Some(id) => !self.paused_apps.iter().any(|a| a == id),
            None => true,
        }
    }

    /// Something new came to the front. `seq`: the clipboard's number now.
    #[cfg(test)]
    pub fn on_front(&mut self, front: Front, seq: u32) -> Vec<Do> {
        self.on_front_with_copy_origin(front, seq, false)
    }

    /// Something new came to the front, with whether the clipboard's owner is a built-in AI app.
    pub fn on_front_with_copy_origin(&mut self, front: Front, seq: u32, copied_in_ai_app: bool) -> Vec<Do> {
        let mut out = match front {
            Front::Card => return vec![],
            Front::Other => {
                self.front = None;
                if copied_in_ai_app {
                    self.copied_in_ai_app = Some(seq);
                }
                if self.card.as_ref().is_some_and(|c| c.shown) {
                    vec![Do::Hide]
                } else {
                    vec![]
                }
            }
            Front::Ai(app) => self.on_watched(Watched::Ai(app), seq, copied_in_ai_app),
            Front::Surface(s) => self.on_watched(Watched::Surface(s), seq, copied_in_ai_app),
        };
        self.sync_typing(&mut out);
        out
    }

    fn on_watched(&mut self, w: Watched, seq: u32, copied_in_ai_app: bool) -> Vec<Do> {
        let mut out = Vec::new();
        let watching = self.watching(&w);
        let hwnd = w.hwnd();
        self.front = Some(w.clone());
        if copied_in_ai_app {
            self.copied_in_ai_app = Some(seq);
        }
        let skipped_credential_copy = matches!(&w, Watched::Ai(_)) && self.copied_in_ai_app == Some(seq);
        let fresh_copy = watching && self.checked != Some(seq) && !skipped_credential_copy;
        if let Some(card) = &self.card {
            // A typed card belongs to its app's box, not to a copy, so it comes back with the app, unless a copy
            // that hasn't been checked is waiting there (that copy's check comes first).
            let mine = card.watched == w && if card.typed { !fresh_copy } else { card.seq == seq };
            if mine && watching {
                if card.shown {
                    out.push(Do::Show { hwnd });
                }
            } else {
                out.push(Do::Drop);
                self.card = None;
            }
        }
        if fresh_copy {
            out.extend(self.check(seq, w));
        }
        out
    }

    /// The clipboard changed. Read only with an AI app or a surface in front.
    #[cfg(test)]
    pub fn on_clipboard(&mut self, seq: u32) -> Vec<Do> {
        self.on_clipboard_with_copy_origin(seq, false)
    }

    /// The clipboard changed, with whether its owner is a built-in AI app.
    pub fn on_clipboard_with_copy_origin(&mut self, seq: u32, copied_in_ai_app: bool) -> Vec<Do> {
        let mut out = Vec::new();
        if self.checked == Some(seq) {
            return out; // Clotr's own copy, or nothing new
        }
        if self.card.take().is_some() {
            out.push(Do::Drop);
        }
        if copied_in_ai_app {
            self.copied_in_ai_app = Some(seq);
        }
        if let Some(w) = self.front.clone() {
            let skipped_credential_copy = matches!(&w, Watched::Ai(_)) && self.copied_in_ai_app == Some(seq);
            if self.watching(&w) && !skipped_credential_copy {
                out.extend(self.check(seq, w));
            }
        }
        out
    }

    fn check(&mut self, seq: u32, w: Watched) -> Vec<Do> {
        self.checked = Some(seq);
        let out = match &w {
            Watched::Ai(a) => vec![Do::Check { seq, app: a.id.clone() }],
            Watched::Surface(s) => vec![Do::CheckSurface { seq, kind: s.kind.clone() }],
        };
        self.card = Some(Card {
            seq,
            watched: w,
            shown: false,
            focus: None,
            typed: false,
        });
        out
    }

    /// The page found something to show for this copy: show it if it's still the copy in front of the same AI app
    /// or surface. `focus`: whatever had the keyboard at that moment, captured once for this card. Returns the
    /// window to show it beside.
    pub fn ready(&mut self, seq: u32, now_seq: u32, focus: Option<Vec<i32>>) -> Option<isize> {
        let front = self.front.clone()?;
        let typing = self.typing_wanted();
        let card = self.card.as_mut()?;
        let current = if card.typed {
            typing == Some(front.hwnd())
        } else {
            now_seq == seq
        };
        if card.seq != seq || !current || card.watched != front {
            return None;
        }
        card.shown = true;
        card.focus = focus;
        Some(front.hwnd())
    }

    /// Whether a paste belongs to the text box the card appeared over: the copy still in front of the same AI app
    /// or surface, matching the focus token `ready` captured when the card first showed. A card never shown, a
    /// stale copy, or a different box now holding the keyboard all say no -- the safe answer is to leave the text
    /// on the clipboard.
    pub fn may_paste(&self, seq: u32, now_seq: u32, focus: &[i32]) -> bool {
        let Some(front) = self.front.as_ref() else {
            return false;
        };
        let Some(card) = self.card.as_ref() else {
            return false;
        };
        !card.typed
            && matches!(card.watched, Watched::Ai(_))
            && card.seq == seq
            && now_seq == seq
            && card.watched == *front
            && self.watching(front)
            && card.focus.as_deref() == Some(focus)
    }

    /// The copy the page may read now: the one being checked, while its AI app or surface is in front.
    pub fn may_read(&self, seq: u32, now_seq: u32) -> bool {
        let Some(front) = self.front.as_ref() else {
            return false;
        };
        let Some(card) = self.card.as_ref() else {
            return false;
        };
        !card.typed && card.seq == seq && now_seq == seq && card.watched == *front && self.watching(front)
    }

    /// The card showing beside the AI app or surface in front, if any: its window.
    pub fn showing(&self) -> Option<isize> {
        let front = self.front.as_ref()?;
        self.card.as_ref().filter(|c| c.shown && c.watched == *front).map(|_| front.hwnd())
    }

    /// The person chose, dismissed the card, or the page found nothing: this copy is over. `checked` stays on its
    /// sequence, so coming back to the same app cannot bring a dismissed copy back.
    pub fn done(&mut self, seq: u32) -> bool {
        let had = self.card.as_ref().is_some_and(|c| c.seq == seq);
        if had {
            self.card = None;
        }
        had
    }

    /// Clotr put the safe version on the clipboard: it's never checked. The card stays for its last note.
    pub fn wrote(&mut self, old: u32, new: u32) {
        self.checked = Some(new);
        if let Some(card) = self.card.as_mut().filter(|c| c.seq == old && !c.typed) {
            card.seq = new;
        }
    }

    pub fn set_paused(&mut self, paused: bool, paused_apps: Vec<String>) -> Vec<Do> {
        self.paused = paused;
        self.paused_apps = paused_apps;
        let mut out = match &self.card {
            Some(c) if !self.watching(&c.watched) => {
                self.card = None;
                vec![Do::Drop]
            }
            _ => vec![],
        };
        self.sync_typing(&mut out);
        out
    }

    // ---------- The typing check ----------

    /// The AI app window the typing check may be on right now: in front, not paused, the switch on.
    fn typing_wanted(&self) -> Option<isize> {
        if !self.typing {
            return None;
        }
        match &self.front {
            Some(w @ Watched::Ai(a)) if self.watching(w) => Some(a.hwnd),
            _ => None,
        }
    }

    /// Starts or stops the typing check to match what's in front, telling typing.rs only when it changes.
    fn sync_typing(&mut self, out: &mut Vec<Do>) {
        let want = self.typing_wanted();
        if want == self.typing_at {
            return;
        }
        self.boxed = None;
        if self.typing_at.take().is_some() {
            out.push(Do::TypingOff);
        }
        if let Some(hwnd) = want {
            self.typing_at = Some(hwnd);
            out.push(Do::TypingOn { hwnd });
        }
    }

    /// "Check what I type in AI apps" switched. Off ends a typed card too.
    pub fn set_typing(&mut self, on: bool) -> Vec<Do> {
        self.typing = on;
        let mut out = Vec::new();
        if !on && self.card.as_ref().is_some_and(|c| c.typed) {
            self.card = None;
            out.push(Do::Drop);
        }
        self.sync_typing(&mut out);
        out
    }

    /// Focus landed on an element in the watched app. Only a chat box there is watched.
    pub fn on_box(&mut self, hwnd: isize, shape: BoxShape) -> Vec<Do> {
        self.boxed = None;
        if shape != BoxShape::Chat || self.typing_at != Some(hwnd) || self.typing_wanted() != Some(hwnd) {
            return vec![];
        }
        self.boxed = Some(hwnd);
        vec![Do::WatchBox]
    }

    /// Typing paused in the watched box: the one place a read is allowed.
    pub fn on_typed(&self, hwnd: isize) -> Vec<Do> {
        if self.boxed == Some(hwnd) && self.typing_wanted() == Some(hwnd) {
            vec![Do::ReadBox]
        } else {
            vec![]
        }
    }

    /// A read came back, numbered `seq` by main.rs (`empty`: nothing in the box, as after Enter). Asks for a check
    /// unless a copy's card is waiting for its choice; an empty box with no typed card has nothing to say.
    pub fn typed(&mut self, seq: u32, hwnd: isize, empty: bool) -> Vec<Do> {
        if self.boxed != Some(hwnd) || self.typing_wanted() != Some(hwnd) {
            return vec![];
        }
        let Some(Watched::Ai(app)) = self.front.clone() else {
            return vec![];
        };
        match &self.card {
            Some(c) if !c.typed => return vec![],
            None if empty => return vec![],
            _ => {}
        }
        // The same box's next check keeps the card where it is; the page decides whether it still has something
        // to say.
        let shown = self.card.as_ref().is_some_and(|c| c.shown);
        let id = app.id.clone();
        self.card = Some(Card {
            seq,
            watched: Watched::Ai(app),
            shown,
            focus: None,
            typed: true,
        });
        vec![Do::CheckTyped { seq, app: id }]
    }

    /// The typed card's box may be read again for "Clot this leak and copy": the same card, its app in front and
    /// its box still watched.
    pub fn may_read_typed(&self, seq: u32) -> bool {
        let Some(front) = self.front.as_ref() else {
            return false;
        };
        self.card
            .as_ref()
            .is_some_and(|c| c.typed && c.seq == seq && c.watched == *front)
            && self.boxed == Some(front.hwnd())
            && self.typing_wanted() == Some(front.hwnd())
    }

    /// The id of the AI app in front at this window, if that's what's in front.
    pub fn ai_at(&self, hwnd: isize) -> Option<String> {
        match &self.front {
            Some(Watched::Ai(a)) if a.hwnd == hwnd => Some(a.id.clone()),
            _ => None,
        }
    }

    /// Clotr put the typed message's safe version on the clipboard: it's never checked as a copy.
    pub fn wrote_typed(&mut self, new: u32) {
        self.checked = Some(new);
    }

    /// The window of whatever's in front among what Clotr watches, for "back to app" -- never read by the engine,
    /// only used to give the keyboard back to it.
    pub fn front_hwnd(&self) -> Option<isize> {
        self.front.as_ref().map(Watched::hwnd)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude() -> Front {
        Front::Ai(FrontApp {
            hwnd: 7,
            id: "claude".into(),
        })
    }

    fn run_box() -> Front {
        Front::Surface(FrontSurface {
            hwnd: 11,
            kind: "run".into(),
        })
    }

    #[test]
    fn nothing_is_read_while_no_ai_app_or_surface_is_in_front() {
        let mut b = Brain::default();
        assert_eq!(b.on_front(Front::Other, 1), vec![]);
        assert_eq!(b.on_clipboard(2), vec![]);
        assert!(!b.may_read(2, 2));
    }

    #[test]
    fn a_copy_made_with_an_ai_app_in_front_is_checked_once() {
        let mut b = Brain::default();
        b.on_front(claude(), 1);
        assert_eq!(
            b.on_clipboard(2),
            vec![
                Do::Drop,
                Do::Check {
                    seq: 2,
                    app: "claude".into()
                }
            ]
        );
        assert!(b.may_read(2, 2));
        assert_eq!(b.on_clipboard(2), vec![], "the same copy isn't checked twice");
    }

    #[test]
    fn a_copy_made_elsewhere_is_checked_when_an_ai_app_comes_to_the_front() {
        let mut b = Brain::default();
        b.on_front(Front::Other, 1);
        b.on_clipboard(5);
        assert_eq!(
            b.on_front(claude(), 5),
            vec![Do::Check {
                seq: 5,
                app: "claude".into()
            }]
        );
        b.done(5);
        b.on_front(Front::Other, 5);
        assert_eq!(b.on_front(claude(), 5), vec![], "already checked");
    }

    #[test]
    fn a_copy_made_in_an_ai_app_is_not_checked() {
        let mut b = Brain::default();
        assert_eq!(b.on_front_with_copy_origin(claude(), 8, true), vec![]);
        assert_eq!(b.on_clipboard_with_copy_origin(8, true), vec![]);
        assert_eq!(b.card, None, "the app's own copy never gets a card");
        assert!(!b.may_read(8, 8));
    }

    #[test]
    fn a_copy_made_elsewhere_still_gets_a_card_when_an_ai_app_comes_to_the_front() {
        let mut b = Brain::default();
        assert_eq!(b.on_front_with_copy_origin(Front::Other, 9, false), vec![]);
        assert_eq!(b.on_clipboard_with_copy_origin(9, false), vec![]);
        assert_eq!(
            b.on_front_with_copy_origin(claude(), 9, false),
            vec![Do::Check {
                seq: 9,
                app: "claude".into()
            }]
        );
    }

    #[test]
    fn a_copy_from_an_ai_app_can_still_be_checked_as_a_command_on_a_surface() {
        let mut b = Brain::default();
        assert_eq!(
            b.on_front_with_copy_origin(run_box(), 11, true),
            vec![Do::CheckSurface {
                seq: 11,
                kind: "run".into()
            }]
        );
    }

    #[test]
    fn a_dismissed_copy_stays_over_when_the_ai_app_comes_back() {
        let mut b = Brain::default();
        assert_eq!(
            b.on_front_with_copy_origin(claude(), 10, false),
            vec![Do::Check {
                seq: 10,
                app: "claude".into()
            }]
        );
        assert!(b.done(10), "closing the card ends that copy");
        assert_eq!(b.on_front_with_copy_origin(Front::Other, 10, false), vec![]);
        assert_eq!(b.on_front_with_copy_origin(claude(), 10, false), vec![]);
        assert_eq!(b.card, None, "the dismissed copy isn't shown again");
    }

    #[test]
    fn the_card_steps_aside_and_comes_back_with_its_app() {
        let mut b = Brain::default();
        b.on_front(claude(), 3);
        assert_eq!(b.ready(3, 3, None), Some(7));
        assert_eq!(b.showing(), Some(7));
        assert_eq!(b.on_front(Front::Other, 3), vec![Do::Hide]);
        assert!(!b.may_read(3, 3), "nothing is read while another program is in front");
        assert_eq!(b.showing(), None);
        assert_eq!(b.on_front(claude(), 3), vec![Do::Show { hwnd: 7 }]);
        assert_eq!(b.on_front(Front::Card, 3), vec![], "reaching the card changes nothing");
        assert!(b.may_read(3, 3));
    }

    #[test]
    fn a_new_copy_or_another_app_ends_the_card() {
        let mut b = Brain::default();
        b.on_front(claude(), 3);
        b.ready(3, 3, None);
        assert_eq!(
            b.on_clipboard(4),
            vec![
                Do::Drop,
                Do::Check {
                    seq: 4,
                    app: "claude".into()
                }
            ]
        );
        b.ready(4, 4, None);
        let chatgpt = Front::Ai(FrontApp {
            hwnd: 9,
            id: "chatgpt".into(),
        });
        assert_eq!(b.on_front(chatgpt, 4), vec![Do::Drop]);
        assert_eq!(b.card, None);
    }

    #[test]
    fn a_stale_check_never_shows() {
        let mut b = Brain::default();
        b.on_front(claude(), 3);
        assert_eq!(b.ready(3, 4, None), None, "the clipboard changed while it was being checked");
        b.on_front(claude(), 5);
        assert_eq!(b.ready(3, 5, None), None);
        assert!(!b.may_read(3, 5));
    }

    #[test]
    fn clotrs_own_copy_is_never_checked() {
        let mut b = Brain::default();
        b.on_front(claude(), 3);
        b.ready(3, 3, None);
        b.wrote(3, 4);
        assert_eq!(b.on_clipboard(4), vec![]);
        assert_eq!(b.showing(), Some(7), "the card stays for its last note");
        assert!(b.done(4));
    }

    #[test]
    fn paused_means_nothing_is_read() {
        let mut b = Brain::default();
        b.set_paused(true, vec![]);
        assert_eq!(b.on_front(claude(), 1), vec![]);
        assert_eq!(b.on_clipboard(2), vec![]);
        b.set_paused(false, vec!["claude".into()]);
        assert_eq!(b.on_clipboard(3), vec![]);
        assert!(!b.may_read(3, 3));
        b.set_paused(false, vec![]);
        assert_eq!(
            b.on_clipboard(4),
            vec![Do::Check {
                seq: 4,
                app: "claude".into()
            }]
        );
        b.ready(4, 4, None);
        assert_eq!(b.set_paused(true, vec![]), vec![Do::Drop]);
    }

    #[test]
    fn a_paste_matches_only_the_box_the_card_first_showed_over() {
        let mut b = Brain::default();
        b.on_front(claude(), 3);
        assert!(!b.may_paste(3, 3, &[1, 2]), "nothing to paste before the card is ready");
        assert_eq!(b.ready(3, 3, Some(vec![1, 2])), Some(7));
        assert!(b.may_paste(3, 3, &[1, 2]));
        assert!(!b.may_paste(3, 3, &[9, 9]), "a different box now holding the keyboard never pastes");
        assert!(!b.may_paste(2, 3, &[1, 2]), "not this copy");
    }

    #[test]
    fn a_surface_card_never_pastes_even_when_its_original_focus_is_still_there() {
        let mut b = Brain::default();
        b.on_front(run_box(), 3);
        b.on_clipboard(3);
        b.ready(3, 3, Some(vec![1, 2]));
        assert!(!b.may_paste(3, 3, &[1, 2]), "only AI app cards may paste");
    }

    #[test]
    fn no_focus_token_means_no_paste() {
        let mut b = Brain::default();
        b.on_front(claude(), 3);
        b.ready(3, 3, None);
        assert!(!b.may_paste(3, 3, &[1, 2]), "Windows couldn't say what had the keyboard");
    }

    #[test]
    fn the_focus_token_is_captured_once_and_outlives_stepping_aside() {
        let mut b = Brain::default();
        b.on_front(claude(), 3);
        b.ready(3, 3, Some(vec![1, 2]));
        b.on_front(Front::Other, 3); // the card steps aside
        b.on_front(claude(), 3); // and comes back, without `ready` being asked again
        assert!(
            b.may_paste(3, 3, &[1, 2]),
            "the same box, reached again, still pastes"
        );
    }

    // ---------- Surfaces: checked like an AI app, but never for a credential ----------

    #[test]
    fn a_surface_in_front_is_checked_once_for_a_command_never_a_credential() {
        let mut b = Brain::default();
        b.on_front(run_box(), 1);
        assert_eq!(
            b.on_clipboard(2),
            vec![
                Do::Drop,
                Do::CheckSurface {
                    seq: 2,
                    kind: "run".into()
                }
            ]
        );
        assert!(b.may_read(2, 2));
        assert_eq!(b.on_clipboard(2), vec![], "the same copy isn't checked twice");
    }

    #[test]
    fn a_surface_never_produces_an_ai_apps_check() {
        let mut b = Brain::default();
        b.on_front(run_box(), 1);
        let todo = b.on_clipboard(2);
        assert!(
            todo.iter().all(|d| !matches!(d, Do::Check { .. })),
            "a surface's copy must never be asked for as a credential check: {todo:?}"
        );
    }

    #[test]
    fn a_surfaces_card_steps_aside_and_comes_back() {
        let mut b = Brain::default();
        b.on_front(run_box(), 3);
        assert_eq!(b.ready(3, 3, None), Some(11));
        assert_eq!(b.showing(), Some(11));
        assert_eq!(b.on_front(Front::Other, 3), vec![Do::Hide]);
        assert_eq!(b.on_front(run_box(), 3), vec![Do::Show { hwnd: 11 }]);
    }

    #[test]
    fn switching_from_an_ai_app_to_a_surface_drops_the_ai_apps_card() {
        let mut b = Brain::default();
        b.on_front(claude(), 3);
        b.ready(3, 3, None);
        assert_eq!(b.on_front(run_box(), 3), vec![Do::Drop]);
        assert_eq!(b.card, None);
    }

    #[test]
    fn switching_from_a_surface_to_an_ai_app_drops_the_surfaces_card() {
        let mut b = Brain::default();
        b.on_front(run_box(), 3);
        b.ready(3, 3, None);
        assert_eq!(b.on_front(claude(), 3), vec![Do::Drop]);
        assert_eq!(b.card, None);
    }

    // ---------- The typing check ----------

    fn typing() -> Brain {
        Brain {
            typing: true,
            ..Default::default()
        }
    }

    /// Claude in front, its chat box focused and watched.
    fn typing_in_claude() -> Brain {
        let mut b = typing();
        b.on_front(claude(), 1);
        b.done(1); // the copy that came with the app had nothing
        assert_eq!(b.on_box(7, BoxShape::Chat), vec![Do::WatchBox]);
        b
    }

    #[test]
    fn the_typing_check_starts_with_an_ai_app_in_front_and_stops_when_it_leaves() {
        let mut b = typing();
        assert_eq!(
            b.on_front(claude(), 1),
            vec![
                Do::Check {
                    seq: 1,
                    app: "claude".into()
                },
                Do::TypingOn { hwnd: 7 }
            ]
        );
        assert_eq!(b.on_front(Front::Card, 1), vec![], "reaching the card changes nothing");
        assert_eq!(b.on_front(Front::Other, 1), vec![Do::TypingOff]);
        assert!(!b.on_front(run_box(), 1).contains(&Do::TypingOn { hwnd: 11 }), "never on a surface");
        assert_eq!(b.typing_at, None);
    }

    #[test]
    fn a_chat_box_in_the_app_in_front_is_watched_and_read_after_a_pause() {
        let b = typing_in_claude();
        assert_eq!(b.on_typed(7), vec![Do::ReadBox]);
    }

    #[test]
    fn no_read_box_with_another_program_in_front() {
        let mut b = typing_in_claude();
        b.on_front(Front::Other, 1);
        assert_eq!(b.on_typed(7), vec![], "the app left the front");
        assert_eq!(b.on_box(7, BoxShape::Chat), vec![], "and nothing new is watched there");
        let mut b = typing_in_claude();
        let chatgpt = Front::Ai(FrontApp {
            hwnd: 9,
            id: "chatgpt".into(),
        });
        assert_eq!(b.on_front(chatgpt, 1), vec![Do::TypingOff, Do::TypingOn { hwnd: 9 }]);
        assert_eq!(b.on_typed(7), vec![], "Claude's box, with ChatGPT in front");
        assert_eq!(b.on_typed(9), vec![], "ChatGPT's box isn't watched until it's looked at");
    }

    #[test]
    fn no_read_box_for_a_password_box_or_anything_but_a_chat_box() {
        let mut b = typing();
        b.on_front(claude(), 1);
        assert_eq!(b.on_box(7, BoxShape::Password), vec![], "no subscription for a password box");
        assert_eq!(b.on_typed(7), vec![]);
        assert_eq!(b.on_box(7, BoxShape::Other), vec![]);
        assert_eq!(b.on_typed(7), vec![]);
        let mut b = typing_in_claude();
        b.on_box(7, BoxShape::Password);
        assert_eq!(b.on_typed(7), vec![], "focus moved from the chat box to a password box");
        assert_eq!(b.on_box(11, BoxShape::Chat), vec![], "a box in a window that isn't the one in front");
    }

    #[test]
    fn no_read_box_while_paused_or_with_the_switch_off() {
        let mut b = typing_in_claude();
        assert_eq!(b.set_paused(true, vec![]), vec![Do::TypingOff]);
        assert_eq!(b.on_typed(7), vec![], "all of Clotr paused");
        assert_eq!(b.on_box(7, BoxShape::Chat), vec![]);
        assert_eq!(b.set_paused(false, vec![]), vec![Do::TypingOn { hwnd: 7 }]);
        assert_eq!(b.on_typed(7), vec![], "watched again only once it's looked at again");
        b.on_box(7, BoxShape::Chat);
        assert_eq!(b.set_paused(false, vec!["claude".into()]), vec![Do::TypingOff]);
        assert_eq!(b.on_typed(7), vec![], "that app paused");
        let mut b = typing_in_claude();
        assert_eq!(b.set_typing(false), vec![Do::TypingOff]);
        assert_eq!(b.on_typed(7), vec![], "the switch off");
        let mut b = Brain::default();
        assert_eq!(b.on_front(claude(), 1).contains(&Do::TypingOn { hwnd: 7 }), false);
        assert_eq!(b.on_box(7, BoxShape::Chat), vec![], "the switch was never on");
    }

    #[test]
    fn a_typed_check_makes_a_typed_card_that_never_reads_the_clipboard_or_pastes() {
        let mut b = typing_in_claude();
        let seq = 1 << 31;
        assert_eq!(
            b.typed(seq, 7, false),
            vec![Do::CheckTyped {
                seq,
                app: "claude".into()
            }]
        );
        assert_eq!(b.ready(seq, 1, Some(vec![1])), Some(7), "shown whatever the clipboard holds");
        assert!(b.may_read_typed(seq));
        assert!(!b.may_read(seq, seq), "never a clipboard read");
        assert!(!b.may_paste(seq, seq, &[1]), "never a paste");
        b.wrote_typed(5);
        assert_eq!(b.on_clipboard(5), vec![], "the safe copy Clotr wrote isn't checked");
        assert_eq!(b.showing(), Some(7), "the card stays for its note");
    }

    #[test]
    fn a_typed_card_steps_aside_and_comes_back_and_a_new_copy_ends_it() {
        let mut b = typing_in_claude();
        let seq = 1 << 31;
        b.typed(seq, 7, false);
        b.ready(seq, 1, None);
        assert_eq!(b.on_front(Front::Other, 1), vec![Do::Hide, Do::TypingOff]);
        assert!(!b.may_read_typed(seq), "never re-read with another program in front");
        assert_eq!(b.on_front(claude(), 1), vec![Do::Show { hwnd: 7 }, Do::TypingOn { hwnd: 7 }]);
        assert_eq!(
            b.on_clipboard(2),
            vec![
                Do::Drop,
                Do::Check {
                    seq: 2,
                    app: "claude".into()
                }
            ]
        );
    }

    #[test]
    fn a_typed_check_waits_behind_a_copys_card_and_an_empty_box_says_nothing() {
        let mut b = typing();
        b.on_front(claude(), 1);
        b.on_box(7, BoxShape::Chat);
        assert_eq!(b.typed(1 << 31, 7, false), vec![], "the copy's card comes first");
        b.done(1);
        assert_eq!(b.typed(1 << 31, 7, true), vec![], "nothing typed, nothing showing");
        b.typed((1 << 31) + 1, 7, false);
        assert_eq!(
            b.typed((1 << 31) + 2, 7, true),
            vec![Do::CheckTyped {
                seq: (1 << 31) + 2,
                app: "claude".into()
            }],
            "an empty box after a card (the message was sent) lets the page close it"
        );
        let mut b = typing();
        b.on_front(claude(), 1);
        assert_eq!(b.typed(1 << 31, 7, false), vec![], "no box watched, so nothing was read");
    }

    #[test]
    fn switching_the_typing_check_off_ends_a_typed_card() {
        let mut b = typing_in_claude();
        b.typed(1 << 31, 7, false);
        assert_eq!(b.set_typing(false), vec![Do::Drop, Do::TypingOff]);
        assert_eq!(b.card, None);
    }

    #[test]
    fn pausing_all_of_clotr_silences_a_surface_too() {
        let mut b = Brain::default();
        b.set_paused(true, vec![]);
        assert_eq!(b.on_front(run_box(), 1), vec![]);
        assert_eq!(b.on_clipboard(2), vec![]);
        assert!(!b.may_read(2, 2));
    }
}
