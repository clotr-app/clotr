use serde_json::{json, Value};
use std::io::{self, Read, Write};
#[cfg(all(windows, not(test)))]
use std::path::PathBuf;

#[cfg(all(windows, not(test)))]
#[path = "../program.rs"]
#[allow(dead_code)]
mod program;

#[path = "../one_clotr_pipe.rs"]
#[allow(dead_code)]
mod one_clotr_pipe;
#[path = "../one_clotr_protocol.rs"]
#[allow(dead_code)]
mod one_clotr_protocol;
#[path = "../store.rs"]
#[allow(dead_code)]
mod store;

const MAX_MESSAGE: usize = 1024 * 1024;

#[cfg(all(windows, not(test)))]
fn process_parent(pid: u32) -> io::Result<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.map_err(io::Error::other)?;
    let result = (|| {
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        unsafe { Process32FirstW(snapshot, &mut entry) }.map_err(io::Error::other)?;
        loop {
            if entry.th32ProcessID == pid {
                return Ok(entry.th32ParentProcessID);
            }
            if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                return Err(io::Error::new(io::ErrorKind::NotFound, "parent process unavailable"));
            }
        }
    })();
    let _ = unsafe { CloseHandle(snapshot) };
    result
}

#[cfg(all(windows, not(test)))]
fn process_image_path(pid: u32) -> io::Result<PathBuf> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.map_err(io::Error::other)?;
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    let result =
        unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut length) }
            .map_err(io::Error::other)
            .map(|()| PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize])));
    let _ = unsafe { CloseHandle(process) };
    result
}

#[cfg(all(windows, not(test)))]
fn check_parent_browser() -> Result<(), &'static str> {
    let parent = process_parent(std::process::id()).map_err(|_| "the parent process could not be identified")?;
    let image = process_image_path(parent).map_err(|_| "the parent process could not be identified")?;
    let path = image.to_string_lossy();
    let signer = program::signer(&path);
    one_clotr_pipe::browser_parent_rejection(&path, signer.as_deref()).map_or(Ok(()), Err)
}

#[cfg(any(not(windows), test))]
fn check_parent_browser() -> Result<(), &'static str> {
    Err("browser caller verification is unavailable")
}

fn main() -> io::Result<()> {
    if let Err(reason) = check_parent_browser() {
        eprintln!("[Clotr] Browser connection refused: {reason}.");
        return Ok(());
    }
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let mut header = [0u8; 4];
        match input.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error),
        }
        let size = u32::from_le_bytes(header) as usize;
        if size == 0 || size > MAX_MESSAGE {
            return Ok(());
        }
        let mut bytes = vec![0; size];
        input.read_exact(&mut bytes)?;
        let request = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let answer = one_clotr_protocol::forwardable(&request)
            .map(|clean| one_clotr_pipe::request(&clean).unwrap_or_else(|_| one_clotr_pipe::not_running()))
            .unwrap_or_else(|| json!({"type":"unknown"}));
        let bytes = serde_json::to_vec(&answer).unwrap_or_else(|_| b"{\"type\":\"unknown\"}".to_vec());
        output.write_all(&(bytes.len() as u32).to_le_bytes())?;
        output.write_all(&bytes)?;
        output.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_checks_direction_version_and_message_fields() {
        assert!(one_clotr_protocol::valid(
            &json!({"v":1,"type":"hello","role":"extension","browser":"Firefox"}),
            "extension"
        ));
        assert!(!one_clotr_protocol::valid(
            &json!({"v":2,"type":"hello","role":"extension","browser":"Firefox"}),
            "extension"
        ));
        assert!(!one_clotr_protocol::valid(
            &json!({"v":1,"type":"hello","role":"extension","browser":"Firefox","value":"fixture"}),
            "extension"
        ));
        assert!(!one_clotr_protocol::valid(&json!({"v":1,"type":"forget"}), "host"));
    }

    #[test]
    fn settings_cleaner_drops_a_planted_raw_value_and_unlisted_fields() {
        let clean = one_clotr_protocol::clean_wrappers(&json!({
            "responses":{"value":"planted raw fixture","updatedAt":50},
            "paused":{"value":true,"updatedAt":99},
            "largeText":{"value":true,"updatedAt":20,"linked":true}
        }));
        assert_eq!(clean.len(), 1);
        assert_eq!(clean["largeText"]["value"], true);
        assert_eq!(
            one_clotr_protocol::clean_wrappers(&json!({"tourniquet":{"value":null,"updatedAt":21}}))["tourniquet"]
                ["value"],
            Value::Null
        );
    }

    #[test]
    fn bridge_fails_soft_when_the_app_pipe_is_missing() {
        assert_eq!(one_clotr_pipe::not_running(), json!({"type":"not_running"}));
    }

    #[test]
    fn relay_cleans_write_fields_before_they_enter_the_pipe() {
        let sent = one_clotr_protocol::forwardable(&json!({
            "v":1,"type":"write_settings","settings":{
                "responses":{"value":"planted raw fixture","updatedAt":9},
                "largeText":{"value":true,"updatedAt":10}
            }
        }))
        .unwrap();
        assert_eq!(
            sent["settings"],
            json!({
                "largeText":{"value":true,"updatedAt":10.0,"linked":true}
            })
        );
        assert!(!serde_json::to_string(&sent).unwrap().contains("planted raw fixture"));
        assert!(one_clotr_protocol::forwardable(&json!({
            "v":1,"type":"write_settings","settings":{},"detected":"planted raw fixture"
        }))
        .is_none());
    }
}
