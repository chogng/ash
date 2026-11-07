use std::io::ErrorKind;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

use portable_pty::CommandBuilder;
use portable_pty::PtySize;
use portable_pty::native_pty_system;

use crate::process::ProcessRecord;
use crate::process::record_is_active;

const START_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_RECORDING: Duration = Duration::from_secs(600);
const STOP_TIMEOUT: Duration = Duration::from_secs(45);

/// A private PTY delivers Ctrl+C to Samply alone, including on Windows where
/// terminating the child would skip its ETW flush and profile export.
pub(crate) fn record(target: &ProcessRecord, profiler: &Path, output: &Path) -> Result<(), String> {
    if !profiler.is_absolute() || !profiler.is_file() || !output.is_absolute() {
        return Err("Profiling requires absolute executable and output paths".into());
    }
    match std::fs::symlink_metadata(output) {
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
        Ok(_) => return Err("The CPU profile staging file already exists".into()),
    }
    let mut command = CommandBuilder::new(profiler);
    command.env_clear();
    for name in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "TMPDIR",
        "SYSTEMROOT",
        "WINDIR",
        "SYSTEMDRIVE",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "PROGRAMW6432",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "LANG",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.args(["record", "--save-only", "--rate", "250", "--pid"]);
    command.arg(target.pid.to_string());
    command.arg("-o");
    command.arg(output);
    if let Some(directory) = output.parent() {
        command.cwd(directory);
    }
    let pair = native_pty_system()
        .openpty(PtySize::default())
        .map_err(|error| error.to_string())?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;
    if !record_is_active(target)? {
        return Err("The Local App Server exited before profiling could start".into());
    }
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    drop(pair.slave);

    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    thread::spawn(move || relay_profiler_output(reader, ready_tx));
    let stop_requested = Arc::new(AtomicBool::new(false));
    let retain_report = Arc::new(AtomicBool::new(false));
    let input_stop = stop_requested.clone();
    let input_retain = retain_report.clone();
    thread::spawn(move || {
        // Stop explicitly retains the report. EOF on Main exit or crash only shuts down the tool.
        let mut operation = [0];
        if std::io::stdin().read_exact(&mut operation).is_ok() && operation == *b"S" {
            input_retain.store(true, Ordering::Relaxed);
        }
        input_stop.store(true, Ordering::Release);
    });

    let result = (|| {
        let started = Instant::now();
        let mut ready_at = None;
        let mut stop_at = None;
        let mut control_closed = false;
        loop {
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                return if status.success() && ready_at.is_some() && output.is_file() {
                    Ok(())
                } else {
                    Err(format!("Samply exited without a CPU profile: {status}"))
                };
            }
            if ready_at.is_none() && ready_rx.try_recv().is_ok() {
                ready_at = Some(Instant::now());
                let mut stdout = std::io::stdout().lock();
                control_closed = writeln!(stdout, "ready")
                    .and_then(|()| stdout.flush())
                    .is_err();
            }
            if let Some(ready) = ready_at {
                if stop_at.is_none()
                    && (control_closed
                        || stop_requested.load(Ordering::Acquire)
                        || ready.elapsed() >= MAX_RECORDING
                        || !record_is_active(target).unwrap_or(false))
                {
                    writer
                        .write_all(b"\x03")
                        .and_then(|()| writer.flush())
                        .map_err(|error| error.to_string())?;
                    stop_at = Some(Instant::now());
                }
            } else if started.elapsed() >= START_TIMEOUT {
                return Err("Samply did not acknowledge that sampling started".into());
            }
            if stop_at.is_some_and(|stop| stop.elapsed() >= STOP_TIMEOUT) {
                return Err("Samply did not finish writing the CPU profile".into());
            }
            thread::sleep(Duration::from_millis(100));
        }
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if stop_requested.load(Ordering::Acquire) && !retain_report.load(Ordering::Relaxed) {
        let _ = std::fs::remove_file(output);
    }
    result
}

fn relay_profiler_output(mut reader: Box<dyn Read + Send>, ready: mpsc::SyncSender<()>) {
    let mut buffer = [0; 2048];
    let mut tail = Vec::new();
    let mut signalled = false;
    while let Ok(count @ 1..) = reader.read(&mut buffer) {
        let _ = std::io::stderr().write_all(&buffer[..count]);
        if signalled {
            continue;
        }
        tail.extend_from_slice(&buffer[..count]);
        // These are Samply's attach acknowledgements, emitted after its Ctrl+C handler is ready.
        let output = String::from_utf8_lossy(&tail).to_ascii_lowercase();
        if output.contains("press ctrl+c to stop")
            || output.contains("press ctrl-c to stop")
            || (output.contains("recording process with pid") && output.contains("until ctrl+c"))
        {
            let _ = ready.send(());
            signalled = true;
        }
        if tail.len() > 2048 {
            tail.drain(..tail.len() - 2048);
        }
    }
}
