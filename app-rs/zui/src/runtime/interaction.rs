//! Backend-neutral interaction state and presentation semantics.
//!
//! The product host registers one immutable [`InteractionFrame`] after layout, routes platform
//! events through [`UiDispatch`], and maps the resulting [`UiIntent`] to product state changes.
//! This module owns no platform adapter, command registry, or product model.

mod dispatch;
mod frame;
mod types;

pub use crate::ui::foundation::ElementId;
pub use dispatch::DispatchOutcome;
pub use dispatch::FocusDirection;
pub use dispatch::UiDispatch;
pub use frame::AccessibilityNode;
pub use frame::InteractionFrame;
pub use frame::InteractionFrameCheckpoint;
pub use types::AccessibilityExpansion;
pub use types::AccessibilityRole;
pub use types::AccessibilitySelection;
pub use types::CursorFeedback;
pub use types::DispatchInvalidation;
pub use types::FocusBehavior;
pub use types::NavigationAxis;
pub use types::NavigationGroupId;
pub use types::NodeAction;
pub use types::UiIntent;
pub use types::UiNode;

#[cfg(test)]
#[path = "interaction_tests.rs"]
mod tests;
