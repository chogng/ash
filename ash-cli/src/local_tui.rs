use std::env;
use std::io::IsTerminal;
use std::path::PathBuf;
use std::thread;
use std::time::Instant;

use ash_app_server_client::AppServerSession;
use ash_app_server_client::ClientError;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_protocol::protocol::common::ClientInfo;

use crate::reconnect;
use crate::reconnect::Failure;

pub(super) fn run(dir_root: PathBuf, profile_root: PathBuf) -> Result<(), String> {
    run_entry(dir_root, profile_root, Entry::New)
}

pub(super) fn resume(
    dir_root: PathBuf,
    profile_root: PathBuf,
    recovery: ash_tui::TuiRecoveryState,
) -> Result<(), String> {
    run_entry(dir_root, profile_root, Entry::Resume(recovery))
}

enum Entry {
    New,
    Resume(ash_tui::TuiRecoveryState),
}

fn run_entry(mut dir_root: PathBuf, profile_root: PathBuf, entry: Entry) -> Result<(), String> {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return Err("interactive mode requires a TTY; use `ash ask` or `ash exec` instead".into());
    }
    let executable =
        env::current_exe().map_err(|error| format!("could not resolve ash executable: {error}"))?;
    let mut session =
        connect(&executable, &dir_root, &profile_root).map_err(|error| error.to_string())?;
    let (updater, notices) = match crate::update::AutomaticUpdater::start(session.client()) {
        Some((updater, notices)) => (Some(updater), Some(notices)),
        None => (None, None),
    };
    let mut recovery = match entry {
        Entry::New => None,
        Entry::Resume(recovery) => Some(recovery),
    };
    let mut drafts = None;
    let mut start_empty = false;
    loop {
        let mut options = ash_tui::TuiOptions::new("TUI conversation")
            .with_dir_root(&dir_root)
            .with_profile_root(&profile_root);
        if let Some(process_id) = session.process_id() {
            options = options.with_app_server_process_id(process_id);
        }
        if let Some(notices) = &notices {
            options = options.with_notices(notices.clone());
        }
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
                dir_root = std::fs::canonicalize(path)
                    .map_err(|error| format!("could not open worktree: {error}"))?;
                session = connect(&executable, &dir_root, &profile_root)
                    .map_err(|error| error.to_string())?;
                if let Some(updater) = &updater {
                    updater.replace_client(session.client());
                }
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
                eprintln!("Local App Server disconnected: {reason}");
                session =
                    reconnect(&executable, &dir_root, &profile_root, &reason).map_err(|error| {
                        reconnect::recovery_error(error, &recovery_command(next_recovery.as_ref()))
                    })?;
                if let Some(updater) = &updater {
                    updater.replace_client(session.client());
                }
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
                    format!("Local App Server recovery stopped after {kind:?}: {reason}"),
                    &recovery_command(recovery.as_ref()),
                ));
            }
        }
    }
}

fn recovery_command(recovery: Option<&ash_tui::TuiRecoveryState>) -> Vec<String> {
    let Some(recovery) = recovery else {
        return vec!["ash".into()];
    };
    vec![
        "ash".into(),
        "resume".into(),
        recovery.session_id().to_string(),
        recovery.thread_id().to_string(),
    ]
}

fn connect(
    executable: &std::path::Path,
    dir_root: &std::path::Path,
    profile_root: &std::path::Path,
) -> Result<AppServerSession, ClientError> {
    let command = StdioAppServerCommand::new(executable)
        .with_argument("app-server")
        .with_argument("connect")
        .with_environment_variable("ASH_HOME", profile_root.as_os_str())
        .with_environment_variable("ASH_WORKSPACE_ROOT", dir_root.as_os_str());
    AppServerSession::start_stdio(
        command,
        ClientInfo {
            name: "ash-cli".into(),
            version: env!("CARGO_PKG_VERSION").into(),
        },
        ash_tui::client_capabilities(),
    )
}

fn reconnect(
    executable: &std::path::Path,
    dir_root: &std::path::Path,
    profile_root: &std::path::Path,
    initial_reason: &str,
) -> Result<AppServerSession, String> {
    let started = Instant::now();
    reconnect::retry(
        "Local App Server",
        initial_reason,
        || connect(executable, dir_root, profile_root).map_err(classify_error),
        thread::sleep,
        || started.elapsed(),
        |attempt, delay| {
            eprintln!(
                "Reconnecting to Local App Server (attempt {attempt}, retrying in {} ms)...",
                delay.as_millis()
            );
        },
    )
}

fn classify_error(error: ClientError) -> Failure {
    match error {
        ClientError::Transport(_) => Failure::Retryable(error.to_string()),
        ClientError::Protocol(_) | ClientError::Server { .. } => Failure::Terminal(format!(
            "Local App Server reconnect stopped because the server rejected the connection: {error}"
        )),
    }
}

#[cfg(test)]
#[path = "local_tui_tests.rs"]
mod tests;
