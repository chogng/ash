// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::Authorization::SDDL_REVISION_1;
use windows_sys::Win32::Security::GetTokenInformation;
use windows_sys::Win32::Security::TOKEN_QUERY;
use windows_sys::Win32::Security::TOKEN_USER;
use windows_sys::Win32::Security::TokenUser;
use windows_sys::Win32::System::Threading::GetCurrentProcess;
use windows_sys::Win32::System::Threading::OpenProcessToken;

pub(super) type Result<T> = std::result::Result<T, String>;

pub(super) fn wide(text: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    text.as_ref().encode_wide().chain(Some(0)).collect()
}

pub(super) fn error(operation: &str) -> String {
    format!("{operation} failed (Windows error {})", unsafe {
        GetLastError()
    })
}

pub(super) struct Handle(pub(super) HANDLE);
unsafe impl Send for Handle {}

impl Handle {
    pub(super) fn new(handle: HANDLE, operation: &str) -> Result<Self> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(error(operation))
        } else {
            Ok(Self(handle))
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub(super) struct Local(pub(super) *mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub(super) fn sid(text: &str) -> Result<Local> {
    let mut value = std::ptr::null_mut();
    if unsafe { ConvertStringSidToSidW(wide(text).as_ptr(), &mut value) } == 0 {
        Err(error("ConvertStringSidToSidW"))
    } else {
        Ok(Local(value))
    }
}

pub(super) fn sid_text(value: *mut c_void) -> Result<String> {
    let mut text = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(value, &mut text) } == 0 {
        return Err(error("ConvertSidToStringSidW"));
    }
    let guard = Local(text.cast());
    let mut length = 0;
    unsafe {
        while *text.add(length) != 0 {
            length += 1;
        }
        let result = String::from_utf16(std::slice::from_raw_parts(text, length))
            .map_err(|error| error.to_string());
        drop(guard);
        result
    }
}

pub(super) fn token_user(token: HANDLE) -> Result<String> {
    let mut size = 0;
    unsafe {
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
    }
    if size == 0 {
        return Err(error("GetTokenInformation(TokenUser)"));
    }
    let mut data = vec![0u64; (size as usize + 7) / 8];
    if unsafe { GetTokenInformation(token, TokenUser, data.as_mut_ptr().cast(), size, &mut size) }
        == 0
    {
        return Err(error("GetTokenInformation(TokenUser)"));
    }
    sid_text(unsafe { (*(data.as_ptr().cast::<TOKEN_USER>())).User.Sid })
}

pub(super) fn current_user() -> Result<String> {
    let mut raw = std::ptr::null_mut();
    // Management runs on one impersonating pipe thread. Execution has no thread
    // token and uses its process identity; the service's SYSTEM identity is never
    // used as the owner of a caller's accounts or DPAPI journal.
    if unsafe {
        windows_sys::Win32::System::Threading::OpenThreadToken(
            windows_sys::Win32::System::Threading::GetCurrentThread(),
            TOKEN_QUERY,
            1,
            &mut raw,
        )
    } == 0
    {
        if std::io::Error::last_os_error().raw_os_error() != Some(1008) {
            return Err(error("OpenThreadToken"));
        }
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
            return Err(error("OpenProcessToken"));
        }
    }
    let token = Handle::new(raw, "OpenProcessToken")?;
    token_user(token.0)
}

pub(super) fn logon_sid(token: HANDLE) -> Result<String> {
    use windows_sys::Win32::Security::SID_AND_ATTRIBUTES;
    use windows_sys::Win32::Security::TOKEN_GROUPS;
    use windows_sys::Win32::Security::TokenGroups;
    let mut size = 0;
    unsafe {
        GetTokenInformation(token, TokenGroups, std::ptr::null_mut(), 0, &mut size);
    }
    if size == 0 {
        return Err(error("GetTokenInformation(TokenGroups)"));
    }
    let mut buffer = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token,
            TokenGroups,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(error("GetTokenInformation(TokenGroups)"));
    }
    let groups = unsafe { &*buffer.as_ptr().cast::<TOKEN_GROUPS>() };
    let offset = std::mem::offset_of!(TOKEN_GROUPS, Groups);
    if offset + groups.GroupCount as usize * size_of::<SID_AND_ATTRIBUTES>() > size as usize {
        return Err("invalid token group buffer".into());
    }
    let groups =
        unsafe { std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize) };
    for group in groups {
        if group.Attributes & 0xc000_0000 == 0xc000_0000 {
            return sid_text(group.Sid);
        }
    }
    Err("the sandbox token has no logon identity".into())
}

pub(super) fn descriptor(sddl: &str) -> Result<Local> {
    let mut raw = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(sddl).as_ptr(),
            SDDL_REVISION_1,
            &mut raw,
            std::ptr::null_mut(),
        )
    } == 0
    {
        Err(error(
            "ConvertStringSecurityDescriptorToSecurityDescriptorW",
        ))
    } else {
        Ok(Local(raw))
    }
}

pub(super) fn program_data() -> Result<std::path::PathBuf> {
    use windows::Win32::Foundation::FreeLibrary;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::LibraryLoader::GetProcAddress;
    use windows::Win32::System::LibraryLoader::LOAD_LIBRARY_SEARCH_SYSTEM32;
    use windows::Win32::System::LibraryLoader::LoadLibraryExW;
    use windows::Win32::UI::Shell::FOLDERID_ProgramData;
    use windows::core::GUID;
    use windows::core::HRESULT;
    use windows::core::PWSTR;
    use windows::core::s;
    use windows::core::w;
    // Configuration needs Known Folder resolution, but the logon worker must
    // initialize without Shell32 and its interactive-desktop DLL dependencies.
    // Resolve the official API only when used, from the trusted System32 image.
    struct Module(HMODULE);
    impl Drop for Module {
        fn drop(&mut self) {
            let _ = unsafe { FreeLibrary(self.0) };
        }
    }
    let module = Module(
        unsafe { LoadLibraryExW(w!("shell32.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32) }
            .map_err(|error| error.to_string())?,
    );
    type GetPath = unsafe extern "system" fn(*const GUID, u32, HANDLE, *mut PWSTR) -> HRESULT;
    let procedure = unsafe { GetProcAddress(module.0, s!("SHGetKnownFolderPath")) }
        .ok_or("SHGetKnownFolderPath is unavailable")?;
    let get_path: GetPath = unsafe { std::mem::transmute(procedure) };
    let mut raw = PWSTR::null();
    unsafe { get_path(&FOLDERID_ProgramData, 0, std::ptr::null_mut(), &mut raw) }
        .ok()
        .map_err(|error| error.to_string())?;
    let path = unsafe { raw.to_string() }
        .map(std::path::PathBuf::from)
        .map_err(|error| error.to_string());
    unsafe {
        CoTaskMemFree(Some(raw.0.cast()));
    }
    path
}

pub(super) fn create_private_directory(path: &Path, owner: &str) -> Result<()> {
    create_directory(path, &format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{owner})"))
}

pub(super) fn create_service_directory(path: &Path, owner: &str) -> Result<()> {
    create_directory(
        path,
        &format!("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;{owner})"),
    )
}

fn create_directory(path: &Path, sddl: &str) -> Result<()> {
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
    let sd = descriptor(sddl)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    if unsafe { CreateDirectoryW(wide(path).as_ptr(), &attributes) } == 0 {
        return Err(error("CreateDirectoryW(private runtime)"));
    }
    Ok(())
}

/// Credentials and approved executable identities must stay administrator-owned.
/// A user-created DPAPI blob is not proof that an account belongs to this service.
pub(crate) fn verify_service_path(path: &Path) -> Result<()> {
    use windows_sys::Win32::Security::ACCESS_ALLOWED_ACE;
    use windows_sys::Win32::Security::ACE_HEADER;
    use windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW;
    use windows_sys::Win32::Security::Authorization::SE_FILE_OBJECT;
    use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
    use windows_sys::Win32::Security::EqualSid;
    use windows_sys::Win32::Security::GetAce;
    use windows_sys::Win32::Security::OWNER_SECURITY_INFORMATION;
    let mut owner = std::ptr::null_mut();
    let mut acl = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    let result = unsafe {
        GetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut acl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return Err(format!(
            "GetNamedSecurityInfoW(service path) failed ({result})"
        ));
    }
    let _descriptor = Local(descriptor);
    let system = sid("S-1-5-18")?;
    let administrators = sid("S-1-5-32-544")?;
    let privileged =
        |value| unsafe { EqualSid(value, system.0) != 0 || EqualSid(value, administrators.0) != 0 };
    if owner.is_null() || !privileged(owner) || acl.is_null() {
        return Err("sandbox service path is not administrator-owned".into());
    }
    // Includes directory deletion/creation rights and ownership/DACL changes.
    const WRITE: u32 = 0x500d_0156;
    for index in 0..unsafe { (*acl).AceCount } as u32 {
        let mut raw = std::ptr::null_mut();
        if unsafe { GetAce(acl, index, &mut raw) } == 0 {
            return Err(error("GetAce(service path)"));
        }
        let header = unsafe { &*raw.cast::<ACE_HEADER>() };
        match header.AceType {
            0 => {
                let ace = unsafe { &*raw.cast::<ACCESS_ALLOWED_ACE>() };
                if ace.Mask & WRITE != 0 && !privileged((&raw const ace.SidStart).cast_mut().cast())
                {
                    return Err("sandbox service path grants writes outside administrators".into());
                }
            }
            1 => {}
            _ => return Err("sandbox service path has an unsupported access entry".into()),
        }
    }
    Ok(())
}

pub(super) fn random_hex(bytes: usize) -> Result<String> {
    let mut value = vec![0u8; bytes];
    getrandom::getrandom(&mut value).map_err(|error| error.to_string())?;
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Pin every path component without following replacement reparse points. The
/// executable is additionally held against writes while its digest is checked.
pub(super) fn pin_executable(path: &Path) -> Result<Vec<Handle>> {
    use windows_sys::Win32::Foundation::GENERIC_READ;
    use windows_sys::Win32::Storage::FileSystem::*;
    let canonical = std::fs::canonicalize(path).map_err(|error| error.to_string())?;
    let mut chain = canonical
        .ancestors()
        .map(Path::to_owned)
        .collect::<Vec<_>>();
    chain.reverse();
    let mut handles = Vec::new();
    for part in &chain {
        let leaf = part == &canonical;
        let access = if leaf {
            GENERIC_READ
        } else {
            FILE_READ_ATTRIBUTES
        };
        let share = if leaf {
            FILE_SHARE_READ
        } else {
            FILE_SHARE_READ | FILE_SHARE_WRITE
        };
        let handle = Handle::new(
            unsafe {
                CreateFileW(
                    wide(part).as_ptr(),
                    access,
                    share,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    std::ptr::null_mut(),
                )
            },
            "CreateFileW(runtime path)",
        )?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
            return Err(error("GetFileInformationByHandle(runtime)"));
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("runtime path changed to a reparse point".into());
        }
        handles.push(handle);
    }
    Ok(handles)
}

pub(super) fn create_service_file(target: &Path, sddl: &str) -> Result<std::fs::File> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::GENERIC_READ;
    use windows_sys::Win32::Foundation::GENERIC_WRITE;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::CREATE_NEW;
    use windows_sys::Win32::Storage::FileSystem::CreateFileW;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    let parent = target.parent().ok_or("service image has no parent")?;
    let _parent = pin_executable(parent)?;
    verify_service_path(parent)?;
    if target.try_exists().map_err(|error| error.to_string())? {
        let pinned = pin_executable(target)?;
        verify_service_path(target)?;
        drop(pinned);
        std::fs::remove_file(target).map_err(|error| error.to_string())?;
    }
    let sd = descriptor(sddl)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    let raw = unsafe {
        CreateFileW(
            wide(target).as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    let handle = Handle::new(raw, "CreateFileW(protected service image)")?;
    let handle = std::mem::ManuallyDrop::new(handle);
    Ok(unsafe { std::fs::File::from_raw_handle(handle.0) })
}

pub(crate) fn copy_service_image(source: &Path, target: &Path, readers: &[String]) -> Result<()> {
    let source = std::fs::canonicalize(source).map_err(|error| error.to_string())?;
    let _source = pin_executable(&source)?;
    let mut sddl = "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)".to_owned();
    for reader in readers {
        let _sid = sid(reader)?;
        sddl.push_str(&format!("(A;;GRGX;;;{reader})"));
    }
    let mut target = create_service_file(target, &sddl)?;
    let mut source = std::fs::File::open(source).map_err(|error| error.to_string())?;
    std::io::copy(&mut source, &mut target).map_err(|error| error.to_string())?;
    target.sync_all().map_err(|error| error.to_string())
}
