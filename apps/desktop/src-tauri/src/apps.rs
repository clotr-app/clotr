//! Which AI app is in front: the built-in list (apps/ai-apps.json, AI apps only) and the matching rule.
//!
//! A program counts as an AI app when its file name is on the list and who made it checks out: the Store package
//! it runs from (Windows knows each packaged program's package, and no other program can claim it) or the publisher
//! its file is signed by. A file name alone is never enough, so a program that merely calls itself ChatGPT.exe is
//! not treated as ChatGPT.
//!
//! A maker whose every desktop app is an AI app (named once in the shared `makers` list) skips the file-name gate
//! entirely: any program signed by that maker, or packaged under a Store family ending in its publisher id, is one
//! of its apps -- a rename of the exe, its Store package or its product line (ChatGPT.exe becoming Codex.exe) never
//! drops it off the list. A maker who ships other software too (Microsoft) still needs the file name plus its
//! package or publisher, since it never names a `maker`.

use serde::Deserialize;

/// A company whose every desktop app is an AI app (OpenAI, Anthropic): `find` matches any program it signed, or
/// packaged under a Store family ending in `_<publisherId>`, before it ever looks at a file's own name. Never
/// written for a maker who ships other software too (Microsoft, for Copilot): there, an app's own `windows` entry
/// (exe plus package or publisher) stays the gate.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Maker {
    pub id: String,
    pub name: String,
    pub signer: String,
    #[serde(rename = "publisherId")]
    pub publisher_id: String,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct AiApp {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub windows: Vec<WinId>,
    /// The id of a `Maker` in the same list's `makers`, resolved once at parse time. `None` for a maker who ships
    /// other software too, where a `windows` entry stays the only gate.
    #[serde(default)]
    pub maker: Option<Maker>,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WinId {
    pub exe: String,
    #[serde(default)]
    pub package_family: Option<String>,
    #[serde(default)]
    pub publisher: Option<String>,
    /// Where the list says this program was seen. "to confirm on a real PC" means nobody has checked it yet.
    #[serde(default)]
    pub seen: Option<String>,
}

impl WinId {
    /// Whether someone has checked this entry on a real PC. The list's own `about` says what the words mean.
    pub fn confirmed(&self) -> bool {
        !self.seen.as_deref().is_some_and(|s| s.starts_with("to confirm"))
    }
}

#[derive(Deserialize)]
struct RawApp {
    id: String,
    name: String,
    #[serde(default)]
    windows: Vec<WinId>,
    #[serde(default)]
    maker: Option<String>,
}

#[derive(Deserialize)]
struct List {
    #[serde(default)]
    makers: Vec<Maker>,
    apps: Vec<RawApp>,
}

const BUILT_IN: &str = include_str!("../../../ai-apps.json");

/// A package family names its maker in the part after the last underscore (`OpenAI.Codex_2p2nqsd0c76g0`'s is
/// `2p2nqsd0c76g0`); a rename of everything before that underscore never changes it.
fn family_names_publisher(family: &str, publisher_id: &str) -> bool {
    family.len() > publisher_id.len()
        && family[..family.len() - publisher_id.len()].ends_with('_')
        && family[family.len() - publisher_id.len()..].eq_ignore_ascii_case(publisher_id)
}

/// The list as written, every entry checked: an id Clotr can use in a file name and in events, and for each program
/// a file name plus at least one way to know who made it. A `maker` id is resolved against `makers` here, once, so
/// `find` never has to look it up again.
pub fn parse(json: &str) -> Result<Vec<AiApp>, String> {
    let list: List = serde_json::from_str(json).map_err(|e| format!("the AI app list doesn't read: {e}"))?;
    for m in &list.makers {
        if m.id.trim().is_empty() || m.name.trim().is_empty() || m.signer.trim().is_empty() || m.publisher_id.trim().is_empty()
        {
            return Err(format!("a maker needs an id, a name, a signer and a publisherId ({})", m.id));
        }
    }
    let mut maker_ids: Vec<&str> = list.makers.iter().map(|m| m.id.as_str()).collect();
    maker_ids.sort_unstable();
    maker_ids.dedup();
    if maker_ids.len() != list.makers.len() {
        return Err("two makers share an id".into());
    }
    let mut apps = Vec::with_capacity(list.apps.len());
    for raw in list.apps {
        let id_ok = !raw.id.is_empty()
            && raw.id.len() <= 40
            && raw.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !id_ok || raw.name.trim().is_empty() {
            return Err(format!("an AI app's id or name isn't usable ({})", raw.id));
        }
        for w in &raw.windows {
            if !w.exe.to_ascii_lowercase().ends_with(".exe") || w.exe.contains(['\\', '/']) {
                return Err(format!("{}: a program must be a file name ending in .exe", raw.id));
            }
            if w.package_family.is_none() && w.publisher.is_none() {
                return Err(format!("{}: a program needs its package or its publisher", raw.id));
            }
        }
        let maker = match &raw.maker {
            Some(id) => Some(
                list.makers
                    .iter()
                    .find(|m| &m.id == id)
                    .cloned()
                    .ok_or_else(|| format!("{}: maker \"{id}\" isn't in makers", raw.id))?,
            ),
            None => None,
        };
        // An app the list knows only on phones (no Windows program, no maker) isn't one Windows can recognise, so it
        // stays out of this platform's list rather than failing the whole file.
        if raw.windows.is_empty() && maker.is_none() {
            continue;
        }
        apps.push(AiApp {
            id: raw.id,
            name: raw.name,
            windows: raw.windows,
            maker,
        });
    }
    let mut ids: Vec<&str> = apps.iter().map(|a| a.id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != apps.len() {
        return Err("two AI apps share an id".into());
    }
    Ok(apps)
}

/// The apps Clotr checks. The DK checks' build adds a stand-in "AI app" (src/bin/clotr-dk-ai.rs); Clotr itself never
/// has it.
pub fn built_in() -> Vec<AiApp> {
    #[allow(unused_mut)]
    let mut apps = parse(BUILT_IN).expect("apps/ai-apps.json is checked by the unit tests");
    #[cfg(feature = "dk-test-app")]
    apps.push(AiApp {
        id: "dk-test".into(),
        name: "DK test app".into(),
        windows: vec![WinId {
            exe: "clotr-dk-ai.exe".into(),
            package_family: None,
            publisher: None,
            seen: None,
        }],
        maker: None,
    });
    apps
}

/// Every maker the built-in list names, whether or not an app currently claims it -- the safety net for a maker
/// entry added before its product does, or for a maker's signer showing up on a program no app yet lists.
pub fn built_in_makers() -> Vec<Maker> {
    let list: List = serde_json::from_str(BUILT_IN).expect("apps/ai-apps.json is checked by the unit tests");
    list.makers
}

/// What Windows says about the program in front. `signer` is asked only when a file name matched and an entry names
/// a publisher (checking a signature reads the file, so it's done only when it matters).
pub struct Program<'a> {
    pub exe_path: &'a str,
    pub package_family: Option<&'a str>,
}

/// The program's own file name, with no folder in front of it -- the only part of the exe's path `find` or a
/// maker-level match ever reads to pick what to call it.
pub fn file_name(exe_path: &str) -> &str {
    exe_path.rsplit(['\\', '/']).next().unwrap_or("")
}

pub fn find<'a>(apps: &'a [AiApp], program: &Program, signer: &mut dyn FnMut() -> Option<String>) -> Option<&'a AiApp> {
    let file = file_name(program.exe_path);
    let mut signed_by: Option<Option<String>> = None;

    // Rung one: a maker whose every desktop app is an AI app matches on its signer, or on a Store package family
    // ending in its publisher id, before any app's own file name is even looked at -- a rename of the exe or its
    // package (ChatGPT.exe becoming Codex.exe) never drops it off the list. The package family is checked across
    // every maker first, and the signer only asked (once, cached) if none of them matched by family -- so a
    // package match never pays for a signature read, whichever maker's entry happens to come first in the list.
    if let Some(have) = program.package_family {
        for app in apps {
            if let Some(maker) = &app.maker {
                if family_names_publisher(have, &maker.publisher_id) {
                    return Some(app);
                }
            }
        }
    }
    for app in apps {
        let Some(maker) = &app.maker else { continue };
        let have = signed_by.get_or_insert_with(&mut *signer);
        if have.as_deref().is_some_and(|h| h.eq_ignore_ascii_case(&maker.signer)) {
            return Some(app);
        }
    }

    for app in apps {
        for w in &app.windows {
            if !w.exe.eq_ignore_ascii_case(file) {
                continue;
            }
            let unchecked = w.package_family.is_none() && w.publisher.is_none();
            if unchecked && cfg!(feature = "dk-test-app") {
                return Some(app);
            }
            if let (Some(want), Some(have)) = (&w.package_family, program.package_family) {
                if want.eq_ignore_ascii_case(have) {
                    return Some(app);
                }
            }
            if let Some(want) = &w.publisher {
                let have = signed_by.get_or_insert_with(&mut *signer);
                if have.as_deref().is_some_and(|h| h.eq_ignore_ascii_case(want)) {
                    return Some(app);
                }
            }
        }
    }
    None
}

/// Whether Home and the flyout count `app` as covered: its Store package is on this PC, or Clotr has seen it in front
/// (`seen` holds app ids). Only an entry checked on a real PC counts by its package. An unchecked one (Copilot's)
/// waits until Clotr has actually recognised the app in front, so the count never promises an app Clotr might miss.
pub fn covered(app: &AiApp, installed: &mut dyn FnMut(&str) -> bool, seen: &[String]) -> bool {
    seen.iter().any(|id| id == &app.id)
        || app
            .windows
            .iter()
            .filter(|w| w.confirmed())
            .filter_map(|w| w.package_family.as_deref())
            .any(installed)
}

/// Rung one's safety net: a program signed by a known AI maker, or packaged under its publisher id, even when no
/// app in the list claims that maker yet (a maker entry added ahead of its product) or no app matched at all. Only
/// ever worth calling after `find` has already come back empty.
pub fn find_known_maker<'a>(
    makers: &'a [Maker],
    program: &Program,
    signer: &mut dyn FnMut() -> Option<String>,
) -> Option<&'a Maker> {
    let mut signed_by: Option<Option<String>> = None;
    if let Some(have) = program.package_family {
        for maker in makers {
            if family_names_publisher(have, &maker.publisher_id) {
                return Some(maker);
            }
        }
    }
    for maker in makers {
        let have = signed_by.get_or_insert_with(&mut *signer);
        if have.as_deref().is_some_and(|h| h.eq_ignore_ascii_case(&maker.signer)) {
            return Some(maker);
        }
    }
    None
}

/// What `front_of` shows on Home when `find` already came back empty but `find_known_maker` didn't: the program's
/// own file name and the maker's name ("Codex.exe", "OpenAI"), never a path or the signature itself. `None` when
/// the program isn't signed by, or packaged under, any known maker.
pub fn unmatched_maker_name(
    makers: &[Maker],
    program: &Program,
    signer: &mut dyn FnMut() -> Option<String>,
) -> Option<(String, String)> {
    let maker = find_known_maker(makers, program, signer)?;
    Some((file_name(program.exe_path).to_string(), maker.name.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apps() -> Vec<AiApp> {
        parse(BUILT_IN).unwrap()
    }

    #[test]
    fn the_built_in_list_reads_and_names_chatgpt_claude_and_copilot() {
        let ids: Vec<String> = apps().into_iter().map(|a| a.id).collect();
        assert_eq!(ids, ["chatgpt", "claude", "copilot"]);
    }

    #[test]
    fn a_store_app_matches_by_its_package() {
        let list = apps();
        let p = Program {
            exe_path: r"C:\Program Files\WindowsApps\Claude_2.19675.0.0_x64__pzs8sxrjxfjjc\app\claude.exe",
            package_family: Some("Claude_pzs8sxrjxfjjc"),
        };
        let mut asked = false;
        let hit = find(&list, &p, &mut || {
            asked = true;
            None
        });
        assert_eq!(hit.map(|a| a.id.as_str()), Some("claude"));
        assert!(!asked, "the package settles it without reading the file's signature");
    }

    #[test]
    fn a_signed_program_matches_by_its_publisher() {
        let list = apps();
        let p = Program {
            exe_path: r"C:\Users\x\AppData\Local\AnthropicClaude\app-1.0\Claude.exe",
            package_family: None,
        };
        let hit = find(&list, &p, &mut || Some("Anthropic, PBC".into()));
        assert_eq!(hit.map(|a| a.id.as_str()), Some("claude"));
    }

    #[test]
    fn a_file_name_alone_is_not_enough() {
        let list = apps();
        let fake = Program {
            exe_path: r"C:\Temp\ChatGPT.exe",
            package_family: None,
        };
        assert_eq!(find(&list, &fake, &mut || None), None);
        let wrong_package = Program {
            exe_path: r"C:\Temp\claude.exe",
            package_family: Some("Someone.Claude_abc"),
        };
        assert_eq!(find(&list, &wrong_package, &mut || Some("Someone Else".into())), None);
    }

    #[test]
    fn other_programs_are_never_ai_apps() {
        let list = apps();
        for exe in [
            r"C:\Windows\notepad.exe",
            r"C:\Program Files\Mozilla Thunderbird\thunderbird.exe",
            "",
        ] {
            let p = Program {
                exe_path: exe,
                package_family: None,
            };
            // Signed by neither a known maker nor anything a `windows` entry names.
            assert_eq!(find(&list, &p, &mut || Some("Some Other Company".into())), None, "{exe}");
        }
    }

    #[test]
    fn todays_real_chatgpt_codex_package_matches_chatgpt() {
        let list = apps();
        let p = Program {
            exe_path: r"C:\Program Files\WindowsApps\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe",
            package_family: Some("OpenAI.Codex_2p2nqsd0c76g0"),
        };
        let hit = find(&list, &p, &mut || Some("OpenAI OpCo, LLC".into()));
        assert_eq!(hit.map(|a| a.id.as_str()), Some("chatgpt"));
    }

    #[test]
    fn a_renamed_openai_signed_exe_still_matches_chatgpt() {
        let list = apps();
        let p = Program {
            exe_path: r"C:\Program Files\WindowsApps\OpenAI.SomeFutureApp_x64__2p2nqsd0c76g0\app\SomeFutureApp.exe",
            package_family: Some("OpenAI.SomeFutureApp_2p2nqsd0c76g0"),
        };
        let hit = find(&list, &p, &mut || Some("OpenAI OpCo, LLC".into()));
        assert_eq!(
            hit.map(|a| a.id.as_str()),
            Some("chatgpt"),
            "a maker whose every app is an AI app matches on its signature alone, whatever the exe or package"
        );
    }

    #[test]
    fn codexs_own_exe_in_the_same_package_matches_too() {
        let list = apps();
        let p = Program {
            exe_path: r"C:\Program Files\WindowsApps\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\app\Codex.exe",
            package_family: Some("OpenAI.Codex_2p2nqsd0c76g0"),
        };
        let hit = find(&list, &p, &mut || Some("OpenAI OpCo, LLC".into()));
        assert_eq!(hit.map(|a| a.id.as_str()), Some("chatgpt"));
    }

    #[test]
    fn the_old_chatgpt_desktop_family_still_matches() {
        let list = apps();
        let p = Program {
            exe_path: r"C:\Program Files\WindowsApps\OpenAI.ChatGPT-Desktop_1.0.0.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe",
            package_family: Some("OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0"),
        };
        let mut asked = false;
        let hit = find(&list, &p, &mut || {
            asked = true;
            None
        });
        assert_eq!(hit.map(|a| a.id.as_str()), Some("chatgpt"));
        assert!(!asked, "the publisher id in the package family settles it without a signature");
    }

    #[test]
    fn a_made_up_openai_package_matches_by_publisher_id_alone() {
        let list = apps();
        let p = Program {
            exe_path: r"C:\Program Files\WindowsApps\OpenAI.Whatever_1.0.0.0_x64__2p2nqsd0c76g0\app\Whatever.exe",
            package_family: Some("OpenAI.Whatever_2p2nqsd0c76g0"),
        };
        let mut asked = false;
        let hit = find(&list, &p, &mut || {
            asked = true;
            None
        });
        assert_eq!(
            hit.and_then(|a| a.maker.as_ref()).map(|m| m.name.as_str()),
            Some("OpenAI"),
            "a never-before-seen OpenAI package still matches the maker"
        );
        assert!(!asked, "the publisher id suffix settles it without a signature");
    }

    #[test]
    fn an_unsigned_exe_called_chatgpt_doesnt_match() {
        let list = apps();
        let p = Program {
            exe_path: r"C:\Temp\ChatGPT.exe",
            package_family: None,
        };
        assert_eq!(find(&list, &p, &mut || None), None, "no signature, no match");
    }

    #[test]
    fn a_microsoft_signed_notepad_doesnt_match_copilot() {
        let list = apps();
        let p = Program {
            exe_path: r"C:\Windows\notepad.exe",
            package_family: None,
        };
        assert_eq!(
            find(&list, &p, &mut || Some("Microsoft Corporation".into())),
            None,
            "Microsoft ships other software too, so Copilot keeps the exe-plus-package/publisher gate"
        );
    }

    #[test]
    fn a_list_entry_without_a_maker_or_with_a_path_is_refused() {
        let no_maker = r#"{"apps":[{"id":"x","name":"X","windows":[{"exe":"x.exe"}]}]}"#;
        assert!(parse(no_maker).is_err());
        let path = r#"{"apps":[{"id":"x","name":"X","windows":[{"exe":"C:\\x.exe","publisher":"X"}]}]}"#;
        assert!(parse(path).is_err());
        let w = r#""windows":[{"exe":"x.exe","publisher":"X"}]"#;
        let twice = format!(r#"{{"apps":[{{"id":"x","name":"X",{w}}},{{"id":"x","name":"Y",{w}}}]}}"#);
        assert!(parse(&twice).is_err());
        let bad_id = format!(r#"{{"apps":[{{"id":"X Y","name":"X",{w}}}]}}"#);
        assert!(parse(&bad_id).is_err());
        // An entry the list knows only on phones is left out of the Windows list, not refused.
        let phone_only = r#"{"apps":[{"id":"lumo","name":"Lumo"}]}"#;
        assert_eq!(parse(phone_only).map(|a| a.len()), Ok(0));
    }

    #[test]
    fn an_app_naming_an_unknown_maker_id_is_refused() {
        let unknown = r#"{"makers":[],"apps":[{"id":"x","name":"X","maker":"ghost"}]}"#;
        assert!(parse(unknown).is_err());
        let two_makers_share_an_id =
            r#"{"makers":[{"id":"m","name":"M","signer":"S","publisherId":"p"},{"id":"m","name":"N","signer":"T","publisherId":"q"}],"apps":[]}"#;
        assert!(parse(two_makers_share_an_id).is_err());
    }

    /// Rung one's safety net needs its own fixture: every maker the built-in list ships (OpenAI, Anthropic) is
    /// already claimed by an app, so `find` alone would always catch them -- a maker with no app proves
    /// `find_known_maker` still fires once a future maker entry is added ahead of its product.
    fn fixture_makers() -> Vec<Maker> {
        vec![Maker {
            id: "fixture".into(),
            name: "Fixture Maker".into(),
            signer: "Fixture Maker, Inc.".into(),
            publisher_id: "fixt00000maker".into(),
        }]
    }

    #[test]
    fn a_fixture_makers_signed_program_is_caught_once_find_comes_back_empty() {
        let apps = apps(); // no app in the real list claims "fixture"
        let p = Program {
            exe_path: r"C:\Program Files\FixtureCo\NewThing.exe",
            package_family: None,
        };
        assert_eq!(find(&apps, &p, &mut || Some("Fixture Maker, Inc.".into())), None);
        let makers = fixture_makers();
        let hit = find_known_maker(&makers, &p, &mut || Some("Fixture Maker, Inc.".into()));
        assert_eq!(hit.map(|m| m.name.as_str()), Some("Fixture Maker"));
    }

    #[test]
    fn a_fixture_makers_package_family_is_caught_by_its_publisher_id_too() {
        let p = Program {
            exe_path: r"C:\Program Files\WindowsApps\FixtureCo.NewThing_1.0.0.0_x64__fixt00000maker\NewThing.exe",
            package_family: Some("FixtureCo.NewThing_fixt00000maker"),
        };
        let makers = fixture_makers();
        let hit = find_known_maker(&makers, &p, &mut || None);
        assert_eq!(hit.map(|m| m.name.as_str()), Some("Fixture Maker"));
    }

    #[test]
    fn unmatched_maker_name_names_the_file_and_the_maker_never_a_path() {
        let makers = fixture_makers();
        let p = Program {
            exe_path: r"C:\Program Files\FixtureCo\NewThing.exe",
            package_family: None,
        };
        let hit = unmatched_maker_name(&makers, &p, &mut || Some("Fixture Maker, Inc.".into()));
        assert_eq!(hit, Some(("NewThing.exe".to_string(), "Fixture Maker".to_string())));
    }

    #[test]
    fn unmatched_maker_name_is_none_once_nothing_known_signed_it() {
        let makers = fixture_makers();
        let p = Program {
            exe_path: r"C:\Windows\notepad.exe",
            package_family: None,
        };
        assert_eq!(unmatched_maker_name(&makers, &p, &mut || Some("Microsoft Corporation".into())), None);
    }

    /// The ids `covered` counts on a stand-in PC that has exactly these Store packages and has seen these apps.
    fn covered_ids(installed: &[&str], seen: &[&str]) -> Vec<String> {
        let seen: Vec<String> = seen.iter().map(|s| s.to_string()).collect();
        let mut has = |family: &str| installed.iter().any(|f| f.eq_ignore_ascii_case(family));
        apps()
            .iter()
            .filter(|a| covered(a, &mut has, &seen))
            .map(|a| a.id.clone())
            .collect()
    }

    #[test]
    fn only_the_ai_apps_on_this_pc_count_as_covered() {
        assert_eq!(covered_ids(&["OpenAI.Codex_2p2nqsd0c76g0", "Claude_pzs8sxrjxfjjc"], &[]), ["chatgpt", "claude"]);
        assert_eq!(covered_ids(&["claude_PZS8SXRJXFJJC"], &[]), ["claude"], "families ignore case");
        assert!(covered_ids(&[], &[]).is_empty(), "a PC with no AI app counts none");
        assert!(covered_ids(&["Microsoft.WindowsCalculator_8wekyb3d8bbwe"], &[]).is_empty());
    }

    #[test]
    fn an_app_seen_in_front_counts_even_with_no_store_package() {
        // Claude's own installer, outside the Store, leaves no package to find; having been in front is enough.
        assert_eq!(covered_ids(&[], &["claude"]), ["claude"]);
        assert_eq!(covered_ids(&["Claude_pzs8sxrjxfjjc"], &["claude"]), ["claude"], "counted once");
    }

    #[test]
    fn copilot_counts_only_once_it_has_been_seen_in_front() {
        // Its list entry is still "to confirm on a real PC", so its package alone doesn't prove Clotr knows it.
        assert!(covered_ids(&["Microsoft.Copilot_8wekyb3d8bbwe"], &[]).is_empty());
        assert_eq!(covered_ids(&["Microsoft.Copilot_8wekyb3d8bbwe"], &["copilot"]), ["copilot"]);
    }

    #[test]
    fn an_entry_is_confirmed_unless_the_list_says_to_confirm_it() {
        let copilot = apps().into_iter().find(|a| a.id == "copilot").unwrap();
        assert!(copilot.windows.iter().all(|w| !w.confirmed()));
        let claude = apps().into_iter().find(|a| a.id == "claude").unwrap();
        assert!(claude.windows.iter().all(WinId::confirmed));
        let unsaid = WinId { exe: "x.exe".into(), package_family: Some("X_1".into()), publisher: None, seen: None };
        assert!(unsaid.confirmed(), "an entry the list says nothing about is taken as written");
    }

    #[test]
    fn an_unrelated_signer_never_trips_the_fixture_makers_safety_net() {
        let p = Program {
            exe_path: r"C:\Windows\notepad.exe",
            package_family: None,
        };
        assert_eq!(
            find_known_maker(&fixture_makers(), &p, &mut || Some("Microsoft Corporation".into())),
            None
        );
    }
}
