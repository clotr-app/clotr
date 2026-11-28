use crate::only;
use tauri::WebviewWindow;

// ---------- Links: a false alarm report, and a chat ----------

/// "Wrong? Report a false alarm": a prefilled issue on Clotr's own repository (kinds only, never a detail), opened
/// in the person's browser. Any other address is refused.
pub fn report_link_ok(url: &str) -> bool {
    const START: &str = "https://github.com/clotr-app/clotr/issues/new?template=false-alarm.yml&title=";
    let Some(rest) = url.strip_prefix(START) else {
        return false;
    };
    url.len() < 1000
        && url.bytes().all(|byte| byte.is_ascii_graphic())
        && !decoded(rest).chars().any(|character| character.is_ascii_digit())
}

/// %XX escapes back to the text they stand for (what the link would show), as far as they read.
fn decoded(part: &str) -> String {
    let bytes = part.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                out.push((high * 16 + low) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// One hex digit's value, either case.
fn hex_value(byte: u8) -> Option<u32> {
    (byte as char).to_digit(16)
}

/// Hands `address` to Windows, which opens it the way a clicked link opens: a web page in the person's own
/// browser, an email in their mail app.
pub(crate) fn shell_open(address: &str) {
    let wide: Vec<u16> = address.encode_utf16().chain(std::iter::once(0)).collect();
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
}

#[tauri::command]
pub(crate) async fn open_report(window: WebviewWindow, url: String) -> Result<bool, String> {
    only(&window, "card")?;
    if !report_link_ok(&url) {
        return Ok(false);
    }
    shell_open(&url);
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
fn is_uuid(id: &str) -> bool {
    let bytes = id.as_bytes();
    let groups: [usize; 5] = [8, 4, 4, 4, 12];
    let mut i = 0;
    for (group, len) in groups.iter().enumerate() {
        for _ in 0..*len {
            if !bytes.get(i).is_some_and(u8::is_ascii_hexdigit) {
                return false;
            }
            i += 1;
        }
        if group < groups.len() - 1 {
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
pub(crate) async fn open_lookback_link(window: WebviewWindow, url: String) -> Result<bool, String> {
    only(&window, "main")?;
    if !lookback_link_ok(&url) {
        return Ok(false);
    }
    shell_open(&url);
    Ok(true)
}

/// Where "Get the browser extension" goes: the site's own extension page, which links every browser's store. Fixed
/// here, so the page never says where to go.
const EXTENSION_PAGE: &str = "https://clotr.app/extension.html";

/// Home's and Protection's "Get the browser extension", in the browser the person normally uses. Clotr for Windows
/// covers only the AI apps on this PC, so this is how someone using an AI site in a browser gets covered too.
#[tauri::command]
pub(crate) async fn open_extension_page(window: WebviewWindow) -> Result<bool, String> {
    only(&window, "main")?;
    shell_open(EXTENSION_PAGE);
    Ok(true)
}

/// Testing only: hands back a fixture export's bytes directly (the same ArrayBuffer shape the web view's own file
/// input would), so a test can drive "Choose my export" without automating Windows' real Open File dialog. A
/// real build (no `dk-test-app` feature) always refuses; a dk-test-app build with no `CLOTR_LOOKBACK_FIXTURE` set
/// refuses too. Rust still never parses an export: this only ever hands through the bytes of the one fixed
/// path a test named, exactly as `scan_next` hands through a counted file's bytes.
#[tauri::command]
pub(crate) async fn lookback_dk_fixture(window: WebviewWindow) -> Result<tauri::ipc::Response, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_registered_commands;
    use serde_json::{json, Value};

    #[test]
    fn the_extension_page_is_the_sites_own_and_the_main_window_alone_may_open_it() {
        assert_eq!(EXTENSION_PAGE, "https://clotr.app/extension.html");
        assert!(app_registered_commands().contains(&"open_extension_page"));
        let main: Value = serde_json::from_str(include_str!("../../capabilities/main.json")).unwrap();
        assert!(main["permissions"].as_array().unwrap().contains(&json!("allow-open-extension-page")));
        for other in ["../capabilities/card.json", "../capabilities/flyout.json"] {
            let text = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(other))
                .unwrap();
            assert!(!text.contains("open-extension-page"), "{other}");
        }
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

    /// chat_link_ok() agrees with lookback-core.js's chatLinkOk() on every case in the shared
    /// list (tests/lookback.test.js reads the same file). `null` isn't a case here: Rust has no such value for a
    /// `&str`, so that one stays JS-only.
    #[test]
    fn chat_link_ok_agrees_with_the_extensions_chatlinkok_on_the_shared_cases() {
        let cases: Value = serde_json::from_str(include_str!("../../../../../tests/fixtures/chat-link-cases.json"))
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
}
