use std::collections::HashMap;
use std::path::Path;

#[cfg(unix)]
use crate::SpawnedProcess;
#[cfg(unix)]
use crate::TerminalSize;
use crate::spawn_pipe_process;
#[cfg(unix)]
use crate::spawn_pty_process;

#[cfg(unix)]
use super::collect_output_until_exit;
use super::combine_spawned_output;
#[cfg(unix)]
use super::find_python;
#[cfg(unix)]
use super::process_exists;
use super::shell_command;
#[cfg(unix)]
use super::wait_for_marker_pid;
#[cfg(unix)]
use super::wait_for_output_contains;

#[tokio::test]
async fn dropping_driver_cancels_its_exit_forwarder() -> anyhow::Result<()> {
    let (writer_tx, _writer_rx) = tokio::sync::mpsc::channel(1);
    let (_output_tx, output_rx) = tokio::sync::broadcast::channel(1);
    let (mut exit_tx, exit_rx) = tokio::sync::oneshot::channel();
    let spawned = crate::spawn_from_driver(crate::ProcessDriver {
        writer_tx,
        stdout_rx: output_rx,
        stderr_rx: None,
        exit_rx,
        terminator: None,
        writer_handle: None,
        resizer: None,
    });
    tokio::task::yield_now().await;
    drop(spawned);
    tokio::time::timeout(std::time::Duration::from_secs(2), exit_tx.closed()).await?;
    Ok(())
}

#[cfg(target_os = "macos")]
#[test]
fn descriptor_cleanup_covers_sparse_fds_above_a_lowered_limit() -> anyhow::Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::fd::FromRawFd;
    use std::os::fd::OwnedFd;
    use std::os::unix::process::CommandExt;

    let python =
        find_python().ok_or_else(|| anyhow::anyhow!("Python is required for FD validation"))?;
    let file = std::fs::File::open("/dev/null")?;
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == -1 {
        return Err(std::io::Error::last_os_error().into());
    }
    let high = limit.rlim_cur.min(4096) as i32 - 3;
    anyhow::ensure!(high > 64, "test requires at least 68 descriptors");
    let duplicate = |minimum: i32| -> anyhow::Result<OwnedFd> {
        let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, minimum) };
        if fd == -1 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    };
    let unwanted = duplicate(high)?;
    let preserved = duplicate(high + 1)?;
    let cloexec = duplicate(high + 2)?;
    if unsafe { libc::fcntl(cloexec.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
        return Err(std::io::Error::last_os_error().into());
    }
    let preserved_fd = preserved.as_raw_fd();
    let mut command = std::process::Command::new(python);
    command.args([
        "-c",
        "import errno, os, sys\nfor fd in map(int, sys.argv[1:3]):\n    try: os.fstat(fd)\n    except OSError as e: assert e.errno == errno.EBADF\n    else: raise AssertionError('unexpected inherited descriptor')\nassert os.read(int(sys.argv[3]), 1) == b''",
    ]);
    command.arg(unwanted.as_raw_fd().to_string());
    command.arg(cloexec.as_raw_fd().to_string());
    command.arg(preserved_fd.to_string());
    // Only the forked child's limit changes. Existing sparse descriptors survive
    // lowering RLIMIT_NOFILE and still need to be covered by the cleanup sweep.
    unsafe {
        command.pre_exec(move || {
            limit.rlim_cur = 64;
            if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            crate::pty::close_inherited_fds_except(&[preserved_fd])
        });
    }
    let output = command.output()?;
    anyhow::ensure!(
        output.status.success(),
        "descriptor validation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pipe_terminate_reaps_child() -> anyhow::Result<()> {
    let env_map: HashMap<String, String> = std::env::vars().collect();
    let command = if cfg!(windows) {
        "ping -n 60 127.0.0.1 > NUL"
    } else {
        "sleep 60"
    };
    let (program, args) = shell_command(command);
    let spawned = spawn_pipe_process(&program, &args, Path::new("."), &env_map, &None, &[]).await?;
    let (session, _output_rx, exit_rx) = combine_spawned_output(spawned);

    session.terminate();

    let exit_code = tokio::time::timeout(tokio::time::Duration::from_secs(5), exit_rx)
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for terminated child to be reaped"))?
        .map_err(|_| anyhow::anyhow!("child waiter was aborted before reaping"))?;
    assert_eq!(session.exit_code(), Some(exit_code));
    assert!(session.has_exited());

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pipe_drop_reaps_child() -> anyhow::Result<()> {
    let env_map: HashMap<String, String> = std::env::vars().collect();
    let command = if cfg!(windows) {
        "ping -n 60 127.0.0.1 > NUL"
    } else {
        "sleep 60"
    };
    let (program, args) = shell_command(command);
    let spawned = spawn_pipe_process(&program, &args, Path::new("."), &env_map, &None, &[]).await?;
    let (session, _output_rx, exit_rx) = combine_spawned_output(spawned);

    drop(session);

    tokio::time::timeout(tokio::time::Duration::from_secs(5), exit_rx)
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for dropped child to be reaped"))?
        .map_err(|_| anyhow::anyhow!("child waiter was aborted before reaping"))?;

    Ok(())
}

#[cfg(unix)]
enum PtyShutdown {
    Terminate,
    Drop,
}

#[cfg(unix)]
fn assert_pty_shutdown_with_detached_child(
    inherited_fds: &[i32],
    shutdown: PtyShutdown,
) -> anyhow::Result<()> {
    let Some(python) = find_python() else {
        eprintln!("python not found; skipping detached PTY shutdown test");
        return Ok(());
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let (session, child_pid) = runtime.block_on(async {
        let marker = "__ash_detached_pid:";
        // The detached child retains the slave descriptors but outlives the
        // original process group. Its alarm bounds a regressed runtime drop.
        let script = format!(
            r"import os, select, signal, time, tty
signal.alarm(10)
if os.fork() == 0:
    os.setsid()
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.alarm(10)
    tty.setraw(0)
    print('{marker}' + str(os.getpid()), flush=True)
    select.select([0], [], [])
    print('__ash_input_ready__', flush=True)
    time.sleep(10)
    os._exit(0)
time.sleep(10)
"
        );
        let env_map: HashMap<String, String> = std::env::vars().collect();
        let spawned = spawn_pty_process(
            &python,
            &["-c".to_string(), script],
            Path::new("."),
            &env_map,
            &None,
            TerminalSize::default(),
            inherited_fds,
        )
        .await?;
        let (session, mut output_rx, exit_rx) = combine_spawned_output(spawned);
        let child_pid = wait_for_marker_pid(&mut output_rx, marker, /*timeout_ms*/ 2_000).await?;
        let writer = session.writer_sender();
        writer.send(vec![b'x'; 1024 * 1024]).await?;
        writer.send(b"pending".to_vec()).await?;
        // The slave reports readable input without consuming it; the first write
        // exceeds terminal capacity, so the second chunk must remain queued.
        wait_for_output_contains(
            &mut output_rx,
            "__ash_input_ready__",
            /*timeout_ms*/ 2_000,
        )
        .await?;
        assert_eq!(writer.capacity(), writer.max_capacity() - 1);
        drop(writer);
        let session = match shutdown {
            PtyShutdown::Terminate => {
                session.terminate();
                Some(session)
            }
            PtyShutdown::Drop => {
                drop(session);
                None
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), exit_rx).await??;
        Ok::<_, anyhow::Error>((session, child_pid))
    })?;

    let started = std::time::Instant::now();
    drop(runtime);
    let elapsed = started.elapsed();
    let detached_child_alive = process_exists(child_pid)?;
    let _ = unsafe { libc::kill(child_pid, libc::SIGKILL) };
    drop(session);
    assert!(
        elapsed < std::time::Duration::from_secs(2),
        "runtime shutdown waited for detached PTY child: {elapsed:?}"
    );
    assert!(
        detached_child_alive,
        "detached child exited before runtime shutdown"
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn pty_spawn_without_io_driver_returns_error() -> anyhow::Result<()> {
    use std::os::fd::AsRawFd;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()?;
    let preserved_fd = std::fs::File::open("/dev/null")?;
    let env_map: HashMap<String, String> = std::env::vars().collect();
    let (program, args) = shell_command("true");
    for inherited_fds in [&[][..], &[preserved_fd.as_raw_fd()][..]] {
        let Err(error) = runtime.block_on(spawn_pty_process(
            &program,
            &args,
            Path::new("."),
            &env_map,
            &None,
            TerminalSize::default(),
            inherited_fds,
        )) else {
            anyhow::bail!("PTY spawn succeeded without a Tokio I/O driver");
        };
        assert_eq!(
            error.to_string(),
            "PTY I/O requires a Tokio runtime with I/O enabled"
        );
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn pty_terminate_allows_runtime_shutdown_with_detached_child() -> anyhow::Result<()> {
    assert_pty_shutdown_with_detached_child(&[], PtyShutdown::Terminate)
}

#[cfg(unix)]
#[test]
fn pty_drop_allows_runtime_shutdown_with_detached_child() -> anyhow::Result<()> {
    assert_pty_shutdown_with_detached_child(&[], PtyShutdown::Drop)
}

#[cfg(unix)]
#[test]
fn pty_preserving_fds_terminate_allows_runtime_shutdown_with_detached_child() -> anyhow::Result<()>
{
    use std::os::fd::AsRawFd;

    let preserved_fd = std::fs::File::open("/dev/null")?;
    assert_pty_shutdown_with_detached_child(&[preserved_fd.as_raw_fd()], PtyShutdown::Terminate)
}

#[cfg(unix)]
#[test]
fn pty_preserving_fds_drop_allows_runtime_shutdown_with_detached_child() -> anyhow::Result<()> {
    use std::os::fd::AsRawFd;

    let preserved_fd = std::fs::File::open("/dev/null")?;
    assert_pty_shutdown_with_detached_child(&[preserved_fd.as_raw_fd()], PtyShutdown::Drop)
}

#[cfg(unix)]
#[test]
fn pty_terminate_allows_runtime_shutdown_with_full_output_channel() -> anyhow::Result<()> {
    use std::os::fd::AsRawFd;

    let Some(python) = find_python() else {
        eprintln!("python not found; skipping PTY output backpressure test");
        return Ok(());
    };
    let preserved_fd = std::fs::File::open("/dev/null")?;
    for inherited_fds in [&[][..], &[preserved_fd.as_raw_fd()][..]] {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let (session, stdout_rx) = runtime.block_on(async {
            let env_map: HashMap<String, String> = std::env::vars().collect();
            let script =
                "import os, signal\nsignal.alarm(10)\nwhile True:\n    os.write(1, b'x' * 8192)\n";
            let SpawnedProcess {
                session,
                stdout_rx,
                exit_rx,
                ..
            } = spawn_pty_process(
                &python,
                &["-c".to_string(), script.to_string()],
                Path::new("."),
                &env_map,
                &None,
                TerminalSize::default(),
                inherited_fds,
            )
            .await?;
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while stdout_rx.len() < stdout_rx.max_capacity() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await?;
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            session.terminate();
            tokio::time::timeout(std::time::Duration::from_secs(2), exit_rx).await??;
            Ok::<_, anyhow::Error>((session, stdout_rx))
        })?;

        // Keep the receiver alive through runtime shutdown. An OS-thread
        // watchdog releases a regressed blocking_send without a Tokio timer.
        let (shutdown_tx, shutdown_rx) = std::sync::mpsc::channel();
        let receiver_guard = std::thread::spawn(move || {
            let _ = shutdown_rx.recv_timeout(std::time::Duration::from_secs(3));
            drop(stdout_rx);
        });
        let started = std::time::Instant::now();
        drop(runtime);
        let elapsed = started.elapsed();
        let _ = shutdown_tx.send(());
        receiver_guard
            .join()
            .map_err(|_| anyhow::anyhow!("output receiver watchdog panicked"))?;
        drop(session);
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "runtime shutdown waited on a full PTY output channel: {elapsed:?}"
        );
    }
    Ok(())
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_dropped_output_receiver_keeps_draining_child() -> anyhow::Result<()> {
    use std::os::fd::AsRawFd;

    let Some(python) = find_python() else {
        eprintln!("python not found; skipping PTY dropped output receiver test");
        return Ok(());
    };
    let preserved_fd = std::fs::File::open("/dev/null")?;
    let env_map: HashMap<String, String> = std::env::vars().collect();
    let script =
        "import signal, sys\nsignal.alarm(10)\nsys.stdout.buffer.write(b'x' * (4 * 1024 * 1024))";
    for inherited_fds in [&[][..], &[preserved_fd.as_raw_fd()][..]] {
        let SpawnedProcess {
            session: _session,
            stdout_rx,
            exit_rx,
            ..
        } = spawn_pty_process(
            &python,
            &["-c".to_string(), script.to_string()],
            Path::new("."),
            &env_map,
            &None,
            TerminalSize::default(),
            inherited_fds,
        )
        .await?;
        drop(stdout_rx);
        let code = tokio::time::timeout(std::time::Duration::from_secs(2), exit_rx).await??;
        assert_eq!(code, 0, "child should finish even when output is discarded");
    }
    Ok(())
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_close_stdin_preserves_large_input_and_delivers_eof() -> anyhow::Result<()> {
    let Some(python) = find_python() else {
        eprintln!("python not found; skipping PTY input backpressure and EOF test");
        return Ok(());
    };
    let script = r"import signal, sys, termios, time
signal.alarm(10)
attrs = termios.tcgetattr(0)
attrs[3] &= ~termios.ECHO
termios.tcsetattr(0, termios.TCSANOW, attrs)
print('__ready__', flush=True)
time.sleep(0.2)
data = sys.stdin.buffer.read()
# Closing the portable writer appends a newline before VEOF.
assert data == b'0123456789abcdefghijklmnopqrstuvwxyz\n' * 32768 + b'\n', len(data)
print('__complete__', flush=True)
";
    let env_map: HashMap<String, String> = std::env::vars().collect();
    let spawned = spawn_pty_process(
        &python,
        &["-c".to_string(), script.to_string()],
        Path::new("."),
        &env_map,
        &None,
        TerminalSize::default(),
        &[],
    )
    .await?;
    let (session, mut output_rx, exit_rx) = combine_spawned_output(spawned);
    wait_for_output_contains(&mut output_rx, "__ready__", /*timeout_ms*/ 2_000).await?;
    let writer = session.writer_sender();
    writer
        .send(b"0123456789abcdefghijklmnopqrstuvwxyz\n".repeat(32_768))
        .await?;
    drop(writer);
    session.close_stdin();

    let (output, code) = collect_output_until_exit(output_rx, exit_rx, /*timeout_ms*/ 5_000).await;
    assert_eq!(
        (code, String::from_utf8_lossy(&output).trim()),
        (0, "__complete__")
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn pty_terminate_reaps_child_when_waiter_is_queued() -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()?;
    let (blocker_started_tx, blocker_started_rx) = std::sync::mpsc::channel();
    let (release_blocker_tx, release_blocker_rx) = std::sync::mpsc::channel();
    // Keep the PTY's blocking child waiter queued until after termination.
    runtime.spawn_blocking(move || {
        let _ = blocker_started_tx.send(());
        let _ = release_blocker_rx.recv_timeout(std::time::Duration::from_secs(5));
    });
    blocker_started_rx.recv_timeout(std::time::Duration::from_secs(2))?;

    let pid_file = std::env::temp_dir().join(format!(
        "ash-pty-reap-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    runtime.block_on(async {
        let mut env_map: HashMap<String, String> = std::env::vars().collect();
        env_map.insert(
            "ASH_PTY_TEST_PID_FILE".to_string(),
            pid_file.display().to_string(),
        );
        let (program, args) =
            shell_command("printf '%s' \"$$\" > \"$ASH_PTY_TEST_PID_FILE\"; sleep 60");
        let spawned = spawn_pty_process(
            &program,
            &args,
            Path::new("."),
            &env_map,
            &None,
            TerminalSize::default(),
            &[],
        )
        .await?;
        let (session, _output_rx, exit_rx) = combine_spawned_output(spawned);

        let child_pid = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Ok(pid) = std::fs::read_to_string(&pid_file)
                    && let Ok(pid) = pid.parse::<libc::pid_t>()
                {
                    return pid;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for the PTY child PID"))?;
        std::fs::remove_file(&pid_file)?;

        session.terminate();
        drop(session);
        release_blocker_tx.send(())?;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), exit_rx)
            .await
            .map_err(|_| anyhow::anyhow!("timed out waiting for the PTY child waiter"))?;

        // A returned PID proves an exited child was still an unreaped zombie.
        let wait_result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let result =
                    unsafe { libc::waitpid(child_pid, std::ptr::null_mut(), libc::WNOHANG) };
                if result != 0 {
                    return result;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for the PTY child to exit"))?;
        let wait_error = std::io::Error::last_os_error();
        assert_eq!(
            wait_result, -1,
            "PTY child {child_pid} remained an unreaped zombie"
        );
        assert_eq!(wait_error.raw_os_error(), Some(libc::ECHILD));

        Ok(())
    })
}
