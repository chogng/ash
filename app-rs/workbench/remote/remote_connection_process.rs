use std::io::BufRead;
use std::io::BufReader;
use std::path::Path;
use std::process::Child;
use std::process::Command;
use std::process::ExitStatus;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use ash_remote_connections::RemoteConnectionName;
use zui::app::AppProxy;

use crate::launch_progress::REMOTE_LAUNCH_PROGRESS_ENV;
use crate::launch_progress::RemoteLaunchProgressEvent;
use crate::workbench_event::WorkbenchEvent;

const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(100);
static NEXT_REMOTE_LAUNCH_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RemoteWindowLaunchUpdate {
    Progress(RemoteLaunchProgressEvent),
    Exited { success: bool, code: Option<i32> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RemoteWindowLaunchEvent {
    launch_id: u64,
    update: RemoteWindowLaunchUpdate,
}

impl RemoteWindowLaunchEvent {
    pub(crate) const fn launch_id(&self) -> u64 {
        self.launch_id
    }

    pub(crate) const fn update(&self) -> &RemoteWindowLaunchUpdate {
        &self.update
    }
}

/// Cancellable supervision handle retained only while a child prepares its Remote runtime.
///
/// Dropping this handle deliberately detaches from a ready child. Call [`Self::cancel`] before
/// dropping it when the launch has not reported readiness.
pub(crate) struct RemoteConnectionLaunch {
    launch_id: u64,
    child: Arc<Mutex<Option<Child>>>,
}

impl RemoteConnectionLaunch {
    pub(crate) const fn launch_id(&self) -> u64 {
        self.launch_id
    }

    pub(crate) fn cancel(&self) -> Result<(), String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "Remote child process state is unavailable".to_owned())?;
        if let Some(child) = child.as_mut() {
            child
                .kill()
                .map_err(|error| format!("could not cancel Remote window launch: {error}"))?;
        }
        Ok(())
    }
}

/// Starts a new app process without a shell and observes only its bounded launch progress.
pub(crate) fn launch_remote_connection(
    name: &RemoteConnectionName,
    event_proxy: AppProxy<WorkbenchEvent>,
) -> Result<RemoteConnectionLaunch, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("could not locate the running app executable: {error}"))?;
    launch_remote_connection_with_executable(&executable, name, event_proxy)
}

fn launch_remote_connection_with_executable(
    executable: &Path,
    name: &RemoteConnectionName,
    event_proxy: AppProxy<WorkbenchEvent>,
) -> Result<RemoteConnectionLaunch, String> {
    let launch_id = NEXT_REMOTE_LAUNCH_ID.fetch_add(1, Ordering::Relaxed);
    let mut child = remote_connection_command(executable, name)
        .spawn()
        .map_err(|error| format!("could not start a new app Remote window: {error}"))?;
    let progress = child.stdout.take().ok_or_else(|| {
        let _ = child.kill();
        let _ = child.wait();
        "new app Remote process has no progress stream".to_owned()
    })?;
    let child = Arc::new(Mutex::new(Some(child)));
    let reader_proxy = event_proxy.clone();
    let reader = std::thread::Builder::new()
        .name("app-remote-window-progress".into())
        .spawn(move || read_child_progress(launch_id, progress, &reader_proxy));
    let reader = match reader {
        Ok(reader) => reader,
        Err(error) => {
            terminate_child(&child);
            return Err(format!(
                "could not observe the new app Remote process: {error}"
            ));
        }
    };
    let reaper_child = Arc::clone(&child);
    let reaper = std::thread::Builder::new()
        .name("app-remote-window".into())
        .spawn(move || reap_child(launch_id, reaper_child, reader, &event_proxy));
    if let Err(error) = reaper {
        terminate_child(&child);
        return Err(format!(
            "could not supervise the new app Remote process: {error}"
        ));
    }
    Ok(RemoteConnectionLaunch { launch_id, child })
}

fn read_child_progress(
    launch_id: u64,
    progress_stream: impl std::io::Read,
    event_proxy: &AppProxy<WorkbenchEvent>,
) {
    for line in BufReader::new(progress_stream).lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                send_progress(
                    event_proxy,
                    launch_id,
                    RemoteLaunchProgressEvent::Failed(format!(
                        "could not read Remote launch progress: {error}"
                    )),
                );
                return;
            }
        };
        match RemoteLaunchProgressEvent::parse_wire(&line) {
            Ok(Some(progress)) => send_progress(event_proxy, launch_id, progress),
            Ok(None) => println!("{line}"),
            Err(error) => {
                eprintln!("invalid Remote launch progress: {error}");
                send_progress(
                    event_proxy,
                    launch_id,
                    RemoteLaunchProgressEvent::Failed(
                        "the Remote child returned invalid launch progress".into(),
                    ),
                );
                return;
            }
        }
    }
}

fn reap_child(
    launch_id: u64,
    child: Arc<Mutex<Option<Child>>>,
    progress_reader: std::thread::JoinHandle<()>,
    event_proxy: &AppProxy<WorkbenchEvent>,
) {
    loop {
        let status = match poll_child(&child) {
            Ok(status) => status,
            Err(error) => {
                send_progress(
                    event_proxy,
                    launch_id,
                    RemoteLaunchProgressEvent::Failed(error),
                );
                return;
            }
        };
        if let Some(status) = status {
            if progress_reader.join().is_err() {
                send_progress(
                    event_proxy,
                    launch_id,
                    RemoteLaunchProgressEvent::Failed(
                        "the Remote launch progress reader stopped unexpectedly".into(),
                    ),
                );
            }
            send_event(
                event_proxy,
                RemoteWindowLaunchEvent {
                    launch_id,
                    update: RemoteWindowLaunchUpdate::Exited {
                        success: status.success(),
                        code: status.code(),
                    },
                },
            );
            return;
        }
        std::thread::park_timeout(CHILD_POLL_INTERVAL);
    }
}

fn poll_child(child: &Arc<Mutex<Option<Child>>>) -> Result<Option<ExitStatus>, String> {
    let mut child = child
        .lock()
        .map_err(|_| "Remote child process state is unavailable".to_owned())?;
    let Some(process) = child.as_mut() else {
        return Ok(None);
    };
    match process.try_wait() {
        Ok(Some(status)) => {
            *child = None;
            Ok(Some(status))
        }
        Ok(None) => Ok(None),
        Err(error) => Err(format!("could not supervise Remote window launch: {error}")),
    }
}

fn send_progress(
    event_proxy: &AppProxy<WorkbenchEvent>,
    launch_id: u64,
    progress: RemoteLaunchProgressEvent,
) {
    send_event(
        event_proxy,
        RemoteWindowLaunchEvent {
            launch_id,
            update: RemoteWindowLaunchUpdate::Progress(progress),
        },
    );
}

fn send_event(event_proxy: &AppProxy<WorkbenchEvent>, event: RemoteWindowLaunchEvent) {
    let _ = event_proxy.send_event(WorkbenchEvent::RemoteWindowLaunch(event));
}

fn terminate_child(child: &Arc<Mutex<Option<Child>>>) {
    if let Ok(mut child) = child.lock()
        && let Some(mut child) = child.take()
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn remote_connection_command(executable: &Path, name: &RemoteConnectionName) -> Command {
    let mut command = Command::new(executable);
    command
        .arg("remote")
        .arg("connect")
        .arg(name.as_str())
        .env(REMOTE_LAUNCH_PROGRESS_ENV, "json-lines")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    command
}

#[cfg(test)]
#[path = "remote_connection_process_tests.rs"]
mod tests;
