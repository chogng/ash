use ash_ui_components::InputBoxState;
use ash_ui_components::InteractionRegion;
use zui::ui::AccessibilityRole;
use zui::ui::CaretVisibility;
use zui::ui::CursorFeedback;
use zui::ui::ElementId;
use zui::ui::FocusBehavior;
use zui::ui::NavigationAxis;
use zui::ui::NavigationGroupId;
use zui::ui::NodeAction;
use zui::ui::Rect;
use zui::ui::UiDispatch;

use crate::remote::remote_connection_manager::REMOTE_CONNECTION_MANAGER;
use crate::remote::remote_connection_manager::REMOTE_CONNECTION_MANAGER_STATUS;

pub(crate) fn input_state(
    dispatch: &UiDispatch,
    id: ElementId,
    caret_visibility: CaretVisibility,
) -> InputBoxState {
    if dispatch.is_focused(id) {
        InputBoxState::Focused(caret_visibility)
    } else if dispatch.is_hovered(id) {
        InputBoxState::Hovered
    } else {
        InputBoxState::Resting
    }
}

pub(crate) fn button_region(
    id: ElementId,
    bounds: Rect,
    label: &str,
    navigation: NavigationGroupId,
    enabled: bool,
) -> InteractionRegion {
    let region = InteractionRegion::new(
        "RemoteConnectionManagerButton",
        id,
        bounds,
        AccessibilityRole::Button,
        label,
    )
    .with_cursor(CursorFeedback::Pointer)
    .with_focus(FocusBehavior::TabStop)
    .with_navigation(navigation, NavigationAxis::Horizontal);
    if enabled {
        region.with_action(NodeAction::Activate)
    } else {
        region
    }
}

pub(crate) fn input_region(
    id: ElementId,
    bounds: Rect,
    label: &str,
    value: &str,
    navigation: NavigationGroupId,
) -> InteractionRegion {
    InteractionRegion::new(
        "RemoteConnectionManagerInput",
        id,
        bounds,
        AccessibilityRole::TextInput,
        label,
    )
    .with_cursor(CursorFeedback::Text)
    .with_focus(FocusBehavior::TabStop)
    .with_navigation(navigation, NavigationAxis::Vertical)
    .with_value(value)
}

pub(crate) fn status_region(bounds: Rect, label: &str) -> InteractionRegion {
    InteractionRegion::new(
        "RemoteConnectionManagerStatus",
        REMOTE_CONNECTION_MANAGER_STATUS,
        bounds,
        AccessibilityRole::Group,
        label,
    )
    .with_parent(REMOTE_CONNECTION_MANAGER)
}
