use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

/// The broker supplies this identity from the admitted invocation, never from extension input.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionClientRequestParams {
    #[schemars(length(min = 1, max = 256))]
    pub extension_id: String,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub activation_generation: u64,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub incarnation: u64,
    pub operation: extension_protocol::ExtensionClientOperation,
}

/// Editor intent delivered to Rust; it never grants execution authority.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type",
    deny_unknown_fields
)]
pub enum ExtensionHostActivationEventDto {
    Command {
        #[schemars(length(min = 1, max = 256))]
        command: String,
    },
    Language {
        #[schemars(length(min = 1, max = 128))]
        language_id: String,
    },
    // A struct variant preserves the closed wire shape; Serde unit variants ignore extra fields.
    StartupFinished {},
    ResolveAuthority {
        #[schemars(length(min = 1, max = 64))]
        authority_prefix: String,
    },
}

/// Activates one exact admitted package generation when its declaration matches the event.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostActivateParams {
    #[schemars(length(min = 1, max = 256))]
    pub extension_id: String,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub activation_generation: u64,
    pub event: ExtensionHostActivationEventDto,
}

/// Declared command metadata available before a process exists, not a provider registration.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostCommandContributionDto {
    #[schemars(length(min = 1, max = 256))]
    pub command: String,
    #[schemars(length(min = 1, max = 512))]
    pub title: String,
}

/// Immutable manifest facts for an authorized extension waiting for its first matching event.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostActivationDto {
    #[schemars(length(max = 128))]
    pub events: Vec<String>,
    #[schemars(length(max = 2048))]
    pub commands: Vec<ExtensionHostCommandContributionDto>,
}

/// Starts a connection-owned extension fleet with explicit environment overrides.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostStartParams {
    #[schemars(length(max = 128))]
    pub environment: std::collections::BTreeMap<String, Option<String>>,
}

/// Requests a complete reconciliation of the executable Editor Extension fleet.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostReconcileParams {
    pub mode: ExtensionHostReconcileModeDto,
}

/// Selects whether reconciliation refreshes authority or retries failed runtimes as well.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionHostReconcileModeDto {
    Refresh,
    RestartFailed,
}

/// Immutable projection of one complete executable Editor Extension fleet generation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostSnapshotDto {
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub generation: u64,
    #[schemars(length(max = 128))]
    pub extensions: Vec<ExtensionHostExtensionDto>,
}

/// One exact package contribution and its current process lifecycle.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostExtensionDto {
    #[schemars(length(min = 1, max = 256))]
    pub id: String,
    #[schemars(length(min = 1, max = 128))]
    pub version: String,
    #[schemars(length(min = 71, max = 71))]
    pub package_digest: String,
    #[schemars(range(min = 1))]
    pub runtime_api_version: u16,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub activation_generation: u64,
    #[ts(type = "number | null")]
    pub incarnation: Option<u64>,
    pub lifecycle: ExtensionHostLifecycleDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub activation: Option<ExtensionHostActivationDto>,
    pub failure: Option<ExtensionHostFailureDto>,
    #[schemars(length(max = 262_144))]
    pub stderr: String,
    #[schemars(length(max = 4096))]
    pub output_events: Vec<ExtensionHostOutputEventDto>,
    #[schemars(length(max = 2048))]
    pub registrations: Vec<ExtensionHostRegistrationDescriptorDto>,
}

/// One process-fenced extension Output mutation in supervisor arrival order.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostOutputEventDto {
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub sequence: u64,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub incarnation: u64,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub activation_generation: u64,
    #[serde(flatten)]
    pub operation: ExtensionHostOutputOperationDto,
}

/// Presentation class of an extension-created Output channel.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionHostOutputChannelKindDto {
    Output,
    Log,
}

/// Structured severity of an extension Output entry.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionHostOutputSeverityDto {
    Trace,
    Debug,
    Information,
    Warning,
    Error,
    Log,
}

/// Ordered operation in an extension-created Output channel stream.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "operation"
)]
pub enum ExtensionHostOutputOperationDto {
    Create {
        #[schemars(length(min = 1, max = 256))]
        channel_id: String,
        #[schemars(length(min = 1, max = 512))]
        label: String,
        kind: ExtensionHostOutputChannelKindDto,
    },
    Append {
        #[schemars(length(min = 1, max = 256))]
        channel_id: String,
        #[schemars(length(max = 524_288))]
        text: String,
        severity: ExtensionHostOutputSeverityDto,
        #[schemars(length(min = 1, max = 128))]
        category: Option<String>,
    },
    Replace {
        #[schemars(length(min = 1, max = 256))]
        channel_id: String,
        #[schemars(length(max = 524_288))]
        text: String,
        severity: ExtensionHostOutputSeverityDto,
        #[schemars(length(min = 1, max = 128))]
        category: Option<String>,
    },
    Clear {
        #[schemars(length(min = 1, max = 256))]
        channel_id: String,
    },
    Show {
        #[schemars(length(min = 1, max = 256))]
        channel_id: String,
        preserve_focus: bool,
    },
    Dispose {
        #[schemars(length(min = 1, max = 256))]
        channel_id: String,
    },
}

/// Observable state of one per-extension process supervised by App Server.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionHostLifecycleDto {
    Dormant,
    Stopped,
    Starting,
    Handshaking,
    Ready,
    Recovering,
    CrashLoop,
    Failed,
}

/// Stable failure categories shared by runtime health and invocation outcomes.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionHostFailureCodeDto {
    AuthorityDenied,
    StaleSnapshot,
    IsolationUnavailable,
    LaunchFailed,
    HandshakeFailed,
    ActivationFailed,
    RegistrationNotFound,
    OperationNotSupported,
    Cancelled,
    DeadlineExceeded,
    QuotaExceeded,
    HostExited,
    HostRestarted,
    OutcomeIndeterminate,
    CrashLoop,
    InvalidProtocol,
    Internal,
}

/// Sanitized failure attached to one extension lifecycle snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostFailureDto {
    pub code: ExtensionHostFailureCodeDto,
    #[schemars(length(min = 1, max = 4096))]
    pub message: String,
    #[ts(type = "number | null")]
    pub incarnation: Option<u64>,
}

/// One provider registration published atomically by an activated extension process.
#[derive(Clone, Debug, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostRegistrationDescriptorDto {
    #[schemars(length(min = 1, max = 256))]
    pub registration_id: String,
    #[serde(flatten)]
    pub kind: ExtensionHostRegistrationKindDto,
}

impl<'de> Deserialize<'de> for ExtensionHostRegistrationDescriptorDto {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            registration_id: String,
            #[serde(flatten)]
            kind: serde_json::Map<String, Value>,
        }
        // Serde's flattened tagged enum cannot report consumed fields to the outer strict object.
        // The enum itself checks every remaining field; the public schema retains its closed shape.
        let wire = Wire::deserialize(deserializer)?;
        let kind =
            serde_json::from_value(Value::Object(wire.kind)).map_err(serde::de::Error::custom)?;
        Ok(Self {
            registration_id: wire.registration_id,
            kind,
        })
    }
}

/// Registration types understood by the App Server provider brokers in Host RPC v1.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    deny_unknown_fields
)]
pub enum ExtensionHostRegistrationKindDto {
    RemoteConnectionResolver {
        #[schemars(length(min = 1, max = 64))]
        authority_prefix: String,
    },
    RemoteAuthorityResolver {
        #[schemars(length(min = 1, max = 64))]
        authority_prefix: String,
    },
    StatusBar {
        #[ts(type = "number")]
        revision: u64,
        entries: Vec<extension_protocol::ExtensionStatusBarEntry>,
    },
    TextDocumentEvents {},
    ExternalUriOpener {
        #[schemars(length(min = 1, max = 2))]
        schemes: Vec<ExtensionHostExternalUriSchemeDto>,
        #[schemars(length(min = 1, max = 512))]
        label: String,
    },
    DataChannel {
        #[schemars(length(min = 1, max = 256))]
        channel_id: String,
    },
    LinkPresentationProvider {
        #[schemars(length(min = 1, max = 2048))]
        uri_pattern: String,
        #[schemars(length(min = 1, max = 32))]
        presentation_kind: String,
    },
    Command {
        #[schemars(length(min = 1, max = 256))]
        command: String,
        #[schemars(length(min = 1, max = 512))]
        title: String,
    },
    LanguageProvider {
        #[schemars(length(min = 1, max = 64))]
        language_ids: Vec<String>,
        #[schemars(length(min = 1, max = 32))]
        operations: Vec<ExtensionHostLanguageProviderOperationDto>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[schemars(length(max = 64))]
        completion_trigger_characters: Vec<String>,
    },
    DebugAdapter {
        #[schemars(length(min = 1, max = 256))]
        debugger_type: String,
    },
    TaskProvider {
        #[schemars(length(min = 1, max = 256))]
        task_type: String,
    },
    TestProfileProvider {
        #[schemars(length(min = 1, max = 256))]
        provider_id: String,
        #[schemars(length(min = 1, max = 512))]
        label: String,
    },
}

/// URL schemes admitted by the external URI opener registration.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionHostExternalUriSchemeDto {
    Http,
    Https,
}

/// Language provider operations supported by the v1 invocation broker seam.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionHostLanguageProviderOperationDto {
    Diagnostics,
    SelectionRanges,
    DocumentHighlights,
    WorkspaceSymbols,
    Completion,
    ParameterHints,
    Definition,
    Hover,
    References,
    Rename,
    Formatting,
    CodeAction,
    CodeLens,
    DocumentSymbols,
    FoldingRanges,
    DocumentLinks,
    DocumentColors,
    SemanticTokens,
    InlayHints,
    LinkedEditing,
}

/// Starts one non-blocking provider invocation fenced to an exact runtime snapshot.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostInvokeStartParams {
    #[schemars(length(min = 1, max = 256))]
    pub extension_id: String,
    #[schemars(length(min = 1, max = 256))]
    pub registration_id: String,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub activation_generation: u64,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub incarnation: u64,
    #[schemars(length(min = 1, max = 128))]
    pub operation: String,
    #[ts(type = "unknown")]
    pub payload: Value,
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub deadline_unix_millis: u64,
}

/// Opaque connection-owned identity allocated without waiting for the provider result.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostInvokeStartResult {
    #[schemars(length(min = 1, max = 256))]
    pub invocation_id: String,
}

/// Reads one invocation state. A terminal read releases the connection-owned session.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostInvokeReadParams {
    #[schemars(length(min = 1, max = 256))]
    pub invocation_id: String,
}

/// Non-blocking result of polling one provider invocation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "state", deny_unknown_fields)]
pub enum ExtensionHostInvokeReadResult {
    Pending,
    Succeeded {
        #[ts(type = "unknown")]
        payload: Value,
    },
    Failed {
        code: ExtensionHostFailureCodeDto,
        #[schemars(length(min = 1, max = 4096))]
        message: String,
    },
    Cancelled {
        reason: ExtensionHostCancellationReasonDto,
    },
}

/// Requests cancellation of one connection-owned provider invocation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostInvokeCancelParams {
    #[schemars(length(min = 1, max = 256))]
    pub invocation_id: String,
}

/// Whether cancellation was newly requested or the session was already terminal.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostInvokeCancelResult {
    pub disposition: ExtensionHostInvokeCancelDispositionDto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionHostInvokeCancelDispositionDto {
    Requested,
    AlreadyTerminal,
}

/// Observable reason why an invocation reached the cancelled terminal state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionHostCancellationReasonDto {
    Caller,
    Deadline,
    AuthorityRevoked,
    Shutdown,
}

/// Notification that a newer complete Extension Host fleet generation is available.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostChanged {
    #[schemars(range(min = 1))]
    #[ts(type = "number")]
    pub generation: u64,
}

#[cfg(test)]
#[path = "extension_host_tests.rs"]
mod tests;
