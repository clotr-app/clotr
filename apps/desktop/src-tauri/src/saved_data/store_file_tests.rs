use super::*;

// ---------- Made-up values and helpers ----------

const CARD: &str = "4111111111111111";
const PHONE: &str = "4155550132";

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("clotr-store-test-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn apps() -> Vec<String> {
    vec!["claude".into(), "chatgpt".into()]
}

fn event(fp: &str) -> Value {
    json!({ "t": 1_700_000_000_000u64, "site": "app:claude", "type": "credit_card", "name": "Credit Card Number",
            "severity": "high", "action": "redacted", "fp": fp })
}

// ---------- One Clotr's shared settings ----------

#[test]
fn shared_settings_changes_keep_only_local_values_and_their_write_time() {
    let dir = temp_dir("one-clotr-settings-time");
    let mut store = Store::open(&dir).unwrap();
    store.save_settings(&json!({"largeText":true,"keepDays":90}), From::Settings).unwrap();
    store.set_responses(&json!(["email"]), "block").unwrap();
    store.set_tourniquet(&Value::Null).unwrap();
    let bytes = fs::read(dir.join("one-clotr-settings.json")).unwrap();
    let metadata: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(metadata["largeText"]["value"], true);
    assert_eq!(metadata["largeText"]["updatedAt"].is_u64(), true);
    assert_eq!(metadata["responses"]["value"]["email"], "block");
    assert_eq!(metadata["tourniquet"]["value"], Value::Null);
    assert!(metadata.get("salt").is_none());
    assert!(metadata.get("events").is_none());
    fs::remove_dir_all(dir).unwrap();
}

// ---------- Opening, one-time notes and the apps seen in front ----------

#[test]
fn a_new_store_gets_a_salt_from_the_secure_random_and_keeps_it() {
    let dir = temp_dir("salt");
    let salt = Store::open(&dir).unwrap().settings()["salt"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(is_hex(&salt, 32), "{salt}");
    assert_eq!(Store::open(&dir).unwrap().settings()["salt"], json!(salt));
    let other = temp_dir("salt2");
    assert_ne!(Store::open(&other).unwrap().settings()["salt"], json!(salt));
    let _ = fs::remove_dir_all(dir);
    let _ = fs::remove_dir_all(other);
}

#[test]
fn each_one_time_note_is_kept_once_shown_and_a_page_can_never_set_one() {
    let dir = temp_dir("once");
    let mut store = Store::open(&dir).unwrap();
    for note in [Once::StartLine, Once::CloseToast] {
        assert!(!store.once(note), "{note:?} starts unshown");
    }
    store.set_once(Once::StartLine).unwrap();
    assert!(store.once(Once::StartLine));
    assert!(!store.once(Once::CloseToast), "each note is its own");
    store.set_once(Once::CloseToast).unwrap();
    let reopened = Store::open(&dir).unwrap();
    assert!(reopened.once(Once::StartLine) && reopened.once(Once::CloseToast), "a restart keeps both");
    let from_page = clean_settings(&json!({ "startLineSeen": true, "closeToastSeen": true }), false);
    assert!(from_page.is_empty(), "{from_page:?}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn an_ai_app_seen_in_front_is_kept_once_across_a_restart_and_never_taken_from_a_page() {
    let dir = temp_dir("seen-apps");
    let mut store = Store::open(&dir).unwrap();
    assert!(store.seen_apps().is_empty());
    assert!(store.note_app_seen("claude").unwrap(), "new the first time");
    assert!(!store.note_app_seen("claude").unwrap(), "not new the second");
    assert!(store.note_app_seen("chatgpt").unwrap());
    assert_eq!(Store::open(&dir).unwrap().seen_apps(), ["claude", "chatgpt"]);
    assert!(!clean_settings(&json!({ "seenApps": ["copilot"] }), false).contains_key("seenApps"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_seen_list_read_back_keeps_only_app_ids() {
    let dir = temp_dir("seen-apps-odd");
    fs::create_dir_all(&dir).unwrap();
    let raw = json!({ "seenApps": ["claude", "..\\x", 7, "Claude", "", "claude", "chatgpt"] });
    fs::write(dir.join(FILE), serde_json::to_vec(&raw).unwrap()).unwrap();
    assert_eq!(Store::open(&dir).unwrap().seen_apps(), ["claude", "chatgpt"]);
    let mut store = Store::open(&dir).unwrap();
    assert!(!store.note_app_seen("Not An Id").unwrap(), "an id Clotr's list could never hold is refused");
    assert_eq!(store.seen_apps(), ["claude", "chatgpt"]);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn the_typed_notes_seen_mark_survives_a_restart_and_a_page_can_never_set_it() {
    let dir = temp_dir("typed-note");
    let mut store = Store::open(&dir).unwrap();
    assert_eq!(store.settings().get("typedNoteSeen"), None);
    store.set_typed_note_seen().unwrap();
    assert_eq!(store.settings()["typedNoteSeen"], json!(true));
    // Restarting keeps it, so the first typed card's note shows once, not once per start.
    assert_eq!(Store::open(&dir).unwrap().settings()["typedNoteSeen"], json!(true));
    // Only the card's own command sets it; a settings save never carries it in.
    assert!(!clean_settings(&json!({ "typedNoteSeen": true }), false).contains_key("typedNoteSeen"));
    let _ = fs::remove_dir_all(dir);
}

// ---------- Pause and the weekly check ----------

/// "Pause for an hour" stays an hour across a restart: its deadline is kept with the pause, a deadline already
/// past by the next start lifts the pause there and then, and a plain pause or resume clears it. It used to
/// come back as a pause with no end.
#[test]
fn a_timed_pause_keeps_its_deadline_over_a_restart_and_ends_if_it_passed_meanwhile() {
    let dir = temp_dir("timed-pause");
    let mut store = Store::open(&dir).unwrap();
    let later = now_ms() as i64 + 30 * 60 * 1000;
    store.set_paused_all(true).unwrap();
    store.set_paused_until(later).unwrap();
    let again = Store::open(&dir).unwrap();
    assert!(again.paused_all());
    assert_eq!(again.paused_until(), Some(later));

    // Written by an earlier run whose hour has since passed (the PC was off, or Clotr quit, in between).
    let past = now_ms() as i64 - 1000;
    fs::write(dir.join(FILE), json!({ "pausedAll": true, "pausedUntil": past }).to_string()).unwrap();
    let restarted = Store::open(&dir).unwrap();
    assert!(!restarted.paused_all(), "an hour that's over doesn't come back as a pause with no end");
    assert_eq!(restarted.paused_until(), None);

    let mut store = Store::open(&dir).unwrap();
    store.set_paused_all(true).unwrap();
    store.set_paused_until(later).unwrap();
    store.set_paused_all(true).unwrap();
    assert_eq!(store.paused_until(), None, "a plain pause has no end");
    assert!(!clean_settings(&json!({ "pausedUntil": 1 }), false).contains_key("pausedUntil"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn the_weekly_checks_own_time_survives_a_restart_and_a_page_can_never_set_it() {
    let dir = temp_dir("weekly");
    let mut store = Store::open(&dir).unwrap();
    assert_eq!(store.last_weekly_check(), None);
    store.set_last_weekly_check(1_700_000_000_000).unwrap();
    assert_eq!(store.last_weekly_check(), Some(1_700_000_000_000));
    // Restarting keeps it, the same way pausedAll does.
    assert_eq!(Store::open(&dir).unwrap().last_weekly_check(), Some(1_700_000_000_000));
    // Settings saved from the main window never carry it in: clean_settings has no case for the key, so a
    // hostile or buggy save can't move the clock back.
    let clean = clean_settings(&json!({ "lastWeeklyCheck": 0 }), false);
    assert!(!clean.contains_key("lastWeeklyCheck"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_weekly_finds_new_and_still_counts_survive_a_restart_and_a_page_can_never_set_them() {
    let dir = temp_dir("weekly-find");
    let mut store = Store::open(&dir).unwrap();
    assert_eq!(store.weekly_find_total(), 0);
    store.set_weekly_find(1, 3).unwrap();
    assert_eq!(store.weekly_find_total(), 4);
    assert_eq!(Store::open(&dir).unwrap().weekly_find_total(), 4);
    let clean = clean_settings(&json!({ "lastWeeklyFind": { "new": 9, "still": 9 } }), false);
    assert!(!clean.contains_key("lastWeeklyFind"));
    let _ = fs::remove_dir_all(dir);
}

// ---------- History and the vault ----------

#[test]
fn events_keep_only_the_extensions_fields() {
    let mut sent = event("0123456789abcdef");
    sent["text"] = json!("my card is 4111 1111 1111 1111");
    sent["via"] = json!("bandage");
    let clean = clean_event(&sent, &apps()).unwrap();
    let mut keys: Vec<&String> = clean.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["action", "fp", "name", "severity", "site", "t", "type"]);
}

#[test]
fn scheme_two_survives_history_and_vault_cleaning_while_old_entries_stay_unmarked() {
    let mut fresh_event = event("0123456789abcdef");
    fresh_event["scheme"] = json!(2);
    let cleaned_event = clean_event(&fresh_event, &apps()).unwrap();
    assert_eq!(cleaned_event["scheme"], json!(2));

    let old_event = clean_event(&event("0123456789abcdef"), &apps()).unwrap();
    assert!(old_event.get("scheme").is_none());

    let fresh_vault = json!({
        "kind": "value",
        "type": "phone_number",
        "fp": "0123456789abcdef",
        "scheme": 2,
        "added": 1
    });
    assert_eq!(clean_vault_entry(&fresh_vault).unwrap()["scheme"], json!(2));

    let old_vault = json!({ "kind": "value", "type": "phone_number", "fp": "0123456789abcdef", "added": 1 });
    assert!(clean_vault_entry(&old_vault).unwrap().get("scheme").is_none());
}

#[test]
fn events_with_a_value_where_a_name_or_fingerprint_goes_lose_it_or_are_dropped() {
    assert_eq!(
        clean_event(&event(CARD), &apps()).unwrap()["fp"],
        json!(""),
        "a card number is not a fingerprint"
    );
    assert_eq!(
        clean_event(&event("4111 1111 1111 1111"), &apps()).unwrap()["fp"],
        json!("")
    );
    let mut named = event("0123456789abcdef");
    named["name"] = json!(format!("Card {CARD}"));
    assert_eq!(clean_event(&named, &apps()), None);
    named["name"] = json!("someone@example.com");
    assert_eq!(clean_event(&named, &apps()), None);
    let mut kind = event("0123456789abcdef");
    kind["type"] = json!(PHONE);
    assert_eq!(clean_event(&kind, &apps()), None);
}

#[test]
fn events_only_for_ai_apps_on_the_list_and_known_choices() {
    let mut elsewhere = event("0123456789abcdef");
    elsewhere["site"] = json!("app:thunderbird");
    assert_eq!(clean_event(&elsewhere, &apps()), None);
    elsewhere["site"] = json!("chatgpt.com");
    assert_eq!(clean_event(&elsewhere, &apps()), None);
    let mut reply = event("0123456789abcdef");
    reply["action"] = json!("mentioned");
    assert_eq!(clean_event(&reply, &apps()), None, "no AI replies are read on Windows");
    assert!(clean_event(&event("0123456789abcdef"), &apps()).is_some());
}

#[test]
fn vault_entries_are_fingerprints_or_formats_never_values() {
    let by_fingerprint = json!({ "kind": "value", "type": "phone_number", "fp": "0123456789abcdef", "added": 1 });
    assert_eq!(clean_vault_entry(&by_fingerprint).unwrap()["mode"], json!("protect"));
    let raw = json!({ "kind": "value", "type": "phone_number", "value": PHONE, "added": 1 });
    assert_eq!(clean_vault_entry(&raw), None);
    let shape_with_digits = json!({ "kind": "shape", "type": "my_id", "shape": "AB-1234##" });
    assert_eq!(clean_vault_entry(&shape_with_digits), None);
    let shape = json!({ "kind": "shape", "type": "my_id", "shape": "AB-####" });
    assert!(clean_vault_entry(&shape).is_some());
}

#[test]
fn history_older_than_keep_days_goes() {
    let dir = temp_dir("prune");
    let mut store = Store::open(&dir).unwrap();
    store.save_settings(&json!({ "keepDays": 90 }), From::Settings).unwrap();
    let now = now_ms();
    let old = json!({ "t": now - 100 * DAY_MS, "site": "app:claude", "type": "email", "name": "Email Address",
                      "severity": "medium", "action": "allowed", "fp": "" });
    let new = json!({ "t": now, "site": "app:claude", "type": "email", "name": "Email Address",
                      "severity": "medium", "action": "allowed", "fp": "" });
    assert_eq!(store.record(&json!([old, new]), &apps()).unwrap(), 2);
    assert_eq!(store.events().as_array().unwrap().len(), 1);
    let _ = fs::remove_dir_all(dir);
}

// ---------- Check my files' Ignore and Extension check's Keep it ----------

#[test]
fn a_scan_fingerprint_never_carries_the_path_or_id_it_was_made_from() {
    let path = r"C:\Users\test\Downloads\tax-notes.txt";
    let fp = scan_fingerprint("salt1", "file", path);
    assert_eq!(fp.len(), 16, "{fp}");
    assert!(fp.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(!fp.contains("tax") && !fp.to_lowercase().contains("downloads"));
    // Same salt, same value: the same fingerprint every time, so a later scan recognizes it.
    assert_eq!(fp, scan_fingerprint("salt1", "file", path));
    // A different salt, a different kind, or a different value: a different fingerprint.
    assert_ne!(fp, scan_fingerprint("salt2", "file", path));
    assert_ne!(fp, scan_fingerprint("salt1", "ext", path));
    assert_ne!(fp, scan_fingerprint("salt1", "file", r"C:\Users\test\Downloads\other.txt"));
}

#[test]
fn ignoring_a_file_makes_the_next_scan_recognize_it_by_fingerprint_alone() {
    let dir = temp_dir("ignore");
    let mut store = Store::open(&dir).unwrap();
    let path = r"C:\Users\test\Downloads\tax-notes.txt";
    assert!(!store.is_scan_ignored("file", path));
    let fp = store.ignore_scan_item("file", path).unwrap();
    assert!(store.is_scan_ignored("file", path));
    assert!(!store.is_scan_ignored("ext", path), "a different list");
    assert!(!store.is_scan_ignored("file", r"C:\Users\test\Downloads\other.txt"));
    // The fingerprint on disk, never the path.
    let raw = fs::read_to_string(dir.join("store.json")).unwrap();
    assert!(raw.contains(&fp) && !raw.contains("tax-notes"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn ignoring_the_same_file_twice_keeps_one_entry() {
    let dir = temp_dir("ignore-twice");
    let mut store = Store::open(&dir).unwrap();
    let path = r"C:\Users\test\Downloads\tax-notes.txt";
    store.ignore_scan_item("file", path).unwrap();
    store.ignore_scan_item("file", path).unwrap();
    assert_eq!(store.settings()["scanIgnored"].as_array().unwrap().len(), 1);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn an_ignored_file_is_still_recognized_after_clotr_restarts() {
    let dir = temp_dir("ignore-reload");
    let path = r"C:\Users\test\Desktop\logins.txt";
    {
        let mut store = Store::open(&dir).unwrap();
        store.ignore_scan_item("file", path).unwrap();
    }
    let reopened = Store::open(&dir).unwrap();
    assert!(reopened.is_scan_ignored("file", path));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn the_ignored_files_a_walk_checks_are_the_ones_ignore_made() {
    let dir = temp_dir("ignored-files");
    let mut store = Store::open(&dir).unwrap();
    let path = r"C:\Users\test\Downloads\tax-notes.txt";
    assert!(!store.ignored_files().contains(Path::new(path)));
    store.ignore_scan_item("file", path).unwrap();
    store.ignore_scan_item("ext", "abcdef").unwrap();
    let ignored = store.ignored_files();
    assert!(ignored.contains(Path::new(path)));
    assert!(!ignored.contains(Path::new(r"C:\Users\test\Downloads\other.txt")));
    assert!(!ignored.contains(Path::new("abcdef")), "an extension's entry isn't a file's");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn undo_right_after_ignore_drops_only_that_fingerprint() {
    let dir = temp_dir("unignore");
    let mut store = Store::open(&dir).unwrap();
    let path = r"C:\Users\test\Downloads\tax-notes.txt";
    let other = r"C:\Users\test\Downloads\other.txt";
    store.ignore_scan_item("file", path).unwrap();
    store.ignore_scan_item("file", other).unwrap();
    assert!(store.is_scan_ignored("file", path));
    store.unignore_scan_item("file", path).unwrap();
    assert!(!store.is_scan_ignored("file", path), "undone");
    assert!(store.is_scan_ignored("file", other), "a different item, left alone");
    assert_eq!(store.settings()["scanIgnored"].as_array().unwrap().len(), 1);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn undoing_an_item_never_on_the_list_does_nothing() {
    let dir = temp_dir("unignore-missing");
    let mut store = Store::open(&dir).unwrap();
    store.unignore_scan_item("file", r"C:\Users\test\Downloads\never-ignored.txt").unwrap();
    let count = store.settings()["scanIgnored"].as_array().map_or(0, Vec::len);
    assert_eq!(count, 0);
    let _ = fs::remove_dir_all(dir);
}

// ---------- Tell only what's new ----------

#[test]
fn a_find_is_new_once_and_never_again_after_that() {
    let dir = temp_dir("seen-once");
    let mut store = Store::open(&dir).unwrap();
    let path = r"C:\Users\test\Downloads\tax-notes.txt";
    let kinds = vec!["us_ssn".to_string()];
    assert!(store.note_scan_find(path, &kinds).unwrap(), "the first time, it's new");
    assert!(!store.note_scan_find(path, &kinds).unwrap(), "the same path and kinds again: not new");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_find_is_new_again_once_its_own_kinds_change() {
    let dir = temp_dir("seen-kinds-change");
    let mut store = Store::open(&dir).unwrap();
    let path = r"C:\Users\test\Downloads\notes.txt";
    assert!(store.note_scan_find(path, &["email".to_string()]).unwrap());
    assert!(!store.note_scan_find(path, &["email".to_string()]).unwrap());
    assert!(
        store.note_scan_find(path, &["email".to_string(), "password".to_string()]).unwrap(),
        "a password found in it since: a different fingerprint, so new again"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_finds_own_kinds_in_any_order_are_the_same_fingerprint() {
    let dir = temp_dir("seen-order");
    let mut store = Store::open(&dir).unwrap();
    let path = r"C:\Users\test\Downloads\notes.txt";
    assert!(store.note_scan_find(path, &["password".to_string(), "email".to_string()]).unwrap());
    assert!(!store.note_scan_find(path, &["email".to_string(), "password".to_string()]).unwrap());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_seen_fingerprint_never_carries_the_path_or_the_kinds_it_was_made_from() {
    let dir = temp_dir("seen-private");
    let mut store = Store::open(&dir).unwrap();
    store
        .note_scan_find(r"C:\Users\test\Downloads\tax-notes.txt", &["us_ssn".to_string()])
        .unwrap();
    let raw = fs::read_to_string(dir.join("store.json")).unwrap();
    assert!(!raw.contains("tax-notes") && !raw.to_lowercase().contains("ssn"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_seen_find_survives_a_restart() {
    let dir = temp_dir("seen-reload");
    let path = r"C:\Users\test\Desktop\logins.txt";
    {
        let mut store = Store::open(&dir).unwrap();
        store.note_scan_find(path, &["password".to_string()]).unwrap();
    }
    let mut reopened = Store::open(&dir).unwrap();
    assert!(!reopened.note_scan_find(path, &["password".to_string()]).unwrap());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn show_them_again_clears_every_ignored_item() {
    let dir = temp_dir("clear-ignored");
    let mut store = Store::open(&dir).unwrap();
    store.ignore_scan_item("file", r"C:\Users\test\Downloads\tax-notes.txt").unwrap();
    store.ignore_scan_item("ext", "exe").unwrap();
    assert_eq!(store.settings()["scanIgnored"].as_array().unwrap().len(), 2);
    store.clear_scan_ignored().unwrap();
    assert_eq!(store.settings()["scanIgnored"].as_array().unwrap().len(), 0);
    let _ = fs::remove_dir_all(dir);
}

// ---------- History's scan rows ----------

fn scan_row(scan: &str) -> Value {
    json!({ "t": 1_700_000_000_000u64, "scan": scan, "items": 40, "seconds": 4, "counts": { "credit_card": 1 } })
}

#[test]
fn a_scan_row_keeps_only_when_kind_count_and_counts_per_detail() {
    let clean = clean_scan_row(&scan_row("quick")).unwrap();
    let mut keys: Vec<&String> = clean.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["counts", "items", "scan", "seconds", "t"]);
    assert_eq!(clean["counts"], json!({ "credit_card": 1 }));
}

#[test]
fn older_scan_rows_do_not_gain_a_fabricated_duration() {
    let mut row = scan_row("quick");
    row.as_object_mut().unwrap().remove("seconds");
    let clean = clean_scan_row(&row).unwrap();
    assert_eq!(clean.get("seconds"), None);
}

#[test]
fn a_scan_row_never_carries_a_path_a_filename_or_a_detected_value() {
    let mut row = scan_row("full");
    row["path"] = json!(r"C:\Users\test\Downloads\tax-notes.txt");
    row["name"] = json!("tax-notes.txt");
    row["value"] = json!(CARD);
    let clean = clean_scan_row(&row).unwrap();
    let raw = serde_json::to_string(&clean).unwrap();
    assert!(!raw.contains("tax-notes") && !raw.contains(CARD));
}

#[test]
fn a_scan_row_with_an_unknown_scan_or_detail_kind_is_dropped_or_trimmed() {
    let mut bad_scan = scan_row("folder");
    assert_eq!(clean_scan_row(&bad_scan), None);
    bad_scan["scan"] = json!("lookback");
    assert!(clean_scan_row(&bad_scan).is_some());
    let mut bad_kind = scan_row("quick");
    bad_kind["counts"] = json!({ "credit_card": 1, "not a kind!": 2 });
    assert_eq!(clean_scan_row(&bad_kind).unwrap()["counts"], json!({ "credit_card": 1 }));
}

#[test]
fn recording_a_scan_row_adds_it_and_a_bad_one_is_refused() {
    let dir = temp_dir("scan-row");
    let mut store = Store::open(&dir).unwrap();
    assert!(store.record_scan(&scan_row("quick")).unwrap());
    assert_eq!(store.scans().as_array().unwrap().len(), 1);
    assert!(!store.record_scan(&scan_row("folder")).unwrap());
    assert_eq!(store.scans().as_array().unwrap().len(), 1);
    assert!(!store.settings().as_object().unwrap().contains_key("scans"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn scan_comparison_keeps_only_per_kind_count_changes() {
    let dir = temp_dir("scan-delta");
    let mut store = Store::open(&dir).unwrap();
    let mut first = scan_row("quick");
    first["counts"] = json!({ "credit_card": 3, "password": 1 });
    store.record_scan(&first).unwrap();
    let mut next = scan_row("quick");
    next["counts"] = json!({ "credit_card": 1, "phone": 2 });
    store.record_scan(&next).unwrap();
    let latest = store.scans().as_array().unwrap().last().unwrap().clone();
    assert_eq!(latest["added"], json!({ "phone": 2 }));
    assert_eq!(latest["gone"], json!({ "credit_card": 2, "password": 1 }));
    let raw = serde_json::to_string(&latest).unwrap();
    assert!(!raw.contains("tax") && !raw.contains(CARD));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn scan_rows_are_still_there_after_clotr_restarts_and_capped() {
    let dir = temp_dir("scan-row-reload");
    {
        let mut store = Store::open(&dir).unwrap();
        for _ in 0..(MAX_SCAN_ROWS + 10) {
            store.record_scan(&scan_row("quick")).unwrap();
        }
    }
    let reopened = Store::open(&dir).unwrap();
    assert_eq!(reopened.scans().as_array().unwrap().len(), MAX_SCAN_ROWS);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn clearing_history_clears_scan_rows_too() {
    let dir = temp_dir("scan-row-clear");
    let mut store = Store::open(&dir).unwrap();
    store.record_scan(&scan_row("quick")).unwrap();
    store.clear_history().unwrap();
    assert_eq!(store.scans(), json!([]));
    let _ = fs::remove_dir_all(dir);
}

// ---------- Tourniquet ----------

#[test]
fn tourniquet_keeps_only_its_own_two_shapes() {
    assert_eq!(
        clean_tourniquet(Some(&json!({ "for": "child", "since": 1000 }))),
        Some(json!({ "for": "child", "since": 1000 }))
    );
    assert_eq!(
        clean_tourniquet(Some(&json!({ "for": "adult", "since": 1000 }))),
        Some(json!({ "for": "adult", "since": 1000 }))
    );
    let day = 86_400_000u64;
    assert_eq!(
        clean_tourniquet(Some(&json!({ "for": "after_scam", "since": 1000, "until": 1000 + 30 * day }))),
        Some(json!({ "for": "after_scam", "since": 1000, "until": 1000 + 30 * day }))
    );
    assert_eq!(clean_tourniquet(None), None);
    assert_eq!(clean_tourniquet(Some(&Value::Null)), None);
}

#[test]
fn tourniquet_rejects_an_unknown_word_a_stray_field_or_a_bad_end() {
    let day = 86_400_000u64;
    assert_eq!(clean_tourniquet(Some(&json!({ "for": "teen", "since": 1000 }))), None);
    assert_eq!(
        clean_tourniquet(Some(&json!({ "for": "child", "since": 1000, "until": 2000 }))),
        None,
        "until only belongs to after_scam"
    );
    assert_eq!(
        clean_tourniquet(Some(&json!({ "for": "after_scam", "since": 1000 }))),
        None,
        "after_scam needs an until"
    );
    assert_eq!(
        clean_tourniquet(Some(&json!({ "for": "after_scam", "since": 2000, "until": 1000 }))),
        None,
        "until before since"
    );
    assert_eq!(
        clean_tourniquet(Some(&json!({ "for": "after_scam", "since": 1000, "until": 1000 + 62 * day }))),
        None,
        "more than 61 days"
    );
}

#[test]
fn a_bad_tourniquet_record_is_dropped_on_save_and_reload_without_touching_anything_else() {
    let dir = temp_dir("tourniquet");
    let mut store = Store::open(&dir).unwrap();
    store
        .save_settings(&json!({ "tourniquet": { "for": "nonsense" }, "largeText": true }), From::Settings)
        .unwrap();
    assert_eq!(store.settings().get("tourniquet"), None);
    assert_eq!(store.settings()["largeText"], json!(true));
    store
        .save_settings(&json!({ "tourniquet": { "for": "child", "since": 1000 } }), From::Settings)
        .unwrap();
    let reopened = Store::open(&dir).unwrap();
    assert_eq!(reopened.settings()["tourniquet"], json!({ "for": "child", "since": 1000 }));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn set_tourniquet_turns_it_on_and_a_bad_or_empty_value_turns_it_off() {
    let dir = temp_dir("set-tourniquet");
    let mut store = Store::open(&dir).unwrap();
    assert!(store.set_tourniquet(&json!({ "for": "adult", "since": 1000 })).unwrap());
    assert_eq!(store.settings()["tourniquet"], json!({ "for": "adult", "since": 1000 }));
    assert!(!store.set_tourniquet(&json!({ "for": "nonsense" })).unwrap());
    assert_eq!(store.settings().get("tourniquet"), None, "a bad value takes it off, not leaves the old one");
    store.set_tourniquet(&json!({ "for": "child", "since": 2000 })).unwrap();
    assert!(!store.set_tourniquet(&Value::Null).unwrap());
    assert_eq!(store.settings().get("tourniquet"), None);
    let _ = fs::remove_dir_all(dir);
}

// ---------- Settings: what a page or a move file may change ----------

#[test]
fn a_malformed_scan_ignored_entry_is_dropped_on_reload() {
    let raw = json!({ "scanIgnored": [
        { "fp": "0123456789abcdef", "kind": "file" },
        { "fp": "not-hex-at-all!!", "kind": "file" },
        { "fp": "0123456789abcdef", "kind": "folder" },
        { "fp": "0123456789abcdef" },
    ] });
    let cleaned = clean_settings(&raw, false);
    assert_eq!(
        cleaned["scanIgnored"],
        json!([{ "fp": "0123456789abcdef", "kind": "file" }])
    );
}

#[test]
fn a_malformed_scan_seen_entry_is_dropped_on_reload() {
    let raw = json!({ "scanSeen": ["0123456789abcdef", "not-hex-at-all!!", "0123456789abcdef"] });
    let cleaned = clean_settings(&raw, false);
    assert_eq!(cleaned["scanSeen"], json!(["0123456789abcdef"]), "bad entries dropped, duplicates kept once");
}

#[test]
fn settings_keep_known_keys_and_the_salt_only_from_a_move_file() {
    let raw = json!({
        "responses": { "credit_card": "log", "phone_number": "maybe", "4111": "warn" },
        "pausedApps": { "claude": true, "chatgpt": false },
        "keepDays": 30,
        "largeText": true,
        "salt": "0123456789abcdef0123456789abcdef",
        "draft": CARD,
        "events": [event("0123456789abcdef")],
    });
    let plain = clean_settings(&raw, false);
    assert_eq!(plain["responses"], json!({ "credit_card": "log" }));
    assert_eq!(plain["pausedApps"], json!({ "claude": true }));
    assert!(!plain.contains_key("keepDays") && !plain.contains_key("salt") && !plain.contains_key("draft"));
    assert!(!plain.contains_key("events"), "settings never carry history");
    assert_eq!(
        clean_settings(&raw, true)["salt"],
        json!("0123456789abcdef0123456789abcdef")
    );
}

#[test]
fn the_main_windows_own_settings_are_kept_only_as_their_named_choices() {
    let raw = json!({
        "startWithWindows": true,
        "look": "ember",
        "motion": "still",
        "language": "es",
        "weeklyCheck": true,
        "notifyFind": false,
        "scanDevFiles": true,
    });
    let clean = clean_settings(&raw, false);
    assert_eq!(clean["startWithWindows"], json!(true));
    assert_eq!(clean["look"], json!("ember"));
    assert_eq!(clean["motion"], json!("still"));
    assert_eq!(clean["language"], json!("es"));
    assert_eq!(clean["weeklyCheck"], json!(true));
    assert_eq!(clean["notifyFind"], json!(false));
    assert_eq!(clean["scanDevFiles"], json!(true));

    let hostile = json!({
        "look": "<script>",
        "motion": "smooth",
        "language": "fr",
        "startWithWindows": "yes",
        "weeklyCheck": 1,
        "notifyFind": "true",
        "scanDevFiles": "no",
    });
    let dropped = clean_settings(&hostile, false);
    for key in [
        "look",
        "motion",
        "language",
        "startWithWindows",
        "weeklyCheck",
        "notifyFind",
        "scanDevFiles",
    ] {
        assert!(!dropped.contains_key(key), "{key}");
    }
}

#[test]
fn plan_ticked_keeps_only_known_step_ids_deduped_and_capped() {
    let raw = json!({ "planTicked": ["keys", "money", "keys", "not-a-step", 7, "idPhotos"] });
    let clean = clean_settings(&raw, false);
    assert_eq!(clean["planTicked"], json!(["keys", "money", "idPhotos"]));
}

#[test]
fn plan_ticked_survives_a_round_trip_through_the_store() {
    let dir = temp_dir("plan-ticked");
    let mut store = Store::open(&dir).unwrap();
    store
        .save_settings(&json!({ "planTicked": ["keys", "idDocs"] }), From::Settings)
        .unwrap();
    drop(store);
    let reopened = Store::open(&dir).unwrap();
    assert_eq!(reopened.settings()["planTicked"], json!(["keys", "idDocs"]));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn results_mode_keeps_only_guided_or_detailed() {
    assert_eq!(
        clean_settings(&json!({ "resultsMode": "guided" }), false)["resultsMode"],
        json!("guided")
    );
    assert_eq!(
        clean_settings(&json!({ "resultsMode": "detailed" }), false)["resultsMode"],
        json!("detailed")
    );
    assert!(!clean_settings(&json!({ "resultsMode": "verbose" }), false).contains_key("resultsMode"));
    assert!(!clean_settings(&json!({ "resultsMode": 1 }), false).contains_key("resultsMode"));
}

#[test]
fn helper_name_is_trimmed_and_capped_never_rejected() {
    let clean = clean_settings(&json!({ "helperName": "  Sam  " }), false);
    assert_eq!(clean["helperName"], json!("Sam"));
    let empty = clean_settings(&json!({ "helperName": "   " }), false);
    assert_eq!(empty["helperName"], json!(""));
    let long = "a".repeat(200);
    let capped = clean_settings(&json!({ "helperName": long }), false);
    assert_eq!(capped["helperName"].as_str().unwrap().chars().count(), 60);
    assert!(!clean_settings(&json!({ "helperName": 7 }), false).contains_key("helperName"));
}

#[test]
fn results_mode_and_helper_name_survive_a_round_trip_through_the_store() {
    let dir = temp_dir("results-mode");
    let mut store = Store::open(&dir).unwrap();
    store
        .save_settings(&json!({ "resultsMode": "guided", "helperName": "Sam" }), From::Settings)
        .unwrap();
    drop(store);
    let reopened = Store::open(&dir).unwrap();
    assert_eq!(reopened.settings()["resultsMode"], json!("guided"));
    assert_eq!(reopened.settings()["helperName"], json!("Sam"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn old_looks_migrate_to_plum_and_ember() {
    for (old, current) in [("savanna", "plum"), ("dark", "ember")] {
        let raw = json!({ "look": old });
        assert_eq!(clean_settings(&raw, false)["look"], json!(current), "{old}");
    }
}

#[test]
fn a_moved_look_is_saved_under_its_new_name_on_the_first_open() {
    // This is why a saved "light" can mean Light again: when the old warm Light moved to Plum, the first open
    // wrote "plum" back to the file, the same way this writes "ember" for "dark".
    let dir = temp_dir("look-moved");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(FILE), r#"{ "look": "dark" }"#).unwrap();
    drop(Store::open(&dir).unwrap());
    let on_disk: Value = serde_json::from_slice(&fs::read(dir.join(FILE)).unwrap()).unwrap();
    assert_eq!(on_disk["look"], json!("ember"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn each_picked_look_opens_the_same_after_a_restart() {
    let dir = temp_dir("look-kept");
    for look in ["light", "plum", "ember", "system"] {
        let mut store = Store::open(&dir).unwrap();
        store.save_settings(&json!({ "look": look }), From::Settings).unwrap();
        drop(store);
        assert_eq!(Store::open(&dir).unwrap().settings()["look"], json!(look), "{look}");
    }
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn current_named_looks_are_kept_and_unknown_looks_are_dropped() {
    for look in ["system", "light", "plum", "ember"] {
        assert_eq!(clean_settings(&json!({ "look": look }), false)["look"], json!(look));
    }
    assert!(!clean_settings(&json!({ "look": "unknown" }), false).contains_key("look"));
}

// ---------- Hostile writes and move files ----------

#[test]
fn the_file_never_holds_a_planted_value_after_hostile_writes() {
    let dir = temp_dir("planted");
    let mut store = Store::open(&dir).unwrap();
    let mut planted = event(CARD);
    planted["name"] = json!("Credit Card Number");
    planted["extra"] = json!(CARD);
    store
        .record(
            &json!([planted, { "t": 1, "site": "app:claude", "type": "phone_number", "name": PHONE,
                               "severity": "high", "action": "allowed", "fp": PHONE }]),
            &apps(),
        )
        .unwrap();
    store.set_responses(&json!([CARD, "credit_card"]), "log").unwrap();
    store
        .save_settings(
            &json!({ "vault": [{ "kind": "value", "type": "phone_number", "value": PHONE }],
                                "guided": { PHONE: 1 }, "note": CARD }),
            From::Settings,
        )
        .unwrap();
    let text = fs::read_to_string(dir.join(FILE)).unwrap();
    assert!(!text.contains(CARD) && !text.contains(PHONE), "{text}");
    let _ = fs::remove_dir_all(dir);
}

/// The shared move file (tests/fixtures/): what the settings page brings from it (the keys the app keeps,
/// apps/desktop/ui/move-file.js) is stored as it is, salt included, and nothing else is.
#[test]
fn the_shared_move_file_is_kept_as_brought() {
    let text = include_str!("../../../../../tests/fixtures/move-file.json");
    let fixture: Value = serde_json::from_str(text).unwrap();
    let sealed = &fixture["settings"];
    let brought_keys = ["responses", "guided", "keepDays", "largeText", "salt", "vault"];
    let mut brought = Map::new();
    for key in brought_keys {
        brought.insert(key.into(), sealed[key].clone());
    }
    let dir = temp_dir("move");
    let mut store = Store::open(&dir).unwrap();
    store
        .save_settings(&Value::Object(brought.clone()), From::MoveFile)
        .unwrap();
    let kept = Store::open(&dir).unwrap().settings();
    for key in brought_keys {
        assert_eq!(kept[key], brought[key], "{key}");
    }
    for browser_only in ["paused", "siteModes", "lock", "bandage", "tourniquet"] {
        assert!(kept.get(browser_only).is_none(), "{browser_only}");
    }
    let mut plain = Store::open(&temp_dir("move-plain")).unwrap();
    let before = plain.settings()["salt"].clone();
    plain.save_settings(&Value::Object(brought), From::Settings).unwrap();
    assert_eq!(
        plain.settings()["salt"],
        before,
        "the main window can't change the salt"
    );
    let _ = fs::remove_dir_all(dir);
    let _ = fs::remove_dir_all(temp_dir("move-plain"));
}

/// The move file's own success message lists what changed, in counts and names, never values -- so this
/// only surfaces a field when the store's settings actually differ before and after, never the salt or guided
/// (neither means anything to the person), and says nothing changed when nothing did.
#[test]
fn brought_summary_lists_only_what_actually_changed() {
    let before = json!({
        "responses": { "email": "warn" },
        "vault": [{ "kind": "value", "type": "phone_number", "value": "1" }],
        "largeText": false,
        "keepDays": 365,
        "salt": "aaaa",
        "guided": { "email": 1 },
    });
    let after = json!({
        "responses": { "email": "warn", "phone_number": "block" },
        "vault": [{ "kind": "value", "type": "phone_number", "value": "1" },
                  { "kind": "value", "type": "email", "value": "2" }],
        "largeText": true,
        "keepDays": 365,
        "salt": "bbbb",
        "guided": { "email": 5 },
    });
    let brought = brought_summary(&before, &after);
    assert_eq!(brought["changed"], json!(true));
    assert_eq!(brought["parts"]["responses"], json!(2), "a count of kinds, never which ones");
    assert_eq!(brought["parts"]["vault"], json!(2));
    assert_eq!(brought["parts"]["largeText"], json!(true));
    assert!(brought["parts"].get("keepDays").is_none(), "unchanged, so left out");
    assert!(brought["parts"].get("salt").is_none(), "never surfaced");
    assert!(brought["parts"].get("guided").is_none(), "never surfaced");
}

#[test]
fn brought_summary_says_nothing_changed_when_everything_already_matched() {
    let same = json!({ "responses": { "email": "warn" }, "vault": [], "largeText": false, "keepDays": 90 });
    let brought = brought_summary(&same, &same);
    assert_eq!(brought["changed"], json!(false));
    assert_eq!(brought["parts"], json!({}));
}

// ---------- The Full scan record ----------

#[test]
fn a_full_scan_record_entry_is_only_a_key_a_stamp_and_the_look_bit_never_a_value_kind_or_fingerprint() {
    // Read against the real source, the way PRIVACY.md's promises are checked (desktop-privacy.test.js): if
    // `Baseline`'s entry type ever grows a field, this fails loudly rather than silently widening what the
    // bit is allowed to carry.
    let source = include_str!("stored_value_checks.rs");
    assert!(
        source.contains("entries: Vec<(u64, u64, bool)>"),
        "a Full scan record entry must stay exactly a key, a stamp and the look bit, nothing else"
    );
    // And the bytes on disk match that shape exactly: no slack room for a kind byte or a fingerprint's worth
    // of extra bytes (a fingerprint alone, as used elsewhere for history, is 32 bytes on its own).
    let entries: Vec<(u64, u64, bool)> = (0..50).map(|i| (i, i * 2, i % 3 == 0)).collect();
    let raw = Baseline::new(1, entries.clone()).encode();
    assert_eq!(raw.len(), 24 + entries.len() * 17);
    let back = Baseline::decode(&raw).unwrap();
    for (key, stamp, flag) in &entries {
        assert_eq!(back.flagged(*key), *flag);
        assert!(back.unchanged(*key, *stamp));
    }
}

#[test]
fn the_full_scan_record_round_trips_and_holds_keys_stamps_and_the_look_bit_only() {
    let dir = temp_dir("baseline");
    let store = Store::open(&dir).unwrap();
    assert!(store.baseline().is_none() && store.baseline_summary().is_none(), "no Full scan yet");
    let salt = store.scan_salt();
    let path = Path::new(r"C:\Users\test\Downloads\tax-notes.txt");
    let key = baseline_key(&salt, path);
    let stamp = baseline_stamp(51, 133_000_000_000_000_000);
    let entries = vec![(key, stamp, true), (7, 9, false), (key, stamp, true)];
    store.save_baseline(&Baseline::new(1_760_000_000_000, entries)).unwrap();
    let back = store.baseline().unwrap();
    assert_eq!(back.at, 1_760_000_000_000);
    assert_eq!(back.len(), 2, "one entry a file");
    assert!(back.unchanged(key, stamp));
    assert!(back.flagged(key), "it had something worth a look");
    assert!(!back.flagged(7), "this one didn't");
    assert!(!back.flagged(9), "a key never recorded");
    assert!(!back.unchanged(key, baseline_stamp(52, 133_000_000_000_000_000)), "a new size is a change");
    assert!(!back.unchanged(key, baseline_stamp(51, 133_000_000_000_000_001)), "a new time is a change");
    assert!(!back.unchanged(8, 9), "a file the Full scan never saw");
    assert_eq!(store.baseline_summary(), Some((1_760_000_000_000, 2)));
    // On disk: 24 bytes of header and 17 a file (one more than v1's 16, for the bit), and nothing of the path.
    let raw = fs::read(dir.join("scan-baseline.bin")).unwrap();
    assert_eq!(raw.len(), 24 + 2 * 17);
    assert_eq!(&raw[..8], b"CLOTRBL3");
    assert!(!String::from_utf8_lossy(&raw).to_lowercase().contains("tax-notes"));
    let _ = fs::remove_dir_all(dir);
}

/// A record written by hand: the magic, when, how many, then each file's bytes as given.
fn record_by_hand(magic: &[u8; 8], at: u64, count: u64, files: &[&[u8]]) -> Vec<u8> {
    let mut raw = Vec::new();
    raw.extend_from_slice(magic);
    raw.extend_from_slice(&at.to_le_bytes());
    raw.extend_from_slice(&count.to_le_bytes());
    for file in files {
        raw.extend_from_slice(file);
    }
    raw
}

/// One file's 17 bytes in a v2 or v3 record: key, stamp, look bit.
fn file_bytes(key: u64, stamp: u64, flag: bool) -> Vec<u8> {
    let mut out = key.to_le_bytes().to_vec();
    out.extend_from_slice(&stamp.to_le_bytes());
    out.push(u8::from(flag));
    out
}

#[test]
fn a_v1_record_on_disk_is_no_record_but_its_header_still_says_when_and_that_its_old() {
    let dir = temp_dir("baseline-v1");
    let store = Store::open(&dir).unwrap();
    // A v1 record, the shape the app wrote before the look bit existed: 16 bytes a file (no bit).
    let files: Vec<Vec<u8>> = [(3u64, 30u64), (9u64, 90u64)]
        .iter()
        .map(|(key, stamp)| [key.to_le_bytes(), stamp.to_le_bytes()].concat())
        .collect();
    let raw = record_by_hand(b"CLOTRBL1", 7, 2, &files.iter().map(Vec::as_slice).collect::<Vec<_>>());
    fs::write(dir.join("scan-baseline.bin"), &raw).unwrap();
    assert!(store.baseline().is_none(), "a scan reads everything in its reach, as before any Full scan");
    assert_eq!(store.baseline_summary(), Some((7, 2)), "Settings still says what Clotr keeps");
    assert!(store.baseline_is_old(), "and the Scan screen can say why this scan reads everything");
    assert_eq!(fs::read(dir.join("scan-baseline.bin")).unwrap(), raw, "reading it changes nothing on disk");
    // The next Full scan that finishes writes over it in the current form.
    store.save_baseline(&Baseline::new(8, vec![(3, 31, false)])).unwrap();
    assert_eq!(&fs::read(dir.join("scan-baseline.bin")).unwrap()[..8], b"CLOTRBL3");
    assert!(!store.baseline_is_old());
    assert!(store.baseline().is_some_and(|b| b.unchanged(3, 31)));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_v2_record_on_disk_is_no_record_but_its_header_still_says_when_and_that_its_old() {
    let dir = temp_dir("baseline-v2");
    let store = Store::open(&dir).unwrap();
    // A whole, well-formed v2 record, the shape 1.6.1 wrote: the same layout as today's, an older magic.
    let files = [file_bytes(3, 30, true), file_bytes(9, 90, false)];
    let raw = record_by_hand(b"CLOTRBL2", 1_760_000_000_000, 2, &[&files[0][..], &files[1][..]]);
    fs::write(dir.join("scan-baseline.bin"), &raw).unwrap();
    assert!(store.baseline().is_none(), "a scan reads everything in its reach, as before any Full scan");
    assert_eq!(store.baseline_summary(), Some((1_760_000_000_000, 2)), "Settings still says what Clotr keeps");
    assert!(store.baseline_is_old(), "and the Scan screen can say why this scan reads everything");
    assert_eq!(fs::read(dir.join("scan-baseline.bin")).unwrap(), raw, "reading it changes nothing on disk");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_saved_record_starts_with_clotrbl3_and_reads_back_entry_for_entry() {
    let dir = temp_dir("baseline-v3");
    let store = Store::open(&dir).unwrap();
    assert!(!store.baseline_is_old(), "no record is not an old one");
    let entries: Vec<(u64, u64, bool)> = (1..=40).map(|i| (i * 7, i * 1_000 + 3, i % 4 == 0)).collect();
    store.save_baseline(&Baseline::new(1_770_000_000_000, entries.clone())).unwrap();
    let raw = fs::read(dir.join("scan-baseline.bin")).unwrap();
    assert_eq!(&raw[..8], b"CLOTRBL3");
    assert_eq!(raw.len(), 24 + entries.len() * 17);
    let back = store.baseline().unwrap();
    assert_eq!(back.at, 1_770_000_000_000);
    assert_eq!(back.len(), entries.len());
    for (key, stamp, flag) in &entries {
        assert!(back.unchanged(*key, *stamp), "{key} unchanged");
        assert!(!back.unchanged(*key, stamp + 1), "{key} with a new stamp is a change");
        assert_eq!(back.flagged(*key), *flag, "{key}'s look bit");
    }
    assert_eq!(store.baseline_summary(), Some((1_770_000_000_000, 40)));
    assert!(!store.baseline_is_old());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_v3_record_reads_only_when_its_length_matches_its_count() {
    let dir = temp_dir("baseline-v3-length");
    let store = Store::open(&dir).unwrap();
    let file = dir.join("scan-baseline.bin");
    let (a, b) = (file_bytes(3, 30, true), file_bytes(9, 90, false));
    fs::write(&file, record_by_hand(b"CLOTRBL3", 5, 2, &[&a[..], &b[..]])).unwrap();
    let back = store.baseline().expect("a whole v3 record written by hand reads");
    assert!(back.unchanged(3, 30) && back.unchanged(9, 90) && back.flagged(3) && !back.flagged(9));
    for (what, raw) in [
        ("one byte too many", record_by_hand(b"CLOTRBL3", 5, 2, &[&a[..], &b[..], &[0u8][..]])),
        ("one byte short", record_by_hand(b"CLOTRBL3", 5, 2, &[&a[..], &b[..16]])),
        ("a count too high", record_by_hand(b"CLOTRBL3", 5, 3, &[&a[..], &b[..]])),
        ("a count too low", record_by_hand(b"CLOTRBL3", 5, 1, &[&a[..], &b[..]])),
        ("a header and nothing else", record_by_hand(b"CLOTRBL3", 5, 2, &[])),
        ("half a header", record_by_hand(b"CLOTRBL3", 5, 2, &[])[..12].to_vec()),
    ] {
        fs::write(&file, &raw).unwrap();
        assert!(store.baseline().is_none(), "{what}");
        assert!(!store.baseline_is_old(), "{what} is damaged, not old");
    }
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_damaged_record_is_no_record() {
    let dir = temp_dir("baseline-damaged");
    let store = Store::open(&dir).unwrap();
    store.save_baseline(&Baseline::new(1, vec![(1, 1, false), (2, 2, false)])).unwrap();
    let file = dir.join("scan-baseline.bin");
    let mut raw = fs::read(&file).unwrap();
    raw.pop();
    fs::write(&file, &raw).unwrap();
    assert!(store.baseline().is_none(), "cut short");
    let mut raw = Baseline::new(1, vec![(1, 1, false), (2, 2, false)]).encode();
    raw[24..32].copy_from_slice(&5u64.to_le_bytes());
    fs::write(&file, &raw).unwrap();
    assert!(store.baseline().is_none(), "keys out of order");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn clearing_history_or_showing_ignored_files_again_also_forgets_the_full_scan_record() {
    let dir = temp_dir("baseline-clear");
    let mut store = Store::open(&dir).unwrap();
    store.save_baseline(&Baseline::new(1, vec![(1, 1, false)])).unwrap();
    store.clear_history().unwrap();
    assert!(store.baseline().is_none() && store.baseline_summary().is_none());
    store.save_baseline(&Baseline::new(1, vec![(1, 1, false)])).unwrap();
    store.clear_scan_ignored().unwrap();
    assert!(store.baseline().is_none());
    store.clear_history().unwrap(); // nothing left to remove is still fine
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_files_record_key_is_salted_and_ignores_case() {
    let path = Path::new(r"C:\Users\test\Downloads\Notes.txt");
    assert_eq!(baseline_key("s1", path), baseline_key("s1", Path::new(r"c:\users\test\downloads\notes.txt")));
    assert_ne!(baseline_key("s1", path), baseline_key("s2", path));
    assert_ne!(baseline_key("s1", path), baseline_key("s1", Path::new(r"C:\Users\test\Downloads\Other.txt")));
}

// ---------- Leave out of scans ----------

#[test]
fn leave_out_keeps_the_chosen_path_and_never_hands_it_to_a_page() {
    let dir = temp_dir("exclude");
    let mut store = Store::open(&dir).unwrap();
    let folder = r"C:\Users\test\Desktop\Clotr\.claude\worktrees";
    let id = store.add_exclusion("folder", folder).unwrap().expect("an absolute path fits");
    assert_eq!(store.add_exclusion("folder", folder).unwrap(), Some(id.clone()), "the same one twice is one");
    store.add_exclusion("type", "LOG").unwrap().expect("a type, with or without its dot");
    store.add_exclusion("file", r"C:\Users\test\Documents\corpus.jsonl").unwrap();
    assert_eq!(store.add_exclusion("folder", r"relative\path").unwrap(), None, "only an absolute path");
    assert_eq!(store.add_exclusion("type", ".no way").unwrap(), None, "a type is letters and digits");
    assert_eq!(store.add_exclusion("drive", r"C:\").unwrap(), None, "only the three kinds");

    let settings = serde_json::to_string(&store.settings()).unwrap();
    assert!(!settings.contains("worktrees") && !settings.contains("scanExcluded"), "never in a page's settings");
    let view = store.exclusions_view();
    assert_eq!(view.as_array().unwrap().len(), 3);
    assert_eq!(view[0]["name"], json!("worktrees"));
    assert_eq!(view[0]["parent"], json!(".claude"));
    assert_eq!(view[1]["name"], json!(".log"));
    assert!(!view.to_string().contains(r"C:\\Users"), "names and parents only");

    let exclusions = store.exclusions();
    assert!(exclusions.folder(Path::new(r"c:\users\TEST\desktop\clotr\.claude\worktrees")));
    let inside = Path::new(r"C:\Users\test\Desktop\Clotr\.claude\worktrees\ap-1\src");
    assert!(exclusions.folder(inside), "and inside it");
    let lookalike = Path::new(r"C:\Users\test\Desktop\Clotr\.claude\worktrees-old");
    assert!(!exclusions.folder(lookalike), "a name that only starts the same");
    assert!(exclusions.file(Path::new(r"C:\x\app.log"), "log"));
    assert!(exclusions.file(Path::new(r"C:\Users\test\Documents\CORPUS.jsonl"), "jsonl"));
    assert!(!exclusions.file(Path::new(r"C:\Users\test\Documents\notes.jsonl"), "jsonl"));

    // Kept across a restart, and through Clear history and Show them again: the person chose these.
    store.clear_history().unwrap();
    store.clear_scan_ignored().unwrap();
    let mut reopened = Store::open(&dir).unwrap();
    assert_eq!(reopened.exclusions_view().as_array().unwrap().len(), 3);
    // A page saving settings can't add one either.
    reopened
        .save_settings(&json!({ "scanExcluded": [{ "kind": "folder", "value": r"C:\Windows" }] }), From::Settings)
        .unwrap();
    assert_eq!(reopened.exclusions_view().as_array().unwrap().len(), 3);

    assert!(reopened.remove_exclusion(&id).unwrap());
    assert!(!reopened.remove_exclusion(&id).unwrap(), "already gone");
    assert!(!reopened.exclusions().folder(Path::new(folder)));
    let _ = fs::remove_dir_all(dir);
}

// ---------- Was this right? ----------

#[test]
fn was_this_right_answers_round_trip_as_counts_a_kind_and_tier_pair_only() {
    let dir = temp_dir("accuracy");
    let mut store = Store::open(&dir).unwrap();
    assert_eq!(store.accuracy_answers(), json!([]));
    assert!(store.record_accuracy_answer("password", "yours", true).unwrap());
    assert!(store.record_accuracy_answer("password", "yours", true).unwrap());
    assert!(store.record_accuracy_answer("password", "yours", false).unwrap());
    assert!(store.record_accuracy_answer("card", "secret", true).unwrap());
    // An unknown kind or tier is refused, never stored loosely.
    assert!(!store.record_accuracy_answer("made-up", "yours", true).unwrap());
    assert!(!store.record_accuracy_answer("password", "made-up", true).unwrap());

    let view = store.accuracy_answers();
    let rows = view.as_array().unwrap();
    assert_eq!(rows.len(), 2, "one row a kind-tier pair, not one an answer");
    let password = rows.iter().find(|row| row["kind"] == json!("password")).unwrap();
    assert_eq!(password["tier"], json!("yours"));
    assert_eq!(password["yes"], json!(2));
    assert_eq!(password["no"], json!(1));
    let card = rows.iter().find(|row| row["kind"] == json!("card")).unwrap();
    assert_eq!(card["tier"], json!("secret"));
    assert_eq!(card["yes"], json!(1));
    assert_eq!(card["no"], json!(0));
    assert!(!store.settings().to_string().contains("accuracy"), "its own call carries it, not settings");

    // Survives a restart.
    let reopened = Store::open(&dir).unwrap();
    assert_eq!(reopened.accuracy_answers().as_array().unwrap().len(), 2);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn clear_accuracy_answers_empties_them_without_touching_history() {
    let dir = temp_dir("accuracy-clear");
    let mut store = Store::open(&dir).unwrap();
    store.record_accuracy_answer("key", "project", true).unwrap();
    store.record_scan(&scan_row("quick")).unwrap();
    store.clear_accuracy_answers().unwrap();
    assert_eq!(store.accuracy_answers(), json!([]));
    assert_eq!(store.scans().as_array().unwrap().len(), 1, "Clear history and this stay apart");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn an_accuracy_answer_never_carries_a_file_a_name_a_place_or_a_value() {
    let dir = temp_dir("accuracy-export");
    let mut store = Store::open(&dir).unwrap();
    store.record_accuracy_answer("email", "project", true).unwrap();
    store.record_accuracy_answer("id", "secret", false).unwrap();
    let raw = store.accuracy_answers().to_string();
    for field in ["path", "name", "file", "place", "value", "folder", "fp", "t"] {
        assert!(!raw.contains(&format!("\"{field}\"")), "{field} has no business in an accuracy row");
    }
    let _ = fs::remove_dir_all(dir);
}
