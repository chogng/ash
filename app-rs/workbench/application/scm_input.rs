use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use anyhow::Result;
use anyhow::anyhow;
use ash_app_server_protocol::protocol::git::GitCommitParams;
use ash_app_server_protocol::protocol::git::GitPathsParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesCommitParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesListParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesMutationParams;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesReadParams;
use ash_protocol::CommandId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use ash_scm::ChangesActivation;
use ash_scm::PullRequestMode;
use zui::input::Key;
use zui::input::KeyEvent;
use zui::input::NamedKey;
use zui::ui::ElementId;

use super::WorkbenchEvent;
use crate::WorkbenchApplication;
use crate::app_server::AppServerRequestHandle;

impl WorkbenchApplication {
    pub(super) fn route_scm_keyboard(&mut self, event: &KeyEvent) -> bool {
        if !self.ui_dispatch.is_focused(ash_scm::COMMIT_MESSAGE_EDITOR) {
            return false;
        }
        if event.logical_key == Key::Named(NamedKey::Escape) {
            self.scm.toolbar_mut().dismiss_menus();
        } else {
            let command = if event.logical_key == Key::Named(NamedKey::Enter) {
                Some(ash_editor::CodeEditorCommand::Newline)
            } else {
                crate::terminal_input::code_editor_command(event, self.modifiers)
            };
            let Some(command) = command else {
                return true;
            };
            self.scm.toolbar_mut().apply_commit_message(command);
            self.caret_blink.activity(std::time::Instant::now());
        }
        self.rebuild_presentation();
        self.request_redraw();
        true
    }

    pub(super) fn activate_scm_element(&mut self, id: ElementId) -> bool {
        let activation = self.scm.activate(id);
        if activation == ChangesActivation::Ignored {
            return false;
        }
        match activation {
            ChangesActivation::Ignored => {}
            ChangesActivation::Changed | ChangesActivation::ScopeChanged(_) => {}
            ChangesActivation::Focus(id) => self.pending_focus = Some(id),
            ChangesActivation::OpenFile(path) => self.open_file(PathBuf::from(path)),
            ChangesActivation::OpenFiles => self.show_files_pane(),
            ChangesActivation::Stage(paths) => self.run_git_paths(paths, GitPathsAction::Stage),
            ChangesActivation::Unstage(paths) => self.run_git_paths(paths, GitPathsAction::Unstage),
            ChangesActivation::Discard(paths) => self.run_git_paths(paths, GitPathsAction::Discard),
            ChangesActivation::GenerateAndCommit => {
                if let Err(error) = self.generate_and_commit_current_turn() {
                    eprintln!("could not commit current Turn changes: {error}");
                }
            }
            ChangesActivation::Commit {
                message,
                include_unstaged,
                push,
            } => {
                if let Err(error) = self.commit_git(message, include_unstaged, push) {
                    eprintln!("could not commit changes: {error}");
                }
            }
            ChangesActivation::Push => {
                if let Err(error) = self.push_git() {
                    eprintln!("could not push changes: {error}");
                }
            }
            ChangesActivation::CreatePullRequest(mode) => self.create_pull_request(mode),
        }
        self.rebuild_presentation_on_next_redraw();
        true
    }

    fn run_git_paths(&mut self, paths: Vec<String>, action: GitPathsAction) {
        if paths.is_empty() {
            return;
        }
        let Some(client) = self.app_server_client.as_mut() else {
            eprintln!("could not update Git paths: App Server connection is unavailable");
            return;
        };
        let params = GitPathsParams {
            repository_id: None,
            paths,
        };
        let result = match action {
            GitPathsAction::Stage => client.stage_git_paths(params),
            GitPathsAction::Unstage => client.unstage_git_paths(params),
            GitPathsAction::Discard => client.discard_git_paths(params),
        };
        if let Err(error) = result {
            eprintln!("could not update Git paths: {error}");
            return;
        }
        if let Err(error) = self.refresh_git_from_app_server() {
            eprintln!("could not refresh Git after path update: {error}");
        }
    }

    fn commit_git(&mut self, message: String, include_unstaged: bool, push: bool) -> Result<()> {
        let paths = include_unstaged.then(|| {
            self.env
                .diffs()
                .iter()
                .map(|diff| diff.path().to_owned())
                .collect::<Vec<_>>()
        });
        let client = self
            .app_server_client
            .as_mut()
            .ok_or_else(|| anyhow!("App Server connection is unavailable"))?;
        if let Some(paths) = paths
            && !paths.is_empty()
        {
            client
                .stage_git_paths(GitPathsParams {
                    repository_id: None,
                    paths,
                })
                .map_err(|error| anyhow!(error.to_string()))?;
        }
        client
            .commit_git(GitCommitParams {
                repository_id: None,
                message,
            })
            .map_err(|error| anyhow!(error.to_string()))?;
        if push {
            client
                .push_git()
                .map_err(|error| anyhow!(error.to_string()))?;
        }
        self.refresh_git_from_app_server()
    }

    fn push_git(&mut self) -> Result<()> {
        self.app_server_client
            .as_mut()
            .ok_or_else(|| anyhow!("App Server connection is unavailable"))?
            .push_git()
            .map_err(|error| anyhow!(error.to_string()))?;
        self.refresh_git_from_app_server()
    }

    fn generate_and_commit_current_turn(&mut self) -> Result<()> {
        let thread = self
            .session_pane
            .thread()
            .ok_or_else(|| anyhow!("No active Thread"))?;
        let session_id = thread.session_id.clone();
        let thread_id = thread.thread_id.clone();
        let current_turn = thread
            .turns
            .last()
            .ok_or_else(|| anyhow!("The active Thread has no Turn"))?
            .turn_id
            .clone();
        let client = self
            .app_server_client
            .as_ref()
            .ok_or_else(|| anyhow!("App Server connection is unavailable"))?;
        let mut client = client.clone();
        let proxy = self.event_proxy.clone();
        std::thread::Builder::new()
            .name("ash-scm-auto-commit".into())
            .spawn(move || {
                let result = generate_and_commit(&mut client, session_id, thread_id, current_turn);
                let _ = proxy.send_event(WorkbenchEvent::ScmOperationFinished(result));
            })
            .map_err(|error| anyhow!("could not start automatic commit: {error}"))?;
        Ok(())
    }

    fn create_pull_request(&mut self, mode: PullRequestMode) {
        let instruction = match mode {
            PullRequestMode::Default => "Create a pull request for the current branch.",
            PullRequestMode::AutoMerge => {
                "Create a pull request for the current branch and enable automatic merge."
            }
            PullRequestMode::AutoSquash => {
                "Create a pull request for the current branch and enable automatic squash merge."
            }
            PullRequestMode::AutoRebase => {
                "Create a pull request for the current branch and enable automatic rebase merge."
            }
            PullRequestMode::Draft => "Create a draft pull request for the current branch.",
        };
        let Some(runtime) = self.session_runtime.as_ref() else {
            eprintln!("could not create pull request: Session runtime is unavailable");
            return;
        };
        if let Err(error) = runtime.submit_agent_message(instruction.to_owned()) {
            eprintln!("could not create pull request: {error}");
        }
    }
}

#[derive(Clone, Copy)]
enum GitPathsAction {
    Stage,
    Unstage,
    Discard,
}

fn command_id(action: &str, change_set_id: &str, revision: u64) -> CommandId {
    CommandId::new(format!("scm-{action}-{change_set_id}-{revision}"))
        .expect("SCM command identity is non-empty")
}

fn generate_and_commit(
    client: &mut AppServerRequestHandle,
    session_id: SessionId,
    thread_id: ThreadId,
    current_turn: TurnId,
) -> std::result::Result<(), String> {
    let summary = client
        .list_turn_changes(TurnChangesListParams {
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
        })
        .map_err(|error| error.to_string())?
        .change_sets
        .into_iter()
        .rev()
        .find(|summary| summary.turn_id == current_turn)
        .ok_or_else(|| "The current Turn has no captured changes".to_owned())?;
    let read_params = TurnChangesReadParams {
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
        change_set_id: summary.change_set_id.clone(),
    };
    let mut read = client
        .read_turn_changes(read_params.clone())
        .map_err(|error| error.to_string())?;
    if read.draft_message.as_deref().is_none_or(str::is_empty) {
        client
            .generate_turn_commit_message(TurnChangesMutationParams {
                command_id: command_id("generate", &summary.change_set_id.0, read.summary.revision),
                session_id: session_id.clone(),
                thread_id: thread_id.clone(),
                change_set_id: summary.change_set_id.clone(),
                expected_revision: read.summary.revision,
            })
            .map_err(|error| error.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
            read = client
                .read_turn_changes(read_params.clone())
                .map_err(|error| error.to_string())?;
            if read
                .draft_message
                .as_deref()
                .is_some_and(|message| !message.is_empty())
            {
                break;
            }
        }
        if read.draft_message.as_deref().is_none_or(str::is_empty) {
            return Err("Commit message generation did not finish within 30 seconds".into());
        }
    }
    client
        .commit_turn_changes(TurnChangesCommitParams {
            command_id: command_id("commit", &summary.change_set_id.0, read.summary.revision),
            session_id,
            thread_id,
            change_set_ids: vec![summary.change_set_id],
            expected_revision: read.summary.revision,
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}
