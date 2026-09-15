use crate::ExecRunId;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_protocol::AgentInteractionKind;
use ash_protocol::RequestId;
use ash_protocol::SessionId;
use ash_protocol::StableTurnError;
use ash_protocol::ThreadId;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::TurnId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;

/// Version emitted in every JSONL-compatible [`ExecEvent`] envelope.
pub const EXEC_EVENT_SCHEMA_VERSION: u32 = 1;

/// Startup target used by one headless runner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppServerTarget {
    Embedded(EmbeddedAppServerOptions),
}

/// Inputs needed to start the shared embedded App Server composition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmbeddedAppServerOptions {
    profile_root: PathBuf,
    dir_root: Option<PathBuf>,
    client_info: ClientInfo,
}

impl EmbeddedAppServerOptions {
    pub fn new(profile_root: impl Into<PathBuf>, client_info: ClientInfo) -> Self {
        Self {
            profile_root: profile_root.into(),
            dir_root: None,
            client_info,
        }
    }

    /// Enables directory-scoped tools for this embedded run.
    pub fn with_dir_root(mut self, dir_root: impl Into<PathBuf>) -> Self {
        self.dir_root = Some(dir_root.into());
        self
    }

    pub fn profile_root(&self) -> &Path {
        &self.profile_root
    }

    pub fn dir_root(&self) -> Option<&Path> {
        self.dir_root.as_deref()
    }

    pub fn client_info(&self) -> &ClientInfo {
        &self.client_info
    }
}

/// Product-level entry intent for one headless Turn.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExecEntry {
    New {
        title: String,
        input: Vec<InputItem>,
    },
    Resume {
        session_id: SessionId,
        thread_id: ThreadId,
        input: Vec<InputItem>,
    },
    Fork {
        session_id: SessionId,
        parent_thread_id: ThreadId,
        title: String,
        input: Vec<InputItem>,
    },
}

impl ExecEntry {
    pub(crate) fn input(&self) -> &[InputItem] {
        match self {
            Self::New { input, .. } | Self::Resume { input, .. } | Self::Fork { input, .. } => {
                input
            }
        }
    }
}

/// Approval authority available to a run with no interactive presentation.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HeadlessApprovalMode {
    /// Stops the Turn as soon as it requires an interactive response.
    #[default]
    DenyInteractiveRequests,
    /// Lets the App Server's automatic reviewer resolve approval requests.
    AutomaticReview,
    /// Explicitly bypasses permission checks for a trusted caller.
    BypassPermissions,
}

/// Fully materialized request consumed by [`crate::ExecRunner`].
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecRunRequest {
    pub run_id: ExecRunId,
    pub entry: ExecEntry,
    pub approval: HeadlessApprovalMode,
}

impl ExecRunRequest {
    pub fn new(entry: ExecEntry) -> Self {
        Self {
            run_id: ExecRunId::generate(),
            entry,
            approval: HeadlessApprovalMode::default(),
        }
    }

    pub fn with_run_id(mut self, run_id: ExecRunId) -> Self {
        self.run_id = run_id;
        self
    }

    pub fn with_approval_mode(mut self, approval: HeadlessApprovalMode) -> Self {
        self.approval = approval;
        self
    }
}

/// Origin of a headless invocation. Scheduler identities remain a future protocol concern.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecOrigin {
    Local,
}

/// Versioned envelope written as one complete JSON object by JSONL sinks.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecEvent {
    pub schema_version: u32,
    pub run_id: ExecRunId,
    pub event: ExecEventKind,
}

impl ExecEvent {
    pub(crate) fn new(run_id: &ExecRunId, event: ExecEventKind) -> Self {
        Self {
            schema_version: EXEC_EVENT_SCHEMA_VERSION,
            run_id: run_id.clone(),
            event,
        }
    }
}

/// Observable lifecycle emitted by one run without duplicating canonical Thread state.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExecEventKind {
    RunStarted {
        origin: ExecOrigin,
        session_id: SessionId,
        thread_id: ThreadId,
    },
    TurnStarted {
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
    },
    ThreadUpdated {
        update: Box<ThreadUpdateEnvelope>,
    },
    RunCompleted {
        outcome: ExecOutcome,
    },
}

/// Stable process-level result category used by CLI and worker adapters.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[repr(i32)]
#[serde(rename_all = "camelCase")]
pub enum ExecExitCode {
    Success = 0,
    Failed = 1,
    RequiresInteraction = 2,
    OutcomeUnknown = 75,
    Interrupted = 130,
}

impl ExecExitCode {
    pub fn get(self) -> i32 {
        self as i32
    }
}

/// Final user-visible content of a canonically completed Turn.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExecFinalOutput {
    AgentMessage { text: String },
    Empty,
}

/// Failure information preserved from a canonical failed Turn.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExecFailure {
    Reported { error: StableTurnError },
    Unspecified,
}

/// Why a canonical interrupted Turn was interrupted from the runner's perspective.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecInterruptionReason {
    CancellationRequested,
    TurnTimeout,
    External,
}

/// Interaction category that cannot be presented by this headless runner.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecInteractionKind {
    Approval,
    UserInput,
    DynamicTool,
    Capability,
}

impl From<AgentInteractionKind> for ExecInteractionKind {
    fn from(kind: AgentInteractionKind) -> Self {
        match kind {
            AgentInteractionKind::Approval => Self::Approval,
            AgentInteractionKind::UserInput => Self::UserInput,
            AgentInteractionKind::DynamicTool => Self::DynamicTool,
        }
    }
}

/// Redaction-safe interaction metadata retained when a headless run stops.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecRequiredInteraction {
    pub kind: ExecInteractionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<RequestId>,
}

/// Why the runner could not establish a canonical terminal Turn state.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExecUnknownReason {
    ConnectionClosed { reason: String },
    ObservationFailed { message: String },
    InterruptFailed { message: String },
    TerminalDeadlineElapsed,
}

/// Terminal result of a run. Every variant carries the canonical aggregate identities.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExecOutcome {
    Completed {
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
        output: ExecFinalOutput,
    },
    Failed {
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
        failure: ExecFailure,
    },
    Interrupted {
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
        reason: ExecInterruptionReason,
    },
    RequiresInteraction {
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
        interaction: ExecRequiredInteraction,
    },
    OutcomeUnknown {
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
        reason: ExecUnknownReason,
    },
}

impl ExecOutcome {
    pub fn exit_code(&self) -> ExecExitCode {
        match self {
            Self::Completed { .. } => ExecExitCode::Success,
            Self::Failed { .. } => ExecExitCode::Failed,
            Self::Interrupted { .. } => ExecExitCode::Interrupted,
            Self::RequiresInteraction { .. } => ExecExitCode::RequiresInteraction,
            Self::OutcomeUnknown { .. } => ExecExitCode::OutcomeUnknown,
        }
    }

    pub fn final_message(&self) -> Option<&str> {
        match self {
            Self::Completed {
                output: ExecFinalOutput::AgentMessage { text },
                ..
            } => Some(text),
            _ => None,
        }
    }
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
