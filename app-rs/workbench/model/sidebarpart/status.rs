//! Session manager status shown with a Sidebar item.

pub use ash_protocol::SessionManagerStatus as TabStatusKind;

/// Application-supplied status shown by the Workbench tab chrome.
///
/// Workbench owns the status label, icon, color, tooltip, and accessibility presentation while the
/// App Server owns the underlying Session manager state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TabStatus {
    kind: TabStatusKind,
}

impl Default for TabStatus {
    fn default() -> Self {
        Self::new(TabStatusKind::Idle)
    }
}

impl TabStatus {
    pub const fn new(kind: TabStatusKind) -> Self {
        Self { kind }
    }

    pub const fn kind(&self) -> TabStatusKind {
        self.kind
    }

    pub const fn label(&self) -> &'static str {
        match self.kind {
            TabStatusKind::Idle => "Idle",
            TabStatusKind::NeedsInput => "Needs input",
            TabStatusKind::Working => "Working",
            TabStatusKind::ReadyForReview => "Ready for review",
            TabStatusKind::Completed => "Completed",
            TabStatusKind::Failed => "Failed",
            TabStatusKind::Stopped => "Stopped",
        }
    }
}

impl From<TabStatusKind> for TabStatus {
    fn from(kind: TabStatusKind) -> Self {
        Self::new(kind)
    }
}
