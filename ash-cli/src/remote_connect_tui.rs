use std::path::PathBuf;
use std::thread;
use std::time::Instant;

use ash_remote::RemoteDirPath;
use ash_remote::RemoteProfile;
use ash_remote::SshTarget;
use ash_remote_connections::RemoteConnectionFailureKind;

use super::RemoteConnectEntry;
use super::runtime;
use super::runtime::ReadyRemoteRuntime;
use crate::reconnect;
use crate::reconnect::Failure;

pub(super) fn run(
    ready: ReadyRemoteRuntime,
    ssh_executable: Option<PathBuf>,
    entry: RemoteConnectEntry,
) -> Result<(), String> {
    let mut profile = ready.profile;
    let mut session = ready.session;
    let mut recovery = match entry {
        RemoteConnectEntry::New => None,
        RemoteConnectEntry::Resume(recovery) => Some(recovery),
    };
    let mut drafts = None;
    let mut start_empty = false;
    loop {
        let mut options =
            ash_tui::TuiOptions::new(format!("Remote SSH: {}", profile.target().host().as_str()))
                .with_remote_dir(PathBuf::from(profile.target().dir().as_str()))
                .with_profile_root(
                    ash_utils_home_dir::find_ash_home().map_err(|error| error.to_string())?,
                );
        if let Some(state) = recovery.take() {
            options = options.with_recovery(state);
        }
        if let Some(state) = drafts.take() {
            options = options.with_drafts(state);
        }
        if start_empty {
            options = options.with_empty_start();
        }
        match ash_tui::run(session, options).map_err(|error| error.to_string())? {
            ash_tui::TuiExit::UserRequested | ash_tui::TuiExit::TerminationRequested => {
                return Ok(());
            }
            ash_tui::TuiExit::OpenWorkspace { path } => {
                let path = path.to_str().ok_or("remote worktree path is not UTF-8")?;
                let dir = RemoteDirPath::parse(path).map_err(|error| error.to_string())?;
                let target = SshTarget::new(profile.target().host().clone(), dir);
                let selected = RemoteProfile::new(target, profile.runtime().clone());
                let ready = runtime::reconnect_exact(&selected, ssh_executable.as_deref())
                    .map_err(|error| error.to_string())?;
                profile = ready.profile;
                session = ready.session;
                recovery = None;
                drafts = None;
                start_empty = true;
            }
            ash_tui::TuiExit::ConnectionLost {
                kind: ash_tui::TuiConnectionLossKind::Transport,
                recovery: next_recovery,
                drafts: next_drafts,
                reason,
            } => {
                eprintln!("Remote App Server disconnected: {reason}");
                session = reconnect(&profile, ssh_executable.as_deref(), &reason)
                    .map_err(|error| {
                        reconnect::recovery_error(
                            error,
                            &recovery_command(
                                &profile,
                                ssh_executable.as_deref(),
                                next_recovery.as_ref(),
                            ),
                        )
                    })?
                    .session;
                recovery = next_recovery;
                drafts = Some(next_drafts);
                start_empty = recovery.is_none() && start_empty;
            }
            ash_tui::TuiExit::ConnectionLost {
                kind,
                recovery,
                drafts: _,
                reason,
            } => {
                return Err(reconnect::recovery_error(
                    format!("Remote App Server recovery stopped after {kind:?}: {reason}"),
                    &recovery_command(&profile, ssh_executable.as_deref(), recovery.as_ref()),
                ));
            }
        }
    }
}

fn recovery_command(
    profile: &RemoteProfile,
    ssh_executable: Option<&std::path::Path>,
    recovery: Option<&ash_tui::TuiRecoveryState>,
) -> Vec<String> {
    let mut command = vec![
        "ash".into(),
        "remote".into(),
        "connect".into(),
        "--host".into(),
        profile.target().host().as_str().into(),
        "--dir".into(),
        profile.target().dir().as_str().into(),
        "--runtime".into(),
        profile.runtime().executable().into(),
    ];
    if let Some(ssh_executable) = ssh_executable {
        command.extend([
            "--ssh".into(),
            ssh_executable.to_string_lossy().into_owned(),
        ]);
    }
    if let Some(recovery) = recovery {
        command.extend([
            "--resume".into(),
            recovery.session_id().to_string(),
            recovery.thread_id().to_string(),
        ]);
    }
    command
}

fn reconnect(
    profile: &RemoteProfile,
    ssh_executable: Option<&std::path::Path>,
    initial_reason: &str,
) -> Result<ReadyRemoteRuntime, String> {
    let started = Instant::now();
    reconnect::retry(
        "Remote App Server",
        initial_reason,
        || match runtime::reconnect_exact(profile, ssh_executable) {
            Ok(ready) => Ok(ready),
            Err(error) if error.kind() == RemoteConnectionFailureKind::Transport => {
                Err(Failure::Retryable(error.to_string()))
            }
            Err(error) => Err(Failure::Terminal(format!(
                "Remote App Server reconnect stopped because the verified runtime changed or rejected the connection: {error}"
            ))),
        },
        thread::sleep,
        || started.elapsed(),
        |attempt, delay| {
            eprintln!(
                "Reconnecting to Remote App Server (attempt {attempt}, retrying in {} ms)...",
                delay.as_millis()
            )
        },
    )
}

#[cfg(test)]
#[path = "remote_connect_tui_tests.rs"]
mod tests;
