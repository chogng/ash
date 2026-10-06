//! Windows JS processes start with a locked primary token and a temporary startup
//! impersonation token. Only the product child may remove the latter, before evaluating JS.

use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::io::FromRawHandle;
use std::os::windows::io::OwnedHandle;
use std::ptr::null;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::GENERIC_ALL;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT;

use windows_sys::Win32::Foundation::SetHandleInformation;
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::Foundation::WAIT_TIMEOUT;

use windows_sys::Win32::Security::ACCESS_ALLOWED_ACE;
use windows_sys::Win32::Security::ACE_HEADER;
use windows_sys::Win32::Security::ACL;
use windows_sys::Win32::Security::ACL_REVISION;
use windows_sys::Win32::Security::AddAccessAllowedAce;
use windows_sys::Win32::Security::AddAce;
use windows_sys::Win32::Security::CreateRestrictedToken;
use windows_sys::Win32::Security::CreateWellKnownSid;
use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
use windows_sys::Win32::Security::DISABLE_MAX_PRIVILEGE;
use windows_sys::Win32::Security::GetAce;
use windows_sys::Win32::Security::GetLengthSid;
use windows_sys::Win32::Security::GetSidSubAuthority;
use windows_sys::Win32::Security::GetSidSubAuthorityCount;
use windows_sys::Win32::Security::GetTokenInformation;
use windows_sys::Win32::Security::InitializeAcl;
use windows_sys::Win32::Security::IsWellKnownSid;
use windows_sys::Win32::Security::PSID;
use windows_sys::Win32::Security::RevertToSelf;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Security::SECURITY_CAPABILITIES;
use windows_sys::Win32::Security::SID_AND_ATTRIBUTES;
use windows_sys::Win32::Security::SetKernelObjectSecurity;
use windows_sys::Win32::Security::SetTokenInformation;
use windows_sys::Win32::Security::TOKEN_ADJUST_DEFAULT;
use windows_sys::Win32::Security::TOKEN_ALL_ACCESS;
use windows_sys::Win32::Security::TOKEN_DEFAULT_DACL;
use windows_sys::Win32::Security::TOKEN_GROUPS;
use windows_sys::Win32::Security::TOKEN_INFORMATION_CLASS;
use windows_sys::Win32::Security::TOKEN_MANDATORY_LABEL;
use windows_sys::Win32::Security::TOKEN_QUERY;
use windows_sys::Win32::Security::TOKEN_USER;
use windows_sys::Win32::Security::TokenCapabilities;
use windows_sys::Win32::Security::TokenDefaultDacl;
use windows_sys::Win32::Security::TokenGroups;
use windows_sys::Win32::Security::TokenIntegrityLevel;
use windows_sys::Win32::Security::TokenIsAppContainer;
use windows_sys::Win32::Security::TokenRestrictedSids;
use windows_sys::Win32::Security::TokenUser;
use windows_sys::Win32::Security::WELL_KNOWN_SID_TYPE;
use windows_sys::Win32::Security::WinLowLabelSid;
use windows_sys::Win32::Security::WinMediumLabelSid;
use windows_sys::Win32::Security::WinRestrictedCodeSid;
use windows_sys::Win32::Security::WinUntrustedLabelSid;

use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::Diagnostics::Debug::WriteProcessMemory;

use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
use windows_sys::Win32::System::JobObjects::JOBOBJECT_BASIC_UI_RESTRICTIONS;
use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
use windows_sys::Win32::System::JobObjects::JobObjectBasicUIRestrictions;
use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
use windows_sys::Win32::System::JobObjects::QueryInformationJobObject;
use windows_sys::Win32::System::JobObjects::SetInformationJobObject;
use windows_sys::Win32::System::JobObjects::TerminateJobObject;

use windows_sys::Win32::System::Pipes::CreatePipe;

use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;
use windows_sys::Win32::System::Threading::CREATE_UNICODE_ENVIRONMENT;
use windows_sys::Win32::System::Threading::CreateProcessAsUserW;
use windows_sys::Win32::System::Threading::DETACHED_PROCESS;
use windows_sys::Win32::System::Threading::DeleteProcThreadAttributeList;
use windows_sys::Win32::System::Threading::EXTENDED_STARTUPINFO_PRESENT;
use windows_sys::Win32::System::Threading::GetCurrentProcess;
use windows_sys::Win32::System::Threading::GetExitCodeProcess;
use windows_sys::Win32::System::Threading::GetProcessMitigationPolicy;
use windows_sys::Win32::System::Threading::InitializeProcThreadAttributeList;
use windows_sys::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST;
use windows_sys::Win32::System::Threading::OpenProcessToken;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_HANDLE_LIST;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES;
use windows_sys::Win32::System::Threading::PROCESS_INFORMATION;
use windows_sys::Win32::System::Threading::ProcessChildProcessPolicy;
use windows_sys::Win32::System::Threading::ProcessSystemCallDisablePolicy;
use windows_sys::Win32::System::Threading::ResumeThread;
use windows_sys::Win32::System::Threading::STARTF_USESTDHANDLES;
use windows_sys::Win32::System::Threading::STARTUPINFOEXW;
use windows_sys::Win32::System::Threading::SetProcessMitigationPolicy;
use windows_sys::Win32::System::Threading::SetThreadToken;
use windows_sys::Win32::System::Threading::TerminateProcess;
use windows_sys::Win32::System::Threading::UpdateProcThreadAttribute;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

use ash_sandboxing::SandboxCommand;

mod app_container;

fn checked(success: i32) -> io::Result<()> {
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

unsafe fn owned(raw: HANDLE) -> OwnedHandle {
    // SAFETY: callers pass newly created, valid, uniquely owned Win32 handles.
    unsafe { OwnedHandle::from_raw_handle(raw) }
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle()
}

enum PipeDirection {
    Input,
    Output,
}

fn pipe(direction: PipeDirection) -> io::Result<(File, OwnedHandle)> {
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read = null_mut();
    let mut write = null_mut();
    // SAFETY: valid output pointers and security attributes for an anonymous pipe.
    unsafe {
        checked(CreatePipe(&mut read, &mut write, &security, 0))?;
        let read = owned(read);
        let write = owned(write);
        let (parent, child) = match direction {
            PipeDirection::Output => (read, write),
            PipeDirection::Input => (write, read),
        };
        checked(SetHandleInformation(raw(&parent), HANDLE_FLAG_INHERIT, 0))?;
        Ok((File::from(parent), child))
    }
}

fn sid(kind: WELL_KNOWN_SID_TYPE) -> io::Result<Vec<u32>> {
    let mut buffer = vec![0u32; 17];
    let mut length = (buffer.len() * size_of::<u32>()) as u32;
    // SAFETY: aligned buffer is SECURITY_MAX_SID_SIZE bytes; API writes its actual size.
    unsafe {
        checked(CreateWellKnownSid(
            kind,
            null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut length,
        ))?;
    }
    Ok(buffer)
}

fn tokens(
    app_sid: &str,
) -> io::Result<(
    OwnedHandle,
    OwnedHandle,
    super::desktop::Desktop,
    super::win::Local,
)> {
    let mut current = null_mut();
    // SAFETY: token handles are locally owned and never inherited by the child.
    unsafe {
        checked(OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ALL_ACCESS,
            &mut current,
        ))?;
        let current = owned(current);
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).map_err(|error| io::Error::other(error.to_string()))?;
        let ids: Vec<u32> = nonce
            .chunks_exact(4)
            .map(|part| u32::from_le_bytes(part.try_into().unwrap()))
            .collect();
        let identity = format!("S-1-5-21-{}-{}-{}-{}", ids[0], ids[1], ids[2], ids[3]);
        let private_sid = super::win::sid(&identity).map_err(io::Error::other)?;
        let private_sid_ptr = private_sid.0;
        let user_data = query(&current, TokenUser)?;
        let group_data = query(&current, TokenGroups)?;
        let user = &*user_data.as_ptr().cast::<TOKEN_USER>();
        let groups = &*group_data.as_ptr().cast::<TOKEN_GROUPS>();
        // Windows permits startup impersonation only when the primary token's
        // restrictions are contained in the startup token and integrity levels match.
        let mut startup_sids = vec![
            SID_AND_ATTRIBUTES {
                Sid: private_sid_ptr,
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: user.User.Sid,
                Attributes: 0,
            },
        ];
        startup_sids.extend(
            std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize)
                .iter()
                .map(|group| SID_AND_ATTRIBUTES {
                    Sid: group.Sid,
                    Attributes: 0,
                }),
        );
        let mut initial = null_mut();
        checked(CreateRestrictedToken(
            raw(&current),
            DISABLE_MAX_PRIVILEGE,
            0,
            null(),
            0,
            null(),
            startup_sids.len() as u32,
            startup_sids.as_ptr(),
            &mut initial,
        ))?;
        let initial = owned(initial);
        grant_internal_objects(&initial, private_sid_ptr)?;
        set_integrity(&initial, WinMediumLabelSid)?;
        let restricting = [SID_AND_ATTRIBUTES {
            Sid: private_sid_ptr,
            Attributes: 0,
        }];
        let mut deny = vec![SID_AND_ATTRIBUTES {
            Sid: user.User.Sid,
            Attributes: 0,
        }];
        deny.extend(
            std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize)
                .iter()
                .filter(|group| group.Attributes & (0xc000_0000 | 0x20) == 0)
                .map(|group| SID_AND_ATTRIBUTES {
                    Sid: group.Sid,
                    Attributes: 0,
                }),
        );
        let mut lockdown = null_mut();
        // Only this launch's private SID participates in the restricting access check.
        // Host files/registry have no grants for it. WRITE_RESTRICTED is excluded.
        checked(CreateRestrictedToken(
            raw(&current),
            DISABLE_MAX_PRIVILEGE,
            deny.len() as u32,
            deny.as_ptr(),
            0,
            null(),
            restricting.len() as u32,
            restricting.as_ptr(),
            &mut lockdown,
        ))?;
        let lockdown = owned(lockdown);
        grant_internal_objects(&lockdown, private_sid_ptr)?;
        // Rust's Windows runtime initializes bcrypt before main; low integrity is
        // required there. The trusted child lowers this token to untrusted before JS.
        set_integrity(&lockdown, WinLowLabelSid)?;
        let owner = super::win::sid_text(user.User.Sid).map_err(io::Error::other)?;
        let desktop =
            super::desktop::Desktop::new(&owner, &owner, &identity).map_err(io::Error::other)?;
        let objects = super::win::descriptor(&format!(
            "D:P(A;;GA;;;{owner})(A;;GA;;;SY)(A;;GA;;;RC)(A;;GA;;;{identity})(A;;GA;;;{app_sid})"
        ))
        .map_err(io::Error::other)?;
        checked(SetKernelObjectSecurity(
            raw(&lockdown),
            DACL_SECURITY_INFORMATION,
            objects.0,
        ))?;
        Ok((lockdown, initial, desktop, objects))
    }
}

fn grant_internal_objects(token: &OwnedHandle, private_sid: PSID) -> io::Result<()> {
    // The restriction also applies to synchronization objects the process creates.
    // Extend only this token's default DACL; host resources receive no private SID grants.
    unsafe {
        let data = query(token, TokenDefaultDacl)?;
        let default = &*data.as_ptr().cast::<TOKEN_DEFAULT_DACL>();
        if default.DefaultDacl.is_null() {
            return Err(io::Error::other("missing startup token DACL"));
        }
        let original = &*default.DefaultDacl;
        let mut restricted = sid(WinRestrictedCodeSid)?;
        let restricted_ptr = restricted.as_mut_ptr().cast();
        let size = original.AclSize as usize
            + 2 * (size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>())
            + GetLengthSid(private_sid) as usize
            + GetLengthSid(restricted_ptr) as usize;
        let mut storage = vec![0u32; size.div_ceil(size_of::<u32>())];
        let acl = storage.as_mut_ptr().cast::<ACL>();
        checked(InitializeAcl(acl, size as u32, ACL_REVISION))?;
        for index in 0..original.AceCount as u32 {
            let mut ace = null_mut();
            checked(GetAce(default.DefaultDacl, index, &mut ace))?;
            let header = &*ace.cast::<ACE_HEADER>();
            checked(AddAce(
                acl,
                ACL_REVISION,
                u32::MAX,
                ace,
                header.AceSize as u32,
            ))?;
        }
        checked(AddAccessAllowedAce(
            acl,
            ACL_REVISION,
            GENERIC_ALL,
            private_sid,
        ))?;
        checked(AddAccessAllowedAce(
            acl,
            ACL_REVISION,
            GENERIC_ALL,
            restricted_ptr,
        ))?;
        let default = TOKEN_DEFAULT_DACL { DefaultDacl: acl };
        checked(SetTokenInformation(
            raw(token),
            TokenDefaultDacl,
            (&default as *const TOKEN_DEFAULT_DACL).cast(),
            size_of_val(&default) as u32,
        ))
    }
}

fn set_integrity(token: &OwnedHandle, kind: WELL_KNOWN_SID_TYPE) -> io::Result<()> {
    let mut integrity = sid(kind)?;
    let label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: integrity.as_mut_ptr().cast(),
            Attributes: 0x20,
        },
    };
    // SAFETY: owned token and aligned SID/label remain live through the call.
    unsafe {
        checked(SetTokenInformation(
            raw(token),
            TokenIntegrityLevel,
            (&label as *const TOKEN_MANDATORY_LABEL).cast(),
            (size_of_val(&label) + GetLengthSid(label.Label.Sid) as usize) as u32,
        ))
    }
}

struct Attributes {
    storage: Vec<usize>,
}

impl Attributes {
    fn new() -> io::Result<Self> {
        let mut bytes = 0;
        // SAFETY: first call reports required size; Vec supplies stable pointer alignment.
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 3, 0, &mut bytes);
        }
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        unsafe {
            checked(InitializeProcThreadAttributeList(
                storage.as_mut_ptr().cast(),
                3,
                0,
                &mut bytes,
            ))?;
        }
        Ok(Self { storage })
    }
    fn pointer(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: the initialized attribute list is backed by storage until this returns.
        unsafe {
            DeleteProcThreadAttributeList(self.pointer());
        }
    }
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn command_line(launch: &SandboxCommand) -> Vec<u16> {
    let mut line = Vec::new();
    for argument in std::iter::once(launch.program())
        .chain(launch.arguments().iter().map(|arg| arg.as_os_str()))
    {
        if !line.is_empty() {
            line.push(b' ' as u16);
        }
        line.push(b'"' as u16);
        let mut slashes = 0;
        for unit in argument.encode_wide() {
            if unit == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            line.extend(std::iter::repeat_n(
                b'\\' as u16,
                if unit == b'"' as u16 {
                    slashes * 2 + 1
                } else {
                    slashes
                },
            ));
            slashes = 0;
            line.push(unit);
        }
        line.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        line.push(b'"' as u16);
    }
    line.push(0);
    line
}

pub fn spawn(launch: &SandboxCommand) -> io::Result<ash_sandboxing::ProcessHandle> {
    if !cfg!(target_pointer_width = "64") {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "locked processes require 64-bit Windows",
        ));
    }
    let container = app_container::AppContainer::new(launch.working_directory())
        .map_err(|error| io::Error::other(format!("AppContainer creation: {error}")))?;
    let (lockdown, startup_token, desktop, object_descriptor) = tokens(&container.sid_text()?)?;
    container.grant_internal_objects(&lockdown)?;
    container.grant_internal_objects(&startup_token)?;
    let startup_token = container
        .startup_token(&startup_token)
        .map_err(|error| io::Error::other(format!("AppContainer startup token: {error}")))?;
    let capabilities = container.capabilities();
    let child_policy = 1u32;
    let (stdin, child_stdin) = pipe(PipeDirection::Input)?;
    let (stdout, child_stdout) = pipe(PipeDirection::Output)?;
    let (stderr, child_stderr) = pipe(PipeDirection::Output)?;
    let mut attributes = Attributes::new()?;
    let handles = [raw(&child_stdin), raw(&child_stdout), raw(&child_stderr)];
    let mut info: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    info.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    info.StartupInfo.hStdInput = handles[0];
    info.StartupInfo.hStdOutput = handles[1];
    info.StartupInfo.hStdError = handles[2];
    info.lpAttributeList = attributes.pointer();
    let mut desktop_name = wide(OsStr::new(&desktop.name));
    info.StartupInfo.lpDesktop = desktop_name.as_mut_ptr();
    let object_security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: object_descriptor.0,
        bInheritHandle: 0,
    };
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let mut system_root = vec![0u16; 32_768];
    let length = unsafe {
        windows_sys::Win32::System::SystemInformation::GetSystemWindowsDirectoryW(
            system_root.as_mut_ptr(),
            system_root.len() as u32,
        )
    } as usize;
    if length == 0 || length >= system_root.len() {
        return Err(io::Error::last_os_error());
    }
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| io::Error::other("missing AppContainer profile directory"))?;
    let environment: Vec<u16> = "LOCALAPPDATA="
        .encode_utf16()
        .chain(local_app_data.encode_wide())
        .chain([0])
        .chain(
            "SystemRoot="
                .encode_utf16()
                .chain(system_root[..length].iter().copied())
                .chain([0, 0]),
        )
        .collect();
    let mut line = command_line(launch);
    // SAFETY: pointers remain live through creation; only the three specified pipe handles inherit.
    unsafe {
        checked(UpdateProcThreadAttribute(
            attributes.pointer(),
            0,
            PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY as usize,
            (&child_policy as *const u32).cast(),
            size_of_val(&child_policy),
            null_mut(),
            null_mut(),
        ))?;
        checked(UpdateProcThreadAttribute(
            attributes.pointer(),
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            (&capabilities as *const SECURITY_CAPABILITIES).cast(),
            size_of_val(&capabilities),
            null_mut(),
            null_mut(),
        ))?;
        checked(UpdateProcThreadAttribute(
            attributes.pointer(),
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_ptr().cast(),
            size_of_val(&handles),
            null_mut(),
            null_mut(),
        ))?;
        let job_raw = CreateJobObjectW(null(), null());
        if job_raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = owned(job_raw);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        checked(SetInformationJobObject(
            raw(&job),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&limits) as u32,
        ))?;
        let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            UIRestrictionsClass: 0xff,
        };
        checked(SetInformationJobObject(
            raw(&job),
            JobObjectBasicUIRestrictions,
            (&ui as *const JOBOBJECT_BASIC_UI_RESTRICTIONS).cast(),
            size_of_val(&ui) as u32,
        ))?;
        checked(CreateProcessAsUserW(
            raw(&lockdown),
            wide(launch.program()).as_ptr(),
            line.as_mut_ptr(),
            &object_security,
            &object_security,
            1,
            CREATE_SUSPENDED
                | DETACHED_PROCESS
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            wide(launch.working_directory().as_os_str()).as_ptr(),
            &info.StartupInfo,
            &mut process,
        ))
        .map_err(|error| io::Error::other(format!("CreateProcessAsUserW: {error}")))?;
        let child = WindowsProcess {
            process: owned(process.hProcess),
            job,
            _desktop: desktop,
            _app_container: container,
            stdin: Some(stdin),
            stdout: Some(stdout),
            stderr: Some(stderr),
            closed: false,
        };
        let thread = owned(process.hThread);
        // The child stays suspended until its job and startup token are installed. Every
        // worker starts with the locked primary token; only the initial thread can prepare V8.
        checked(AssignProcessToJobObject(
            raw(&child.job),
            raw(&child.process),
        ))?;
        checked(SetThreadToken(&raw(&thread), raw(&startup_token)))?;
        prepare_loader(raw(&child.process))?;
        if ResumeThread(raw(&thread)) == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        Ok(ash_sandboxing::ProcessHandle::new(child))
    }
}

#[cfg(target_pointer_width = "64")]
fn prepare_loader(process: HANDLE) -> io::Result<()> {
    #[repr(C)]
    struct BasicInformation {
        exit_status: isize,
        peb: usize,
        affinity: usize,
        priority: isize,
        process_id: usize,
        parent_id: usize,
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtQueryInformationProcess(
            process: HANDLE,
            class: u32,
            information: *mut std::ffi::c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
    }
    // Windows 10+ 64-bit PEB.ProcessParameters is at 0x20, and
    // RTL_USER_PROCESS_PARAMETERS.LoaderThreads at 0x40c. Parallel loader workers
    // would use the locked primary token before DLL initialization completes.
    // Serial loading keeps preparation on the sole startup thread without granting
    // any worker startup authority. Firefox uses this same per-process loader field:
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1515088
    // No registry, image or host ACL is modified.
    unsafe {
        let mut basic: BasicInformation = std::mem::zeroed();
        let status = NtQueryInformationProcess(
            process,
            0,
            (&mut basic as *mut BasicInformation).cast(),
            size_of_val(&basic) as u32,
            null_mut(),
        );
        if status < 0 {
            return Err(io::Error::from_raw_os_error(
                RtlNtStatusToDosError(status) as i32
            ));
        }
        let mut parameters = 0usize;
        let mut bytes = 0;
        checked(ReadProcessMemory(
            process,
            (basic.peb + 0x20) as _,
            (&mut parameters as *mut usize).cast(),
            size_of_val(&parameters),
            &mut bytes,
        ))?;
        if bytes != size_of_val(&parameters) {
            return Err(io::Error::other("incomplete process parameters pointer"));
        }
        let mut length = 0u32;
        checked(ReadProcessMemory(
            process,
            (parameters + 4) as _,
            (&mut length as *mut u32).cast(),
            size_of_val(&length),
            &mut bytes,
        ))?;
        if bytes != size_of_val(&length) || length < 0x410 {
            return Err(io::Error::other("unsupported process parameters layout"));
        }
        let threads = 1u32;
        checked(WriteProcessMemory(
            process,
            (parameters + 0x40c) as _,
            (&threads as *const u32).cast(),
            size_of_val(&threads),
            &mut bytes,
        ))?;
        if bytes != size_of_val(&threads) {
            return Err(io::Error::other("incomplete loader configuration"));
        }
    }
    Ok(())
}

#[cfg(target_pointer_width = "32")]
fn prepare_loader(_: HANDLE) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "locked processes require 64-bit Windows",
    ))
}

struct WindowsProcess {
    process: OwnedHandle,
    job: OwnedHandle,
    _desktop: super::desktop::Desktop,
    _app_container: app_container::AppContainer,
    stdin: Option<File>,
    stdout: Option<File>,
    stderr: Option<File>,
    closed: bool,
}

impl ash_sandboxing::SandboxProcess for WindowsProcess {
    fn take_stdin(&mut self) -> Option<Box<dyn io::Write + Send>> {
        self.stdin.take().map(|pipe| Box::new(pipe) as _)
    }
    fn take_stdout(&mut self) -> Option<Box<dyn io::Read + Send>> {
        self.stdout.take().map(|pipe| Box::new(pipe) as _)
    }
    fn take_stderr(&mut self) -> Option<Box<dyn io::Read + Send>> {
        self.stderr.take().map(|pipe| Box::new(pipe) as _)
    }
    fn try_wait(&mut self) -> io::Result<Option<ash_sandboxing::SandboxProcessExitStatus>> {
        // SAFETY: process handle remains owned throughout query and wait.
        unsafe {
            match WaitForSingleObject(raw(&self.process), 0) {
                WAIT_TIMEOUT => Ok(None),
                WAIT_OBJECT_0 => {
                    let mut code = 0;
                    checked(GetExitCodeProcess(raw(&self.process), &mut code))?;
                    Ok(Some(ash_sandboxing::SandboxProcessExitStatus::Code(
                        code as i32,
                    )))
                }
                _ => Err(io::Error::last_os_error()),
            }
        }
    }
    fn close(&mut self) -> io::Result<()> {
        if self.closed {
            return Ok(());
        }
        // SAFETY: job/process are exclusive owned handles. TerminateProcess also covers
        // failures before job assignment; there is no resumed child on those error paths.
        unsafe {
            checked(TerminateJobObject(raw(&self.job), 1))?;
            TerminateProcess(raw(&self.process), 1);
            if WaitForSingleObject(raw(&self.process), 5_000) != WAIT_OBJECT_0 {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "JavaScript process did not terminate",
                ));
            }
        }
        self.closed = true;
        Ok(())
    }
}

impl Drop for WindowsProcess {
    fn drop(&mut self) {
        let _ = ash_sandboxing::SandboxProcess::close(self);
    }
}

fn query(token: &OwnedHandle, class: TOKEN_INFORMATION_CLASS) -> io::Result<Vec<usize>> {
    let mut bytes = 0;
    // SAFETY: size query followed by an aligned buffer; owned query-only token stays live.
    unsafe {
        GetTokenInformation(token.as_raw_handle(), class, null_mut(), 0, &mut bytes);
        let mut data = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
        checked(GetTokenInformation(
            token.as_raw_handle(),
            class,
            data.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        ))?;
        Ok(data)
    }
}

pub fn finish_startup() -> io::Result<()> {
    // Validate while the trusted initial thread can still query its primary token.
    // Neither this query-only handle nor the startup impersonation token survives execution.
    unsafe {
        let mut token = null_mut();
        checked(OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_ADJUST_DEFAULT,
            &mut token,
        ))?;
        let token = OwnedHandle::from_raw_handle(token);
        let restricted = query(&token, TokenRestrictedSids)?;
        let groups = &*restricted.as_ptr().cast::<TOKEN_GROUPS>();
        if groups.GroupCount != 1
            || *GetSidSubAuthorityCount(groups.Groups[0].Sid) != 5
            || *GetSidSubAuthority(groups.Groups[0].Sid, 0) != 21
        {
            return Err(io::Error::other("missing execution restrictions"));
        }
        let integrity = query(&token, TokenIntegrityLevel)?;
        let label = &*integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>();
        if IsWellKnownSid(label.Label.Sid, WinLowLabelSid) == 0 {
            return Err(io::Error::other(
                "JavaScript host requires matching startup integrity",
            ));
        }
        let app_container = query(&token, TokenIsAppContainer)?;
        let capabilities = query(&token, TokenCapabilities)?;
        if *app_container.as_ptr().cast::<u32>() != 1
            || (*capabilities.as_ptr().cast::<TOKEN_GROUPS>()).GroupCount != 0
        {
            return Err(io::Error::other(
                "JavaScript host requires an AppContainer without capabilities",
            ));
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        checked(QueryInformationJobObject(
            null_mut(),
            JobObjectExtendedLimitInformation,
            (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&limits) as u32,
            null_mut(),
        ))?;
        let required = JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if limits.BasicLimitInformation.LimitFlags & required != required
            || limits.BasicLimitInformation.ActiveProcessLimit != 1
        {
            return Err(io::Error::other(
                "JavaScript host requires a single-process kill-on-close job",
            ));
        }
        let mut child_policy = 0u32;
        checked(GetProcessMitigationPolicy(
            GetCurrentProcess(),
            ProcessChildProcessPolicy,
            (&mut child_policy as *mut u32).cast(),
            size_of_val(&child_policy),
        ))?;
        if child_policy & 1 == 0 {
            return Err(io::Error::other(
                "JavaScript host requires child process creation to be disabled",
            ));
        }
        // A supervised, headless extension reports faults through the protocol. OS
        // crash dialogs would block retirement and surface test/extension failures
        // as modal product windows instead.
        windows_sys::Win32::System::Diagnostics::Debug::SetErrorMode(
            windows_sys::Win32::System::Diagnostics::Debug::SEM_FAILCRITICALERRORS
                | windows_sys::Win32::System::Diagnostics::Debug::SEM_NOGPFAULTERRORBOX
                | windows_sys::Win32::System::Diagnostics::Debug::SEM_NOOPENFILEERRORBOX,
        );
        // PROCESS_MITIGATION_SYSTEM_CALL_DISABLE_POLICY is one DWORD of flags.
        // DLL initialization may need the GUI subsystem. Disable it process-wide only
        // after trusted startup, before any third-party code. V8 JIT remains enabled.
        let mut mitigation = 1u32;
        checked(SetProcessMitigationPolicy(
            ProcessSystemCallDisablePolicy,
            (&mitigation as *const u32).cast(),
            size_of_val(&mitigation),
        ))?;
        checked(GetProcessMitigationPolicy(
            GetCurrentProcess(),
            ProcessSystemCallDisablePolicy,
            (&mut mitigation as *mut u32).cast(),
            size_of_val(&mitigation),
        ))?;
        if mitigation & 1 == 0 {
            return Err(io::Error::other(
                "JavaScript host requires Win32k calls to be disabled",
            ));
        }
        set_integrity(&token, WinUntrustedLabelSid)?;
        drop(token);
        checked(RevertToSelf())?;
    }
    Ok(())
}
