use lsp_types::{
    ConfigurationItem, LogMessageParams, ProgressParams, PublishDiagnosticsParams,
    ShowMessageParams, WorkDoneProgressCreateParams,
};

use crate::LanguageServerCapabilitySnapshot;

/// A value returned for one `workspace/configuration` query item.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkspaceConfiguration(pub serde_json::Value);

/// Server-to-host events that do not complete a client request.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub enum LanguageServerEvent {
    Diagnostics(PublishDiagnosticsParams),
    LogMessage(LogMessageParams),
    ShowMessage(ShowMessageParams),
    DynamicCapabilitiesChanged(LanguageServerCapabilitySnapshot),
    WorkDoneProgressCreated(WorkDoneProgressCreateParams),
    Progress(ProgressParams),
    Telemetry(serde_json::Value),
    ServerStderr(String),
    /// The initialized protocol transport ended without a requested client shutdown.
    TransportClosed {
        message: String,
    },
    UnhandledNotification {
        method: String,
        params: serde_json::Value,
    },
    UnsupportedServerRequest {
        method: String,
    },
}

/// Product callbacks for server notifications and configuration reads.
///
/// Implementations must return quickly. Queue UI work from [`LanguageServerHost::on_event`]
/// instead of blocking the protocol driver. Configuration results must preserve item order; the
/// default returns JSON `null` for every requested section and scope.
pub trait LanguageServerHost: Send + Sync + 'static {
    fn on_event(&self, _event: LanguageServerEvent) {}

    fn workspace_configuration(&self, items: &[ConfigurationItem]) -> Vec<WorkspaceConfiguration> {
        items
            .iter()
            .map(|_| WorkspaceConfiguration(serde_json::Value::Null))
            .collect()
    }
}

/// Host implementation that ignores events and returns null workspace configuration.
#[derive(Debug, Default)]
pub struct NoopLanguageServerHost;

impl LanguageServerHost for NoopLanguageServerHost {}
