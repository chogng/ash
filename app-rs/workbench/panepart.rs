//! PanePart's structural view projection.
//!
//! Pane topology remains owned by [`crate::PanePart`]. This module converts that topology into
//! leaf and sash geometry for the current frame; it does not own pane content or its runtime.

mod identity;
mod layout;
mod resize;
mod ui;

pub use identity::pane_group_element_id;
pub use identity::pane_sash_element_id;
pub use layout::PaneGroupLayout;
pub use resize::PaneResizeState;
pub use ui::PanePartSashes;
