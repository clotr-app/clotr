//! What Windows knows about a window's program: its file, the Store package it runs from, and who signed it.
//! All read locally; checking a signature never goes online (no revocation check, no fetching certificates).

use std::collections::HashMap;
use std::sync::Mutex;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows::Win32::Security::Cryptography::{
    CertCloseStore, CertFindCertificateInStore, CertFreeCertificateContext, CertGetNameStringW, CryptMsgClose,
    CryptMsgGetParam, CryptQueryObject, CERT_FIND_SUBJECT_CERT, CERT_INFO, CERT_NAME_SIMPLE_DISPLAY_TYPE,
    CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED, CERT_QUERY_FORMAT_FLAG_BINARY, CERT_QUERY_OBJECT_FILE,
    CMSG_SIGNER_INFO, CMSG_SIGNER_INFO_PARAM, HCERTSTORE, PKCS_7_ASN_ENCODING, X509_ASN_ENCODING,
};
use windows::Win32::Security::WinTrust::{
    WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO,
    WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY,
    WTD_UI_NONE,
};
use windows::Win32::Storage::Packaging::Appx::{GetPackageFamilyName, GetPackagesByPackageFamily};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetClassNameW, GetWindowThreadProcessId};

pub struct Info {
    pub exe_path: String,
    pub package_family: Option<String>,
}

struct Process(HANDLE);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

pub fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

pub fn class_of(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

/// A Store app's window is often a frame drawn by ApplicationFrameHost.exe, with the app's own window inside it:
/// the program is the one inside.
pub fn real_owner(hwnd: HWND) -> u32 {
    let pid = pid_of(hwnd);
    if class_of(hwnd) != "ApplicationFrameWindow" {
        return pid;
    }
    struct Search {
        frame: u32,
        found: u32,
    }
    unsafe extern "system" fn each(child: HWND, data: windows::Win32::Foundation::LPARAM) -> windows::core::BOOL {
        let s = &mut *(data.0 as *mut Search);
        let p = pid_of(child);
        if p != 0 && p != s.frame {
            s.found = p;
            return false.into();
        }
        true.into()
    }
    let mut s = Search { frame: pid, found: 0 };
    unsafe {
        let _ = EnumChildWindows(
            Some(hwnd),
            Some(each),
            windows::Win32::Foundation::LPARAM(&mut s as *mut _ as isize),
        );
    }
    if s.found != 0 {
        s.found
    } else {
        pid
    }
}

pub fn info(hwnd: HWND) -> Option<Info> {
    let pid = real_owner(hwnd);
    if pid == 0 {
        return None;
    }
    let handle = Process(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?);
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    unsafe { QueryFullProcessImageNameW(handle.0, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }.ok()?;
    let exe_path = String::from_utf16_lossy(&buf[..len as usize]);
    let mut fam = vec![0u16; 256];
    let mut fam_len = fam.len() as u32;
    let package_family = (unsafe { GetPackageFamilyName(handle.0, &mut fam_len, Some(PWSTR(fam.as_mut_ptr()))) }.0
        == 0)
        .then(|| String::from_utf16_lossy(&fam[..fam_len.saturating_sub(1) as usize]));
    Some(Info {
        exe_path,
        package_family,
    })
}

static SIGNERS: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

/// Who signed a program's file ("Anthropic, PBC"), when the signature checks out on this computer; remembered per
/// file for as long as Clotr runs.
pub fn signer(path: &str) -> Option<String> {
    if let Some(hit) = SIGNERS.lock().ok()?.get_or_insert_with(HashMap::new).get(path) {
        return hit.clone();
    }
    let found = if verified(path) { subject(path) } else { None };
    SIGNERS
        .lock()
        .ok()?
        .get_or_insert_with(HashMap::new)
        .insert(path.to_string(), found.clone());
    found
}

/// Whether a Store package of this family is installed for the person signed in. Windows answers from its own
/// list, so nothing is read from the app or the disk, and the call needs no special permission.
pub fn package_installed(family: &str) -> bool {
    if family.is_empty() {
        return false;
    }
    let name = wide(family);
    let (mut count, mut buffer_len) = (0u32, 0u32);
    // With no buffers given, Windows only counts: ERROR_INSUFFICIENT_BUFFER and a count above zero when the family
    // is installed, success and zero when it isn't.
    let _ = unsafe { GetPackagesByPackageFamily(PCWSTR(name.as_ptr()), &mut count, None, &mut buffer_len, None) };
    count > 0
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The file's signature is whole and chains to a root this computer trusts. Offline only: no revocation check and
/// no certificate fetched from the internet (WTD_CACHE_ONLY_URL_RETRIEVAL).
fn verified(path: &str) -> bool {
    let file = wide(path);
    let mut file_info = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(file.as_ptr()),
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut file_info },
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL,
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let status = unsafe { WinVerifyTrust(HWND(-1isize as *mut _), &mut action, &mut data as *mut _ as *mut _) };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe { WinVerifyTrust(HWND(-1isize as *mut _), &mut action, &mut data as *mut _ as *mut _) };
    status == 0
}

/// The signing certificate's name, read from the file's embedded signature.
fn subject(path: &str) -> Option<String> {
    let file = wide(path);
    let mut store = HCERTSTORE::default();
    let mut msg: *mut core::ffi::c_void = std::ptr::null_mut();
    unsafe {
        CryptQueryObject(
            CERT_QUERY_OBJECT_FILE,
            file.as_ptr() as *const _,
            CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
            CERT_QUERY_FORMAT_FLAG_BINARY,
            0,
            None,
            None,
            None,
            Some(&mut store),
            Some(&mut msg),
            None,
        )
        .ok()?;
    }
    let result = (|| unsafe {
        let mut size = 0u32;
        CryptMsgGetParam(msg, CMSG_SIGNER_INFO_PARAM, 0, None, &mut size).ok()?;
        // Held as u64s, not bytes: the signer record read out of it below needs pointer alignment, which a byte
        // buffer never promises.
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        CryptMsgGetParam(
            msg,
            CMSG_SIGNER_INFO_PARAM,
            0,
            Some(buf.as_mut_ptr() as *mut _),
            &mut size,
        )
        .ok()?;
        let signer = &*(buf.as_ptr() as *const CMSG_SIGNER_INFO);
        let cert_info = CERT_INFO {
            Issuer: signer.Issuer,
            SerialNumber: signer.SerialNumber,
            ..Default::default()
        };
        let cert = CertFindCertificateInStore(
            store,
            X509_ASN_ENCODING | PKCS_7_ASN_ENCODING,
            0,
            CERT_FIND_SUBJECT_CERT,
            Some(&cert_info as *const _ as *const _),
            None,
        );
        if cert.is_null() {
            return None;
        }
        let mut name = [0u16; 256];
        let n = CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, None, Some(&mut name));
        let _ = CertFreeCertificateContext(Some(cert));
        (n > 1).then(|| String::from_utf16_lossy(&name[..n as usize - 1]))
    })();
    unsafe {
        let _ = CryptMsgClose(Some(msg));
        let _ = CertCloseStore(Some(store), 0);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // The web view's own program is signed by Microsoft on every PC that can run Clotr for Windows.
    fn webview_exe() -> Option<String> {
        let base = std::path::Path::new(r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application");
        std::fs::read_dir(base)
            .ok()?
            .flatten()
            .map(|e| e.path().join("msedgewebview2.exe"))
            .find(|p| p.exists())
            .map(|p| p.to_string_lossy().into_owned())
    }

    #[test]
    fn a_signed_programs_publisher_is_read_offline() {
        let Some(exe) = webview_exe() else { return };
        assert_eq!(signer(&exe).as_deref(), Some("Microsoft Corporation"));
    }

    #[test]
    fn an_unsigned_program_has_no_publisher() {
        let me = std::env::current_exe().unwrap();
        assert_eq!(signer(&me.to_string_lossy()), None);
    }

    #[test]
    fn a_package_nobody_made_is_never_installed() {
        assert!(!package_installed("Clotr.NoSuchApp_0000000000000"));
        assert!(!package_installed(""), "an empty family is no package");
    }

    #[test]
    fn this_process_is_found_by_its_window() {
        let me = std::env::current_exe().unwrap().to_string_lossy().to_lowercase();
        let found = info_for_pid(std::process::id()).unwrap();
        assert_eq!(found.exe_path.to_lowercase(), me);
        assert_eq!(found.package_family, None);
    }

    fn info_for_pid(pid: u32) -> Option<Info> {
        let handle = Process(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?);
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        unsafe { QueryFullProcessImageNameW(handle.0, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }.ok()?;
        Some(Info {
            exe_path: String::from_utf16_lossy(&buf[..len as usize]),
            package_family: None,
        })
    }
}
