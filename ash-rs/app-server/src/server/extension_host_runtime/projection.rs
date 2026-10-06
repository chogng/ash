use ash_editor_extension_host::ExtensionHostError;
use ash_editor_extension_host::ExtensionHostSnapshot;
use ash_editor_extension_host::ExtensionHostStatus;
use ash_editor_extension_host::HostErrorCode;
use ash_editor_extension_host::RegistrationDescriptor;
use ash_editor_extension_host::SequencedExtensionHostOutputEvent;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::server) struct ExtensionHostFleetSnapshot {
    pub(in crate::server) generation: u64,
    pub(in crate::server) extensions: Vec<ExtensionHostExtensionSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::server) struct ExtensionHostExtensionSnapshot {
    pub(in crate::server) id: String,
    pub(in crate::server) version: String,
    pub(in crate::server) package_digest: String,
    pub(in crate::server) runtime_api_version: u16,
    pub(in crate::server) activation_generation: u64,
    pub(in crate::server) incarnation: Option<u64>,
    pub(in crate::server) lifecycle: ExtensionHostLifecycle,
    pub(in crate::server) activation: Option<super::source::ActivationPlan>,
    pub(in crate::server) failure: Option<ExtensionHostRuntimeFailure>,
    pub(in crate::server) stderr: String,
    pub(in crate::server) output_events: Vec<SequencedExtensionHostOutputEvent>,
    pub(in crate::server) registrations: Vec<RegistrationDescriptor>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::server) enum ExtensionHostLifecycle {
    Dormant,
    Stopped,
    Starting,
    Ready,
    Recovering,
    CrashLoop,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::server) struct ExtensionHostRuntimeFailure {
    pub(in crate::server) code: ExtensionHostFailureKind,
    pub(in crate::server) message: String,
    pub(in crate::server) incarnation: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::server) enum ExtensionHostFailureKind {
    AuthorityDenied,
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

pub(super) fn extension_projection(
    version: &str,
    snapshot: ExtensionHostSnapshot,
    failure: Option<ExtensionHostRuntimeFailure>,
) -> ExtensionHostExtensionSnapshot {
    let lifecycle = match (snapshot.status, failure.is_some()) {
        (ExtensionHostStatus::CrashLoop, _) => ExtensionHostLifecycle::CrashLoop,
        (_, true) => ExtensionHostLifecycle::Failed,
        (ExtensionHostStatus::Stopped, false) => ExtensionHostLifecycle::Stopped,
        (ExtensionHostStatus::Starting, false) => ExtensionHostLifecycle::Starting,
        (ExtensionHostStatus::Ready, false) => ExtensionHostLifecycle::Ready,
        (ExtensionHostStatus::Recovering, false) => ExtensionHostLifecycle::Recovering,
    };
    ExtensionHostExtensionSnapshot {
        id: snapshot.extension_id,
        version: version.to_string(),
        package_digest: snapshot.package.package_digest,
        runtime_api_version: snapshot.runtime_api_version,
        activation_generation: snapshot.activation_generation,
        incarnation: (snapshot.incarnation != 0).then_some(snapshot.incarnation),
        lifecycle,
        activation: None,
        failure,
        stderr: snapshot.stderr,
        output_events: snapshot.output_events,
        registrations: snapshot.registrations,
    }
}

pub(super) fn runtime_failure(
    error: &ExtensionHostError,
    incarnation: Option<u64>,
) -> ExtensionHostRuntimeFailure {
    let (code, message) = match error {
        ExtensionHostError::AuthorityDenied => (
            ExtensionHostFailureKind::AuthorityDenied,
            "extension authority was revoked",
        ),
        ExtensionHostError::CrashLoop => (
            ExtensionHostFailureKind::CrashLoop,
            "extension process exceeded its restart budget",
        ),
        ExtensionHostError::IsolationUnavailable => (
            ExtensionHostFailureKind::IsolationUnavailable,
            "required process isolation is unavailable",
        ),
        ExtensionHostError::InvalidLimits(_) | ExtensionHostError::RequestIdentityExhausted => (
            ExtensionHostFailureKind::Internal,
            "extension host configuration is invalid",
        ),
        ExtensionHostError::InvalidProtocol(_) => (
            ExtensionHostFailureKind::InvalidProtocol,
            "extension process violated Host RPC v1",
        ),
        ExtensionHostError::QuotaExceeded(_) => (
            ExtensionHostFailureKind::QuotaExceeded,
            "extension host quota was exceeded",
        ),
        ExtensionHostError::RequestTimedOut | ExtensionHostError::StartupTimedOut => (
            ExtensionHostFailureKind::DeadlineExceeded,
            "extension host request exceeded its deadline",
        ),
        ExtensionHostError::RegistrationNotFound => (
            ExtensionHostFailureKind::RegistrationNotFound,
            "extension registration was not found",
        ),
        ExtensionHostError::HostRejected { code, .. } => host_rejection(*code),
        ExtensionHostError::HostRestarted => (
            ExtensionHostFailureKind::HostRestarted,
            "extension process restarted",
        ),
        ExtensionHostError::HostExited | ExtensionHostError::Transport(_) => (
            ExtensionHostFailureKind::HostExited,
            "extension process exited",
        ),
        ExtensionHostError::OutcomeIndeterminate => (
            ExtensionHostFailureKind::OutcomeIndeterminate,
            "extension operation outcome is indeterminate",
        ),
        ExtensionHostError::SpawnFailed => (
            ExtensionHostFailureKind::LaunchFailed,
            "extension process could not be launched",
        ),
        ExtensionHostError::ShutdownTimedOut => (
            ExtensionHostFailureKind::HostExited,
            "extension process did not shut down in time",
        ),
    };
    ExtensionHostRuntimeFailure {
        code,
        message: message.into(),
        incarnation,
    }
}

fn host_rejection(code: HostErrorCode) -> (ExtensionHostFailureKind, &'static str) {
    match code {
        HostErrorCode::InvalidRequest | HostErrorCode::UnsupportedProtocolVersion => (
            ExtensionHostFailureKind::InvalidProtocol,
            "extension process rejected Host RPC v1",
        ),
        HostErrorCode::UnsupportedRuntimeApiVersion => (
            ExtensionHostFailureKind::HandshakeFailed,
            "extension runtime API version is unsupported",
        ),
        HostErrorCode::ActivationFailed => (
            ExtensionHostFailureKind::ActivationFailed,
            "extension activation failed",
        ),
        HostErrorCode::RegistrationNotFound => (
            ExtensionHostFailureKind::RegistrationNotFound,
            "extension registration was not found",
        ),
        HostErrorCode::OperationNotSupported => (
            ExtensionHostFailureKind::OperationNotSupported,
            "extension operation is unsupported",
        ),
        HostErrorCode::PermissionDenied => (
            ExtensionHostFailureKind::AuthorityDenied,
            "extension operation permission denied",
        ),
        HostErrorCode::Cancelled => (
            ExtensionHostFailureKind::Cancelled,
            "extension operation was cancelled",
        ),
        HostErrorCode::DeadlineExceeded => (
            ExtensionHostFailureKind::DeadlineExceeded,
            "extension operation exceeded its deadline",
        ),
        HostErrorCode::QuotaExceeded => (
            ExtensionHostFailureKind::QuotaExceeded,
            "extension host quota was exceeded",
        ),
        HostErrorCode::Internal => (
            ExtensionHostFailureKind::Internal,
            "extension process reported an internal failure",
        ),
    }
}
