use serde_json::Value;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_MESSAGE: usize = 1024 * 1024;
static PIPE_AVAILABLE: AtomicBool = AtomicBool::new(true);

const BROWSER_SIGNERS: [(&str, &str); 5] = [
    ("chrome.exe", "Google LLC"),
    ("brave.exe", "Brave Software, Inc."),
    ("msedge.exe", "Microsoft Corporation"),
    ("vivaldi.exe", "Vivaldi Technologies AS"),
    ("firefox.exe", "Mozilla Corporation"),
];

pub fn browser_parent_is_trusted(image: &str, signer: Option<&str>) -> bool {
    browser_parent_rejection(image, signer).is_none()
}

pub fn browser_parent_rejection(image: &str, signer: Option<&str>) -> Option<&'static str> {
    let name = image.rsplit(|character| character == '\\' || character == '/').next()?;
    let Some((_, expected_signer)) = BROWSER_SIGNERS
        .iter()
        .find(|(expected_name, _)| name.eq_ignore_ascii_case(expected_name))
    else {
        return Some("the parent process is not a supported browser");
    };
    if signer.is_some_and(|actual| actual.eq_ignore_ascii_case(expected_signer)) {
        None
    } else {
        Some("the parent browser signature did not match its name")
    }
}

pub fn is_available() -> bool {
    PIPE_AVAILABLE.load(Ordering::Relaxed)
}

pub fn not_running() -> Value {
    serde_json::json!({"type":"not_running"})
}

fn read_frame(reader: &mut impl Read) -> io::Result<Value> {
    let mut header = [0; 4];
    reader.read_exact(&mut header)?;
    let size = u32::from_le_bytes(header) as usize;
    if size == 0 || size > MAX_MESSAGE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid pipe frame"));
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_frame(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    if bytes.is_empty() || bytes.len() > MAX_MESSAGE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid pipe frame"));
    }
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()
}

#[cfg(windows)]
const PIPE_NAME: &str = r"\\.\pipe\Clotr.OneClotr";

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn paths_match_case_insensitively(left: &std::path::Path, right: &std::path::Path) -> bool {
    left.to_string_lossy()
        .to_lowercase()
        .eq(&right.to_string_lossy().to_lowercase())
}

fn same_resolved_path(left: &std::path::Path, right: &std::path::Path) -> bool {
    let (Ok(left), Ok(right)) = (std::fs::canonicalize(left), std::fs::canonicalize(right)) else {
        return false;
    };
    paths_match_case_insensitively(&left, &right)
}

#[cfg(windows)]
fn process_image_path(pid: u32) -> io::Result<std::path::PathBuf> {
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
            .map_err(io::Error::other);
    let _ = unsafe { CloseHandle(process) };
    result?;
    Ok(std::path::PathBuf::from(String::from_utf16_lossy(
        &buffer[..length as usize],
    )))
}

#[cfg(windows)]
fn sibling_executable(name: &str) -> io::Result<std::path::PathBuf> {
    std::env::current_exe()?
        .parent()
        .map(|folder| folder.join(name))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "executable folder unavailable"))
}

#[cfg(windows)]
fn is_expected_process(pid: u32, executable: &str) -> bool {
    process_image_path(pid)
        .map(|image| sibling_executable(executable).is_ok_and(|expected| same_resolved_path(&image, &expected)))
        .unwrap_or(false)
}

#[cfg(windows)]
fn owner_only_attributes() -> io::Result<(
    windows::Win32::Security::SECURITY_ATTRIBUTES,
    windows::Win32::Foundation::HLOCAL,
)> {
    use windows::core::PCWSTR;
    use windows::Win32::Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES,
    };

    let sddl = wide("D:P(A;;GA;;;OW)");
    let mut descriptor = windows::Win32::Security::PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(sddl.as_ptr()), 1, &mut descriptor, None)
            .map_err(io::Error::other)?;
    }
    Ok((
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        },
        windows::Win32::Foundation::HLOCAL(descriptor.0),
    ))
}

#[cfg(windows)]
pub fn request(value: &Value) -> io::Result<Value> {
    use std::os::windows::io::FromRawHandle;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_NONE, OPEN_EXISTING,
    };
    use windows::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};

    let name = wide(PIPE_NAME);
    if !unsafe { WaitNamedPipeW(PCWSTR(name.as_ptr()), 750) }.as_bool() {
        return Err(io::Error::last_os_error());
    }
    let handle = unsafe {
        CreateFileW(
            PCWSTR(name.as_ptr()),
            (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
            FILE_SHARE_NONE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
        .map_err(io::Error::other)?
    };
    let file = unsafe { std::fs::File::from_raw_handle(handle.0 as *mut _) };
    let mut file = file;
    let mut server_pid = 0;
    if unsafe { GetNamedPipeServerProcessId(handle, &mut server_pid) }.is_err()
        || !is_expected_process(server_pid, "clotr.exe")
    {
        return Ok(not_running());
    }
    write_frame(&mut file, value)?;
    read_frame(&mut file)
}

#[cfg(windows)]
pub fn serve(mut handle: impl FnMut(Value) -> Value + Send + 'static) {
    use std::os::windows::io::FromRawHandle;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, LocalFree, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE};
    use windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, PIPE_READMODE_BYTE,
        PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    let name = wide(PIPE_NAME);
    loop {
        let Ok((attributes, descriptor)) = owner_only_attributes() else {
            return;
        };
        let pipe = unsafe {
            CreateNamedPipeW(
                PCWSTR(name.as_ptr()),
                PIPE_ACCESS_DUPLEX | windows::Win32::Storage::FileSystem::FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                MAX_MESSAGE as u32,
                MAX_MESSAGE as u32,
                0,
                Some(&attributes),
            )
        };
        let _ = unsafe { LocalFree(Some(descriptor)) };
        if pipe == INVALID_HANDLE_VALUE {
            PIPE_AVAILABLE.store(false, Ordering::Relaxed);
            eprintln!("[Clotr] One Clotr connection is unavailable.");
            return;
        }
        PIPE_AVAILABLE.store(true, Ordering::Relaxed);
        let connected = unsafe {
            match ConnectNamedPipe(pipe, None) {
                Ok(()) => true,
                Err(error) => error.code().0 as u32 == ERROR_PIPE_CONNECTED.0,
            }
        };
        if connected {
            let file = unsafe { std::fs::File::from_raw_handle(pipe.0 as *mut _) };
            let mut file = file;
            let mut client_pid = 0;
            let trusted = unsafe { GetNamedPipeClientProcessId(pipe, &mut client_pid) }.is_ok()
                && is_expected_process(client_pid, "clotr-bridge.exe");
            if trusted {
                if let Ok(request) = read_frame(&mut file) {
                    let _ = write_frame(&mut file, &handle(request));
                }
            } else {
                let _ = write_frame(&mut file, &not_running());
            }
            drop(file);
        } else {
            let _ = unsafe { CloseHandle(pipe) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_frames_round_trip_one_fixture_message() {
        let message = serde_json::json!({"v":1,"type":"hello","browser":"Firefox"});
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &message).unwrap();
        assert_eq!(read_frame(&mut bytes.as_slice()).unwrap(), message);
    }

    #[test]
    fn not_running_reply_has_only_its_protocol_type() {
        assert_eq!(not_running(), serde_json::json!({"type":"not_running"}));
    }

    #[test]
    fn path_comparison_ignores_case() {
        assert!(paths_match_case_insensitively(
            std::path::Path::new("C:/Clotr/clotr-bridge.exe"),
            std::path::Path::new("c:/clotr/CLOTR-BRIDGE.EXE")
        ));
    }

    #[test]
    fn unresolved_executable_paths_are_not_trusted() {
        assert!(!same_resolved_path(
            std::path::Path::new("missing/clotr.exe"),
            std::path::Path::new("missing/clotr.exe")
        ));
    }

    #[test]
    fn resolved_paths_match_only_when_the_files_match() {
        let executable = std::env::current_exe().unwrap();
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        assert!(same_resolved_path(&executable, &executable));
        assert!(!same_resolved_path(&executable, &manifest));
    }

    #[test]
    fn pipe_availability_starts_ready_for_settings() {
        assert!(is_available());
    }

    #[test]
    fn only_the_five_signed_browser_executables_can_start_the_bridge() {
        for (name, signer) in [
            ("chrome.exe", "Google LLC"),
            ("brave.exe", "Brave Software, Inc."),
            ("msedge.exe", "Microsoft Corporation"),
            ("vivaldi.exe", "Vivaldi Technologies AS"),
            ("firefox.exe", "Mozilla Corporation"),
        ] {
            let path = format!(r"C:\Browsers\{name}");
            assert!(browser_parent_is_trusted(&path, Some(signer)), "{name}");
        }
        assert!(!browser_parent_is_trusted("chrome.exe", Some("Unknown Publisher")));
        assert!(!browser_parent_is_trusted("chrome.exe", None));
        assert!(!browser_parent_is_trusted("clotr-bridge.exe", Some("Google LLC")));
        assert_eq!(
            browser_parent_rejection(r"C:\Temp\unknown.exe", Some("Unknown Publisher")),
            Some("the parent process is not a supported browser")
        );
        assert_eq!(
            browser_parent_rejection("chrome.exe", Some("Unknown Publisher")),
            Some("the parent browser signature did not match its name")
        );
    }
}
