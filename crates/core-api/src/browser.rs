use ash_async_utils::CancellationToken;
use ash_protocol::SessionId;
use std::fmt;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct BrowserTargetId(pub String);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateBrowserTargetRequest {
    pub url: String,
    pub canvas: Option<BrowserCanvasPresentation>,
}

/// Presentation supplied by a task opening an interactive page beside its conversation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserCanvasPresentation {
    pub session_id: SessionId,
    pub instance_id: String,
    pub title: String,
    pub definition: Option<BrowserCanvasDefinitionId>,
}

/// An admitted extension's stable Canvas type; it never contains a page URL or task identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserCanvasDefinitionId {
    pub extension_id: String,
    pub canvas_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserCanvasDefinition {
    pub id: BrowserCanvasDefinitionId,
    pub display_name: String,
    pub description: String,
    pub requires_input: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateBrowserTargetResult {
    pub target_id: BrowserTargetId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserElementTarget {
    pub node_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserObserveRequest {
    pub target_id: BrowserTargetId,
    pub include_accessibility_tree: bool,
    pub include_dom_snapshot: bool,
    pub include_screenshot: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserObservation {
    pub target_id: BrowserTargetId,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub accessibility_tree: Option<String>,
    pub dom_snapshot: Option<String>,
    pub screenshot: Option<BrowserMediaResource>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BrowserTextInputTarget {
    Element(BrowserElementTarget),
    FocusedElement,
}

#[derive(Clone, Debug, PartialEq)]
pub enum BrowserAction {
    /// Explicitly enabled protocol access, scoped to the task's isolated browser pages.
    Cdp {
        target_id: BrowserTargetId,
        operation: BrowserCdpOperation,
    },
    Navigate {
        target_id: BrowserTargetId,
        url: String,
    },
    Click {
        target_id: BrowserTargetId,
        target: BrowserElementTarget,
    },
    Hover {
        target_id: BrowserTargetId,
        target: BrowserElementTarget,
    },
    Drag {
        target_id: BrowserTargetId,
        source: BrowserElementTarget,
        destination: BrowserElementTarget,
    },
    HandleDialog {
        target_id: BrowserTargetId,
        accept: bool,
        prompt_text: Option<String>,
    },
    RunPlaywright {
        target_id: BrowserTargetId,
        code: String,
    },
    TypeText {
        target_id: BrowserTargetId,
        target: BrowserTextInputTarget,
        text: String,
    },
    Scroll {
        target_id: BrowserTargetId,
        delta_x: f64,
        delta_y: f64,
    },
    GoBack {
        target_id: BrowserTargetId,
    },
    Reload {
        target_id: BrowserTargetId,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum BrowserCdpOperation {
    Command {
        method: String,
        params: serde_json::Map<String, serde_json::Value>,
        session_id: Option<String>,
    },
    ReadEvents,
    Close,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserActionResult {
    pub target_id: BrowserTargetId,
    pub output: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserMediaResource {
    pub resource_id: String,
    pub mime_type: String,
    pub size: u64,
    pub digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BrowserError {
    CapabilityUnavailable,
    TargetUnavailable(BrowserTargetId),
    PolicyDenied(String),
    Cancelled(String),
    TimedOut,
    Failed(String),
}

impl fmt::Display for BrowserError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CapabilityUnavailable => formatter.write_str("browser capability unavailable"),
            Self::TargetUnavailable(target) => {
                write!(formatter, "browser target unavailable: {}", target.0)
            }
            Self::PolicyDenied(reason) => {
                write!(formatter, "browser action denied by policy: {reason}")
            }
            Self::Cancelled(reason) => write!(formatter, "browser action cancelled: {reason}"),
            Self::TimedOut => formatter.write_str("browser action timed out"),
            Self::Failed(reason) => formatter.write_str(reason),
        }
    }
}
impl std::error::Error for BrowserError {}

/// Host-provided browser operations used by the Agent.
///
/// Implementations translate these semantic requests into a local or remote browser backend while
/// enforcing target ownership, origin policy, deadlines, and cancellation. Protocol access requires
/// a separate explicit host grant; a closed target must never silently resolve to a different tab.
pub trait BrowserCapability: Send + Sync {
    /// Returns `None` while the originating host's extension registry is unsettled.
    fn list_canvases(
        &self,
        _session: &SessionId,
        _cancellation: &CancellationToken,
    ) -> Result<Option<Vec<BrowserCanvasDefinition>>, BrowserError> {
        Err(BrowserError::CapabilityUnavailable)
    }
    fn create_target(
        &self,
        request: CreateBrowserTargetRequest,
        cancellation: &CancellationToken,
    ) -> Result<CreateBrowserTargetResult, BrowserError>;
    fn observe(
        &self,
        request: BrowserObserveRequest,
        cancellation: &CancellationToken,
    ) -> Result<BrowserObservation, BrowserError>;
    fn perform(
        &self,
        action: BrowserAction,
        cancellation: &CancellationToken,
    ) -> Result<BrowserActionResult, BrowserError>;
    /// Lists only targets the originating task may observe; page state still comes from the host.
    fn list_targets(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Vec<BrowserObservation>, BrowserError>;
    fn close_target(
        &self,
        target_id: BrowserTargetId,
        cancellation: &CancellationToken,
    ) -> Result<(), BrowserError>;
}
