#![allow(unsafe_code)]

use crate::FileInformation;
use std::fs::File;
use std::io;
use std::mem::size_of;
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ID_128, FILE_ID_INFO, FILE_STANDARD_INFO, FileIdInfo, FileStandardInfo,
    GetFileInformationByHandleEx,
};

pub(super) fn inspect(file: &File) -> io::Result<FileInformation> {
    let handle = file.as_raw_handle() as HANDLE;
    let mut identity = FILE_ID_INFO {
        VolumeSerialNumber: 0,
        FileId: FILE_ID_128 {
            Identifier: [0; 16],
        },
    };
    // SAFETY: `file` owns a live handle for the duration of the call, `identity` is the exact
    // output type for `FileIdInfo`, and the supplied buffer size matches that type.
    let identity_succeeded = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&raw mut identity).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if identity_succeeded == 0 {
        return Err(io::Error::last_os_error());
    }

    let mut standard = FILE_STANDARD_INFO {
        AllocationSize: 0,
        EndOfFile: 0,
        NumberOfLinks: 0,
        DeletePending: 0,
        Directory: 0,
    };
    // SAFETY: `file` owns a live handle for the duration of the call, `standard` is the exact
    // output type for `FileStandardInfo`, and the supplied buffer size matches that type.
    let standard_succeeded = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            (&raw mut standard).cast(),
            size_of::<FILE_STANDARD_INFO>() as u32,
        )
    };
    if standard_succeeded == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(FileInformation::new(
        identity.VolumeSerialNumber,
        identity.FileId.Identifier,
        u64::from(standard.NumberOfLinks),
    ))
}

pub(super) fn common_application_data_dir() -> std::io::Result<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::FOLDERID_ProgramData;
    use windows_sys::Win32::UI::Shell::SHGetKnownFolderPath;
    let mut pointer = std::ptr::null_mut();
    // SAFETY: Windows owns the folder lookup and allocates a terminated UTF-16 buffer.
    let status = unsafe {
        SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, std::ptr::null_mut(), &mut pointer)
    };
    if status < 0 || pointer.is_null() {
        return Err(std::io::Error::other(
            "cannot resolve system permission directory",
        ));
    }
    let mut length = 0;
    // SAFETY: successful SHGetKnownFolderPath guarantees the buffer remains valid until freed.
    unsafe {
        while *pointer.add(length) != 0 {
            length += 1;
        }
        let result = std::path::PathBuf::from(std::ffi::OsString::from_wide(
            std::slice::from_raw_parts(pointer, length),
        ));
        CoTaskMemFree(pointer.cast());
        Ok(result)
    }
}

pub(super) fn validate_administrator_owned(file: &std::fs::File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Security::ACCESS_ALLOWED_ACE;
    use windows_sys::Win32::Security::ACE_HEADER;
    use windows_sys::Win32::Security::Authorization::GetSecurityInfo;
    use windows_sys::Win32::Security::Authorization::SE_FILE_OBJECT;
    use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
    use windows_sys::Win32::Security::GetAce;
    use windows_sys::Win32::Security::INHERIT_ONLY_ACE;
    use windows_sys::Win32::Security::IsWellKnownSid;
    use windows_sys::Win32::Security::OWNER_SECURITY_INFORMATION;
    use windows_sys::Win32::Security::WinBuiltinAdministratorsSid;
    use windows_sys::Win32::Security::WinLocalSystemSid;
    use windows_sys::Win32::Storage::FileSystem::DELETE;
    use windows_sys::Win32::Storage::FileSystem::FILE_APPEND_DATA;
    use windows_sys::Win32::Storage::FileSystem::FILE_DELETE_CHILD;
    use windows_sys::Win32::Storage::FileSystem::FILE_WRITE_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::FILE_WRITE_DATA;
    use windows_sys::Win32::Storage::FileSystem::FILE_WRITE_EA;
    use windows_sys::Win32::Storage::FileSystem::WRITE_DAC;
    use windows_sys::Win32::Storage::FileSystem::WRITE_OWNER;
    use windows_sys::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE;
    use windows_sys::Win32::System::SystemServices::ACCESS_DENIED_ACE_TYPE;
    let is_directory = file.metadata()?.is_dir();
    let mut owner = std::ptr::null_mut();
    let mut dacl = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: the open handle remains live; Windows owns all descriptor pointers until LocalFree.
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32));
    }
    // Only administrator/System ownership and non-writable access for every other SID is trusted.
    // Unknown ACE forms are rejected rather than treating an opaque conditional grant as safe.
    let trusted = unsafe {
        let privileged = |sid: windows_sys::Win32::Security::PSID| {
            !sid.is_null()
                && (IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
                    || IsWellKnownSid(sid, WinLocalSystemSid) != 0)
        };
        let mut trusted = privileged(owner) && !dacl.is_null();
        if trusted {
            for index in 0..(*dacl).AceCount {
                let mut ace = std::ptr::null_mut();
                if GetAce(dacl, u32::from(index), &mut ace) == 0 || ace.is_null() {
                    trusted = false;
                    break;
                }
                let header = &*ace.cast::<ACE_HEADER>();
                if header.AceFlags & INHERIT_ONLY_ACE as u8 != 0 {
                    continue;
                }
                if header.AceType == ACCESS_DENIED_ACE_TYPE as u8 {
                    continue;
                }
                if header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8 {
                    trusted = false;
                    break;
                }
                let allowed = &*ace.cast::<ACCESS_ALLOWED_ACE>();
                let writable = (if is_directory {
                    0
                } else {
                    FILE_WRITE_DATA | FILE_APPEND_DATA
                }) | FILE_WRITE_EA
                    | FILE_WRITE_ATTRIBUTES
                    | FILE_DELETE_CHILD
                    | DELETE
                    | WRITE_DAC
                    | WRITE_OWNER
                    | windows_sys::Win32::Foundation::GENERIC_WRITE
                    | windows_sys::Win32::Foundation::GENERIC_ALL;
                if allowed.Mask & writable != 0
                    && !privileged(std::ptr::addr_of!(allowed.SidStart).cast_mut().cast())
                {
                    trusted = false;
                    break;
                }
            }
        }
        windows_sys::Win32::Foundation::LocalFree(descriptor);
        trusted
    };
    if trusted {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "file has an untrusted owner or writable ACL",
        ))
    }
}
