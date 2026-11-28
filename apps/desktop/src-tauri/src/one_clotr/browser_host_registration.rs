use serde_json::json;
use std::io;
use std::path::{Path, PathBuf};

const HOST: &str = "app.clotr.bridge";
const CHROMIUM_IDS: [&str; 2] = ["gkgpgejhhmmhklaghdnbjbalkmpjnmab", "hbangnmofjeaieaeamlncpcfmhbclbkj"];
const FIREFOX_ID: &str = "clotr@billiambash";

#[derive(Clone, Copy)]
struct Browser {
    key: &'static str,
    file: &'static str,
    firefox: bool,
}

const BROWSERS: [Browser; 5] = [
    Browser {
        key: r"Software\Google\Chrome\NativeMessagingHosts\app.clotr.bridge",
        file: "chrome.json",
        firefox: false,
    },
    Browser {
        key: r"Software\BraveSoftware\Brave\NativeMessagingHosts\app.clotr.bridge",
        file: "brave.json",
        firefox: false,
    },
    Browser {
        key: r"Software\Microsoft\Edge\NativeMessagingHosts\app.clotr.bridge",
        file: "edge.json",
        firefox: false,
    },
    Browser {
        key: r"Software\Vivaldi\NativeMessagingHosts\app.clotr.bridge",
        file: "vivaldi.json",
        firefox: false,
    },
    Browser {
        key: r"Software\Mozilla\NativeMessagingHosts\app.clotr.bridge",
        file: "firefox.json",
        firefox: true,
    },
];

fn manifest(exe: &Path, firefox: bool) -> serde_json::Value {
    let mut value = json!({
        "name": HOST,
        "description": "Clotr for Windows settings bridge",
        "path": exe,
        "type": "stdio"
    });
    if firefox {
        value["allowed_extensions"] = json!([FIREFOX_ID]);
    } else {
        value["allowed_origins"] = json!(CHROMIUM_IDS
            .iter()
            .map(|id| format!("chrome-extension://{id}/"))
            .collect::<Vec<_>>());
    }
    value
}

trait RegistryWriter {
    fn set_default(&mut self, key: &str, value: &str) -> io::Result<()>;
    fn remove_default(&mut self, key: &str) -> io::Result<()>;
}

fn register(root: &Path, exe: &Path, registry: &mut impl RegistryWriter) -> io::Result<()> {
    let manifests = root.join("NativeMessaging");
    std::fs::create_dir_all(&manifests)?;
    for browser in BROWSERS {
        let path = manifests.join(browser.file);
        let text = serde_json::to_vec_pretty(&manifest(exe, browser.firefox))?;
        crate::one_clotr_protocol::write_local_file(root, &path, &text)?;
        registry.set_default(browser.key, &path.to_string_lossy())?;
    }
    Ok(())
}

fn register_if_consented(
    accepted: bool,
    root: &Path,
    exe: &Path,
    registry: &mut impl RegistryWriter,
) -> io::Result<()> {
    if accepted {
        register(root, exe, registry)
    } else {
        Ok(())
    }
}

fn unregister(root: &Path, registry: &mut impl RegistryWriter) -> io::Result<()> {
    let manifests = root.join("NativeMessaging");
    let mut failure = None;
    for browser in BROWSERS {
        if let Err(error) = registry.remove_default(browser.key) {
            failure.get_or_insert(error);
        }
        if let Err(error) = std::fs::remove_file(manifests.join(browser.file)) {
            if error.kind() != io::ErrorKind::NotFound {
                failure.get_or_insert(error);
            }
        }
    }
    if let Err(error) = std::fs::remove_dir(&manifests) {
        if !matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::DirectoryNotEmpty) {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

#[cfg(windows)]
pub fn register_for_current_user() {
    let Ok(exe) = std::env::current_exe() else { return };
    let bridge = exe.with_file_name("clotr-bridge.exe");
    if !bridge.exists() {
        return;
    }
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Clotr")
        .join("Desktop");
    let _ = register_if_consented(true, &root, &bridge, &mut CurrentUserRegistry);
}

#[cfg(windows)]
pub fn unregister_for_current_user() {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Clotr")
        .join("Desktop");
    let _ = unregister(&root, &mut CurrentUserRegistry);
}

#[cfg(windows)]
struct CurrentUserRegistry;

#[cfg(windows)]
impl RegistryWriter for CurrentUserRegistry {
    fn set_default(&mut self, key: &str, value: &str) -> io::Result<()> {
        use windows::core::PCWSTR;
        use windows::Win32::System::Registry::{
            RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
            REG_OPTION_NON_VOLATILE, REG_SZ,
        };
        let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let key = wide(key);
        let value = wide(value);
        let mut handle = HKEY::default();
        unsafe {
            let created = RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                Some(0),
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                None,
                &mut handle,
                None,
            );
            if created.0 != 0 {
                return Err(io::Error::from_raw_os_error(created.0 as i32));
            }
            let bytes = std::slice::from_raw_parts(value.as_ptr().cast::<u8>(), value.len() * 2);
            let written = RegSetValueExW(handle, PCWSTR::null(), Some(0), REG_SZ, Some(bytes));
            let _ = RegCloseKey(handle);
            if written.0 != 0 {
                Err(io::Error::from_raw_os_error(written.0 as i32))
            } else {
                Ok(())
            }
        }
    }

    fn remove_default(&mut self, key: &str) -> io::Result<()> {
        use windows::core::PCWSTR;
        use windows::Win32::System::Registry::{
            RegCloseKey, RegDeleteValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        };
        let key: Vec<u16> = key.encode_utf16().chain(Some(0)).collect();
        let mut handle = HKEY::default();
        let opened = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                Some(0),
                KEY_SET_VALUE,
                &mut handle,
            )
        };
        if opened.0 == 2 {
            return Ok(());
        }
        if opened.0 != 0 {
            return Err(io::Error::from_raw_os_error(opened.0 as i32));
        }
        let deleted = unsafe { RegDeleteValueW(handle, PCWSTR::null()) };
        let _ = unsafe { RegCloseKey(handle) };
        if deleted.0 == 0 || deleted.0 == 2 {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(deleted.0 as i32))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FixtureRegistry(HashMap<String, String>);
    impl RegistryWriter for FixtureRegistry {
        fn set_default(&mut self, key: &str, value: &str) -> io::Result<()> {
            self.0.insert(key.to_string(), value.to_string());
            Ok(())
        }

        fn remove_default(&mut self, key: &str) -> io::Result<()> {
            self.0.remove(key);
            Ok(())
        }
    }

    #[test]
    fn browser_manifests_allow_only_clotrs_fixed_ids_and_register_per_user_paths() {
        let root = std::env::temp_dir().join(format!("clotr-native-host-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let exe = root.join("clotr-bridge.exe");
        let mut registry = FixtureRegistry::default();
        register(&root, &exe, &mut registry).unwrap();
        assert_eq!(registry.0.len(), BROWSERS.len());
        for browser in BROWSERS {
            let path = PathBuf::from(&registry.0[browser.key]);
            let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert_eq!(value["name"], HOST);
            assert_eq!(value["path"], exe.to_string_lossy().as_ref());
            if browser.firefox {
                assert_eq!(value["allowed_extensions"], json!([FIREFOX_ID]));
                assert!(value.get("allowed_origins").is_none());
            } else {
                let ids = value["allowed_origins"].as_array().unwrap();
                assert_eq!(ids.len(), CHROMIUM_IDS.len());
                assert!(ids
                    .iter()
                    .all(|id| id.as_str().unwrap().starts_with("chrome-extension://")));
                assert!(!ids.iter().any(|id| id.as_str().unwrap().contains('*')));
                assert!(value.get("allowed_extensions").is_none());
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_waits_for_consent_and_disconnect_removes_all_five_hosts() {
        let root = std::env::temp_dir().join(format!("clotr-consent-hosts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let exe = root.join("clotr-bridge.exe");
        let mut registry = FixtureRegistry::default();

        assert!(registry.0.is_empty(), "startup has not written a browser host");
        register_if_consented(false, &root, &exe, &mut registry).unwrap();
        assert!(registry.0.is_empty(), "declining consent writes no browser host");

        register_if_consented(true, &root, &exe, &mut registry).unwrap();
        assert_eq!(registry.0.len(), BROWSERS.len());
        assert!(BROWSERS.iter().all(|browser| registry.0.contains_key(browser.key)));

        unregister(&root, &mut registry).unwrap();
        assert!(registry.0.is_empty());
        assert!(!root.join("NativeMessaging").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
