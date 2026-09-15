// Licensed under the MIT License.
//! The trusted logon worker exits before the untrusted command is resumed.

use super::account::Account;
use super::win;
use super::win::Handle;
use super::win::Result;
use serde::Deserialize;
use serde::Serialize;
use std::fs::File;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::time::Duration;
use std::time::Instant;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::Pipes::*;
use windows_sys::Win32::System::Threading::*;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub(super) version: u32,
    pub(super) owner: String,
    pub(super) account: String,
    pub(super) capability: String,
    pub(super) command: String,
    pub(super) cwd: String,
    pub(super) environment: Vec<String>,
    pub(super) pipes: Option<[String; 3]>,
    pub(super) pseudoconsole: Option<usize>,
    pub(super) reply: std::path::PathBuf,
    pub(super) desktop: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    pid: u32,
    thread: u32,
    error: Option<String>,
}

pub(super) struct Child {
    pub(super) process: Handle,
    pub(super) pid: u32,
    pub(super) stdin: Box<dyn std::io::Write + Send>,
    pub(super) stdout: Box<dyn std::io::Read + Send>,
    pub(super) stderr: Option<Box<dyn std::io::Read + Send>>,
}

pub(super) struct Pipes {
    pub(super) names: [String; 3],
    handles: Vec<Handle>,
}

impl Pipes {
    pub(super) fn new(owner: &str, account: &str) -> Result<Self> {
        let sd = win::descriptor(&format!("D:P(A;;GA;;;{owner})(A;;GRGW;;;{account})"))?;
        let security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd.0,
            bInheritHandle: 0,
        };
        let prefix = format!(r"\\.\pipe\ash-windows-sandbox-{}", win::random_hex(16)?);
        let names = [
            format!("{prefix}-in"),
            format!("{prefix}-out"),
            format!("{prefix}-err"),
        ];
        let mut handles = Vec::new();
        for name in &names {
            let raw = unsafe {
                CreateNamedPipeW(
                    win::wide(name).as_ptr(),
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    65536,
                    65536,
                    0,
                    &security,
                )
            };
            handles.push(Handle::new(raw, "CreateNamedPipeW")?);
        }
        Ok(Self { names, handles })
    }

    pub(super) fn connect(&self, worker: HANDLE) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(15);
        for handle in &self.handles {
            loop {
                if unsafe { ConnectNamedPipe(handle.0, std::ptr::null_mut()) } != 0 {
                    break;
                }
                let error = unsafe { GetLastError() };
                if error == ERROR_PIPE_CONNECTED {
                    break;
                }
                if error != ERROR_PIPE_LISTENING && error != ERROR_NO_DATA {
                    return Err(win::error("ConnectNamedPipe"));
                }
                if Instant::now() >= deadline
                    || unsafe { WaitForSingleObject(worker, 0) } == WAIT_OBJECT_0
                {
                    return Err("the Ash logon worker did not connect its standard streams".into());
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            let mode = PIPE_READMODE_BYTE | PIPE_WAIT;
            if unsafe {
                SetNamedPipeHandleState(handle.0, &mode, std::ptr::null(), std::ptr::null())
            } == 0
            {
                return Err(win::error("SetNamedPipeHandleState"));
            }
        }
        Ok(())
    }

    pub(super) fn files(mut self) -> [File; 3] {
        std::array::from_fn(|_| {
            let handle = self.handles.remove(0);
            let file = unsafe { File::from_raw_handle(handle.0) };
            std::mem::forget(handle);
            file
        })
    }
}

pub(super) fn spawn(
    account: &Account,
    runner: &Path,
    directory: &Path,
    request: &Request,
    pipes: Option<Pipes>,
    terminal: Option<&mut ash_utils_pty::PreparedConPty>,
    job: &super::job::Job,
) -> Result<Child> {
    let input = directory.join("request.json");
    let arguments = [
        runner.to_string_lossy().into_owned(),
        "run".into(),
        input.to_string_lossy().into_owned(),
    ];
    let command = wxc_common::cmdline::cmdline_from_argv_for_context(
        &arguments,
        wxc_common::cmdline::CommandLineContext::WindowsCreateProcess,
    )
    .map_err(|error| error.to_string())?;
    let mut command = win::wide(command);
    let mut password = win::wide(&account.password);
    // As in Codex, the trusted logon worker uses the default logon desktop.
    // Only the restricted command is attached to the execution-owned desktop.
    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        ..unsafe { std::mem::zeroed() }
    };
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // The trusted bootstrap has no workspace-relative operations. LogonW's
    // service-side cwd checks cannot use our private pinned runtime directory;
    // use the OS-resolved system directory while keeping the command's own cwd.
    let worker_directory = wxc_common::system_dir::resolve_system_directory()
        .ok_or("could not resolve the Windows system directory")?;
    let started = unsafe {
        CreateProcessWithLogonW(
            win::wide(&account.name).as_ptr(),
            win::wide(".").as_ptr(),
            password.as_ptr(),
            0,
            win::wide(runner).as_ptr(),
            command.as_mut_ptr(),
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            std::ptr::null(),
            win::wide(&worker_directory).as_ptr(),
            &startup,
            &mut process,
        )
    };
    for value in &mut password {
        unsafe {
            std::ptr::write_volatile(value, 0);
        }
    }
    if started == 0 {
        return Err(format!(
            "{}; worker directory: '{}'",
            win::error("CreateProcessWithLogonW"),
            worker_directory.display()
        ));
    }
    let worker = Handle::new(process.hProcess, "logon worker process")?;
    let worker_thread = Handle::new(process.hThread, "logon worker thread")?;
    if let Err(error) = job.assign_process(worker.0) {
        unsafe {
            TerminateProcess(worker.0, 1);
        }
        return Err(error.to_string());
    }
    let mut worker_request = request.clone();
    if let Some(terminal) = terminal.as_ref() {
        let mut remote = std::ptr::null_mut();
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                terminal.pseudoconsole_handle().cast(),
                worker.0,
                &mut remote,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            return Err(win::error("DuplicateHandle(pseudoconsole)"));
        }
        worker_request.pseudoconsole = Some(remote as usize);
    }
    std::fs::write(
        &input,
        serde_json::to_vec(&worker_request).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if unsafe { ResumeThread(worker_thread.0) } == u32::MAX {
        return Err(win::error("ResumeThread(logon worker)"));
    }
    if let Some(pipes) = pipes.as_ref()
        && let Err(error) = pipes.connect(worker.0)
    {
        if unsafe { WaitForSingleObject(worker.0, 0) } == WAIT_OBJECT_0 {
            let mut code = 0;
            unsafe {
                GetExitCodeProcess(worker.0, &mut code);
            }
            if let Ok(bytes) = std::fs::read(&request.reply) {
                if let Ok(reply) = serde_json::from_slice::<Reply>(&bytes) {
                    if let Some(error) = reply.error {
                        return Err(error);
                    }
                }
            }
            return Err(format!("{error}; worker exit code: {code:#x}"));
        }
        return Err(error);
    }
    if unsafe { WaitForSingleObject(worker.0, 15000) } != WAIT_OBJECT_0 {
        return Err("Ash logon worker did not finish preparing the child".into());
    }
    let mut code = 0;
    if unsafe { GetExitCodeProcess(worker.0, &mut code) } == 0 {
        return Err(win::error("GetExitCodeProcess(logon worker)"));
    }
    let reply: Reply =
        serde_json::from_slice(&std::fs::read(&request.reply).map_err(|error| error.to_string())?)
            .map_err(|_| "invalid reply from Ash logon worker")?;
    if let Some(error) = reply.error {
        return Err(error);
    }
    if code != 0 {
        return Err("Ash logon worker failed".into());
    }
    let child = Handle::new(
        unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE,
                0,
                reply.pid,
            )
        },
        "OpenProcess(prepared child)",
    )?;
    let thread = Handle::new(
        unsafe {
            OpenThread(
                THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                0,
                reply.thread,
            )
        },
        "OpenThread(prepared child)",
    )?;
    if unsafe { GetProcessIdOfThread(thread.0) } != reply.pid {
        return Err("prepared thread does not belong to the expected child".into());
    }
    let mut in_job = 0;
    if unsafe { IsProcessInJob(child.0, job.handle_value() as HANDLE, &mut in_job) } == 0
        || in_job == 0
    {
        return Err("prepared child is not in the execution-owned job".into());
    }
    let mut raw_token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(child.0, TOKEN_QUERY, &mut raw_token) } == 0 {
        return Err(win::error("OpenProcessToken(prepared child)"));
    }
    let token = Handle::new(raw_token, "prepared child token")?;
    if win::token_user(token.0)? != account.sid || unsafe { IsTokenRestricted(token.0) } == 0 {
        return Err("prepared child does not have the expected restricted account identity".into());
    }
    verify_capability(token.0, &request.capability)?;
    // The bootstrap must initialize Windows libraries before preparing the
    // restricted child. Apply UI limits only after it exits, while the user
    // command is still suspended and cannot execute a single instruction.
    job.set_ui_limits().map_err(|error| error.to_string())?;
    std::fs::remove_file(&input).map_err(|error| error.to_string())?;
    std::fs::remove_file(&request.reply).map_err(|error| error.to_string())?;
    // The worker's unrestricted logon token is gone before user code starts.
    if unsafe { ResumeThread(thread.0) } != 1 {
        return Err("prepared child did not have exactly one suspension".into());
    }
    let (stdin, stdout, stderr) = match (pipes, terminal) {
        (Some(pipes), None) => {
            let [stdin, stdout, stderr] = pipes.files();
            (
                Box::new(stdin) as Box<dyn std::io::Write + Send>,
                Box::new(stdout) as Box<dyn std::io::Read + Send>,
                Some(Box::new(stderr) as Box<dyn std::io::Read + Send>),
            )
        }
        (None, Some(terminal)) => {
            terminal
                .client_attached()
                .map_err(|error| error.to_string())?;
            (
                terminal
                    .take_writer()
                    .ok_or("ConPTY input has already been taken")?,
                terminal
                    .take_reader()
                    .ok_or("ConPTY output has already been taken")?,
                None,
            )
        }
        _ => return Err("process stdio must use either pipes or ConPTY".into()),
    };
    Ok(Child {
        process: child,
        pid: reply.pid,
        stdin,
        stdout,
        stderr,
    })
}

fn verify_capability(token: HANDLE, expected: &str) -> Result<()> {
    let mut size = 0;
    unsafe {
        GetTokenInformation(
            token,
            TokenRestrictedSids,
            std::ptr::null_mut(),
            0,
            &mut size,
        );
    }
    if size == 0 {
        return Err(win::error("GetTokenInformation(TokenRestrictedSids)"));
    }
    let mut storage = vec![0u64; (size as usize + 7) / 8];
    if unsafe {
        GetTokenInformation(
            token,
            TokenRestrictedSids,
            storage.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(win::error("GetTokenInformation(TokenRestrictedSids)"));
    }
    let groups = unsafe { &*storage.as_ptr().cast::<TOKEN_GROUPS>() };
    if groups.GroupCount != 3 {
        return Err("prepared child does not have the exact execution capability".into());
    }
    let mut actual = unsafe { std::slice::from_raw_parts(groups.Groups.as_ptr(), 3) }
        .iter()
        .map(|group| win::sid_text(group.Sid))
        .collect::<Result<Vec<_>>>()?;
    let mut wanted = vec![
        expected.to_owned(),
        win::logon_sid(token)?,
        "S-1-1-0".to_owned(),
    ];
    actual.sort();
    wanted.sort();
    if actual != wanted {
        return Err("prepared child has unexpected restricting SIDs".into());
    }
    Ok(())
}

pub(super) fn run(path: &Path) -> Result<()> {
    let data = std::fs::read(path).map_err(|error| error.to_string())?;
    if data.len() > 1024 * 1024 {
        return Err("worker request exceeds 1 MiB".into());
    }
    let request: Request = serde_json::from_slice(&data).map_err(|_| "invalid worker request")?;
    if request.version != 4 || win::current_user()? != request.account {
        return Err("worker request identity or protocol mismatch".into());
    }
    if request.account == request.owner {
        return Err("the worker must use a dedicated account".into());
    }
    let desktop_suffix = request
        .desktop
        .strip_prefix("Winsta0\\AshExecution-")
        .ok_or("invalid execution desktop")?;
    if desktop_suffix.len() != 32
        || !desktop_suffix
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err("invalid execution desktop".into());
    }
    let result = prepare_child(&request);
    let reply = match result {
        Ok((process, thread, pid, tid)) => {
            let reply = Reply {
                pid,
                thread: tid,
                error: None,
            };
            if let Err(error) = std::fs::write(
                &request.reply,
                serde_json::to_vec(&reply).map_err(|error| error.to_string())?,
            ) {
                unsafe {
                    TerminateProcess(process.0, 1);
                }
                return Err(error.to_string());
            }
            drop((process, thread));
            return Ok(());
        }
        Err(error) => Reply {
            pid: 0,
            thread: 0,
            error: Some(error),
        },
    };
    std::fs::write(
        &request.reply,
        serde_json::to_vec(&reply).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Err("failed to prepare restricted child".into())
}

pub(super) fn restricted_token(owner: &str, account: &str, capability: &str) -> Result<Handle> {
    let sid = win::sid(capability)?;
    let mut base = std::ptr::null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE
                | TOKEN_QUERY
                | TOKEN_ASSIGN_PRIMARY
                | TOKEN_ADJUST_DEFAULT
                | TOKEN_ADJUST_PRIVILEGES
                | WRITE_DAC,
            &mut base,
        )
    } == 0
    {
        return Err(win::error("OpenProcessToken(worker)"));
    }
    let base = Handle::new(base, "worker token")?;
    let logon = win::sid(&win::logon_sid(base.0)?)?;
    let everyone = win::sid("S-1-1-0")?;
    let restricting = [
        SID_AND_ATTRIBUTES {
            Sid: sid.0,
            Attributes: 0,
        },
        SID_AND_ATTRIBUTES {
            Sid: logon.0,
            Attributes: 0,
        },
        SID_AND_ATTRIBUTES {
            Sid: everyone.0,
            Attributes: 0,
        },
    ];
    let mut restricted = std::ptr::null_mut();
    if unsafe {
        CreateRestrictedToken(
            base.0,
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
            restricting.len() as u32,
            restricting.as_ptr(),
            &mut restricted,
        )
    } == 0
    {
        return Err(win::error("CreateRestrictedToken"));
    }
    let token = Handle::new(restricted, "restricted token")?;
    let mut privilege = unsafe { std::mem::zeroed::<TOKEN_PRIVILEGES>() };
    privilege.PrivilegeCount = 1;
    if unsafe {
        LookupPrivilegeValueW(
            std::ptr::null(),
            win::wide("SeChangeNotifyPrivilege").as_ptr(),
            &mut privilege.Privileges[0].Luid,
        )
    } == 0
    {
        return Err(win::error("LookupPrivilegeValueW(SeChangeNotifyPrivilege)"));
    }
    privilege.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    if unsafe {
        AdjustTokenPrivileges(
            token.0,
            0,
            &privilege,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(win::error("AdjustTokenPrivileges(SeChangeNotifyPrivilege)"));
    }
    if unsafe { GetLastError() } == ERROR_NOT_ALL_ASSIGNED {
        return Err("the restricted token lacks SeChangeNotifyPrivilege".into());
    }
    let token_sd = win::descriptor(&format!(
        "D:P(A;;GA;;;SY)(A;;0x8;;;{})(A;;GA;;;{})(A;;GA;;;{})",
        owner, account, capability
    ))?;
    if unsafe { SetKernelObjectSecurity(token.0, DACL_SECURITY_INFORMATION, token_sd.0) } == 0 {
        return Err(win::error("SetKernelObjectSecurity(restricted token)"));
    }
    // Codex's capability + logon + Everyone token supports Windows CLR
    // private namespaces. Filesystem ACLs and the preflight audit implement the
    // account isolation contract; this token does not promise host-wide read-only.
    let default_sd = win::descriptor(&format!(
        "D:(A;;GA;;;WD)(A;;GA;;;{})(A;;GA;;;{})",
        win::logon_sid(base.0)?,
        capability
    ))?;
    let mut dacl = std::ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorDacl(default_sd.0, &mut present, &mut dacl, &mut defaulted) }
        == 0
        || present == 0
    {
        return Err(win::error("GetSecurityDescriptorDacl(default token ACL)"));
    }
    let token_dacl = TOKEN_DEFAULT_DACL { DefaultDacl: dacl };
    if unsafe {
        SetTokenInformation(
            token.0,
            TokenDefaultDacl,
            (&token_dacl as *const TOKEN_DEFAULT_DACL).cast(),
            size_of::<TOKEN_DEFAULT_DACL>() as u32,
        )
    } == 0
    {
        return Err(win::error("SetTokenInformation(TokenDefaultDacl)"));
    }
    Ok(token)
}

pub(super) fn prepare_child(request: &Request) -> Result<(Handle, Handle, u32, u32)> {
    let token = restricted_token(&request.owner, &request.account, &request.capability)?;
    let mut handles = Vec::new();
    if let Some(pipes) = &request.pipes {
        for (index, pipe) in pipes.iter().enumerate() {
            let access = if index == 0 {
                GENERIC_READ
            } else {
                GENERIC_WRITE
            };
            let handle = Handle::new(
                unsafe {
                    CreateFileW(
                        win::wide(pipe).as_ptr(),
                        access,
                        0,
                        std::ptr::null(),
                        OPEN_EXISTING,
                        0,
                        std::ptr::null_mut(),
                    )
                },
                "CreateFileW(standard stream)",
            )?;
            if unsafe { SetHandleInformation(handle.0, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) }
                == 0
            {
                return Err(win::error("SetHandleInformation"));
            }
            handles.push(handle);
        }
    }
    let inherited = (!handles.is_empty()).then(|| [handles[0].0, handles[1].0, handles[2].0]);
    if inherited.is_some() == request.pseudoconsole.is_some() {
        return Err("worker request must select exactly one standard-stream mode".into());
    }
    let mut size = 0;
    let attribute_count = 1;
    unsafe {
        InitializeProcThreadAttributeList(std::ptr::null_mut(), attribute_count, 0, &mut size);
    }
    let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
    let attributes = storage.as_mut_ptr().cast();
    if unsafe { InitializeProcThreadAttributeList(attributes, attribute_count, 0, &mut size) } == 0
    {
        return Err(win::error("InitializeProcThreadAttributeList"));
    }
    struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
    impl Drop for Attributes {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.0);
            }
        }
    }
    let _attributes = Attributes(attributes);
    if let Some(inherited) = inherited.as_ref() {
        if unsafe {
            UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inherited.as_ptr().cast_mut().cast(),
                size_of_val(inherited),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(win::error("UpdateProcThreadAttribute(handle list)"));
        }
    } else {
        let pseudoconsole = request
            .pseudoconsole
            .filter(|handle| *handle != 0)
            .ok_or("invalid pseudoconsole handle")? as HANDLE;
        if unsafe {
            UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                pseudoconsole,
                size_of::<HANDLE>(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(win::error("UpdateProcThreadAttribute(pseudoconsole)"));
        }
    }
    let mut environment = Vec::new();
    for entry in &request.environment {
        if entry.contains('\0') || !entry.contains('=') {
            return Err("invalid worker environment".into());
        }
        environment.extend(win::wide(entry));
    }
    environment.push(0);
    if environment.len() == 1 {
        environment.push(0);
    }
    let sd = win::descriptor(&format!(
        "D:P(A;;GA;;;SY)(A;;GA;;;{})(A;;GA;;;{})(A;;GA;;;{})",
        request.owner, request.account, request.capability
    ))?;
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    let mut desktop = win::wide(&request.desktop);
    let mut startup_info = STARTUPINFOW {
        cb: size_of::<STARTUPINFOEXW>() as u32,
        lpDesktop: desktop.as_mut_ptr(),
        ..unsafe { std::mem::zeroed() }
    };
    if let Some(inherited) = inherited {
        startup_info.dwFlags = STARTF_USESTDHANDLES;
        startup_info.hStdInput = inherited[0];
        startup_info.hStdOutput = inherited[1];
        startup_info.hStdError = inherited[2];
    } else {
        // A pseudoconsole child must not inherit our standard handles, or its
        // output follows them into this process's console instead of the ConPTY.
        startup_info.dwFlags = STARTF_USESTDHANDLES;
        startup_info.hStdInput = INVALID_HANDLE_VALUE;
        startup_info.hStdOutput = INVALID_HANDLE_VALUE;
        startup_info.hStdError = INVALID_HANDLE_VALUE;
    }
    let startup = STARTUPINFOEXW {
        StartupInfo: startup_info,
        lpAttributeList: attributes,
    };
    let mut command = win::wide(&request.command);
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // CREATE_NO_WINDOW suppresses the console handle itself, so a child
    // attached to a pseudoconsole must not carry it.
    let creation_flags = if inherited.is_some() {
        CREATE_SUSPENDED
            | CREATE_NO_WINDOW
            | CREATE_UNICODE_ENVIRONMENT
            | EXTENDED_STARTUPINFO_PRESENT
    } else {
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT
    };
    if unsafe {
        CreateProcessAsUserW(
            token.0,
            std::ptr::null(),
            command.as_mut_ptr(),
            &security,
            &security,
            i32::from(inherited.is_some()),
            creation_flags,
            environment.as_ptr().cast(),
            win::wide(&request.cwd).as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    } == 0
    {
        return Err(win::error("CreateProcessAsUserW"));
    }
    Ok((
        Handle::new(process.hProcess, "restricted child")?,
        Handle::new(process.hThread, "restricted child thread")?,
        process.dwProcessId,
        process.dwThreadId,
    ))
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;
