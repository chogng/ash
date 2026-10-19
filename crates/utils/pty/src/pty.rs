use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::AtomicBool;
#[cfg(not(unix))]
use std::time::Duration;

use anyhow::Result;
use portable_pty::CommandBuilder;
#[cfg(not(windows))]
use portable_pty::native_pty_system;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::process::ChildTerminator;
use crate::process::ProcessHandle;
use crate::process::ProcessSignal;
use crate::process::PtyHandles;
use crate::process::SpawnedProcess;
use crate::process::TerminalSize;
use crate::process::WaitTask;

/// Returns true when ConPTY support is available (Windows only).
#[cfg(windows)]
pub fn conpty_supported() -> bool {
    crate::win::conpty_supported()
}

/// Returns true when ConPTY support is available (non-Windows always true).
#[cfg(not(windows))]
pub fn conpty_supported() -> bool {
    true
}

struct PtyChildTerminator {
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    #[cfg(unix)]
    process_group_id: Option<u32>,
}

impl ChildTerminator for PtyChildTerminator {
    fn signal(&mut self, signal: ProcessSignal) -> std::io::Result<()> {
        #[cfg(unix)]
        if let Some(process_group_id) = self.process_group_id {
            return crate::process_group::signal_process_group_id(
                process_group_id as libc::pid_t,
                signal.unix_number(),
            )
            .map(|_| ());
        }
        Err(crate::process::unsupported_signal(signal))
    }

    fn kill(&mut self) -> std::io::Result<()> {
        #[cfg(unix)]
        if let Some(process_group_id) = self.process_group_id {
            // Match the pipe backend's hard-kill behavior so descendant
            // processes from interactive shells/REPLs do not survive shutdown.
            // Also try the direct child killer in case the cached PGID is stale.
            let process_group_kill_result =
                crate::process_group::kill_process_group(process_group_id);
            let child_kill_result = self.killer.kill();
            return match child_kill_result {
                Ok(()) => Ok(()),
                Err(err) if err.kind() == ErrorKind::NotFound => process_group_kill_result,
                Err(err) => process_group_kill_result.or(Err(err)),
            };
        }

        self.killer.kill()
    }
}

fn pty_system() -> Box<dyn portable_pty::PtySystem + Send> {
    #[cfg(windows)]
    {
        Box::new(crate::win::ConPtySystem::default())
    }

    #[cfg(not(windows))]
    {
        native_pty_system()
    }
}

/// Spawn a process attached to a PTY using the shared portable-pty backend.
pub async fn spawn_process<'a>(
    program: &str,
    args: impl Into<PtyArguments<'a>>,
    cwd: &Path,
    env: &HashMap<String, String>,
    arg0: &Option<String>,
    size: TerminalSize,
) -> Result<SpawnedProcess> {
    if program.is_empty() {
        anyhow::bail!("missing program for PTY spawn");
    }

    let args = args.into();
    if let PtyArguments::WindowsCommandLine(value) = args {
        anyhow::ensure!(cfg!(windows), "raw command lines require Windows");
        anyhow::ensure!(!value.contains('\0'), "raw command line contains NUL");
        anyhow::ensure!(
            value.encode_utf16().count() < 32767,
            "raw command line is too long"
        );
    }

    let pty_system = pty_system();
    let pair = pty_system.openpty(size.into())?;
    #[cfg(unix)]
    let io = crate::unix_io::PtyIo::new(
        pair.master
            .as_raw_fd()
            .ok_or_else(|| anyhow::anyhow!("PTY master has no file descriptor"))?,
    )?;

    let mut command_builder = CommandBuilder::new(arg0.as_ref().unwrap_or(&program.to_string()));
    command_builder.cwd(cwd);
    command_builder.env_clear();
    match args {
        PtyArguments::Argv(args) => command_builder.args(args),
        PtyArguments::WindowsCommandLine(args) => {
            #[cfg(windows)]
            command_builder.set_raw_args(args);
            #[cfg(not(windows))]
            {
                let _ = args;
                unreachable!("raw command lines were rejected before PTY allocation");
            }
        }
    }
    for (key, value) in env {
        command_builder.env(key, value);
    }

    let mut child = pair.slave.spawn_command(command_builder)?;
    let process_id = child.process_id();
    #[cfg(unix)]
    // portable-pty establishes the spawned PTY child as a new session leader on
    // Unix, so PID == PGID and we can reuse the pipe backend's process-group
    // hard-kill semantics for descendants.
    let process_group_id = process_id;
    let killer = child.clone_killer();

    let (writer_tx, writer_rx) = mpsc::channel::<Vec<u8>>(128);
    let (stdout_tx, stdout_rx) = mpsc::channel::<Vec<u8>>(128);
    let (_stderr_tx, stderr_rx) = mpsc::channel::<Vec<u8>>(1);
    #[cfg(unix)]
    let (reader_handle, writer_handle) = io.spawn(stdout_tx, writer_rx);
    #[cfg(not(unix))]
    let (reader_handle, writer_handle) = {
        let mut reader = pair.master.try_clone_reader()?;
        let reader_handle: JoinHandle<()> = tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 8_192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let _ = stdout_tx.blocking_send(buf[..n].to_vec());
                    }
                    Err(ref e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(ref e) if e.kind() == ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => break,
                }
            }
        });

        let mut writer_rx = writer_rx;
        let mut writer = pair.master.take_writer()?;
        let writer_handle: JoinHandle<()> = tokio::spawn(async move {
            #[cfg(windows)]
            let mut windows_input = crate::WindowsTtyInputNormalizer::default();
            while let Some(bytes) = writer_rx.recv().await {
                #[cfg(windows)]
                let bytes = windows_input.normalize(&bytes);
                use std::io::Write;
                let _ = writer.write_all(&bytes);
                let _ = writer.flush();
            }
        });
        (reader_handle, writer_handle)
    };

    let (exit_tx, exit_rx) = oneshot::channel::<i32>();
    let exit_status = Arc::new(AtomicBool::new(false));
    let wait_exit_status = Arc::clone(&exit_status);
    let exit_code = Arc::new(StdMutex::new(None));
    let wait_exit_code = Arc::clone(&exit_code);
    let wait_handle: JoinHandle<()> = tokio::task::spawn_blocking(move || {
        let code = match child.wait() {
            Ok(status) => status.exit_code() as i32,
            Err(_) => -1,
        };
        wait_exit_status.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut guard) = wait_exit_code.lock() {
            *guard = Some(code);
        }
        let _ = exit_tx.send(code);
    });

    let handles = PtyHandles {
        _slave: if cfg!(windows) {
            Some(pair.slave)
        } else {
            None
        },
        _master: pair.master,
    };

    let handle = ProcessHandle::new(
        process_id,
        writer_tx,
        Box::new(PtyChildTerminator {
            killer,
            #[cfg(unix)]
            process_group_id,
        }),
        reader_handle,
        Vec::new(),
        writer_handle,
        WaitTask::Child(wait_handle),
        exit_status,
        exit_code,
        Some(handles),
        /*resizer*/ None,
    );

    Ok(SpawnedProcess {
        session: handle,
        stdout_rx,
        stderr_rx,
        exit_rx,
    })
}

/// Borrowed process arguments; Windows command lines bypass argv quoting.
#[derive(Clone, Copy)]
pub enum PtyArguments<'a> {
    Argv(&'a [String]),
    WindowsCommandLine(&'a str),
}

impl<'a> From<&'a [String]> for PtyArguments<'a> {
    fn from(args: &'a [String]) -> Self {
        Self::Argv(args)
    }
}

impl<'a> From<&'a Vec<String>> for PtyArguments<'a> {
    fn from(args: &'a Vec<String>) -> Self {
        Self::Argv(args)
    }
}

impl<'a, const N: usize> From<&'a [String; N]> for PtyArguments<'a> {
    fn from(args: &'a [String; N]) -> Self {
        Self::Argv(args)
    }
}
