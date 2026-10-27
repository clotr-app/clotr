use crate::store;
use serde_json::{json, Value};
use std::io::{self, Write};
use std::path::PathBuf;

const SCHEMA: &str = include_str!("../../../../extension/one-clotr-protocol.json");
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

fn data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Clotr")
        .join("Desktop")
}

pub(crate) fn write_local_file(root: &std::path::Path, path: &std::path::Path, bytes: &[u8]) -> io::Result<()> {
    fn check_path(root: &std::path::Path, path: &std::path::Path) -> io::Result<()> {
        let relative = path
            .strip_prefix(root)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file is outside the local folder"))?;
        let mut current = root.to_path_buf();
        for component in std::iter::once(std::path::Component::CurDir).chain(relative.components()) {
            if component != std::path::Component::CurDir {
                current.push(component);
            }
            match std::fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "refusing a linked local path",
                    ));
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
    check_path(root, path)?;
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "file has no parent"))?;
    std::fs::create_dir_all(parent)?;
    check_path(root, path)?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "file has no name"))?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    let temporary = parent.join(format!(
        "{}.{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        nonce
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

pub(crate) fn valid(message: &Value, direction: &str) -> bool {
    let Ok(schema) = serde_json::from_str::<Value>(SCHEMA) else {
        return false;
    };
    let Some(shape) = message
        .get("type")
        .and_then(Value::as_str)
        .and_then(|kind| schema["messages"].get(kind))
    else {
        return false;
    };
    shape["from"] == direction
        && message.get("v").and_then(Value::as_u64) == schema["v"].as_u64()
        && message.as_object().is_some_and(|object| {
            let fields = shape["fields"].as_array().unwrap();
            object
                .keys()
                .all(|key| fields.iter().any(|field| field.as_str() == Some(key)))
                && fields.iter().all(|field| {
                    field
                        .as_str()
                        .is_some_and(|key| key == "type" || object.contains_key(key))
                })
        })
}

fn paired_file() -> PathBuf {
    data_dir().join("one-clotr-paired")
}
fn pending_file() -> PathBuf {
    data_dir().join("one-clotr-pair-pending")
}
fn declined_file() -> PathBuf {
    data_dir().join("one-clotr-pair-declined")
}
fn browsers_file() -> PathBuf {
    data_dir().join("one-clotr-browsers.json")
}
fn is_paired() -> bool {
    paired_file().exists()
}

fn browser_names() -> Vec<String> {
    std::fs::read(browsers_file())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        .unwrap_or_default()
}

fn remember_browser(value: &Value) {
    let Some(browser) = value.get("browser").and_then(Value::as_str) else {
        return;
    };
    let Some(name) = ["Chrome", "Edge", "Brave", "Firefox", "Vivaldi", "Opera"]
        .into_iter()
        .find(|known| browser == *known)
    else {
        return;
    };
    let mut browsers = browser_names();
    if !browsers.iter().any(|known| known == name) {
        browsers.push(name.to_string());
        let root = data_dir();
        let _ = write_local_file(
            &root,
            &browsers_file(),
            &serde_json::to_vec(&browsers).unwrap_or_default(),
        );
    }
}

pub(crate) fn connection_status() -> Value {
    let pending = pending_file().exists();
    json!({
        "available":crate::one_clotr_pipe::is_available(),
        "paired":is_paired(),
        "pending":pending,
        "browsers":if is_paired() || pending { browser_names() } else { Vec::<String>::new() }
    })
}

pub(crate) fn set_consent(accepted: bool) {
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::remove_file(pending_file());
    let _ = std::fs::remove_file(declined_file());
    if accepted {
        let root = data_dir();
        let _ = write_local_file(&root, &paired_file(), b"1");
    } else {
        let root = data_dir();
        let _ = write_local_file(&root, &declined_file(), b"1");
        let _ = std::fs::remove_file(browsers_file());
    }
}

pub(crate) fn disconnect() {
    let _ = std::fs::remove_file(paired_file());
    let _ = std::fs::remove_file(pending_file());
    let _ = std::fs::remove_file(declined_file());
    let _ = std::fs::remove_file(browsers_file());
}

pub(crate) fn clean_wrappers(value: &Value) -> serde_json::Map<String, Value> {
    let schema: Value = serde_json::from_str(SCHEMA).unwrap_or(Value::Null);
    let allowed = schema["settings"].as_array().cloned().unwrap_or_default();
    value.as_object().into_iter().flatten().filter_map(|(key, item)| {
        let known = allowed.iter().any(|name| name.as_str() == Some(key));
        let timestamp = item.get("updatedAt").and_then(Value::as_f64).filter(|time| time.is_finite());
        let setting_value = item.get("value");
        let value_ok = match (key.as_str(), setting_value) {
            ("responses", Some(values)) => values.as_object().is_some_and(|map| map.iter().all(|(kind, choice)| {
                (2..=40).contains(&kind.len()) && kind.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_')
                    && matches!(choice.as_str(), Some("block" | "warn" | "log"))
            })),
            ("largeText" | "replyCheck" | "commandCheck" | "advanced", Some(value)) => value.is_boolean(),
            ("keepDays", Some(value)) => matches!(value.as_u64(), Some(90 | 365 | 730)),
            ("tourniquet", Some(Value::Null)) => true,
            ("tourniquet", Some(value)) => store::clean_settings(&json!({"tourniquet":value}), false).contains_key("tourniquet"),
            _ => false,
        };
        if !known || !item.as_object().is_some_and(|map| map.keys().all(|part| ["value", "updatedAt", "linked"].contains(&part.as_str())))
            || !value_ok || timestamp.is_none()
            || item.get("linked").is_some_and(|linked| !linked.is_boolean()) { return None; }
        Some((key.clone(), json!({"value":item["value"],"updatedAt":timestamp.unwrap(),"linked":item.get("linked").unwrap_or(&Value::Bool(true))})))
    }).collect()
}

fn current_wrappers() -> serde_json::Map<String, Value> {
    let path = data_dir().join("one-clotr-settings.json");
    let stored: Value = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| json!({}));
    let mut out = clean_wrappers(&stored);
    if let Ok(store) = store::Store::open(&data_dir()) {
        let values = store.settings();
        for key in [
            "responses",
            "largeText",
            "keepDays",
            "tourniquet",
            "replyCheck",
            "commandCheck",
            "advanced",
        ] {
            if !out.contains_key(key) {
                if let Some(value) = values.get(key) {
                    out.insert(key.into(), json!({"value":value,"updatedAt":0,"linked":true}));
                }
            }
        }
    }
    out
}

pub(crate) fn reply(message: &Value) -> Value {
    if !valid(message, "extension") {
        return json!({"type":"unknown"});
    }
    match message["type"].as_str().unwrap_or("") {
        "hello" => {
            let _ = std::fs::remove_file(declined_file());
            remember_browser(message);
            json!({"v":1,"type":"hello_ack","appVersion":APP_VERSION,"paired":is_paired()})
        }
        "pair_request" => {
            if is_paired() {
                json!({"v":1,"type":"pair_done","paired":true})
            } else {
                let _ = std::fs::create_dir_all(data_dir());
                if !declined_file().exists() {
                    let _ = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(pending_file());
                }
                json!({"v":1,"type":"pair_pending","paired":false})
            }
        }
        "read_settings" | "write_settings" if !is_paired() => json!({"v":1,"type":"forgotten"}),
        "read_settings" if is_paired() => {
            let mut settings = current_wrappers();
            settings.retain(|_, item| item["linked"] != false);
            let settings = Value::Object(settings);
            json!({"v":1,"type":"settings","settings":settings})
        }
        "write_settings" if is_paired() => {
            let mut merged = current_wrappers();
            for (key, incoming) in clean_wrappers(&message["settings"]) {
                if incoming["linked"] == false {
                    continue;
                }
                let local = merged.get(&key);
                if local.is_some_and(|item| item["linked"] == false) {
                    continue;
                }
                if local.is_none_or(|item| {
                    incoming["updatedAt"].as_f64().unwrap_or(0.0) > item["updatedAt"].as_f64().unwrap_or(0.0)
                }) {
                    let mut incoming = incoming;
                    incoming["linked"] = local
                        .and_then(|item| item.get("linked"))
                        .cloned()
                        .unwrap_or(Value::Bool(true));
                    merged.insert(key, incoming);
                }
            }
            let mut values: serde_json::Map<String, Value> = merged
                .iter()
                .filter_map(|(key, item)| {
                    (key != "tourniquet")
                        .then(|| Some((key.clone(), item.get("value")?.clone())))
                        .flatten()
                })
                .collect();
            if let Ok(mut current) = store::Store::open(&data_dir()) {
                if let Some(tourniquet) = merged.get("tourniquet").and_then(|item| item.get("value")) {
                    let _ = current.set_tourniquet(tourniquet);
                }
                let _ = current.save_settings(&Value::Object(std::mem::take(&mut values)), store::From::Bridge);
            }
            let root = data_dir();
            let _ = write_local_file(
                &root,
                &root.join("one-clotr-settings.json"),
                &serde_json::to_vec(&Value::Object(merged)).unwrap_or_default(),
            );
            json!({"v":1,"type":"settings_ack"})
        }
        "forget" => {
            disconnect();
            json!({"v":1,"type":"forgotten"})
        }
        _ => json!({"type":"unknown"}),
    }
}

#[cfg(test)]
mod tests {
    use super::write_local_file;
    use std::path::PathBuf;

    #[cfg(unix)]
    #[test]
    fn settings_write_refuses_to_follow_a_symlink() {
        let root = std::env::temp_dir().join(format!("clotr-one-clotr-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("outside.json");
        let linked = root.join("one-clotr-settings.json");
        std::fs::write(&target, b"keep this fixture").unwrap();
        std::os::unix::fs::symlink(&target, &linked).unwrap();
        assert!(write_local_file(&root, &linked, b"replacement").is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"keep this fixture");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn settings_write_replaces_an_ordinary_file() {
        let root: PathBuf = std::env::temp_dir().join(format!("clotr-one-clotr-write-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("one-clotr-settings.json");
        std::fs::write(&file, b"old").unwrap();
        write_local_file(&root, &file, b"new").unwrap();
        assert_eq!(std::fs::read(file).unwrap(), b"new");
        std::fs::remove_dir_all(root).unwrap();
    }
}

pub(crate) fn forwardable(message: &Value) -> Option<Value> {
    if !valid(message, "extension") {
        return None;
    }
    let mut clean = message.clone();
    if clean["type"] == "write_settings" {
        clean["settings"] = Value::Object(clean_wrappers(&message["settings"]));
    }
    Some(clean)
}
