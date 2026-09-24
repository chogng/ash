use super::App;
use super::AppCommand;
use super::AppEvent;
use super::completion::Completion;
use crate::client;
use crate::config::Command as ConfigCommand;
use crate::connectors::Command as ConnectorCommand;
use crate::dirs::Command as DirCommand;
use crate::host::Command as HostCommand;
use crate::keymap_setup::Command as KeymapCommand;
use crate::projects::Command as ProjectCommand;
use crate::sessions::Command as SessionCommand;
use crate::status::Command as StatusCommand;
use crate::theme::Command as ThemeCommand;
use crate::thread::Command as ThreadCommand;
use crate::thread::Event as ThreadEvent;
use std::collections::BTreeMap;

/// A backend or host resource whose operations must remain ordered.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(super) enum RequestKey {
    Interrupt,
    Interaction,
    Thread,
    Config,
    Keymap,
    StatusLine,
    Connectors,
    Directories,
    Projects,
    Sessions,
    Preview,
    SessionDetails,
    Marketplace,
    Mcp,
    Memories,
    Skills,
    Clipboard,
    FileExport,
    Git,
    Memory,
    Issues,
    IssueControl,
}

#[derive(Default)]
pub(super) struct RequestTasks {
    tasks: BTreeMap<RequestKey, PendingRequest>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct RequestOrigin {
    pub(super) mode: crate::terminal::ScreenMode,
    pub(super) panel_generation: u64,
}

impl RequestOrigin {
    pub(super) fn current(app: &App) -> Self {
        Self {
            mode: app.screen_mode(),
            panel_generation: app.panels().generation(),
        }
    }
}

struct PendingRequest {
    task: client::RequestTask<Completion>,
    origin: RequestOrigin,
}

pub(super) struct RequestCompletion {
    pub(super) completion: Completion,
    pub(super) origin: RequestOrigin,
}

impl RequestTasks {
    pub(super) fn is_idle(&self, key: Option<RequestKey>) -> bool {
        key.is_none_or(|key| !self.tasks.contains_key(&key))
    }

    pub(super) fn spawn(
        &mut self,
        key: Option<RequestKey>,
        name: &'static str,
        request: impl FnOnce() -> Completion + Send + 'static,
        app: &mut App,
        origin: RequestOrigin,
    ) {
        let Some(key) = key else {
            app.update(ThreadEvent::FailureReported(format!(
                "background request `{name}` has no request key"
            )));
            return;
        };
        if self.tasks.contains_key(&key) {
            app.update(ThreadEvent::FailureReported(format!(
                "background request `{name}` conflicts with an active {key:?} request"
            )));
            return;
        }
        match client::RequestTask::spawn(name, request) {
            Ok(task) => {
                self.tasks.insert(key, PendingRequest { task, origin });
            }
            Err(error) => app.update(ThreadEvent::FailureReported(format!(
                "could not start background request: {error}"
            ))),
        }
    }

    pub(super) fn spawn_presentation<E>(
        &mut self,
        key: Option<RequestKey>,
        name: &'static str,
        request: impl FnOnce() -> Result<E, String> + Send + 'static,
        app: &mut App,
        origin: RequestOrigin,
    ) where
        E: Into<AppEvent>,
    {
        self.spawn(
            key,
            name,
            move || Completion::Presentation(request().map(Into::into)),
            app,
            origin,
        );
    }

    pub(super) fn poll(&mut self) -> Vec<Result<RequestCompletion, std::io::Error>> {
        let mut completed = Vec::new();
        let keys = self.tasks.keys().copied().collect::<Vec<_>>();
        for key in keys {
            let result = self
                .tasks
                .get_mut(&key)
                .expect("the request key was collected from the active task map")
                .task
                .poll();
            match result {
                Ok(Some(completion)) => {
                    let pending = self.tasks.remove(&key).unwrap();
                    completed.push(Ok(RequestCompletion {
                        completion,
                        origin: pending.origin,
                    }));
                }
                Ok(None) => {}
                Err(error) => {
                    self.tasks.remove(&key);
                    completed.push(Err(error));
                }
            }
        }
        completed
    }
}

pub(super) fn request_key(command: &AppCommand) -> Option<RequestKey> {
    match command {
        AppCommand::Thread(ThreadCommand::Interrupt) => Some(RequestKey::Interrupt),
        AppCommand::Thread(ThreadCommand::ResolveRequest(_)) => Some(RequestKey::Interaction),
        AppCommand::Host(
            HostCommand::CopyLastResponse
            | HostCommand::ReadClipboardImage { .. }
            | HostCommand::RefreshClipboardImageAvailability,
        ) => Some(RequestKey::Clipboard),
        AppCommand::Host(HostCommand::ExportTranscript { .. }) => Some(RequestKey::FileExport),
        AppCommand::Quit
        | AppCommand::Suspend
        | AppCommand::Thread(ThreadCommand::CycleNextApprovalMode) => None,
        AppCommand::Config(
            ConfigCommand::SetIssues(_)
            | ConfigCommand::SetGit(_)
            | ConfigCommand::SetMemories(_)
            | ConfigCommand::OpenAdvisor
            | ConfigCommand::SetAdvisor(_)
            | ConfigCommand::OpenEditor
            | ConfigCommand::Subscription(_, _)
            | ConfigCommand::Edit(_)
            | ConfigCommand::Connection(_)
            | ConfigCommand::SetProviderApiKey(_),
        )
        | AppCommand::Theme(
            ThemeCommand::OpenPicker
            | ThemeCommand::OpenCustomPicker
            | ThemeCommand::SetCustom { .. }
            | ThemeCommand::Set { .. },
        )
        | AppCommand::Models(_) => Some(RequestKey::Config),
        AppCommand::Keymap(KeymapCommand::OpenEditor | KeymapCommand::Edit(_)) => {
            Some(RequestKey::Keymap)
        }
        AppCommand::Status(StatusCommand::OpenPanel) => Some(RequestKey::Thread),
        AppCommand::Status(StatusCommand::OpenLineEditor | StatusCommand::EditLine(_)) => {
            Some(RequestKey::StatusLine)
        }
        AppCommand::Connectors(
            ConnectorCommand::ConnectDeviceOAuth { .. } | ConnectorCommand::Disconnect { .. },
        ) => Some(RequestKey::Connectors),
        AppCommand::Dirs(
            DirCommand::Add { .. }
            | DirCommand::Remove { .. }
            | DirCommand::SetPermissions(_)
            | DirCommand::MoveSession { .. },
        ) => Some(RequestKey::Directories),
        AppCommand::Projects(
            ProjectCommand::OpenRoots
            | ProjectCommand::OpenAddRoot
            | ProjectCommand::AddRoot { .. },
        ) => Some(RequestKey::Projects),
        AppCommand::Git(_) => Some(RequestKey::Git),
        AppCommand::Sessions(SessionCommand::Preview { .. }) => Some(RequestKey::Preview),
        AppCommand::Sessions(
            SessionCommand::Restore { .. }
            | SessionCommand::Delete { .. }
            | SessionCommand::Resume { .. }
            | SessionCommand::Archive { .. }
            | SessionCommand::CreateAndEnter { .. },
        ) => Some(RequestKey::Sessions),
        AppCommand::Sessions(SessionCommand::Fork { .. } | SessionCommand::SwitchThread { .. })
        | AppCommand::Thread(
            ThreadCommand::ExecuteProductCommand(_)
            | ThreadCommand::LoadOlderHistory
            | ThreadCommand::OpenRewindPicker
            | ThreadCommand::RewindToCheckpoint { .. }
            | ThreadCommand::RestoreMessage { .. }
            | ThreadCommand::SubmitTurn { .. }
            | ThreadCommand::Enqueue { .. }
            | ThreadCommand::EditQueue { .. }
            | ThreadCommand::CancelQueue(_)
            | ThreadCommand::RefreshQueue
            | ThreadCommand::SteerTurn { .. },
        ) => Some(RequestKey::Thread),
        AppCommand::Issues(command) if command.is_control() => Some(RequestKey::IssueControl),
        AppCommand::Issues(_) => Some(RequestKey::Issues),
        AppCommand::Memories(_) => Some(RequestKey::Memories),
        AppCommand::Marketplace(_) => Some(RequestKey::Marketplace),
        AppCommand::Lsp(_) => Some(RequestKey::Config),
        AppCommand::Mcp(_) => Some(RequestKey::Mcp),
        AppCommand::Skills(_) => Some(RequestKey::Skills),
    }
}
