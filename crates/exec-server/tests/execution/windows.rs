//! Windows acceptance through the product executable and authenticated RPC.

use super::Host;
use super::finish;
use super::read;
use exec_server::ExecClient;
use exec_server_protocol::ExecError;
use exec_server_protocol::ProcessInput;
use exec_server_protocol::ProcessRead;
use exec_server_protocol::ProcessSnapshot;
use exec_server_protocol::ProcessStart;
use exec_server_protocol::ProcessState;
use exec_server_protocol::Request;
use exec_server_protocol::Response;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use std::time::Instant;

fn powershell() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe")
}

fn command(id: &str, script: &str, input: ProcessInput) -> ProcessStart {
    ProcessStart {
        operation_id: id.into(),
        program: powershell().to_str().unwrap().into(),
        arguments: vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-Command".into(),
            script.into(),
        ],
        cwd: ".".into(),
        input,
        timeout_millis: 30_000,
    }
}

fn terminal() -> ProcessInput {
    ProcessInput::Terminal { rows: 24, cols: 80 }
}

fn until_output(client: &ExecClient, id: &str, marker: &str) -> ProcessSnapshot {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let snapshot = read(client, id);
        if snapshot.stdout.text.contains(marker) {
            return snapshot;
        }
        assert_eq!(snapshot.state, ProcessState::Running, "{snapshot:?}");
        assert!(Instant::now() < deadline, "missing {marker}: {snapshot:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn assert_drained(client: &ExecClient, snapshot: &ProcessSnapshot) {
    let Response::Process(after) = client
        .request(Request::ProcessRead(ProcessRead {
            operation_id: snapshot.operation_id.clone(),
            stdout_cursor: snapshot.stdout.next_cursor,
            stderr_cursor: snapshot.stderr.next_cursor,
            wait_millis: 0,
        }))
        .unwrap()
    else {
        panic!("expected process snapshot")
    };
    assert_eq!(after.state, snapshot.state);
    assert!(after.stdout.text.is_empty(), "{after:?}");
    assert!(after.stderr.text.is_empty(), "{after:?}");
    assert!(!after.stdout.gap && !after.stderr.gap, "{after:?}");
}

#[test]
#[ignore = "requires PSEC through the product RPC and ConPTY helper"]
fn psec_rpc_terminal_reconnect_preserves_execution_resize_and_exit_output() {
    let host = Host::start();
    let client = host.client();
    let start = command(
        "terminal-once",
        "$ErrorActionPreference='Stop'; \
         if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { exit 80 }; \
         [IO.File]::AppendAllText('count.txt','x'); [Console]::WriteLine('terminal-ready'); \
         $answer=[Console]::ReadLine(); \
         [Console]::WriteLine(('size={0}x{1}' -f [Console]::WindowWidth,[Console]::WindowHeight)); \
         [Console]::WriteLine(('answer='+$answer)); [Console]::Write('tail-complete'); exit 125",
        terminal(),
    );
    client
        .request(Request::ProcessStart(start.clone()))
        .unwrap();
    until_output(&client, &start.operation_id, "terminal-ready");
    drop(client);
    let client = host.client();
    // A replacement connection observes the original session; retrying the same identity
    // cannot write count.txt a second time or replace the terminal blocked on input.
    client
        .request(Request::ProcessStart(start.clone()))
        .unwrap();
    let mut different = start.clone();
    different.arguments.push("different-request".into());
    assert!(matches!(
        client.request(Request::ProcessStart(different)),
        Err(exec_server::Error::Remote(ExecError::Conflict))
    ));
    assert!(matches!(
        client.request(Request::ProcessResize {
            operation_id: start.operation_id.clone(),
            rows: 0,
            cols: 100,
        }),
        Err(exec_server::Error::Remote(ExecError::InvalidInput))
    ));
    client
        .request(Request::ProcessResize {
            operation_id: start.operation_id.clone(),
            rows: 40,
            cols: 100,
        })
        .unwrap();
    client
        .request(Request::ProcessWrite {
            operation_id: start.operation_id.clone(),
            bytes: b"hello\r".to_vec(),
        })
        .unwrap();
    let snapshot = finish(&client, &start.operation_id);
    assert_eq!(
        snapshot.state,
        ProcessState::Exited { code: Some(125) },
        "{snapshot:?}"
    );
    for expected in ["size=100x40", "answer=hello", "tail-complete"] {
        assert!(snapshot.stdout.text.contains(expected), "{snapshot:?}");
    }
    assert!(snapshot.stderr.text.is_empty(), "{snapshot:?}");
    assert_eq!(
        std::fs::read_to_string(host.root.path().join("count.txt")).unwrap(),
        "x"
    );
    assert_drained(&client, &snapshot);
    let retained = read(&client, &start.operation_id);
    assert_eq!(retained, snapshot);
}

#[test]
#[ignore = "requires PSEC through the product RPC with redirected streams"]
fn psec_rpc_pipe_preserves_stdin_stderr_and_exit_output() {
    let host = Host::start();
    let client = host.client();
    let start = command(
        "pipe-input",
        "$ErrorActionPreference='Stop'; \
         if (-not [Console]::IsInputRedirected -or -not [Console]::IsOutputRedirected) { exit 80 }; \
         [Console]::WriteLine('pipe-ready'); $answer=[Console]::ReadLine(); \
         [Console]::Error.WriteLine('stderr-complete'); \
         [Console]::WriteLine(('answer='+$answer)); [Console]::Write('tail-complete'); exit 23",
        ProcessInput::Open,
    );
    client
        .request(Request::ProcessStart(start.clone()))
        .unwrap();
    until_output(&client, &start.operation_id, "pipe-ready");
    drop(client);
    let client = host.client();
    client
        .request(Request::ProcessWrite {
            operation_id: start.operation_id.clone(),
            bytes: b"hello\n".to_vec(),
        })
        .unwrap();
    let snapshot = finish(&client, &start.operation_id);
    assert_eq!(
        snapshot.state,
        ProcessState::Exited { code: Some(23) },
        "{snapshot:?}"
    );
    assert!(
        snapshot.stdout.text.contains("answer=hello"),
        "{snapshot:?}"
    );
    assert!(
        snapshot.stdout.text.contains("tail-complete"),
        "{snapshot:?}"
    );
    assert_eq!(
        snapshot.stderr.text.trim(),
        "stderr-complete",
        "{snapshot:?}"
    );
    assert_drained(&client, &snapshot);
}

#[test]
#[ignore = "requires PSEC through the product RPC and ConPTY helper"]
fn psec_rpc_terminal_read_only_ceiling_blocks_writes() {
    let host = Host::with_access("read-only");
    let protected = host.root.path().join("protected.txt");
    std::fs::write(&protected, "original").unwrap();
    let client = host.client();
    let start = command(
        "read-only-terminal",
        "$ErrorActionPreference='Stop'; \
         if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { exit 80 }; \
         try { [IO.File]::WriteAllText('protected.txt','modified'); exit 81 } \
         catch { [Console]::WriteLine('write-denied') }; [Console]::Write('tail-complete'); exit 0",
        terminal(),
    );
    client
        .request(Request::ProcessStart(start.clone()))
        .unwrap();
    let snapshot = finish(&client, &start.operation_id);
    assert_eq!(
        snapshot.state,
        ProcessState::Exited { code: Some(0) },
        "{snapshot:?}"
    );
    assert!(
        snapshot.stdout.text.contains("write-denied"),
        "{snapshot:?}"
    );
    assert!(
        snapshot.stdout.text.contains("tail-complete"),
        "{snapshot:?}"
    );
    assert_eq!(std::fs::read_to_string(&protected).unwrap(), "original");
    assert_drained(&client, &snapshot);
}

#[test]
#[ignore = "requires PSEC through the product RPC and ConPTY helper"]
fn psec_rpc_terminal_cancellation_reaps_workload_and_descendants() {
    let host = Host::start();
    let client = host.client();
    let program = powershell().to_str().unwrap().replace('\'', "''");
    let start = command(
        "terminal-cancel",
        &format!(
            "$ErrorActionPreference='Stop'; \
             $child=Start-Process -FilePath '{program}' -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -NoNewWindow -PassThru; \
             [Console]::WriteLine(('workload-pid='+$PID)); [Console]::WriteLine(('descendant-pid='+$child.Id)); \
             [Console]::WriteLine('cancel-ready'); Start-Sleep -Seconds 60"
        ),
        terminal(),
    );
    client
        .request(Request::ProcessStart(start.clone()))
        .unwrap();
    let ready = until_output(&client, &start.operation_id, "cancel-ready");
    let workload = pid(&ready.stdout.text, "workload-pid=");
    let descendant = pid(&ready.stdout.text, "descendant-pid=");
    client
        .request(Request::ProcessCancel {
            operation_id: start.operation_id.clone(),
        })
        .unwrap();
    let snapshot = finish(&client, &start.operation_id);
    assert_eq!(snapshot.state, ProcessState::Cancelled, "{snapshot:?}");
    assert_drained(&client, &snapshot);
    assert_stopped(workload);
    assert_stopped(descendant);
}

#[test]
#[ignore = "requires a Windows host without PSEC support"]
fn rpc_strict_sandbox_refuses_missing_psec_before_execution() {
    let host = Host::start();
    let client = host.client();
    let start = command(
        "must-not-start",
        "[IO.File]::WriteAllText('started.txt','should-not-execute'); exit 0",
        terminal(),
    );
    client
        .request(Request::ProcessStart(start.clone()))
        .unwrap();
    let snapshot = finish(&client, &start.operation_id);
    assert!(
        matches!(snapshot.state, ProcessState::Failed { .. }),
        "{snapshot:?}"
    );
    assert!(!host.root.path().join("started.txt").exists());
    assert!(snapshot.stdout.text.is_empty(), "{snapshot:?}");
}

fn pid(output: &str, prefix: &str) -> u32 {
    // ConPTY can prepend cursor controls to lines containing process identities.
    output
        .split_once(prefix)
        .unwrap()
        .1
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap()
}

fn assert_stopped(pid: u32) {
    let output = Command::new(powershell()).args(["-NoProfile", "-Command", &format!(
        "$ErrorActionPreference='Stop'; $p=Get-Process -Id {pid} -ErrorAction SilentlyContinue; \
         if ($null -eq $p) {{ exit 0 }}; if ($p.WaitForExit(30000)) {{ exit 0 }}; exit 1"
    )]).output().unwrap();
    assert!(
        output.status.success(),
        "process {pid} survived RPC cancellation: {output:?}"
    );
}
