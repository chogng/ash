//! Acceptance of the account backend through the shared command-session owner.
#![cfg(windows)]

#[path = "support/windows.rs"]
mod support;

use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_protocol::ProcessExitStatus;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_tool_executor::CommandExecutionAuthority;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandRequest;
use ash_tool_executor::CommandSessionCursor;
use ash_tool_executor::CommandSessionOptions;
use ash_tool_executor::CommandSessionOwner;
use ash_tool_executor::CommandSessionStart;
use ash_tool_executor::CommandSessionStatus;
use ash_utils_pty::TerminalSize;
use std::time::Duration;
use std::time::Instant;

#[test]
#[ignore = "requires explicitly provisioned Windows sandbox and ASH_TERMINAL_PROBE"]
fn protected_terminal_worker_and_descendants_close_on_every_terminal_end() {
    for end in [
        "exit",
        "interrupt",
        "cancel",
        "terminate",
        "drop",
        "timeout",
    ] {
        terminal_teardown(end);
    }
}

fn terminal_teardown(end: &str) {
    let root = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(root.path()).unwrap();
    let probe = dir.canonical_path().join("probe.exe");
    std::fs::copy(std::env::var_os("ASH_TERMINAL_PROBE").unwrap(), &probe).unwrap();
    let executor = support::executor(&dir, Duration::from_secs(20));
    let owner = CommandSessionOwner::new("terminal-client", "thread", "local");
    let cancellation = CancellationSource::new();
    let started = executor
        .start_session_scoped_with_network(
            CommandRequest {
                program: probe.display().to_string(),
                arguments: Vec::new(),
                working_directory: ".".into(),
                input: CommandInput::Open,
            },
            CommandExecutionAuthority::Sandboxed(support::sandbox_policy(
                FileSystemAccess::DirectoryWrite,
                NetworkAccess::Denied,
            )),
            &cancellation.token(),
            None,
            None,
            owner.clone(),
            CommandSessionOptions {
                execution_timeout: Duration::from_secs(if end == "timeout" { 8 } else { 20 }),
                wait_budget: Duration::from_millis(20),
                terminal: Some(TerminalSize { rows: 24, cols: 80 }),
            },
        )
        .unwrap();
    let CommandSessionStart::Running(initial) = started else {
        panic!("{started:?}")
    };
    let id = initial.session_id;
    let mut cursor = CommandSessionCursor {
        stdout: initial.stdout.next_cursor,
        stderr: initial.stderr.next_cursor,
    };
    let mut text = initial.stdout.text;
    let deadline = Instant::now() + Duration::from_secs(15);
    while !text.contains("worker-protected") {
        assert!(Instant::now() < deadline, "{end}: {text}");
        let update = executor
            .read_session(&owner, &id, cursor, Duration::from_millis(100))
            .unwrap();
        text.push_str(&update.stdout.text);
        assert_eq!(
            update.status,
            CommandSessionStatus::Running,
            "{end}: {update:?}; {text}"
        );
        cursor = CommandSessionCursor {
            stdout: update.stdout.next_cursor,
            stderr: update.stderr.next_cursor,
        };
    }
    let processes: Vec<u32> =
        serde_json::from_slice(&std::fs::read(root.path().join("processes.json")).unwrap())
            .unwrap();
    assert_eq!(processes.len(), 3);
    match end {
        "exit" => executor
            .write_session(&owner, &id, b"accepted\r\n".to_vec())
            .unwrap(),
        "interrupt" => executor.interrupt_session(&owner, &id).unwrap(),
        "cancel" => {
            cancellation.cancel();
        }
        "terminate" => executor.terminate_session(&owner, &id).unwrap(),
        "drop" => {
            drop(executor);
            assert_stopped(&processes);
            return;
        }
        "timeout" => (),
        _ => unreachable!(),
    }
    let completed = loop {
        assert!(
            Instant::now() < deadline,
            "{end}: output did not close: {text}"
        );
        let update = executor
            .read_session(&owner, &id, cursor, Duration::from_millis(100))
            .unwrap();
        text.push_str(&update.stdout.text);
        cursor = CommandSessionCursor {
            stdout: update.stdout.next_cursor,
            stderr: update.stderr.next_cursor,
        };
        if update.status != CommandSessionStatus::Running {
            break update;
        }
    };
    match end {
        "exit" => {
            assert_eq!(
                completed.status,
                CommandSessionStatus::Exited(ProcessExitStatus::Code(0)),
                "{text}"
            );
            assert!(text.contains("probe-complete"), "{text}");
        }
        "interrupt" => assert!(
            matches!(completed.status, CommandSessionStatus::Exited(_)),
            "{completed:?}"
        ),
        "cancel" => assert_eq!(completed.status, CommandSessionStatus::Cancelled),
        "terminate" => assert_eq!(completed.status, CommandSessionStatus::Terminated),
        "timeout" => assert_eq!(completed.status, CommandSessionStatus::TimedOut),
        _ => unreachable!(),
    }
    assert_stopped(&processes);
    executor.release_session(&owner, &id).unwrap();
}

fn assert_stopped(processes: &[u32]) {
    use windows_sys_061::Win32::Foundation::*;
    use windows_sys_061::Win32::Storage::FileSystem::SYNCHRONIZE;
    use windows_sys_061::Win32::System::Threading::*;
    for pid in processes {
        let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, *pid) };
        if handle.is_null() {
            assert_eq!(
                unsafe { GetLastError() },
                ERROR_INVALID_PARAMETER,
                "process {pid} state could not be checked"
            );
        } else {
            let waited = unsafe { WaitForSingleObject(handle, 5000) };
            unsafe {
                CloseHandle(handle);
            }
            assert_eq!(
                waited, WAIT_OBJECT_0,
                "process {pid} survived terminal teardown"
            );
        }
    }
}

#[test]
#[ignore = "requires explicitly provisioned Windows sandbox"]
fn account_terminal_keeps_input_resize_isolation_and_real_exit_status() {
    session_round_trip(Some(TerminalSize { rows: 24, cols: 80 }));
}

#[test]
#[ignore = "requires explicitly provisioned Windows sandbox"]
fn account_pipe_session_keeps_input_and_owner_isolation() {
    session_round_trip(None);
}

fn session_round_trip(terminal: Option<TerminalSize>) {
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let outside = root.path().join("outside");
    std::fs::write(&outside, "unchanged").unwrap();
    let dir = Dir::open_local(&work).unwrap();
    let executor = support::executor(&dir, Duration::from_secs(30));
    let owner = CommandSessionOwner::new("account-client", "thread", "local");
    let foreign = CommandSessionOwner::new("different-client", "thread", "local");
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         [Console]::WriteLine('redirected=' + [Console]::IsInputRedirected); \
         [Console]::WriteLine('session-ready'); \
         $line=[Console]::ReadLine(); \
         if (!([Console]::IsInputRedirected)) {{ [Console]::WriteLine('size=' + [Console]::WindowHeight + ',' + [Console]::WindowWidth) }}; \
         [Console]::WriteLine('answer=' + $line); \
         try {{ [IO.File]::WriteAllText('{}','bad'); exit 99 }} catch {{ }}; \
         [IO.File]::WriteAllText('inside',$line); exit 23",
        outside.display().to_string().replace('\'', "''")
    );
    let powershell = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let cancellation = CancellationSource::new();
    let started = executor
        .start_session_scoped_with_network(
            CommandRequest {
                program: powershell.display().to_string(),
                arguments: vec![
                    "-NoLogo".into(),
                    "-NoProfile".into(),
                    "-Command".into(),
                    script,
                ],
                working_directory: ".".into(),
                input: CommandInput::Open,
            },
            CommandExecutionAuthority::Sandboxed(support::sandbox_policy(
                FileSystemAccess::DirectoryWrite,
                NetworkAccess::Denied,
            )),
            &cancellation.token(),
            None,
            None,
            owner.clone(),
            CommandSessionOptions {
                execution_timeout: Duration::from_secs(30),
                wait_budget: Duration::from_millis(20),
                terminal,
            },
        )
        .unwrap();
    let CommandSessionStart::Running(initial) = started else {
        panic!("{started:?}")
    };
    let id = initial.session_id;
    let mut text = initial.stdout.text;
    let mut cursor = CommandSessionCursor {
        stdout: initial.stdout.next_cursor,
        stderr: initial.stderr.next_cursor,
    };
    let deadline = Instant::now() + Duration::from_secs(20);
    while !text.contains("session-ready") {
        assert!(
            Instant::now() < deadline,
            "terminal did not become ready: {text}"
        );
        let update = executor
            .read_session(&owner, &id, cursor, Duration::from_millis(100))
            .unwrap();
        assert_eq!(update.status, CommandSessionStatus::Running, "{update:?}");
        text.push_str(&update.stdout.text);
        cursor = CommandSessionCursor {
            stdout: update.stdout.next_cursor,
            stderr: update.stderr.next_cursor,
        };
    }
    assert!(
        executor
            .read_session(&foreign, &id, cursor, Duration::ZERO)
            .is_err()
    );
    assert!(
        executor
            .write_session(&foreign, &id, b"intruder\r\n".to_vec())
            .is_err()
    );
    if terminal.is_some() {
        assert!(text.contains("redirected=False"), "{text}");
        executor
            .resize_session(
                &owner,
                &id,
                TerminalSize {
                    rows: 40,
                    cols: 100,
                },
            )
            .unwrap();
        assert!(executor.close_session_input(&owner, &id).is_err());
    } else {
        assert!(text.contains("redirected=True"), "{text}");
    }
    executor
        .write_session(&owner, &id, b"accepted\n".to_vec())
        .unwrap();
    let completed = loop {
        assert!(Instant::now() < deadline, "terminal did not finish: {text}");
        let update = executor
            .read_session(&owner, &id, cursor, Duration::from_millis(100))
            .unwrap();
        text.push_str(&update.stdout.text);
        cursor = CommandSessionCursor {
            stdout: update.stdout.next_cursor,
            stderr: update.stderr.next_cursor,
        };
        assert!(update.stderr.text.is_empty(), "{update:?}");
        if update.status != CommandSessionStatus::Running {
            break update;
        }
    };
    assert_eq!(
        completed.status,
        CommandSessionStatus::Exited(ProcessExitStatus::Code(23)),
        "{text}"
    );
    assert!(text.contains("answer=accepted"), "{text}");
    if terminal.is_some() {
        assert!(text.contains("size=40,100"), "{text}");
    }
    assert_eq!(
        std::fs::read_to_string(work.join("inside")).unwrap(),
        "accepted"
    );
    assert_eq!(std::fs::read_to_string(outside).unwrap(), "unchanged");
    executor.release_session(&owner, &id).unwrap();
}
