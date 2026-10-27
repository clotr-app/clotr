//! The web view (Microsoft Edge WebView2, Windows' own), kept offline. Clotr's pages run the engine and draw the card
//! and the main window in it; nothing in it may reach the internet, and nothing it shows may be kept or sent anywhere.
//!
//! - Its pages come only from Clotr's own files: a CSP of `default-src 'self'` (tauri.conf.json), every navigation
//!   elsewhere refused, no new windows, no downloads.
//! - It runs InPrivate (nothing it sees is written to disk) in Clotr's own data folder.
//! - Crash reports stay on this computer (WebView2's custom crash reporting: Windows sends none to Microsoft), and
//!   Clotr clears any it finds at start, since one could hold what was on the card.
//! - The switches below turn off what the web view does online by itself. With Tauri's own defaults, a network
//!   check caught it fetching Edge's settings and experiments (config.edge.skype.com, with an install id), sending a
//!   network error report (ecs.nel.measure.office.net), looking for a proxy (wpad) and looking up the Windows
//!   account's profile (substrate.office.com). With these switches, that same check sees no request, no name
//!   looked up, no connection and no byte sent.

use std::cell::RefCell;
use std::path::Path;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2Environment, ICoreWebView2EnvironmentOptions,
    ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
};
use webview2_com::{CoreWebView2EnvironmentOptions, CreateCoreWebView2EnvironmentCompletedHandler};
use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};

/// - Features off: SmartScreen (and Tauri's two defaults), reports (network error reports go out through them),
///   form and page-hint services, casting, translation, and the Windows account and sign-in lookups (Clotr never
///   signs in to anything). Network error logging itself stays on: switched off, WebView2 drops and rebinds its
///   observer in a loop for as long as a page is open, close to a whole core between the web view's browser and
///   network processes, and with reports off and no name resolving it has nowhere to send anything anyway.
/// - Background networking (settings, experiments, component and model downloads), domain reliability reports, sync,
///   field trials, pings, proxy discovery and metrics uploads off.
/// - As a last stop, no host name resolves at all, so nothing the web view might still try can reach anyone.
pub const OFFLINE_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,Reporting,",
    "AutofillServerCommunication,OptimizationHints,OptimizationGuideModelDownloading,MediaRouter,Translate,",
    "msEdgeOSAccountInfoSubstrate,msEdgeOSAccountInfoManagerCache,msPrimaryOSAccountInfoCache,msImplicitSignin,",
    "msLoadOneAuthInBackground,msM365LinksImplicitSignin,msOneAuthWAM,msOneAuthIDHRD,msEmxPrimaryAccount ",
    "--disable-background-networking --disable-component-update --disable-domain-reliability --disable-sync ",
    "--disable-field-trial-config --no-pings --no-proxy-server --metrics-recording-only ",
    "--host-resolver-rules=\"MAP * ~NOTFOUND\"",
);

/// The web view draws in its main process instead of a process of its own: about 90 MB less memory, as measured
/// (the whole web view, about 150 MB, instead of 240).
pub const LEAN_ARGS: &str = "--in-process-gpu";

/// The card's page waits hidden until a copy needs it, then has half a second to warn. On WebView2 154 a page
/// that starts hidden was left asleep: a test saw no card at all, however long it waited. These keep it awake
/// (its timers, and a window Windows reports as covered or hidden). An idle page costs next to nothing.
pub const AWAKE_ARGS: &str =
    "--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling";

/// The switches for this run: OFFLINE_ARGS, LEAN_ARGS and AWAKE_ARGS, plus, in a test build only, the network
/// log that proves there was nothing (CLOTR_NETLOG), light or dark whatever Windows uses for screenshots of both
/// (CLOTR_THEME), a CDP port for a trace tool to attach to (CLOTR_REMOTE_DEBUG_PORT), leaving LEAN_ARGS or
/// AWAKE_ARGS off to compare against them (CLOTR_NO_LEAN, CLOTR_NO_AWAKE) and one more switch by hand
/// (CLOTR_EXTRA_ARGS) -- all of these only ever reachable from a dk-test-app build, never shipped.
pub fn browser_args() -> String {
    #[cfg(feature = "dk-test-app")]
    let lean = if std::env::var_os("CLOTR_NO_LEAN").is_some() { "" } else { LEAN_ARGS };
    #[cfg(not(feature = "dk-test-app"))]
    let lean = LEAN_ARGS;
    #[cfg(feature = "dk-test-app")]
    let awake = if std::env::var_os("CLOTR_NO_AWAKE").is_some() { "" } else { AWAKE_ARGS };
    #[cfg(not(feature = "dk-test-app"))]
    let awake = AWAKE_ARGS;
    #[allow(unused_mut)]
    let mut args = format!("{OFFLINE_ARGS} {lean} {awake}");
    #[cfg(feature = "dk-test-app")]
    {
        match std::env::var("CLOTR_THEME").as_deref() {
            Ok("light") => args.push_str(" --blink-settings=preferredColorScheme=1"),
            Ok("dark") => args.push_str(" --blink-settings=preferredColorScheme=0"),
            _ => {}
        }
        if let Some(file) = std::env::var_os("CLOTR_NETLOG") {
            let file = file.to_string_lossy();
            args.push_str(&format!(" --log-net-log=\"{file}\" --net-log-capture-mode=Default"));
        }
        if let Ok(port) = std::env::var("CLOTR_REMOTE_DEBUG_PORT") {
            args.push_str(&format!(" --remote-debugging-port={port}"));
        }
        // An escape hatch for measuring a single switch's effect by hand (e.g. --disable-gpu, --disable-gpu-vsync)
        // without a one-off env var and rebuild for each guess.
        if let Ok(extra) = std::env::var("CLOTR_EXTRA_ARGS") {
            args.push(' ');
            args.push_str(&extra);
        }
    }
    args
}

/// Only Clotr's own files: http://tauri.localhost/... (how Tauri serves them on Windows).
pub fn own_page(url: &tauri::Url) -> bool {
    (url.scheme() == "http" || url.scheme() == "https") && url.host_str() == Some("tauri.localhost")
        || url.scheme() == "tauri" && url.host_str() == Some("localhost")
}

/// A crash report could hold what was on the card's page: none is kept (and none is ever sent, see above).
pub fn clear_crash_reports(dir: &Path) {
    for part in ["reports", "attachments"] {
        let _ = std::fs::remove_dir_all(dir.join("EBWebView").join("Crashpad").join(part));
    }
}

thread_local! {
    // The one environment every window shares (WebView2 lives on the main thread).
    static ENVIRONMENT: RefCell<Option<ICoreWebView2Environment>> = const { RefCell::new(None) };
}

/// The web view's environment, made once, on the main thread: Clotr's data folder, the switches, the person's
/// language, crash reports kept on this computer, no browser extensions.
fn environment(dir: &Path, args: &str, locale: &str) -> Option<ICoreWebView2Environment> {
    if let Some(env) = ENVIRONMENT.with(|e| e.borrow().clone()) {
        return Some(env);
    }
    let options = CoreWebView2EnvironmentOptions::default();
    unsafe {
        options.set_additional_browser_arguments(args.to_string());
        options.set_language(locale.to_string());
        options.set_is_custom_crash_reporting_enabled(true);
        options.set_are_browser_extensions_enabled(false);
        options.set_allow_single_sign_on_using_os_primary_account(false);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |made, env| {
        let _ = tx.send(made.ok().and(env));
        Ok(())
    }));
    let folder = HSTRING::from(dir.to_string_lossy().as_ref());
    let options = ICoreWebView2EnvironmentOptions::from(options);
    unsafe {
        // WebView2 needs COM on this thread (the web view itself sets it up, but only once it starts).
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), &folder, &options, &handler).ok()?;
    }
    let env = webview2_com::wait_with_pump(rx).ok().flatten()?;
    ENVIRONMENT.with(|e| *e.borrow_mut() = Some(env.clone()));
    Some(env)
}

/// A window of Clotr's own pages, kept offline. Call on the main thread.
pub fn window<'a>(
    app: &'a AppHandle,
    dir: &Path,
    args: &str,
    locale: &str,
    label: &str,
    page: &str,
) -> Option<WebviewWindowBuilder<'a, tauri::Wry, AppHandle>> {
    let env = environment(dir, args, locale)?;
    Some(
        WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
            .with_environment(env)
            .incognito(true)
            .on_navigation(own_page)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false),
    )
}

/// Asks WebView2 to trim its own memory while a window sits ready but hidden (the card, kept alive between
/// warnings for an instant reopen), or to let it run normally again right before the window is about to show.
/// Never destroys or reloads the page -- the runtime just releases what it can on its own schedule, so the next
/// show stays instant. Safe from any thread (it's a window message, same as the rest of `with_webview`); if the
/// window is already gone, or this build's WebView2 is older than the `MemoryUsageTargetLevel` API, it's a no-op.
pub fn set_memory_target(window: &WebviewWindow, low: bool) {
    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    let _ = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
            let _ = core19.SetMemoryUsageTargetLevel(level);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_clotrs_own_pages_load() {
        for ok in [
            "http://tauri.localhost/card.html",
            "http://tauri.localhost/main.html#protection",
        ] {
            assert!(own_page(&tauri::Url::parse(ok).unwrap()), "{ok}");
        }
        for no in [
            "https://github.com/clotr-app/clotr",
            "http://tauri.localhost.example.com/card.html",
            "http://localhost:1420/card.html",
            "file:///C:/Windows/win.ini",
            "about:blank",
            "data:text/html,hi",
        ] {
            assert!(!own_page(&tauri::Url::parse(no).unwrap()), "{no}");
        }
    }

    #[test]
    fn the_offline_switches_are_all_there() {
        for switch in [
            "--disable-background-networking",
            "--disable-component-update",
            "--no-proxy-server",
            "msSmartScreenProtection",
            "msEdgeOSAccountInfoSubstrate",
            "--host-resolver-rules=\"MAP * ~NOTFOUND\"",
        ] {
            assert!(OFFLINE_ARGS.contains(switch), "{switch}");
        }
        assert!(!OFFLINE_ARGS.contains("--remote-debugging"), "no door in from outside");
    }

    #[test]
    fn reports_are_off_but_network_error_logging_is_left_alone() {
        let features = OFFLINE_ARGS
            .split_whitespace()
            .find_map(|a| a.strip_prefix("--disable-features="))
            .unwrap();
        let features: Vec<&str> = features.split(',').collect();
        assert!(features.contains(&"Reporting"));
        assert!(!features.contains(&"NetworkErrorLogging"), "switched off, it keeps a core busy while a page is open");
    }

    #[test]
    fn the_hidden_card_stays_awake_and_the_offline_switches_stay_whole() {
        let args = browser_args();
        for switch in [
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
        ] {
            assert!(args.contains(switch), "{switch}");
        }
        // Chromium reads only the last --disable-features: one list, the offline one, or the offline switches go.
        assert_eq!(args.matches("--disable-features=").count(), 1);
        assert!(!args.contains("--remote-debugging"), "no door in from outside");
    }
}
