//! Settings navigation presentation helpers.

use super::SETTINGS_NAV_APPEARANCE;
use super::SETTINGS_NAV_GENERAL;
use super::SETTINGS_NAV_KEYBINDINGS;
use super::SETTINGS_NAV_REMOTE;
use super::SettingsPageLayout;
use super::SettingsPageSection;

use ash_icons::icons;
use ash_ui_components::Button;
use ash_ui_components::ButtonSelection;
use ash_ui_components::ButtonState;
use ash_ui_components::ButtonStyle;
use zui::ui::ElementId;
use zui::ui::UiDispatch;

pub(super) fn navigation_buttons(
    layout: SettingsPageLayout,
    section: SettingsPageSection,
    dispatch: &UiDispatch,
    style: &ButtonStyle,
) -> [Button; 4] {
    [
        navigation_button(
            layout.navigation_bounds(0),
            SETTINGS_NAV_GENERAL,
            icons::GEAR,
            "General",
            section == SettingsPageSection::General,
            dispatch,
            style,
        ),
        navigation_button(
            layout.navigation_bounds(1),
            SETTINGS_NAV_APPEARANCE,
            icons::APPEARANCE,
            "Appearance",
            section == SettingsPageSection::Appearance,
            dispatch,
            style,
        ),
        navigation_button(
            layout.navigation_bounds(2),
            SETTINGS_NAV_KEYBINDINGS,
            icons::COMMAND,
            "Keybindings",
            section == SettingsPageSection::Keybindings,
            dispatch,
            style,
        ),
        navigation_button(
            layout.navigation_bounds(3),
            SETTINGS_NAV_REMOTE,
            icons::REMOTE,
            "Remote",
            section == SettingsPageSection::Remote,
            dispatch,
            style,
        ),
    ]
}

fn navigation_button(
    bounds: zui::ui::Rect,
    id: ElementId,
    icon: ash_icons::Icon,
    label: &str,
    selected: bool,
    dispatch: &UiDispatch,
    style: &ButtonStyle,
) -> Button {
    let state = button_state(id, true, dispatch);
    Button::icon_and_label(bounds, icon, label, state, style.clone()).with_selection(if selected {
        ButtonSelection::Selected
    } else {
        ButtonSelection::Unselected
    })
}

pub(super) fn button_state(id: ElementId, enabled: bool, dispatch: &UiDispatch) -> ButtonState {
    if !enabled {
        ButtonState::Disabled
    } else if dispatch.is_pressed(id) {
        ButtonState::Pressed
    } else if dispatch.is_focused(id) {
        ButtonState::Focused
    } else if dispatch.is_hovered(id) {
        ButtonState::Hovered
    } else {
        ButtonState::Resting
    }
}
