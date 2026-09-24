//! Pane containers, groups, inputs, and split-tree state.

mod pane_container;
mod pane_group;
mod pane_input;
mod pane_part;

pub(crate) use pane_container::PaneContainer;
pub(crate) use pane_group::{PaneGroup, PaneInputId};
pub(crate) use pane_input::{PaneInput, PaneInputKind};
pub(crate) use pane_part::{
    Pane, PaneGroupId, PaneNode, PanePart, PaneSplitDirection, PaneSplitId,
};
