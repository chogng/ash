mod action;
mod matcher;
mod preview;
mod state;
mod view;

pub(crate) use action::ListSelection;
pub(crate) use action::ListSelectionOutcome;
pub(crate) use action::ListSelectionSpec;
pub(crate) use preview::ListSelectionPreview;
pub(crate) use state::ListSelectionAdjustment;
pub(crate) use state::ListSelectionGroup;
pub(crate) use state::ListSelectionInputOutcome;
pub(crate) use state::ListSelectionItem;
pub(crate) use state::ListSelectionItemId;
pub(crate) use state::ListSelectionModel;
pub(crate) use state::ListSelectionState;
pub(crate) use view::ListSelectionPointerTarget;
pub(crate) use view::draw_body_with_pointer;
pub(crate) use view::draw_tabs;
pub(crate) use view::item_style;
pub(crate) use view::pointer_target_at;

/// Completed pointer activation delivered by the input host to a list owner.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ListSelectionClick {
    Single,
    Double,
}
