use std::ffi::c_void;
use std::io;
use std::os::windows::ffi::OsStrExt;
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
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_USER;
use windows_sys::Win32::Security::Authorization::TRUSTEE_W;
use windows_sys::Win32::Security::CONTAINER_INHERIT_ACE;
use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
use windows_sys::Win32::Security::OBJECT_INHERIT_ACE;
use windows_sys::Win32::Security::OWNER_SECURITY_INFORMATION;
use windows_sys::Win32::Security::PROTECTED_DACL_SECURITY_INFORMATION;
use windows_sys::Win32::Security::PSID;
use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
use windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH;
use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
use windows_sys::Win32::Storage::FileSystem::REPLACEFILE_WRITE_THROUGH;
use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

pub(super) fn set_private_directory_permissions(path: &Path) -> io::Result<()> {
    let path = to_wide(path);
    let mut owner: PSID = std::ptr::null_mut();
    let mut descriptor: *mut c_void = std::ptr::null_mut();
    let owner_result = unsafe {
        GetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if owner_result != ERROR_SUCCESS {
        return Err(windows_error(owner_result));
    }
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_ALL_ACCESS,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: owner as *mut u16,
        },
    };
    let mut private_dacl: *mut ACL = std::ptr::null_mut();
    let acl_result =
        unsafe { SetEntriesInAclW(1, &entry, std::ptr::null_mut(), &mut private_dacl) };
    if acl_result != ERROR_SUCCESS {
        unsafe {
            LocalFree(descriptor as HLOCAL);
        }
        return Err(windows_error(acl_result));
    }
    let set_result = unsafe {
        SetNamedSecurityInfoW(
            path.as_ptr() as *mut u16,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            private_dacl,
            std::ptr::null_mut(),
        )
    };
    unsafe {
        LocalFree(private_dacl as HLOCAL);
        LocalFree(descriptor as HLOCAL);
    }
    if set_result != ERROR_SUCCESS {
        return Err(windows_error(set_result));
    }
    Ok(())
}

pub(super) fn promote_file(staging: &Path, destination: &Path) -> io::Result<()> {
    let staging = to_wide(staging);
    let destination = to_wide(destination);
    let promoted = if destination_exists(destination.as_ptr()) {
        unsafe {
            ReplaceFileW(
                destination.as_ptr(),
                staging.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        }
    } else {
        unsafe {
            MoveFileExW(
                staging.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if promoted == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn destination_exists(path: *const u16) -> bool {
    use windows_sys::Win32::Storage::FileSystem::GetFileAttributesW;
    use windows_sys::Win32::Storage::FileSystem::INVALID_FILE_ATTRIBUTES;

    unsafe { GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES }
}

fn to_wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn windows_error(code: u32) -> io::Error {
    io::Error::from_raw_os_error(code as i32)
}
