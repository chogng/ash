#![allow(unsafe_code)]

use std::ffi::c_void;
use std::os::windows::fs::MetadataExt;
use std::path::Path;

use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::Foundation::HLOCAL;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::ACL;
use windows_sys::Win32::Security::Authorization::EXPLICIT_ACCESS_W;
use windows_sys::Win32::Security::Authorization::GRANT_ACCESS;
use windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW;
use windows_sys::Win32::Security::Authorization::SE_FILE_OBJECT;
use windows_sys::Win32::Security::Authorization::SetEntriesInAclW;
use windows_sys::Win32::Security::Authorization::SetNamedSecurityInfoW;
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_SID;
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_UNKNOWN;
use windows_sys::Win32::Security::Authorization::TRUSTEE_W;
use windows_sys::Win32::Security::CONTAINER_INHERIT_ACE;
use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
use windows_sys::Win32::Security::OBJECT_INHERIT_ACE;
use windows_sys::Win32::Security::PSID;
use windows_sys::Win32::Storage::FileSystem::DELETE;
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
use windows_sys::Win32::Storage::FileSystem::FILE_DELETE_CHILD;
use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_EXECUTE;
use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_READ;
use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_WRITE;

use super::native::to_wide;

pub(super) enum DirectoryAccess {
    ReadOnly,
    ReadWrite,
}

pub(super) fn grant_directory_tree(
    path: &Path,
    sid: PSID,
    access: DirectoryAccess,
) -> Result<(), String> {
    let permissions = match access {
        DirectoryAccess::ReadOnly => FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
        DirectoryAccess::ReadWrite => {
            FILE_GENERIC_READ
                | FILE_GENERIC_WRITE
                | FILE_GENERIC_EXECUTE
                | FILE_DELETE_CHILD
                | DELETE
        }
    };
    grant_tree(path, sid, permissions)
}

pub(super) fn grant_file_read_execute(path: &Path, sid: PSID) -> Result<(), String> {
    add_ace(path, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, 0)
}

fn grant_tree(path: &Path, sid: PSID, permissions: u32) -> Result<(), String> {
    let metadata = path
        .symlink_metadata()
        .map_err(|source| format!("could not inspect {}: {source}", path.display()))?;
    let directory = metadata.is_dir();
    add_ace(
        path,
        sid,
        permissions,
        if directory {
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
        } else {
            0
        },
    )?;
    if !directory || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Ok(());
    }
    for entry in std::fs::read_dir(path)
        .map_err(|source| format!("could not traverse {}: {source}", path.display()))?
    {
        let entry = entry.map_err(|source| {
            format!("could not inspect an entry in {}: {source}", path.display())
        })?;
        grant_tree(&entry.path(), sid, permissions)?;
    }
    Ok(())
}

fn add_ace(path: &Path, sid: PSID, permissions: u32, inheritance: u32) -> Result<(), String> {
    let path = to_wide(path.as_os_str());
    let mut old_dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: *mut c_void = std::ptr::null_mut();
    let result = unsafe {
        GetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut old_dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if result != ERROR_SUCCESS {
        return Err(format!(
            "GetNamedSecurityInfoW failed with Windows error {result}"
        ));
    }
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: permissions,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: inheritance,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: sid as *mut u16,
        },
    };
    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let acl_result = unsafe { SetEntriesInAclW(1, &entry, old_dacl, &mut new_dacl) };
    if acl_result != ERROR_SUCCESS {
        unsafe {
            LocalFree(descriptor as HLOCAL);
        }
        return Err(format!(
            "SetEntriesInAclW failed with Windows error {acl_result}"
        ));
    }
    let set_result = unsafe {
        SetNamedSecurityInfoW(
            path.as_ptr() as *mut u16,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            new_dacl,
            std::ptr::null_mut(),
        )
    };
    unsafe {
        LocalFree(new_dacl as HLOCAL);
        LocalFree(descriptor as HLOCAL);
    }
    if set_result != ERROR_SUCCESS {
        return Err(format!(
            "SetNamedSecurityInfoW failed with Windows error {set_result}"
        ));
    }
    Ok(())
}
