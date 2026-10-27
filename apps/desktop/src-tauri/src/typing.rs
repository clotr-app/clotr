//! The typing check: reads the message box of the AI app in front the way a screen reader does (UI Automation),
//! about 400 ms after typing pauses, so the card can warn before Enter. This is the only file in Clotr that reads
//! a text box (a rule test checks), and it never decides on its own whether it may: every watch and every read
//! is asked of the brain through `Host` first.
//!
//! - Nothing runs until `watch` names an AI app (brain.rs's `Do::TypingOn`). Then one focus listener, filtered to
//!   that app's processes, and nothing else. `stop` removes it.
//! - A focused element is looked at once: `IsPassword` first, and a yes ends the look with nothing else asked.
//!   Then the chat-box shape (an editable Edit or Document control with a send-named button near it).
//! - A box that passes gets one text-changed subscription. Each change restarts the 400 ms timer; nothing is read
//!   per keystroke. A read is capped at 20,000 characters and handed to `Host::read` for one check.
//! - The text is never kept here, never logged and never written anywhere.
//!
//! Everything UI Automation runs on this file's own thread (MTA, owns no windows), as Microsoft's threading
//! guidance asks. The event handlers only post a message to that thread. No `crate::` paths, so the typing spike
//! can build this exact file and measure what ships.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows::core::{implement, Ref, BOOL};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCacheRequest, IUIAutomationElement, IUIAutomationEventHandler,
    IUIAutomationEventHandler_Impl, IUIAutomationFocusChangedEventHandler, IUIAutomationFocusChangedEventHandler_Impl,
    IUIAutomationPropertyChangedEventHandler, IUIAutomationPropertyChangedEventHandler_Impl, IUIAutomationTextPattern,
    IUIAutomationValuePattern, TreeScope_Descendants, TreeScope_Element, UIA_ButtonControlTypeId,
    UIA_ControlTypePropertyId, UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_MenuBarControlTypeId,
    UIA_MenuControlTypeId, UIA_MenuItemControlTypeId, UIA_NamePropertyId, UIA_PaneControlTypeId,
    UIA_ProcessIdPropertyId, UIA_TextPatternId, UIA_Text_TextChangedEventId, UIA_ValuePatternId,
    UIA_ValueValuePropertyId, UIA_WindowControlTypeId, UIA_EVENT_ID, UIA_PROPERTY_ID,
};

/// The browser's own debounce: a check runs this long after the last change.
pub const DEBOUNCE: Duration = Duration::from_millis(400);
/// The most of a box ever read, in UTF-16 units (what UI Automation counts).
pub const MAX_CHARS: i32 = 20_000;
/// Chromium may not have built its accessibility tree yet when Clotr first asks, so the focused element comes
/// back as a bare pane: look again this many times, this far apart (the browser's own lookForChatBox pattern).
const RETRIES: u32 = 3;
const RETRY_GAP: Duration = Duration::from_millis(300);
/// A menu can hold the focus until the next key (Alt alone opens menu mode), so it's looked past for longer.
const MENU_RETRIES: u32 = 20;
/// How far up from the box to look for its send button, like the browser's composerInfo.
const ANCESTORS: usize = 4;
/// At most this many buttons are read per level, so a huge page can't make one look slow.
const MAX_BUTTONS: i32 = 200;

/// What a focused element is, as far as the typing check cares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// A chat box Clotr can read: editable, a send button near it, and Text or Value to read it through.
    Chat,
    /// A password box (or one that wouldn't say): never read, never watched.
    Password,
    /// Anything else: a page, a button, a search field with no send button.
    NotChat,
    /// Looks like a chat box but offers nothing to read it with: the self-check line says so.
    Unreadable,
}

/// What one look found. The spike prints these; `shape` is all Clotr itself acts on. Never any text.
#[derive(Clone, Debug, Default)]
pub struct Look {
    pub control: i32,
    pub password: bool,
    /// `None`: no Value pattern to ask.
    pub read_only: Option<bool>,
    pub text: bool,
    pub value: bool,
    pub send: bool,
    /// A bare pane or window (Chromium's tree may not be there yet), or a menu: worth another look shortly.
    pub pane: bool,
    /// The pane is a Chromium page whose tree never came (checked only after the retries).
    pub chromium_pane: bool,
}

/// The chat-box shape from what one look found, as a plain rule so it's tested without a screen. `password` is
/// first: a password box is never anything else, whatever the rest says.
pub fn shape_of(l: &Look) -> Shape {
    if l.password {
        return Shape::Password;
    }
    if l.control != UIA_EditControlTypeId.0 && l.control != UIA_DocumentControlTypeId.0 {
        return Shape::NotChat;
    }
    // Writable as Value says, or an Edit with no Value at all (it may still read through Text). A Document with
    // no Value, or a read-only one, is a page, never a box.
    let editable = match l.read_only {
        Some(read_only) => !read_only,
        None => l.control == UIA_EditControlTypeId.0,
    };
    if !editable || !l.send {
        return Shape::NotChat;
    }
    if l.text || l.value {
        Shape::Chat
    } else {
        Shape::Unreadable
    }
}

/// Focus that's only passing through: a bare pane or window, or a menu. Pressing Alt alone puts a window in menu
/// mode, and leaving it raises no new focus event, since the box never lost the keyboard, so these get looked at
/// again instead of being taken as the answer.
pub fn passing(control: i32) -> bool {
    [
        UIA_PaneControlTypeId,
        UIA_WindowControlTypeId,
        UIA_MenuBarControlTypeId,
        UIA_MenuControlTypeId,
        UIA_MenuItemControlTypeId,
    ]
    .iter()
    .any(|c| c.0 == control)
}

/// A button whose name reads like it sends the message: the browser's SEND_LIKE, English and Spanish.
pub fn send_like(name: &str) -> bool {
    name.split(|c: char| !c.is_alphanumeric())
        .any(|w| w.eq_ignore_ascii_case("send") || w.eq_ignore_ascii_case("enviar"))
}

/// What the typing check asks of the rest of Clotr. main.rs answers through the brain; the spike answers yes and
/// counts. The last four are for the spike's numbers and the DK checks' trace, and do nothing in Clotr.
pub trait Host: Send + 'static {
    /// The focused element in the watched app has this shape: may Clotr subscribe to it? (brain.rs's on_box)
    fn may_watch(&self, hwnd: isize, shape: Shape) -> bool;
    /// Typing paused in the watched box: may Clotr read it now? (brain.rs's on_typed, `Do::ReadBox`)
    fn may_read(&self, hwnd: isize) -> bool;
    /// The box's text, for one check. Whoever gets it drops it after.
    fn read(&self, hwnd: isize, text: String);
    /// Whether this app's box can't be seen (the self-check line), or can again.
    fn blind(&self, hwnd: isize, blind: bool);
    fn changed(&self) {}
    fn looked(&self, _look: &Look) {}
    fn timed(&self, _units: usize, _took: Duration) {}
    /// A box's subscription was made (true) or removed (false).
    fn watching(&self, _on: bool) {}
}

struct El(IUIAutomationElement);
// UI Automation's elements are free-threaded in the MTA, where both the handlers and this file's thread live.
unsafe impl Send for El {}

enum Msg {
    Front { pid: u32, hwnd: isize },
    Stop,
    Focus(El),
    Changed,
    ReadNow(Sender<Option<String>>),
}

static TX: OnceLock<Mutex<Sender<Msg>>> = OnceLock::new();
/// The watched app's processes, read by the focus handler on UI Automation's own threads: empty means none.
static PIDS: Mutex<Vec<u32>> = Mutex::new(Vec::new());
static RUNNING: AtomicBool = AtomicBool::new(false);

fn send(m: Msg) {
    if let Some(tx) = TX.get() {
        let _ = tx.lock().unwrap_or_else(|e| e.into_inner()).send(m);
    }
}

/// Starts the typing thread (once). It does nothing until `watch`.
pub fn start(host: Box<dyn Host>) -> std::io::Result<()> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let (tx, rx) = channel();
    let _ = TX.set(Mutex::new(tx));
    std::thread::Builder::new()
        .name("clotr-typing".into())
        .spawn(move || run(rx, host))
        .map(|_| ())
}

/// Watch this AI app (its window, and the process that owns it) for a chat box.
pub fn watch(pid: u32, hwnd: isize) {
    send(Msg::Front { pid, hwnd });
}

/// Stop watching: every subscription goes, and nothing runs until the next `watch`.
pub fn stop() {
    send(Msg::Stop);
}

/// Reads the watched box once, now, for "Clot this leak and copy". `None` when nothing is watched or it can't be
/// read. The caller has already asked the brain.
pub fn read_now() -> Option<String> {
    let (tx, rx) = channel();
    send(Msg::ReadNow(tx));
    rx.recv_timeout(Duration::from_millis(1500)).ok().flatten()
}

// ---------- The handlers: post to the thread, nothing more ----------

#[implement(IUIAutomationFocusChangedEventHandler)]
struct OnFocus;

impl IUIAutomationFocusChangedEventHandler_Impl for OnFocus_Impl {
    fn HandleFocusChangedEvent(&self, sender: Ref<IUIAutomationElement>) -> windows::core::Result<()> {
        let Ok(el) = sender.ok() else { return Ok(()) };
        // The cache request made with the subscription brought the process id along, so this asks the other
        // program nothing. Focus anywhere but the watched app (Clotr's own card included) is dropped here.
        let pid = unsafe { el.CachedProcessId() }.unwrap_or(0) as u32;
        let ours = pid != 0 && PIDS.lock().unwrap_or_else(|e| e.into_inner()).contains(&pid);
        if ours {
            send(Msg::Focus(El(el.clone())));
        }
        Ok(())
    }
}

#[implement(IUIAutomationEventHandler)]
struct OnText;

impl IUIAutomationEventHandler_Impl for OnText_Impl {
    fn HandleAutomationEvent(
        &self,
        _sender: Ref<IUIAutomationElement>,
        _id: UIA_EVENT_ID,
    ) -> windows::core::Result<()> {
        send(Msg::Changed);
        Ok(())
    }
}

#[implement(IUIAutomationPropertyChangedEventHandler)]
struct OnValue;

impl IUIAutomationPropertyChangedEventHandler_Impl for OnValue_Impl {
    fn HandlePropertyChangedEvent(
        &self,
        _sender: Ref<IUIAutomationElement>,
        _id: UIA_PROPERTY_ID,
        _value: &VARIANT,
    ) -> windows::core::Result<()> {
        send(Msg::Changed);
        Ok(())
    }
}

// ---------- Looking at an element ----------

/// The patterns a look found, kept only while the box is watched.
struct Patterns {
    text: Option<IUIAutomationTextPattern>,
    value: Option<IUIAutomationValuePattern>,
}

/// Looks at one element: whether it's a password box first, then the chat-box shape. Returns what it found, and
/// the patterns to read it with when it's a chat box.
fn look(uia: &IUIAutomation, el: &IUIAutomationElement) -> (Look, Option<Patterns>) {
    // IsPassword before anything else, and no answer counts as yes: a password box is never asked for a pattern.
    let password = unsafe { el.CurrentIsPassword() }.map(BOOL::as_bool).unwrap_or(true);
    let mut l = Look {
        password,
        ..Default::default()
    };
    if password {
        return (l, None);
    }
    l.control = unsafe { el.CurrentControlType() }.map(|c| c.0).unwrap_or(0);
    l.pane = passing(l.control);
    if l.pane {
        let class = unsafe { el.CurrentClassName() }
            .map(|c| c.to_string())
            .unwrap_or_default();
        l.chromium_pane = class == "Chrome_RenderWidgetHostHWND";
    }
    if l.control != UIA_EditControlTypeId.0 && l.control != UIA_DocumentControlTypeId.0 {
        return (l, None);
    }
    let text: Option<IUIAutomationTextPattern> = unsafe { el.GetCurrentPatternAs(UIA_TextPatternId) }.ok();
    let value: Option<IUIAutomationValuePattern> = unsafe { el.GetCurrentPatternAs(UIA_ValuePatternId) }.ok();
    l.text = text.is_some();
    l.value = value.is_some();
    l.read_only = value
        .as_ref()
        .and_then(|v| unsafe { v.CurrentIsReadOnly() }.ok())
        .map(BOOL::as_bool);
    let editable = l.read_only.map(|r| !r).unwrap_or(l.control == UIA_EditControlTypeId.0);
    if editable {
        l.send = send_near(uia, el);
    }
    let chat = shape_of(&l) == Shape::Chat;
    (l, chat.then_some(Patterns { text, value }))
}

/// A send-named button within a few levels of the box, read in one call per level with the names cached.
fn send_near(uia: &IUIAutomation, el: &IUIAutomationElement) -> bool {
    let found = || -> windows::core::Result<bool> {
        let walker = unsafe { uia.ControlViewWalker() }?;
        let root = unsafe { uia.GetRootElement() }?;
        let cond = unsafe {
            uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_ButtonControlTypeId.0))
        }?;
        let cache = unsafe { uia.CreateCacheRequest() }?;
        unsafe { cache.AddProperty(UIA_NamePropertyId) }?;
        let mut area = el.clone();
        for _ in 0..ANCESTORS {
            let parent = unsafe { walker.GetParentElement(&area) }?;
            if unsafe { uia.CompareElements(&parent, &root) }.is_ok_and(BOOL::as_bool) {
                break;
            }
            if let Ok(buttons) = unsafe { parent.FindAllBuildCache(TreeScope_Descendants, &cond, &cache) } {
                let n = unsafe { buttons.Length() }.unwrap_or(0).min(MAX_BUTTONS);
                for i in 0..n {
                    let name = unsafe { buttons.GetElement(i).and_then(|b| b.CachedName()) };
                    if name.is_ok_and(|n| send_like(&n.to_string())) {
                        return Ok(true);
                    }
                }
            }
            area = parent;
        }
        Ok(false)
    };
    found().unwrap_or(false)
}

/// Reads the watched box: `IsPassword` asked again first (a box that turned into a password box is never read),
/// then Text, else Value, capped at MAX_CHARS. `Err` when the app wouldn't answer.
fn read_box(el: &IUIAutomationElement, p: &Patterns) -> Result<String, ()> {
    let password = unsafe { el.CurrentIsPassword() }.map(BOOL::as_bool).unwrap_or(true);
    if password {
        return Err(());
    }
    if let Some(t) = &p.text {
        let range = unsafe { t.DocumentRange() }.map_err(|_| ())?;
        let text = unsafe { range.GetText(MAX_CHARS) }.map_err(|_| ())?;
        return Ok(text.to_string());
    }
    if let Some(v) = &p.value {
        let all = unsafe { v.CurrentValue() }.map_err(|_| ())?;
        let units: Vec<u16> = all.iter().copied().take(MAX_CHARS as usize).collect();
        return Ok(String::from_utf16_lossy(&units));
    }
    Err(())
}

// ---------- Which processes are the app's ----------

/// A process and the ones it started, two levels down: an Electron app's page and a WebView2 app's browser
/// process both answer UI Automation from a child of the window's own process.
pub fn family(pid: u32) -> Vec<u32> {
    let mut all: Vec<(u32, u32)> = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return vec![pid];
        };
        let mut e = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                all.push((e.th32ProcessID, e.th32ParentProcessID));
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    descendants(pid, &all, 2)
}

/// `pid` and its children `depth` levels down, from (process, parent) pairs.
pub fn descendants(pid: u32, all: &[(u32, u32)], depth: usize) -> Vec<u32> {
    let mut out = vec![pid];
    let mut level = vec![pid];
    for _ in 0..depth {
        let next: Vec<u32> = all
            .iter()
            .filter(|(p, parent)| level.contains(parent) && *p != 0 && !out.contains(p))
            .map(|(p, _)| *p)
            .collect();
        if next.is_empty() {
            break;
        }
        out.extend(&next);
        level = next;
    }
    out
}

// ---------- The thread ----------

struct Watched {
    el: IUIAutomationElement,
    patterns: Patterns,
    on_text: Option<IUIAutomationEventHandler>,
    on_value: Option<IUIAutomationPropertyChangedEventHandler>,
}

struct Thread {
    uia: IUIAutomation,
    cache: IUIAutomationCacheRequest,
    host: Box<dyn Host>,
    front: Option<(u32, isize)>,
    on_focus: Option<IUIAutomationFocusChangedEventHandler>,
    watched: Option<Watched>,
    due: Option<Instant>,
    retry: Option<(Instant, u32)>,
}

fn run(rx: Receiver<Msg>, host: Box<dyn Host>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let made = || -> windows::core::Result<(IUIAutomation, IUIAutomationCacheRequest)> {
        let uia: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }?;
        let cache = unsafe { uia.CreateCacheRequest() }?;
        unsafe { cache.AddProperty(UIA_ProcessIdPropertyId) }?;
        Ok((uia, cache))
    };
    let Ok((uia, cache)) = made() else {
        eprintln!("[Clotr] the typing check couldn't start UI Automation");
        return;
    };
    let mut t = Thread {
        uia,
        cache,
        host,
        front: None,
        on_focus: None,
        watched: None,
        due: None,
        retry: None,
    };
    loop {
        let next = [t.due, t.retry.map(|r| r.0)].into_iter().flatten().min();
        let got = match next {
            Some(at) => rx.recv_timeout(at.saturating_duration_since(Instant::now())),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match got {
            Ok(m) => t.on(m),
            Err(RecvTimeoutError::Timeout) => t.tick(),
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    t.stop();
}

impl Thread {
    fn hwnd(&self) -> isize {
        self.front.map(|f| f.1).unwrap_or(0)
    }

    fn on(&mut self, m: Msg) {
        match m {
            Msg::Front { pid, hwnd } => {
                if self.front == Some((pid, hwnd)) {
                    return;
                }
                self.stop();
                if pid == 0 {
                    return;
                }
                self.front = Some((pid, hwnd));
                *PIDS.lock().unwrap_or_else(|e| e.into_inner()) = family(pid);
                let handler: IUIAutomationFocusChangedEventHandler = OnFocus.into();
                if unsafe { self.uia.AddFocusChangedEventHandler(&self.cache, &handler) }.is_ok() {
                    self.on_focus = Some(handler);
                }
                self.look_focused(0);
            }
            Msg::Stop => self.stop(),
            Msg::Focus(El(el)) => {
                if self.front.is_some() {
                    self.retry = None;
                    self.on_element(el, 0);
                }
            }
            Msg::Changed => {
                if self.watched.is_some() {
                    self.host.changed();
                    self.due = Some(Instant::now() + DEBOUNCE);
                }
            }
            Msg::ReadNow(reply) => {
                let text = self.watched.as_ref().and_then(|w| read_box(&w.el, &w.patterns).ok());
                let _ = reply.send(text);
            }
        }
    }

    fn tick(&mut self) {
        let now = Instant::now();
        if let Some((at, attempt)) = self.retry {
            if at <= now {
                self.retry = None;
                self.look_focused(attempt);
            }
        }
        if self.due.is_some_and(|d| d <= now) {
            self.due = None;
            self.read();
        }
    }

    /// The element that has the keyboard now, if it's the watched app's.
    fn look_focused(&mut self, attempt: u32) {
        let Ok(el) = (unsafe { self.uia.GetFocusedElementBuildCache(&self.cache) }) else {
            return;
        };
        let pid = unsafe { el.CachedProcessId() }.unwrap_or(0) as u32;
        if pid != 0 && PIDS.lock().unwrap_or_else(|e| e.into_inner()).contains(&pid) {
            self.on_element(el, attempt);
        }
    }

    fn on_element(&mut self, el: IUIAutomationElement, attempt: u32) {
        self.unwatch();
        let hwnd = self.hwnd();
        let (look, patterns) = look(&self.uia, &el);
        self.host.looked(&look);
        if look.pane {
            let menu = !(look.control == UIA_PaneControlTypeId.0 || look.control == UIA_WindowControlTypeId.0);
            if attempt < if menu { MENU_RETRIES } else { RETRIES } {
                self.retry = Some((Instant::now() + RETRY_GAP, attempt + 1));
            } else if look.chromium_pane {
                self.host.blind(hwnd, true);
            }
            return;
        }
        let shape = shape_of(&look);
        if shape == Shape::Unreadable {
            self.host.blind(hwnd, true);
        }
        if !self.host.may_watch(hwnd, shape) {
            return;
        }
        let Some(patterns) = patterns else { return };
        let mut w = Watched {
            el,
            patterns,
            on_text: None,
            on_value: None,
        };
        if w.patterns.text.is_some() {
            let h: IUIAutomationEventHandler = OnText.into();
            let added = unsafe {
                self.uia.AddAutomationEventHandler(
                    UIA_Text_TextChangedEventId,
                    &w.el,
                    TreeScope_Element,
                    &self.cache,
                    &h,
                )
            };
            if added.is_ok() {
                w.on_text = Some(h);
            }
        }
        if w.patterns.value.is_some() {
            let h: IUIAutomationPropertyChangedEventHandler = OnValue.into();
            let added = unsafe {
                self.uia.AddPropertyChangedEventHandlerNativeArray(
                    &w.el,
                    TreeScope_Element,
                    &self.cache,
                    &h,
                    &[UIA_ValueValuePropertyId],
                )
            };
            if added.is_ok() {
                w.on_value = Some(h);
            }
        }
        if w.on_text.is_none() && w.on_value.is_none() {
            self.host.blind(hwnd, true);
            return;
        }
        self.host.blind(hwnd, false);
        self.host.watching(true);
        self.watched = Some(w);
        // A draft already in the box is checked once, as if typing had just paused.
        self.due = Some(Instant::now() + DEBOUNCE);
    }

    fn read(&mut self) {
        let hwnd = self.hwnd();
        if self.watched.is_none() || !self.host.may_read(hwnd) {
            return;
        }
        let Some(w) = self.watched.as_ref() else { return };
        let started = Instant::now();
        match read_box(&w.el, &w.patterns) {
            Ok(text) => {
                self.host.timed(text.encode_utf16().count(), started.elapsed());
                self.host.read(hwnd, text);
            }
            Err(()) => {
                self.unwatch();
                self.host.blind(hwnd, true);
            }
        }
    }

    fn unwatch(&mut self) {
        self.due = None;
        let Some(w) = self.watched.take() else { return };
        unsafe {
            if let Some(h) = &w.on_text {
                let _ = self
                    .uia
                    .RemoveAutomationEventHandler(UIA_Text_TextChangedEventId, &w.el, h);
            }
            if let Some(h) = &w.on_value {
                let _ = self.uia.RemovePropertyChangedEventHandler(&w.el, h);
            }
        }
        self.host.watching(false);
    }

    fn stop(&mut self) {
        self.unwatch();
        self.retry = None;
        PIDS.lock().unwrap_or_else(|e| e.into_inner()).clear();
        if let Some(h) = self.on_focus.take() {
            let _ = unsafe { self.uia.RemoveFocusChangedEventHandler(&h) };
        }
        self.front = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit() -> Look {
        Look {
            control: UIA_EditControlTypeId.0,
            read_only: Some(false),
            text: true,
            value: true,
            send: true,
            ..Default::default()
        }
    }

    #[test]
    fn a_password_box_is_a_password_box_whatever_else_it_looks_like() {
        let l = Look {
            password: true,
            ..edit()
        };
        assert_eq!(shape_of(&l), Shape::Password);
    }

    #[test]
    fn an_editable_box_with_a_send_button_is_a_chat_box() {
        assert_eq!(shape_of(&edit()), Shape::Chat);
        let rich = Look {
            control: UIA_DocumentControlTypeId.0,
            ..edit()
        };
        assert_eq!(shape_of(&rich), Shape::Chat, "a rich editor reads as a Document");
        let value_only = Look { text: false, ..edit() };
        assert_eq!(
            shape_of(&value_only),
            Shape::Chat,
            "an older Electron app gives Value alone"
        );
    }

    #[test]
    fn no_send_button_or_read_only_or_a_page_is_not_a_chat_box() {
        assert_eq!(shape_of(&Look { send: false, ..edit() }), Shape::NotChat);
        assert_eq!(
            shape_of(&Look {
                read_only: Some(true),
                ..edit()
            }),
            Shape::NotChat
        );
        let page = Look {
            control: UIA_DocumentControlTypeId.0,
            read_only: None,
            value: false,
            ..edit()
        };
        assert_eq!(
            shape_of(&page),
            Shape::NotChat,
            "a Document with no Value is the page itself"
        );
        let button = Look {
            control: UIA_ButtonControlTypeId.0,
            ..edit()
        };
        assert_eq!(shape_of(&button), Shape::NotChat);
    }

    #[test]
    fn a_chat_box_with_nothing_to_read_it_by_is_unreadable() {
        let l = Look {
            read_only: None,
            text: false,
            value: false,
            ..edit()
        };
        assert_eq!(shape_of(&l), Shape::Unreadable);
    }

    #[test]
    fn a_menu_a_pane_or_a_window_is_passing_focus_and_a_box_or_button_isnt() {
        // Alt alone shows focus on the menu bar; the box still has the keyboard, so it's looked at again.
        for c in [
            UIA_MenuBarControlTypeId,
            UIA_MenuControlTypeId,
            UIA_MenuItemControlTypeId,
            UIA_PaneControlTypeId,
        ] {
            assert!(passing(c.0));
        }
        assert!(passing(UIA_WindowControlTypeId.0));
        for c in [
            UIA_EditControlTypeId,
            UIA_DocumentControlTypeId,
            UIA_ButtonControlTypeId,
        ] {
            assert!(!passing(c.0));
        }
    }

    #[test]
    fn a_send_button_is_named_send_or_enviar_as_a_word() {
        for yes in ["Send", "Send message", "send-button", "Enviar mensaje", "SEND"] {
            assert!(send_like(yes), "{yes}");
        }
        for no in ["Sending", "Resend", "Sender", "Submit", "", "Attach"] {
            assert!(!send_like(no), "{no}");
        }
    }

    #[test]
    fn an_apps_family_is_it_and_what_it_started_two_levels_down() {
        let all = [(10, 1), (11, 10), (12, 11), (13, 12), (20, 1), (0, 10)];
        assert_eq!(descendants(10, &all, 2), vec![10, 11, 12]);
        assert_eq!(descendants(20, &all, 2), vec![20]);
    }
}
