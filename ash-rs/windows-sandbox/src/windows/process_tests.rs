use super::*;
use std::io::Read;

#[test]
fn audited_world_writable_files_are_denied_by_the_execution_acl() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("outside-scope");
    std::fs::write(&path, "unchanged").unwrap();
    let owner = win::current_user().unwrap();
    let sd = win::descriptor(&format!("D:P(A;;GA;;;{owner})(A;;GA;;;WD)")).unwrap();
    assert_ne!(
        unsafe {
            SetFileSecurityW(
                win::wide(&path).as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                sd.0,
            )
        },
        0
    );
    assert!(super::super::audit::world_writable(&path).unwrap());
    let mut acl =
        wxc_common::filesystem_dacl::DaclManager::in_directory(&temp.path().join("journal"))
            .unwrap();
    acl.deny_write_access("S-1-5-21-411-412-413-414", std::slice::from_ref(&path))
        .unwrap();
    let token = restricted_token(&owner, &owner, "S-1-5-21-411-412-413-414").unwrap();
    assert_ne!(unsafe { ImpersonateLoggedOnUser(token.0) }, 0);
    struct Revert;
    impl Drop for Revert {
        fn drop(&mut self) {
            if unsafe { RevertToSelf() } == 0 {
                std::process::abort();
            }
        }
    }
    let revert = Revert;
    let result = std::fs::OpenOptions::new().write(true).open(&path);
    drop(revert);
    assert_eq!(
        result.unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "unchanged");
    acl.restore_strict().unwrap();
}

#[test]
#[ignore = "requires explicitly provisioned Ash accounts"]
fn provisioned_logon_starts_windows_libraries() {
    let lease = super::super::runtime::lease(super::super::account::NetworkMode::Denied).unwrap();
    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        ..unsafe { std::mem::zeroed() }
    };
    let system = std::env::var("SystemRoot").unwrap();
    let executable = format!("{system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let mut command = win::wide(format!(
        "\"{executable}\" -NoProfile -NonInteractive -Command exit 0"
    ));
    let mut password = win::wide(&lease.account.password);
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let result = unsafe {
        CreateProcessWithLogonW(
            win::wide(&lease.account.name).as_ptr(),
            win::wide(".").as_ptr(),
            password.as_ptr(),
            0,
            win::wide(&executable).as_ptr(),
            command.as_mut_ptr(),
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            std::ptr::null(),
            win::wide(&system).as_ptr(),
            &startup,
            &mut info,
        )
    };
    for value in &mut password {
        unsafe {
            std::ptr::write_volatile(value, 0);
        }
    }
    assert_ne!(
        result,
        0,
        "{}",
        win::error("CreateProcessWithLogonW(system directory)")
    );
    let process = Handle::new(info.hProcess, "test logon child").unwrap();
    let thread = Handle::new(info.hThread, "test logon thread").unwrap();
    let job = super::super::job::Job::new(&win::random_hex(16).unwrap()).unwrap();
    if let Err(error) = job.assign_process(process.0) {
        unsafe {
            TerminateProcess(process.0, 1);
        }
        panic!("{error}");
    }
    assert_eq!(unsafe { ResumeThread(thread.0) }, 1);
    assert_eq!(
        unsafe { WaitForSingleObject(process.0, 10000) },
        WAIT_OBJECT_0
    );
    let mut code = 0;
    assert_ne!(unsafe { GetExitCodeProcess(process.0, &mut code) }, 0);
    assert_eq!(code, 0);
}

#[test]
#[ignore = "requires explicitly provisioned Ash accounts"]
fn provisioned_account_can_read_bootstrap_and_working_directories() {
    let lease = super::super::runtime::lease(super::super::account::NetworkMode::Denied).unwrap();
    let directory = super::super::Directory::new(
        &lease.root,
        &win::current_user().unwrap(),
        &lease.account.sid,
        "S-1-5-21-811-812-813-814",
    )
    .unwrap();
    let mut password = win::wide(&lease.account.password);
    let mut raw = std::ptr::null_mut();
    let result = unsafe {
        LogonUserW(
            win::wide(&lease.account.name).as_ptr(),
            win::wide(".").as_ptr(),
            password.as_ptr(),
            LOGON32_LOGON_INTERACTIVE,
            LOGON32_PROVIDER_DEFAULT,
            &mut raw,
        )
    };
    for value in &mut password {
        unsafe {
            std::ptr::write_volatile(value, 0);
        }
    }
    assert_ne!(result, 0, "{}", win::error("LogonUserW"));
    let token = Handle::new(raw, "test logon token").unwrap();
    assert_eq!(win::token_user(token.0).unwrap(), lease.account.sid);
    struct Revert;
    impl Drop for Revert {
        fn drop(&mut self) {
            assert_ne!(unsafe { RevertToSelf() }, 0);
        }
    }
    assert_ne!(
        unsafe { ImpersonateLoggedOnUser(token.0) },
        0,
        "{}",
        win::error("ImpersonateLoggedOnUser")
    );
    let _revert = Revert;
    std::fs::metadata(&lease.runner).expect("sandbox user can read bootstrap executable metadata");
    std::fs::File::open(&lease.runner)
        .expect("sandbox user can read bootstrap executable contents");
    assert!(
        std::fs::OpenOptions::new()
            .write(true)
            .open(&lease.runner)
            .is_err(),
        "sandbox user must not modify the trusted bootstrap"
    );
    assert!(
        std::fs::File::open(lease.root.join("state.dpapi")).is_err(),
        "sandbox user must not read the credential journal"
    );
    assert!(
        std::fs::File::open(lease.root.join("lease-1")).is_err(),
        "sandbox user must not read or acquire host leases"
    );
    std::fs::read_dir(lease.runner.parent().unwrap())
        .expect("sandbox user can list bootstrap directory");
    std::fs::read_dir(&directory.0).expect("sandbox user can list its execution directory");
}

#[test]
fn restricted_child_uses_private_desktop_pipes_and_preserves_exit_code() {
    let system = std::env::var("SystemRoot").unwrap();
    check_child(format!(
        "\"{system}\\System32\\cmd.exe\" /d /c \"echo child-ready & exit /b 125\""
    ));
}

#[test]
fn powershell_initializes_and_runs_a_pipeline_with_the_restricted_token() {
    let system = std::env::var("SystemRoot").unwrap();
    check_child(format!(
        "\"{system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoLogo -NoProfile -NonInteractive -Command \"'child-ready' | ForEach-Object {{ Write-Output $_ }}; exit 125\""
    ));
}

#[test]
fn restricted_child_drains_stdout_and_stderr_beyond_pipe_capacity() {
    let system = std::env::var("SystemRoot").unwrap();
    // Each stream exceeds the 64 KiB pipe buffer before the child exits.
    let (output, errors) = check_child(format!(
        "\"{system}\\System32\\cmd.exe\" /d /c \"(for /l %i in (1,1,10000) do @echo output-line) & (for /l %i in (1,1,10000) do @echo error-line 1>&2) & echo child-ready & exit /b 125\""
    ));
    assert_eq!(output.matches("output-line").count(), 10000);
    assert_eq!(errors.matches("error-line").count(), 10000);
}

#[test]
fn restricted_child_attaches_to_execution_owned_conpty() {
    let temp = tempfile::tempdir().unwrap();
    let directory = std::fs::canonicalize(temp.path()).unwrap();
    let _directory_pin = super::super::filesystem::pin(&directory).unwrap();
    let owner = win::current_user().unwrap();
    let capability = "S-1-5-21-611-612-613-614";
    let desktop = super::super::desktop::Desktop::new(&owner, &owner, capability).unwrap();
    let system = std::env::var("SystemRoot").unwrap();
    let mut terminal =
        ash_utils_pty::PreparedConPty::new(ash_utils_pty::TerminalSize { rows: 24, cols: 80 })
            .unwrap();
    terminal
        .resize(ash_utils_pty::TerminalSize {
            rows: 30,
            cols: 100,
        })
        .unwrap();
    let request = Request {
        version: 4,
        owner: owner.clone(),
        account: owner,
        capability: capability.into(),
        // The ping keeps the client alive long enough for the ConPTY renderer
        // to flush the echoed line before the pseudoconsole is closed.
        command: format!(
            "\"{system}\\System32\\cmd.exe\" /d /c \"echo pty-ready & ping -n 3 127.0.0.1 > NUL\""
        ),
        cwd: temp.path().to_str().unwrap().into(),
        environment: vec![
            format!("SystemRoot={system}"),
            format!("PATH={system}\\System32"),
        ],
        pipes: None,
        pseudoconsole: Some(terminal.pseudoconsole_handle() as usize),
        reply: directory.join("unused-reply.json"),
        desktop: desktop.name.clone(),
    };
    let (process, thread, _, _) = prepare_child(&request).unwrap();
    let job = super::super::job::Job::new(&win::random_hex(16).unwrap()).unwrap();
    job.assign_process(process.0).unwrap();
    job.set_ui_limits().unwrap();
    let writer = terminal.take_writer().unwrap();
    let reader = terminal.take_reader().unwrap();
    // ConPTY renders asynchronously, so output must be drained while the
    // child runs instead of after the pseudoconsole is closed.
    let drained = std::thread::spawn(move || {
        let mut reader = reader;
        let mut output = Vec::new();
        reader.read_to_end(&mut output).unwrap();
        output
    });
    assert_eq!(unsafe { ResumeThread(thread.0) }, 1);
    assert_eq!(
        unsafe { WaitForSingleObject(process.0, 10000) },
        WAIT_OBJECT_0
    );
    let mut exit_code = 0;
    assert_ne!(unsafe { GetExitCodeProcess(process.0, &mut exit_code) }, 0);
    drop(writer);
    drop(terminal);
    let output = drained.join().unwrap();
    assert!(
        String::from_utf8_lossy(&output).contains("pty-ready"),
        "ConPTY exit={exit_code:#x}, output: {:?}",
        String::from_utf8_lossy(&output)
    );
}

fn check_child(command: String) -> (String, String) {
    // Exercises the actual child-creation path under the current ordinary user.
    // Dedicated-account logon and network enforcement are separate acceptance.
    let temp = tempfile::tempdir().unwrap();
    let directory = std::fs::canonicalize(temp.path()).unwrap();
    let _directory_pin = super::super::filesystem::pin(&directory).unwrap();
    let owner = win::current_user().unwrap();
    let capability = "S-1-5-21-511-512-513-514";
    let desktop = super::super::desktop::Desktop::new(&owner, &owner, capability).unwrap();
    let pipes = Pipes::new(&owner, &owner).unwrap();
    let system = std::env::var("SystemRoot").unwrap();
    let request = Request {
        version: 4,
        owner: owner.clone(),
        account: owner,
        capability: capability.into(),
        command,
        cwd: directory.to_str().unwrap().into(),
        environment: vec![
            format!("SystemRoot={system}"),
            format!("TEMP={}", directory.display()),
            // This workload uses only the Windows PowerShell system modules.
            // Keep command discovery independent of modules installed on the host.
            format!("PSModulePath={system}\\System32\\WindowsPowerShell\\v1.0\\Modules"),
        ],
        pipes: Some(pipes.names.clone()),
        pseudoconsole: None,
        reply: directory.join("unused-reply.json"),
        desktop: desktop.name.clone(),
    };
    let (process, thread, _, _) = prepare_child(&request).unwrap();
    struct Cleanup(HANDLE);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            unsafe {
                TerminateProcess(self.0, 1);
                WaitForSingleObject(self.0, 5000);
            }
        }
    }
    let _cleanup = Cleanup(process.0);
    let job = super::super::job::Job::new(&win::random_hex(16).unwrap()).unwrap();
    job.assign_process(process.0).unwrap();
    job.set_ui_limits().unwrap();
    pipes.connect(unsafe { GetCurrentProcess() }).unwrap();
    let [stdin, stdout, stderr] = pipes.files();
    drop(stdin);
    // Drain both streams while the child runs; waiting for exit first can
    // block the child on a full pipe and turn output into a false timeout.
    let [stdout, stderr] = [stdout, stderr].map(|mut stream| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).unwrap();
            bytes
        })
    });
    assert_eq!(unsafe { ResumeThread(thread.0) }, 1);
    const TIMEOUT_MS: u32 = 10_000;
    let wait = unsafe { WaitForSingleObject(process.0, TIMEOUT_MS) };
    if wait != WAIT_OBJECT_0 {
        // Close every child-side pipe before joining readers so timeout
        // diagnostics include captured output without hanging teardown.
        job.terminate_and_wait(1).unwrap();
    }
    let mut code = 0;
    assert_ne!(unsafe { GetExitCodeProcess(process.0, &mut code) }, 0);
    let output = String::from_utf8_lossy(&stdout.join().unwrap()).into_owned();
    let errors = String::from_utf8_lossy(&stderr.join().unwrap()).into_owned();
    assert_eq!(
        wait, WAIT_OBJECT_0,
        "child did not exit within {TIMEOUT_MS} ms: {}\nstdout:\n{output}\nstderr:\n{errors}",
        request.command
    );
    assert_eq!(code, 125, "{output}\n{errors}");
    assert!(output.contains("child-ready"), "{output}\n{errors}");
    (output, errors)
}
