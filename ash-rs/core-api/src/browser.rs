use ash_async_utils::CancellationToken;
use std::fmt;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct BrowserTargetId(pub String);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateBrowserTargetRequest {
    pub url: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateBrowserTargetResult {
    pub target_id: BrowserTargetId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ElementTarget {
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
    pub screenshot: Option<MediaResource>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TextInputTarget {
    Element(ElementTarget),
    FocusedElement,
}

#[derive(Clone, Debug, PartialEq)]
pub enum BrowserAction {
    Navigate {
        target_id: BrowserTargetId,
        url: String,
    },
    Click {
        target_id: BrowserTargetId,
        target: ElementTarget,
    },
    TypeText {
        target_id: BrowserTargetId,
        target: TextInputTarget,
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserActionResult {
    pub target_id: BrowserTargetId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MediaResource {
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
/// enforcing target ownership, origin policy, deadlines, and cancellation. They must never expose
/// arbitrary CDP commands to Core or let a closed target silently resolve to a different tab.
pub trait BrowserCapability: Send + Sync {
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
    fn close_target(
        &self,
        target_id: BrowserTargetId,
        cancellation: &CancellationToken,
    ) -> Result<(), BrowserError>;
}
