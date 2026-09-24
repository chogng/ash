use ash_ui_components::ScrollMetrics;
use zui::ui::CaretVisibility;
use zui::ui::ComponentContext;
use zui::ui::ElementId;
use zui::ui::Rect;
use zui::ui::TextInputLayoutEngine;
use zui::ui::UiDispatch;

use crate::SETTINGS_SEARCH_INPUT;
use crate::SettingsKeybindingRow;
use crate::SettingsPage;
use crate::SettingsPageSection;
use crate::SettingsPageStyle;
use crate::SettingsSectionPane;
use crate::SettingsSectionStyle;
use crate::SettingsState;
use crate::remote::RemoteConnectionManager;
use crate::remote::RemoteConnectionManagerField;
use crate::remote::RemoteConnectionManagerState;
use crate::remote::RemoteUiStyle;
use crate::section_layout::SettingsSectionLayout;

/// Environment facts rendered by the General section.
pub struct GeneralSettingsSnapshot<'a> {
    pub directory_label: &'a str,
    pub connection_label: &'a str,
    pub surface_label: &'a str,
}

/// Theme facts rendered by the Appearance section.
pub struct AppearanceSettingsSnapshot<'a> {
    pub scheme: &'a str,
    pub follows_system: bool,
}

/// Command rows and diagnostics rendered by the Keybindings section.
pub struct KeybindingSettingsSnapshot<'a> {
    pub keybinding_rows: &'a [SettingsKeybindingRow],
    pub keybinding_diagnostics: &'a [String],
}

/// Remote connection editor state supplied by the product UI host.
pub struct RemoteSettingsSnapshot<'a> {
    pub connection_manager: &'a RemoteConnectionManagerState,
}

/// Section-scoped read-only values supplied by feature owners for one Settings frame.
pub struct SettingsFeatureSnapshot<'a> {
    pub general: GeneralSettingsSnapshot<'a>,
    pub appearance: AppearanceSettingsSnapshot<'a>,
    pub keybindings: KeybindingSettingsSnapshot<'a>,
    pub remote: RemoteSettingsSnapshot<'a>,
}

/// Styles for the page shell and its concrete sections.
#[derive(Clone, Debug, PartialEq)]
pub struct SettingsPaneStyle {
    page: SettingsPageStyle,
    section: SettingsSectionStyle,
    remote: RemoteUiStyle,
}

impl SettingsPaneStyle {
    pub const fn new(
        page: SettingsPageStyle,
        section: SettingsSectionStyle,
        remote: RemoteUiStyle,
    ) -> Self {
        Self {
            page,
            section,
            remote,
        }
    }
}

/// Inputs needed to render one Settings frame without transferring feature ownership.
pub struct SettingsPaneView<'a> {
    pub state: &'a SettingsState,
    pub keyboard_shortcuts_visible: bool,
    pub features: SettingsFeatureSnapshot<'a>,
    pub caret_visibility: CaretVisibility,
    pub dispatch: &'a UiDispatch,
}

/// Geometry returned to the product host for input-method integration.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SettingsPaneDrawResult {
    pub ime_cursor_area: Option<Rect>,
    pub remote_connection_scroll_metrics: Option<ScrollMetrics>,
    pub remote_connection_list_viewport: Option<Rect>,
}

pub fn draw_settings_pane(
    context: &mut ComponentContext<'_, '_>,
    bounds: Rect,
    header_height: f32,
    parent: ElementId,
    view: SettingsPaneView<'_>,
    style: SettingsPaneStyle,
    text_layout: &mut TextInputLayoutEngine,
) -> SettingsPaneDrawResult {
    let section = view.state.section();
    let page = SettingsPage::new_with_header_height_and_section(
        bounds,
        header_height,
        view.state.search_input(),
        view.caret_visibility,
        style.page,
        section,
        view.dispatch,
        text_layout,
    )
    .with_parent(parent);
    let mut result = SettingsPaneDrawResult {
        ime_cursor_area: view
            .dispatch
            .is_focused(SETTINGS_SEARCH_INPUT)
            .then(|| page.search_caret_bounds())
            .flatten(),
        remote_connection_scroll_metrics: None,
        remote_connection_list_viewport: None,
    };
    let content = page.content_bounds();
    context.draw_component(&page);
    if section == SettingsPageSection::Remote {
        if let Some(manager) = RemoteConnectionManager::new_settings(
            SettingsSectionLayout::new(content).content(),
            view.features.remote.connection_manager,
            view.caret_visibility,
            style.remote,
            text_layout,
            view.dispatch,
            crate::SETTINGS_PAGE,
        ) {
            result.remote_connection_scroll_metrics = Some(manager.list_scroll_metrics());
            result.remote_connection_list_viewport = Some(manager.list_viewport_bounds());
            for field in [
                RemoteConnectionManagerField::Name,
                RemoteConnectionManagerField::Host,
                RemoteConnectionManagerField::Directory,
            ] {
                if view.dispatch.is_focused(field.element_id()) {
                    result.ime_cursor_area = manager.caret_bounds(field);
                }
            }
            context.draw_component(&manager);
        }
    } else {
        context.draw_component(&SettingsSectionPane::new(
            content,
            section,
            style.section,
            view.features.general.directory_label,
            view.features.general.connection_label,
            view.features.general.surface_label,
            view.features.keybindings.keybinding_rows,
            view.keyboard_shortcuts_visible,
            view.features.keybindings.keybinding_diagnostics,
            view.features.appearance.scheme,
            view.features.appearance.follows_system,
            view.state.keybindings_scroll_state(),
            view.state.keybindings_scrollbar_presentation(),
            view.dispatch,
        ));
    }
    result
}
