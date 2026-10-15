use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use crate::ProtocolError;
use crate::ProtocolLimits;
use crate::RequestContext;
use crate::validation::validate_encoded_size;

/// Calls are bound to an existing invocation, never to an arbitrary active window.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionClientRequest {
    pub context: RequestContext,
    pub call_id: u64,
    pub operation: ExtensionClientOperation,
}

impl ExtensionClientRequest {
    pub fn validate(&self, limits: &ProtocolLimits) -> Result<(), ProtocolError> {
        self.context.validate()?;
        if self.call_id == 0 {
            return Err(ProtocolError::InvalidProtocol(
                "client call ID must be non-zero".into(),
            ));
        }
        validate_operation(&self.operation, limits)?;
        validate_encoded_size(self, limits.maximum_frame_bytes)
    }
}

/// Standard Node calls owned by an activation, including activate and background listeners.
/// The parent binds the editor window; the child cannot select a connection or extension identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionBackgroundClientRequest {
    pub context: crate::HostEventContext,
    pub call_id: u64,
    pub operation: ExtensionClientOperation,
}

impl ExtensionBackgroundClientRequest {
    pub fn validate(&self, limits: &ProtocolLimits) -> Result<(), ProtocolError> {
        self.context.validate()?;
        if self.call_id == 0 {
            return Err(ProtocolError::InvalidProtocol(
                "client call ID must be non-zero".into(),
            ));
        }
        validate_operation(&self.operation, limits)?;
        validate_encoded_size(self, limits.maximum_frame_bytes)
    }
}

/// Reply on the same activation fence, without borrowing a foreground request ID.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionBackgroundClientResponse {
    pub context: crate::HostEventContext,
    pub call_id: u64,
    pub outcome: Result<ExtensionClientResult, crate::HostFailure>,
}

fn validate_operation(
    operation: &ExtensionClientOperation,
    limits: &ProtocolLimits,
) -> Result<(), ProtocolError> {
    validate_encoded_size(operation, limits.maximum_payload_bytes)?;
    match operation {
        ExtensionClientOperation::BackendRequest {
            capability,
            method,
            params,
            progress,
        } => {
            if progress.as_ref().is_some_and(|progress| {
                progress.title.is_empty()
                    || progress.title.len() > 2048
                    || progress.title.contains('\0')
            }) {
                return Err(ProtocolError::InvalidProtocol(
                    "invalid progress title".into(),
                ));
            }
            if capability.is_empty()
                || capability.len() > 256
                || method.is_empty()
                || method.len() > 256
                || !params.is_object()
            {
                return Err(ProtocolError::InvalidProtocol(
                    "invalid backend capability request".into(),
                ));
            }
        }
        ExtensionClientOperation::ReadConfiguration { section, resource }
        | ExtensionClientOperation::InspectConfiguration { section, resource } => {
            if section.len() > 1024
                || section.contains('\0')
                || resource
                    .as_ref()
                    .is_some_and(|resource| resource.len() > 8192 || resource.contains('\0'))
            {
                return Err(ProtocolError::InvalidProtocol(
                    "invalid configuration request".into(),
                ));
            }
        }
        ExtensionClientOperation::ResetConfiguration { section, .. }
        | ExtensionClientOperation::UpdateConfiguration { section, .. } => {
            if section.is_empty() || section.len() > 1024 || section.contains('\0') {
                return Err(ProtocolError::InvalidProtocol(
                    "invalid configuration key".into(),
                ));
            }
        }
        ExtensionClientOperation::BackendState { capability, .. } => {
            if capability.is_empty() || capability.len() > 256 {
                return Err(ProtocolError::InvalidProtocol(
                    "invalid backend capability".into(),
                ));
            }
        }
        ExtensionClientOperation::EditorOperation { payload } if !payload.is_object() => {
            return Err(ProtocolError::InvalidProtocol(
                "invalid editor operation".into(),
            ));
        }
        ExtensionClientOperation::ScmUpdate {
            registration_id,
            revision,
            providers,
        } => {
            if registration_id.is_empty()
                || registration_id.len() > 256
                || *revision == 0
                || providers.len() > 512
                || providers.iter().any(|provider| !provider.is_object())
            {
                return Err(ProtocolError::InvalidProtocol(
                    "invalid source control update".into(),
                ));
            }
        }
        _ => {}
    }
    if let ExtensionClientOperation::ShowMessage { message, items, .. } = operation {
        if message.trim().is_empty()
            || items.len() > 16
            || items
                .iter()
                .any(|item| item.trim().is_empty() || item.len() > 2048)
        {
            return Err(ProtocolError::InvalidProtocol(
                "invalid extension notification message or buttons".into(),
            ));
        }
    }
    if let ExtensionClientOperation::OpenRemoteConnection { authority } = operation {
        let valid = authority.split_once('+').is_some_and(|(prefix, target)| {
            !prefix.is_empty()
                && prefix.len() <= 64
                && prefix.as_bytes()[0].is_ascii_lowercase()
                && prefix
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                && !target.is_empty()
        });
        if !valid
            || authority.len() > 2048
            || authority.bytes().any(|byte| byte <= 32 || byte == 127)
        {
            return Err(ProtocolError::InvalidProtocol(
                "invalid Remote connection authority".into(),
            ));
        }
    }
    if let ExtensionClientOperation::SetStatusBarEntries {
        registration_id,
        revision,
        entries,
    } = operation
    {
        crate::validation::validate_identifier(registration_id)?;
        crate::statusbar::validate_entries(*revision, entries)?;
    }
    if let ExtensionClientOperation::SetDiagnostics {
        collection,
        entries,
    } = operation
    {
        if collection.is_empty() || collection.len() > 256 || entries.len() > 1024 {
            return Err(ProtocolError::InvalidProtocol(
                "invalid diagnostic collection".into(),
            ));
        }
        let mut resources = std::collections::BTreeSet::new();
        let mut count = 0;
        for entry in entries {
            if entry.uri.is_empty()
                || entry.uri.len() > 8192
                || !resources.insert(&entry.uri)
                || entry.version == Some(0)
            {
                return Err(ProtocolError::InvalidProtocol(
                    "invalid diagnostic resource or version".into(),
                ));
            }
            count += entry.diagnostics.len();
            for diagnostic in &entry.diagnostics {
                if diagnostic.message.is_empty()
                    || (diagnostic.start.line, diagnostic.start.character)
                        > (diagnostic.end.line, diagnostic.end.character)
                {
                    return Err(ProtocolError::InvalidProtocol(
                        "invalid diagnostic message or range".into(),
                    ));
                }
            }
        }
        if count > 10_000 {
            return Err(ProtocolError::QuotaExceeded("diagnostics"));
        }
    }
    if let ExtensionClientOperation::ExecuteTask { task_id, task } = operation {
        // An edited custom snapshot selects the current catalog callback while
        // retaining the authenticated caller's metadata and execution lifetime.
        let selects_custom_callback = task_id.is_some()
            && task
                .as_ref()
                .is_some_and(|value| value["execution"]["type"] == "custom");
        if (task_id.is_none() && task.is_none())
            || (task_id.is_some() && task.is_some() && !selects_custom_callback)
            || task_id
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.len() > 4096)
            || task.as_ref().is_some_and(|value| !value.is_object())
        {
            return Err(ProtocolError::InvalidProtocol(
                "invalid task execution selection".into(),
            ));
        }
    }
    match operation {
        ExtensionClientOperation::ReadResourceFile { uri }
        | ExtensionClientOperation::StatResource { uri }
        | ExtensionClientOperation::ReadResourceDirectory { uri } => {
            if uri.is_empty() || uri.len() > 8192 || uri.contains('\0') || !uri.contains(':') {
                return Err(ProtocolError::InvalidProtocol(
                    "invalid resource URI".into(),
                ));
            }
        }
        ExtensionClientOperation::SetDebugSessionName { session_id, name } => {
            if session_id.is_empty()
                || session_id.len() > 4096
                || name.len() > 32768
                || name.contains('\0')
            {
                return Err(ProtocolError::InvalidProtocol(
                    "invalid debug session name".into(),
                ));
            }
        }
        ExtensionClientOperation::AddDebugBreakpoints { breakpoints } => {
            if breakpoints.len() > 10_000 || breakpoints.iter().any(|value| !value.is_object()) {
                return Err(ProtocolError::InvalidProtocol(
                    "invalid debug breakpoint batch".into(),
                ));
            }
        }
        ExtensionClientOperation::RemoveDebugBreakpoints { breakpoint_ids } => {
            if breakpoint_ids.len() > 10_000
                || breakpoint_ids
                    .iter()
                    .any(|id| id.is_empty() || id.len() > 32768 || id.contains('\0'))
            {
                return Err(ProtocolError::InvalidProtocol(
                    "invalid debug breakpoint identities".into(),
                ));
            }
        }
        ExtensionClientOperation::GetDebugProtocolBreakpoint {
            session_id,
            breakpoint_id,
        } => {
            if session_id.is_empty()
                || session_id.len() > 4096
                || breakpoint_id.is_empty()
                || breakpoint_id.len() > 32768
                || breakpoint_id.contains('\0')
            {
                return Err(ProtocolError::InvalidProtocol(
                    "invalid debug breakpoint lookup".into(),
                ));
            }
        }
        _ => {}
    }
    if let ExtensionClientOperation::DebugCustomRequest {
        session_id,
        command,
        ..
    } = operation
    {
        if session_id.is_empty()
            || session_id.len() > 4096
            || command.is_empty()
            || command.len() > 256
            || command.contains('\0')
        {
            return Err(ProtocolError::InvalidProtocol(
                "invalid debug request identity or command".into(),
            ));
        }
    }
    if let ExtensionClientOperation::StartDebugging {
        folder,
        configuration,
        options,
    } = operation
    {
        if folder
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 8192)
            || !(configuration.is_string() || configuration.is_object())
            || options.as_ref().is_some_and(|options| {
                options.console_mode.is_some_and(|mode| mode > 1)
                    || options
                        .parent_session_id
                        .as_ref()
                        .is_some_and(|id| id.is_empty() || id.len() > 4096 || id.contains('\0'))
            })
        {
            return Err(ProtocolError::InvalidProtocol(
                "invalid debug launch selection".into(),
            ));
        }
    }
    Ok(())
}

/// Identity and execution options are interpreted by the owning editor window.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionDebugSessionOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "export", ts(optional))]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "export", ts(optional))]
    pub lifecycle_managed_by_parent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "export", ts(optional))]
    pub console_mode: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "export", ts(optional))]
    pub no_debug: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "export", ts(optional))]
    pub suppress_save_before_start: Option<bool>,
}

/// Optional foreground progress; its lifetime belongs to the initiating window.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionProgressOptions {
    pub title: String,
    pub cancellable: bool,
}

/// Editor operations available to executable extensions. Documents, undo and UI remain client-owned.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "operation",
    deny_unknown_fields
)]
pub enum ExtensionClientOperation {
    /// The client authorizes every route against the product package's declared capability.
    BackendRequest {
        capability: String,
        method: String,
        params: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "export", ts(optional))]
        progress: Option<ExtensionProgressOptions>,
    },
    BackendState {
        capability: String,
        #[cfg_attr(feature = "export", ts(type = "number"))]
        after: u64,
    },
    /// Editor-owned interactions, including dirty buffers, are resolved by the initiating window.
    EditorOperation {
        payload: Value,
    },
    ScmUpdate {
        registration_id: String,
        #[cfg_attr(feature = "export", ts(type = "number"))]
        revision: u64,
        providers: Vec<Value>,
    },
    /// Granted only by profile hosts, never forwarded to a window.
    #[cfg_attr(feature = "json-schema", schemars(skip))]
    #[cfg_attr(feature = "export", ts(skip))]
    CoreService {
        request: crate::services::CoreServiceRequest,
    },
    /// The initiating client confirms the saved target before handing it to the connection host.
    OpenRemoteConnection {
        authority: String,
    },
    SetStatusBarEntries {
        registration_id: String,
        #[cfg_attr(feature = "export", ts(type = "number"))]
        revision: u64,
        entries: Vec<crate::ExtensionStatusBarEntry>,
    },
    ExecuteCommand {
        command: String,
        arguments: Vec<Value>,
    },
    FetchTasks {
        version: Option<String>,
        task_type: Option<String>,
    },
    ExecuteTask {
        task_id: Option<String>,
        task: Option<Value>,
    },
    TerminateTask {
        execution_id: String,
    },
    AddDebugBreakpoints {
        breakpoints: Vec<Value>,
    },
    RemoveDebugBreakpoints {
        breakpoint_ids: Vec<String>,
    },
    GetDebugProtocolBreakpoint {
        session_id: String,
        breakpoint_id: String,
    },
    SetDebugSessionName {
        session_id: String,
        name: String,
    },
    ListDebugSessions {},
    StartDebugging {
        folder: Option<String>,
        configuration: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "export", ts(optional))]
        options: Option<ExtensionDebugSessionOptions>,
    },
    StopDebugging {
        session_id: Option<String>,
    },
    DebugCustomRequest {
        session_id: String,
        command: String,
        arguments: Value,
        has_arguments: bool,
    },
    ReadDocument {
        uri: String,
    },
    /// Workspace-relative disk read. The App Server filesystem owner handles this, never the renderer.
    ReadWorkspaceFile {
        path: String,
    },
    /// URI resources are serviced by the bound client filesystem, including virtual providers.
    ReadResourceFile {
        uri: String,
    },
    StatResource {
        uri: String,
    },
    ReadResourceDirectory {
        uri: String,
    },
    ListDocuments,
    /// Replaces only this extension incarnation's named diagnostic collection.
    SetDiagnostics {
        collection: String,
        entries: Vec<ExtensionDiagnosticEntry>,
    },
    ApplyEdit {
        documents: Vec<ExtensionDocumentEdit>,
    },
    /// A supervised Node incarnation refreshes editor facts before evaluating package code.
    ReadInitialization {},
    ReadConfiguration {
        section: String,
        resource: Option<String>,
    },
    InspectConfiguration {
        section: String,
        resource: Option<String>,
    },
    ResetConfiguration {
        section: String,
        target: ExtensionConfigurationTarget,
    },
    UpdateConfiguration {
        section: String,
        value: Value,
        target: ExtensionConfigurationTarget,
    },
    ShowMessage {
        message: String,
        severity: ExtensionMessageSeverity,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        items: Vec<String>,
    },
    ShowQuickPick {
        items: Vec<ExtensionQuickPickItem>,
        placeholder: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionQuickPickItem {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "export", ts(optional))]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "export", ts(optional))]
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ExtensionConfigurationTarget {
    User,
    Workspace,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ExtensionMessageSeverity {
    Information,
    Warning,
    Error,
}

/// Zero-based UTF-16 edit coordinates.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionTextPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionTextEdit {
    pub start: ExtensionTextPosition,
    pub end: ExtensionTextPosition,
    pub text: String,
}

/// The version is mandatory: an extension cannot overwrite edits made since its snapshot.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionDocumentEdit {
    pub uri: String,
    pub version: u32,
    pub edits: Vec<ExtensionTextEdit>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionDocumentSnapshot {
    pub uri: String,
    pub version: u32,
    pub language_id: String,
    pub text: String,
}

/// Diagnostics carry the observed document version so old callbacks cannot mark newer text.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionDiagnosticEntry {
    pub uri: String,
    pub version: Option<u32>,
    pub diagnostics: Vec<ExtensionDiagnostic>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionDiagnostic {
    pub start: ExtensionTextPosition,
    pub end: ExtensionTextPosition,
    pub message: String,
    pub severity: ExtensionDiagnosticSeverity,
    pub source: Option<String>,
    pub code: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ExtensionDiagnosticSeverity {
    Error,
    Warning,
    Information,
    Hint,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "result",
    deny_unknown_fields
)]
pub enum ExtensionClientResult {
    Value {
        value: Value,
    },
    #[cfg_attr(feature = "json-schema", schemars(skip))]
    #[cfg_attr(feature = "export", ts(skip))]
    CoreService {
        response: crate::services::CoreServiceResponse,
    },
    Command {
        value: Value,
        /// Older clients always returned a JSON value, including null for void.
        #[serde(default = "command_has_value")]
        has_value: bool,
    },
    Tasks {
        #[cfg_attr(feature = "export", ts(type = "number"))]
        sequence: u64,
        tasks: Vec<Value>,
        executions: Vec<Value>,
    },
    TaskExecution {
        #[cfg_attr(feature = "export", ts(type = "number"))]
        sequence: u64,
        execution: Value,
    },
    DebugSessions {
        #[cfg_attr(feature = "export", ts(type = "number"))]
        sequence: u64,
        sessions: Vec<Value>,
        active_session: Option<String>,
        breakpoints: Vec<Value>,
    },
    DebugStarted {
        started: bool,
    },
    DebugResponse {
        value: Value,
        has_body: bool,
    },
    Document {
        document: ExtensionDocumentSnapshot,
    },
    File {
        text: String,
    },
    ResourceFile {
        bytes: Vec<u8>,
    },
    ResourceStat {
        file_type: u8,
        #[cfg_attr(feature = "export", ts(type = "number"))]
        size: u64,
        #[cfg_attr(feature = "export", ts(type = "number"))]
        mtime: u64,
    },
    ResourceDirectory {
        entries: Vec<(String, u8)>,
    },
    Documents {
        documents: Vec<ExtensionDocumentSnapshot>,
    },
    Applied {
        applied: bool,
    },
    Initialization {
        initialization: crate::ExtensionHostInitialization,
    },
    Configuration {
        value: Value,
    },
    Selection {
        index: Option<u32>,
    },
    Done,
}

fn command_has_value() -> bool {
    true
}

/// This is a response to a child call, not a new host invocation or an event.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionClientResponse {
    pub context: RequestContext,
    pub call_id: u64,
    pub outcome: Result<ExtensionClientResult, crate::HostFailure>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum ExtensionHostStdinFrame {
    Request(crate::ExtensionHostRequest),
    ClientResponse(ExtensionClientResponse),
    BackgroundClientResponse(ExtensionBackgroundClientResponse),
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
