//! Startup-only package read grants and an AppContainer without network capabilities.
use super::super::win;
use super::checked;
use super::owned;
use super::raw;
use super::wide;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::ptr::null;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::WAIT_ABANDONED;
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::Security::Authorization::ACCESS_MODE;
use windows_sys::Win32::Security::Authorization::EXPLICIT_ACCESS_W;
use windows_sys::Win32::Security::Authorization::GRANT_ACCESS;
use windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW;
use windows_sys::Win32::Security::Authorization::NO_MULTIPLE_TRUSTEE;
use windows_sys::Win32::Security::Authorization::REVOKE_ACCESS;
use windows_sys::Win32::Security::Authorization::SE_FILE_OBJECT;
use windows_sys::Win32::Security::Authorization::SetEntriesInAclW;
use windows_sys::Win32::Security::Authorization::SetNamedSecurityInfoW;
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_SID;
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_UNKNOWN;
use windows_sys::Win32::Security::Authorization::TRUSTEE_W;
use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
use windows_sys::Win32::Security::DuplicateTokenEx;
use windows_sys::Win32::Security::FreeSid;
use windows_sys::Win32::Security::Isolation::CreateAppContainerProfile;
use windows_sys::Win32::Security::Isolation::DeleteAppContainerProfile;
use windows_sys::Win32::Security::PSID;
use windows_sys::Win32::Security::SECURITY_CAPABILITIES;
use windows_sys::Win32::Security::SID_AND_ATTRIBUTES;
use windows_sys::Win32::Security::SecurityImpersonation;
use windows_sys::Win32::Security::TOKEN_ALL_ACCESS;
use windows_sys::Win32::Security::TokenImpersonation;
use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_EXECUTE;
use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_READ;
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::System::Threading::ReleaseMutex;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

pub(super) struct AppContainer {
    name: String,
    sid: PSID,
    paths: Vec<PathBuf>,
}

// The SID allocation is exclusively owned; Win32 reads it only while this resource is live.
unsafe impl Send for AppContainer {}

impl AppContainer {
    pub(super) fn new(package: &Path, sources: crate::LockedProcessSources) -> io::Result<Self> {
        let name = format!(
            "Ash.JavaScript.{}",
            win::random_hex(16).map_err(io::Error::other)?
        );
        let mut sid = null_mut();
        let value = wide(std::ffi::OsStr::new(&name));
        // No internet, local network, loopback, device or other capability is granted.
        let result = unsafe {
            CreateAppContainerProfile(
                value.as_ptr(),
                value.as_ptr(),
                value.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        if result < 0 {
            return Err(io::Error::from_raw_os_error(
                (result as u32 & 0xffff) as i32,
            ));
        }
        let mut container = Self {
            name,
            sid,
            paths: Vec::new(),
        };
        // The working directory of an embedded host can be the entire product or
        // Cargo output tree. Its sources need no disk reads or recursive ACL edits.
        match sources {
            crate::LockedProcessSources::Package => container.grant_package(package, 0)?,
            crate::LockedProcessSources::Embedded => {}
        }
        Ok(container)
    }

    pub(super) fn capabilities(&self) -> SECURITY_CAPABILITIES {
        SECURITY_CAPABILITIES {
            AppContainerSid: self.sid,
            Capabilities: null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        }
    }

    pub(super) fn sid_text(&self) -> io::Result<String> {
        win::sid_text(self.sid).map_err(io::Error::other)
    }

    pub(super) fn grant_internal_objects(
        &self,
        token: &std::os::windows::io::OwnedHandle,
    ) -> io::Result<()> {
        super::grant_internal_objects(token, self.sid)
    }

    pub(super) fn startup_token(
        &self,
        token: &std::os::windows::io::OwnedHandle,
    ) -> io::Result<std::os::windows::io::OwnedHandle> {
        #[link(name = "ntdll")]
        unsafe extern "system" {
            fn NtCreateLowBoxToken(
                output: *mut HANDLE,
                input: HANDLE,
                access: u32,
                attributes: *const std::ffi::c_void,
                sid: PSID,
                capability_count: u32,
                capabilities: *const SID_AND_ATTRIBUTES,
                handle_count: u32,
                handles: *const HANDLE,
            ) -> i32;
            fn RtlNtStatusToDosError(status: i32) -> u32;
        }
        // Windows only accepts impersonation inside the same AppContainer. Convert the
        // trusted initial token to that identity; it gains no networking capability.
        unsafe {
            let mut lowbox = null_mut();
            let status = NtCreateLowBoxToken(
                &mut lowbox,
                raw(token),
                TOKEN_ALL_ACCESS,
                null(),
                self.sid,
                0,
                null(),
                0,
                null(),
            );
            if status < 0 {
                return Err(io::Error::from_raw_os_error(
                    RtlNtStatusToDosError(status) as i32
                ));
            }
            let lowbox = owned(lowbox);
            let mut initial = null_mut();
            checked(DuplicateTokenEx(
                raw(&lowbox),
                TOKEN_ALL_ACCESS,
                null(),
                SecurityImpersonation,
                TokenImpersonation,
                &mut initial,
            ))?;
            Ok(owned(initial))
        }
    }

    fn grant_package(&mut self, path: &Path, depth: usize) -> io::Result<()> {
        if depth > 32 || self.paths.len() >= 4097 {
            return Err(io::Error::other("startup package quota exceeded"));
        }
        let metadata = std::fs::symlink_metadata(path)?;
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("startup package contains a reparse point"));
        }
        self.grant(path)?;
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path)? {
                self.grant_package(&entry?.path(), depth + 1)?;
            }
        }
        Ok(())
    }

    fn grant(&mut self, path: &Path) -> io::Result<()> {
        update_acl(path, self.sid, GRANT_ACCESS)?;
        self.paths.push(path.to_owned());
        Ok(())
    }
}

fn update_acl(path: &Path, sid: PSID, mode: ACCESS_MODE) -> io::Result<()> {
    // Serialize read/modify/write across product processes. Each launch removes only
    // its own unpredictable SID, preserving other live launches and unrelated ACEs.
    let name = win::wide(format!(
        "Local\\AshJsAcl.{}",
        win::current_user().map_err(io::Error::other)?
    ));
    unsafe {
        let mutex = CreateMutexW(null(), 0, name.as_ptr());
        if mutex.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mutex = owned(mutex);
        match WaitForSingleObject(raw(&mutex), 10_000) {
            WAIT_OBJECT_0 | WAIT_ABANDONED => {}
            _ => return Err(io::Error::other("startup ACL lock unavailable")),
        }
        let result = change_acl(path, sid, mode);
        let released = checked(ReleaseMutex(raw(&mutex)));
        result.and(released)
    }
}

unsafe fn change_acl(path: &Path, sid: PSID, mode: ACCESS_MODE) -> io::Result<()> {
    let mut name = wide(path.as_os_str());
    let mut descriptor = null_mut();
    let mut dacl = null_mut();
    unsafe {
        let result = GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        );
        if result != 0 {
            return Err(io::Error::from_raw_os_error(result as i32));
        }
        let _descriptor = win::Local(descriptor.cast());
        let access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
            grfAccessMode: mode,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid.cast(),
            },
        };
        let mut updated = null_mut();
        let result = SetEntriesInAclW(1, &access, dacl, &mut updated);
        if result != 0 {
            return Err(io::Error::from_raw_os_error(result as i32));
        }
        let _updated = win::Local(updated.cast());
        let result = SetNamedSecurityInfoW(
            name.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            updated,
            null_mut(),
        );
        if result != 0 {
            return Err(io::Error::from_raw_os_error(result as i32));
        }
    }
    Ok(())
}

impl Drop for AppContainer {
    fn drop(&mut self) {
        for path in self.paths.iter().rev() {
            let _ = update_acl(path, self.sid, REVOKE_ACCESS);
        }
        unsafe {
            DeleteAppContainerProfile(wide(std::ffi::OsStr::new(&self.name)).as_ptr());
            FreeSid(self.sid);
        }
    }
}
