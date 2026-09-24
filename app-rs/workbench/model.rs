//! Private structural state for Workbench tabs, panes, and mounted content identities.

mod panepart;
mod sidebarpart;
mod state;

pub(crate) use panepart::{
    Pane, PaneContainer, PaneGroup, PaneGroupId, PaneInput, PaneInputId, PaneInputKind, PaneNode,
    PanePart, PaneSplitDirection, PaneSplitId,
};
pub(crate) use sidebarpart::{
    SidebarMode, SidebarPart, TabGroup, TabGroupId, TabId, TabInput, TabInputChange, TabInputKey,
    TabInputMetadata, TabStatus, TabStatusKind,
};
pub(crate) use state::{ClosedTab, Workbench};
