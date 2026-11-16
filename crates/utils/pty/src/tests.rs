use std::collections::HashMap;
use std::path::Path;

use pretty_assertions::assert_eq;

use crate::SpawnedProcess;
use crate::TerminalSize;
use crate::spawn_pty_process;

#[path = "lifecycle_tests.rs"]
mod lifecycle_tests;

#[cfg(windows)]
#[path = "windows_tests.rs"]
mod windows_tests;

pub(crate) fn find_python() -> Option<String> {
    for candidate in ["python3", "python"] {
        if let Ok(output) = std::process::Command::new(candidate)
            .arg("--version")
            .output()
            && output.status.success()
        {
            return Some(candidate.to_string());
        }
    }
    None
}

#[cfg(unix)]
fn shell_command(script: &str) -> (String, Vec<String>) {
    ("/bin/sh".into(), vec!["-c".into(), script.into()])
}

fn combine_spawned_output(
    spawned: SpawnedProcess,
) -> (
    crate::ProcessHandle,
    tokio::sync::broadcast::Receiver<Vec<u8>>,
    tokio::sync::oneshot::Receiver<i32>,
) {
    let SpawnedProcess {
        session,
        stdout_rx,
        stderr_rx,
        exit_rx,
    } = spawned;
    (
        session,
        combine_output_receivers(stdout_rx, stderr_rx),
        exit_rx,
    )
}

async fn collect_output_until_exit(
    mut output_rx: tokio::sync::broadcast::Receiver<Vec<u8>>,
    exit_rx: tokio::sync::oneshot::Receiver<i32>,
    timeout_ms: u64,
) -> (Vec<u8>, i32) {
    let mut collected = Vec::new();
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);
    tokio::pin!(exit_rx);

    loop {
        tokio::select! {
            res = output_rx.recv() => {
                if let Ok(chunk) = res {
                    collected.extend_from_slice(&chunk);
                }
            }
            res = &mut exit_rx => {
                let code = res.unwrap_or(-1);
                // On Windows (ConPTY in particular), it's possible to observe the exit notification
                // before the final bytes are drained from the PTY reader thread. Drain for a brief
                // "quiet" window to make output assertions deterministic.
                let (quiet_ms, max_ms) = if cfg!(windows) { (200, 2_000) } else { (50, 500) };
                let quiet = tokio::time::Duration::from_millis(quiet_ms);
                let max_deadline =
                    tokio::time::Instant::now() + tokio::time::Duration::from_millis(max_ms);
                while tokio::time::Instant::now() < max_deadline {
                    match tokio::time::timeout(quiet, output_rx.recv()).await {
                        Ok(Ok(chunk)) => collected.extend_from_slice(&chunk),
                        Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
                        Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break,
                        Err(_) => break,
                    }
                }
                return (collected, code);
            }
            _ = tokio::time::sleep_until(deadline) => {
                return (collected, -1);
            }
        }
    }
}

async fn wait_for_output_contains(
    output_rx: &mut tokio::sync::broadcast::Receiver<Vec<u8>>,
    needle: &str,
    timeout_ms: u64,
) -> anyhow::Result<Vec<u8>> {
    let mut collected = Vec::new();
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);

    while tokio::time::Instant::now() < deadline {
        let now = tokio::time::Instant::now();
        let remaining = deadline.saturating_duration_since(now);
        match tokio::time::timeout(remaining, output_rx.recv()).await {
            Ok(Ok(chunk)) => {
                collected.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&collected).contains(needle) {
                    return Ok(collected);
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                anyhow::bail!(
                    "PTY output closed while waiting for {needle:?}: {:?}",
                    String::from_utf8_lossy(&collected)
                );
            }
            Err(_) => break,
        }
    }

    anyhow::bail!(
        "timed out waiting for {needle:?} in PTY output: {:?}",
        String::from_utf8_lossy(&collected)
    );
}

async fn wait_for_python_repl_ready(
    output_rx: &mut tokio::sync::broadcast::Receiver<Vec<u8>>,
    timeout_ms: u64,
    ready_marker: &str,
) -> anyhow::Result<Vec<u8>> {
    let mut collected = Vec::new();
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);

    while tokio::time::Instant::now() < deadline {
        let now = tokio::time::Instant::now();
        let remaining = deadline.saturating_duration_since(now);
        match tokio::time::timeout(remaining, output_rx.recv()).await {
            Ok(Ok(chunk)) => {
                collected.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&collected).contains(ready_marker) {
                    return Ok(collected);
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                anyhow::bail!(
                    "PTY output closed while waiting for Python REPL readiness: {:?}",
                    String::from_utf8_lossy(&collected)
                );
            }
            Err(_) => break,
        }
    }

    anyhow::bail!(
        "timed out waiting for Python REPL readiness marker {ready_marker:?} in PTY: {:?}",
        String::from_utf8_lossy(&collected)
    );
}

#[cfg(unix)]
fn process_exists(pid: i32) -> anyhow::Result<bool> {
    let result = unsafe { libc::kill(pid, 0) };
    if result == 0 {
        return Ok(true);
    }

    let err = std::io::Error::last_os_error();
    match err.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(err.into()),
    }
}

#[cfg(unix)]
async fn wait_for_marker_pid(
    output_rx: &mut tokio::sync::broadcast::Receiver<Vec<u8>>,
    marker: &str,
    timeout_ms: u64,
) -> anyhow::Result<i32> {
    let mut collected = Vec::new();
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            anyhow::bail!(
                "timed out waiting for marker {marker:?} in PTY output: {:?}",
                String::from_utf8_lossy(&collected)
            );
        }

        let remaining = deadline.saturating_duration_since(now);
        let chunk = tokio::time::timeout(remaining, output_rx.recv())
            .await
            .map_err(|_| anyhow::anyhow!("timeout waiting for PTY output"))??;
        collected.extend_from_slice(&chunk);

        let text = String::from_utf8_lossy(&collected);
        let mut offset = 0;
        while let Some(pos) = text[offset..].find(marker) {
            let marker_start = offset + pos;
            let suffix = &text[marker_start + marker.len()..];
            let digits_len = suffix
                .chars()
                .take_while(char::is_ascii_digit)
                .map(char::len_utf8)
                .sum::<usize>();
            if digits_len == 0 {
                offset = marker_start + marker.len();
                continue;
            }

            let pid_str = &suffix[..digits_len];
            let trailing = &suffix[digits_len..];
            if trailing.is_empty() {
                break;
            }
            return Ok(pid_str.parse()?);
        }
    }
}

#[cfg(unix)]
async fn wait_for_process_exit(pid: i32, timeout_ms: u64) -> anyhow::Result<bool> {
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);
    loop {
        if !process_exists(pid)? {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_python_repl_emits_output_and_exits() -> anyhow::Result<()> {
    let Some(python) = find_python() else {
        eprintln!("python not found; skipping pty_python_repl_emits_output_and_exits");
        return Ok(());
    };

    let ready_marker = "__codex_pty_ready__";
    let args = vec![
        "-i".to_string(),
        "-q".to_string(),
        "-c".to_string(),
        format!("print('{ready_marker}')"),
    ];
    let env_map: HashMap<String, String> = std::env::vars().collect();
    let spawned = spawn_pty_process(
        &python,
        &args,
        Path::new("."),
        &env_map,
        &None,
        TerminalSize::default(),
    )
    .await?;
    let (session, mut output_rx, exit_rx) = combine_spawned_output(spawned);
    let writer = session.writer_sender();
    let newline = if cfg!(windows) { "\r\n" } else { "\n" };
    let startup_timeout_ms = if cfg!(windows) { 10_000 } else { 5_000 };
    let mut output =
        wait_for_python_repl_ready(&mut output_rx, startup_timeout_ms, ready_marker).await?;
    writer
        .send(format!("print('hello from pty'){newline}").into_bytes())
        .await?;
    writer.send(format!("exit(){newline}").into_bytes()).await?;

    let timeout_ms = if cfg!(windows) { 10_000 } else { 5_000 };
    let (remaining_output, code) = collect_output_until_exit(output_rx, exit_rx, timeout_ms).await;
    output.extend_from_slice(&remaining_output);
    let text = String::from_utf8_lossy(&output);

    assert!(
        text.contains("hello from pty"),
        "expected python output in PTY: {text:?}"
    );
    assert_eq!(code, 0, "expected python to exit cleanly");

    Ok(())
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_terminate_kills_background_children_in_same_process_group() -> anyhow::Result<()> {
    let env_map: HashMap<String, String> = std::env::vars().collect();
    let marker = "__codex_bg_pid:";
    let script = format!("sleep 1000 & bg=$!; echo {marker}$bg; wait");
    let (program, args) = shell_command(&script);
    let spawned = spawn_pty_process(
        &program,
        &args,
        Path::new("."),
        &env_map,
        &None,
        TerminalSize::default(),
    )
    .await?;
    let (session, mut output_rx, _exit_rx) = combine_spawned_output(spawned);

    let bg_pid = match wait_for_marker_pid(&mut output_rx, marker, /*timeout_ms*/ 2_000).await {
        Ok(pid) => pid,
        Err(err) => {
            session.terminate();
            return Err(err);
        }
    };
    assert!(
        process_exists(bg_pid)?,
        "expected background child pid {bg_pid} to exist before terminate"
    );

    session.terminate();

    let exited = wait_for_process_exit(bg_pid, /*timeout_ms*/ 3_000).await?;
    if !exited {
        let _ = unsafe { libc::kill(bg_pid, libc::SIGKILL) };
    }

    assert!(
        exited,
        "background child pid {bg_pid} survived PTY terminate()"
    );

    Ok(())
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_spawn_reports_exec_failures() -> anyhow::Result<()> {
    let env_map: HashMap<String, String> = std::env::vars().collect();
    let spawn_result = spawn_pty_process(
        "/definitely/missing/command",
        &[],
        Path::new("."),
        &env_map,
        &None,
        TerminalSize::default(),
    )
    .await;

    let err = match spawn_result {
        Ok(spawned) => {
            spawned.session.terminate();
            anyhow::bail!("missing executable unexpectedly spawned");
        }
        Err(err) => err,
    };
    let err_text = err.to_string();
    assert!(
        err_text.contains("No such file")
            || err_text.contains("not found")
            || err_text.contains("os error 2"),
        "expected spawn error for missing executable, got: {err_text}",
    );

    Ok(())
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_spawn_supports_resize() -> anyhow::Result<()> {
    let env_map: HashMap<String, String> = std::env::vars().collect();
    let script = "stty -echo; printf 'start:%s\\n' \"$(stty size)\"; IFS= read _line; printf 'after:%s\\n' \"$(stty size)\"";
    let spawned = spawn_pty_process(
        "/bin/sh",
        &["-c".to_string(), script.to_string()],
        Path::new("."),
        &env_map,
        &None,
        TerminalSize {
            rows: 31,
            cols: 101,
        },
    )
    .await?;

    let (session, mut output_rx, exit_rx) = combine_spawned_output(spawned);
    let writer = session.writer_sender();
    let mut output = wait_for_output_contains(
        &mut output_rx,
        "start:31 101\r\n",
        /*timeout_ms*/ 5_000,
    )
    .await?;

    session.resize(TerminalSize {
        rows: 45,
        cols: 132,
    })?;
    writer.send(b"go\n".to_vec()).await?;
    session.close_stdin();

    let (remaining_output, code) =
        collect_output_until_exit(output_rx, exit_rx, /*timeout_ms*/ 5_000).await;
    output.extend_from_slice(&remaining_output);
    let text = String::from_utf8_lossy(&output);
    let normalized = text.replace("\r\n", "\n");

    assert!(
        normalized.contains("after:45 132\n"),
        "expected resized PTY dimensions in output: {text:?}"
    );
    assert_eq!(code, 0, "expected shell to exit cleanly after resize");

    Ok(())
}

#[cfg(not(windows))]
#[tokio::test]
async fn raw_command_line_is_rejected_before_pty_spawn_on_non_windows() {
    let result = spawn_pty_process(
        "/definitely/missing/program",
        crate::PtyArguments::WindowsCommandLine("-c echo"),
        Path::new("."),
        &HashMap::new(),
        &None,
        TerminalSize::default(),
    )
    .await;
    match result {
        Ok(_) => panic!("raw command line was admitted"),
        Err(error) => assert!(error.to_string().contains("require Windows")),
    }
}

fn combine_output_receivers(
    mut stdout_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    mut stderr_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
) -> tokio::sync::broadcast::Receiver<Vec<u8>> {
    let (combined_tx, combined_rx) = tokio::sync::broadcast::channel(256);
    tokio::spawn(async move {
        let mut stdout_open = true;
        let mut stderr_open = true;

        loop {
            tokio::select! {
                stdout = stdout_rx.recv(), if stdout_open => match stdout {
                    Some(chunk) => {
                        let _ = combined_tx.send(chunk);
                    }
                    None => {
                        stdout_open = false;
                    }
                },
                stderr = stderr_rx.recv(), if stderr_open => match stderr {
                    Some(chunk) => {
                        let _ = combined_tx.send(chunk);
                    }
                    None => {
                        stderr_open = false;
                    }
                },
                else => break,
            }
        }
    });
    combined_rx
}
