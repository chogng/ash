//! Versioned wire contract shared by the Ash extension host and extension SDK.
//! No installation, process management, or product implementation belongs here.

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

/// Current Ash Editor Extension Host protocol version.
pub const PROTOCOL_VERSION: u16 = 1;
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_OPERATION_BYTES: usize = 128;
const MAX_ACTIVATION_EVENTS: usize = 128;
const MAX_LANGUAGE_IDS: usize = 64;
const MAX_PROVIDER_OPERATIONS: usize = 32;
const MAX_DISPLAY_TEXT_BYTES: usize = 512;

mod client;
mod output;
pub use client::ExtensionClientOperation;
pub use client::ExtensionClientRequest;
pub use client::ExtensionClientResponse;
pub use client::ExtensionClientResult;
pub use client::ExtensionConfigurationTarget;
pub use client::ExtensionDocumentEdit;
pub use client::ExtensionDocumentSnapshot;
pub use client::ExtensionHostStdinFrame;
pub use client::ExtensionMessageSeverity;
pub use client::ExtensionTextEdit;
pub use client::ExtensionTextPosition;
mod transport;

pub use transport::read_frame;
pub use transport::write_frame;

/// Wire sizes accepted by both peers; process resource limits belong to the host.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProtocolLimits {
    pub maximum_frame_bytes: usize,
    pub maximum_payload_bytes: usize,
    pub maximum_registrations: usize,
}

impl Default for ProtocolLimits {
    fn default() -> Self {
        Self {
            maximum_frame_bytes: 1024 * 1024,
            maximum_payload_bytes: 512 * 1024,
            maximum_registrations: 256,
        }
    }
}

/// Invalid peer input or an exceeded wire quota.
#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("extension host protocol message is invalid: {0}")]
    InvalidProtocol(String),
    #[error("extension host quota exceeded: {0}")]
    QuotaExceeded(&'static str),
    #[error("extension host transport failed")]
    Transport(#[from] std::io::Error),
}
mod validation;

pub use output::ExtensionHostOutputEvent;
pub use output::HostEventContext;
pub use output::HostOutputChannelKind;
pub use output::HostOutputOperation;
pub use output::HostOutputSeverity;
pub use output::SequencedExtensionHostOutputEvent;

use validation::protocol_error;
use validation::validate_activation;
use validation::validate_encoded_size;
use validation::validate_identifier;
use validation::validate_registrations;
use validation::validate_response_kind;
use validation::validate_short_text;

/// Correlation and stale-process fence carried by every host request and response.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestContext {
    pub protocol_version: u16,
    pub request_id: u64,
    pub incarnation: u64,
    pub activation_generation: u64,
}

impl RequestContext {
    pub fn new(request_id: u64, incarnation: u64, activation_generation: u64) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            incarnation,
            activation_generation,
        }
    }

    pub fn validate(self) -> Result<(), ProtocolError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(protocol_error("unsupported protocol version"));
        }
        if self.request_id == 0 || self.incarnation == 0 || self.activation_generation == 0 {
            return Err(protocol_error(
                "request, incarnation, and activation generation must be non-zero",
            ));
        }
        Ok(())
    }
}

/// Exact immutable package identity disclosed to its own runtime process.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageBinding {
    pub package_id: String,
    pub package_digest: String,
    pub entrypoint: String,
}

/// Handshake parameters for one freshly spawned process incarnation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitializeParams {
    pub extension_id: String,
    pub runtime_api_version: u16,
}

/// Successful handshake returned only by the requested process incarnation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitializeResult {
    pub protocol_version: u16,
    pub runtime_api_version: u16,
}

/// Exact activation request sent after authority admission and handshake.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivateParams {
    pub extension_id: String,
    pub package: PackageBinding,
    pub runtime_api_version: u16,
    pub activation_events: Vec<String>,
    pub capabilities: Vec<ExtensionCapability>,
}

/// Manifest-declared ceiling on the registration kinds returned by one runtime process.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionCapability {
    Command,
    LanguageProvider,
    DebugAdapter,
    TaskProvider,
    TestProfileProvider,
    DataChannel,
    LinkPresentationProvider,
    ExternalUriOpener,
}

/// Language provider operations understood by the v1 broker seam.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LanguageProviderOperation {
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

/// One runtime registration returned atomically from activation.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationDescriptor {
    pub registration_id: String,
    #[serde(flatten)]
    pub kind: RegistrationKind,
}

impl<'de> Deserialize<'de> for RegistrationDescriptor {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            registration_id: String,
            #[serde(flatten)]
            kind: serde_json::Map<String, Value>,
        }
        // Internally tagged enums do not consume flattened fields for an outer deny_unknown_fields.
        // Decode the remaining fields through the strict enum so valid variants and unknown fields stay distinct.
        let wire = Wire::deserialize(deserializer)?;
        let kind =
            serde_json::from_value(Value::Object(wire.kind)).map_err(serde::de::Error::custom)?;
        Ok(Self {
            registration_id: wire.registration_id,
            kind,
        })
    }
}

/// Narrow v1 contribution types that App Server brokers can project to domain owners.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    deny_unknown_fields
)]
pub enum RegistrationKind {
    ExternalUriOpener {
        schemes: Vec<ExternalUriScheme>,
        label: String,
    },
    DataChannel {
        channel_id: String,
    },
    LinkPresentationProvider {
        uri_pattern: String,
        presentation_kind: String,
    },
    Command {
        command: String,
        title: String,
    },
    LanguageProvider {
        language_ids: Vec<String>,
        operations: Vec<LanguageProviderOperation>,
    },
    DebugAdapter {
        debugger_type: String,
    },
    TaskProvider {
        task_type: String,
    },
    TestProfileProvider {
        provider_id: String,
        label: String,
    },
}

/// URL schemes that contributed openers may handle; privileged schemes stay with the platform.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExternalUriScheme {
    Http,
    Https,
}

/// Registration set published only after the whole activation succeeds.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivateResult {
    pub registrations: Vec<RegistrationDescriptor>,
}

/// Invocation routed to one registration owned by the activated extension.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvokeParams {
    pub extension_id: String,
    pub registration_id: String,
    pub operation: String,
    pub payload: Value,
    pub deadline_unix_millis: u64,
}

/// JSON result returned by an extension registration invocation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvokeResult {
    pub payload: Value,
}

/// Why an in-flight request is being cancelled.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CancelReason {
    Caller,
    Deadline,
    AuthorityRevoked,
    Shutdown,
}

/// Cancellation targets one request in the same process incarnation and activation generation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelParams {
    pub target_request_id: u64,
    pub reason: CancelReason,
}

/// Typed v1 request methods.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "method", content = "params")]
pub enum HostRequestKind {
    Initialize(InitializeParams),
    Activate(ActivateParams),
    Deactivate,
    Invoke(InvokeParams),
    Cancel(CancelParams),
    Ping,
    Shutdown,
}

/// One request on the bounded process transport.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostRequest {
    #[serde(flatten)]
    pub context: RequestContext,
    #[serde(flatten)]
    pub request: HostRequestKind,
}

impl ExtensionHostRequest {
    pub fn validate(&self, limits: &ProtocolLimits) -> Result<(), ProtocolError> {
        self.context.validate()?;
        match &self.request {
            HostRequestKind::Initialize(params) => {
                validate_identifier(&params.extension_id)?;
                if params.runtime_api_version == 0 {
                    return Err(protocol_error("runtime API version must be non-zero"));
                }
            }
            HostRequestKind::Activate(params) => validate_activation(params)?,
            HostRequestKind::Invoke(params) => {
                validate_identifier(&params.extension_id)?;
                validate_identifier(&params.registration_id)?;
                validate_short_text(&params.operation, MAX_OPERATION_BYTES, "operation")?;
                if params.deadline_unix_millis == 0 {
                    return Err(protocol_error("invoke deadline must be non-zero"));
                }
                let payload_bytes = serde_json::to_vec(&params.payload)
                    .map_err(|error| protocol_error(error.to_string()))?
                    .len();
                if payload_bytes > limits.maximum_payload_bytes {
                    return Err(ProtocolError::QuotaExceeded("invoke payload bytes"));
                }
            }
            HostRequestKind::Cancel(params) if params.target_request_id == 0 => {
                return Err(protocol_error("cancel target request ID must be non-zero"));
            }
            HostRequestKind::Deactivate
            | HostRequestKind::Cancel(_)
            | HostRequestKind::Ping
            | HostRequestKind::Shutdown => {}
        }
        validate_encoded_size(self, limits.maximum_frame_bytes)
    }
}

/// Stable runtime error categories exposed over the host protocol.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostErrorCode {
    InvalidRequest,
    UnsupportedProtocolVersion,
    UnsupportedRuntimeApiVersion,
    ActivationFailed,
    RegistrationNotFound,
    OperationNotSupported,
    PermissionDenied,
    Cancelled,
    DeadlineExceeded,
    QuotaExceeded,
    Internal,
}

/// Sanitized runtime failure. Host implementation details and paths must not be included.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostFailure {
    pub code: HostErrorCode,
    pub message: String,
}

/// Typed successful response bodies.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "result", content = "body")]
pub enum HostSuccess {
    Initialized(InitializeResult),
    Activated(ActivateResult),
    Deactivated,
    Invoked(InvokeResult),
    Cancelled,
    Pong,
    Shutdown,
}

/// Exactly one success or failure outcome for a request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status", content = "body")]
pub enum HostResponseKind {
    Success(HostSuccess),
    Failure(HostFailure),
}

/// One response fenced to the request's process incarnation and activation generation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostResponse {
    #[serde(flatten)]
    pub context: RequestContext,
    #[serde(flatten)]
    pub response: HostResponseKind,
}

/// Frames that an extension may send on its dedicated stdout pipe.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum ExtensionHostStdoutFrame {
    Response(ExtensionHostResponse),
    Output(ExtensionHostOutputEvent),
    ClientRequest(ExtensionClientRequest),
}

impl ExtensionHostResponse {
    pub fn validate_for(
        &self,
        request: &ExtensionHostRequest,
        limits: &ProtocolLimits,
    ) -> Result<(), ProtocolError> {
        self.context.validate()?;
        if self.context != request.context {
            return Err(protocol_error(
                "response does not match request identity, incarnation, and generation",
            ));
        }
        if let HostResponseKind::Success(HostSuccess::Activated(result)) = &self.response {
            validate_registrations(
                &result.registrations,
                limits.maximum_registrations,
                match &request.request {
                    HostRequestKind::Activate(params) => &params.capabilities,
                    _ => {
                        return Err(protocol_error(
                            "activated response does not match an activate request",
                        ));
                    }
                },
            )?;
        }
        if let HostResponseKind::Success(HostSuccess::Invoked(result)) = &self.response {
            validate_encoded_size(&result.payload, limits.maximum_payload_bytes)?;
        }
        validate_response_kind(&request.request, &self.response)?;
        validate_encoded_size(self, limits.maximum_frame_bytes)
    }
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
