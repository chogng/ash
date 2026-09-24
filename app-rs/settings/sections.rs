use ash_ui_components::ScrollState;
use ash_ui_components::ScrollViewStyle;
use ash_ui_components::ScrollbarPresentation;
use ash_ui_theme::UiTheme;
use ash_ui_theme::UiTypography;
use zui::ui::AccessibilityRole;
use zui::ui::Border;
use zui::ui::Component;
use zui::ui::ComponentContext;
use zui::ui::ComponentElement;
use zui::ui::ComputedElement;
use zui::ui::CornerRadii;
use zui::ui::Element;
use zui::ui::ElementId;
use zui::ui::PaintRect;
use zui::ui::Rect;
use zui::ui::TextBlock;
use zui::ui::TextStyle;
use zui::ui::UiDispatch;
use zui::ui::UiNode;
use zui::ui::UiScene;

use crate::SETTINGS_PAGE;
use crate::SettingsPageSection;
use crate::keybindings_section::KeybindingsSection;
use crate::section_layout::ROW_HEIGHT;
use crate::section_layout::SettingsSectionLayout;

const SETTINGS_SECTION_SCOPE: u32 = 11;

pub const OPEN_MEMORIES: ElementId = ElementId::scoped(43, 1);

pub const SETTINGS_SECTION_CONTENT: ElementId = ElementId::scoped(SETTINGS_SECTION_SCOPE, 1);

#[derive(Clone, Debug, PartialEq)]
pub struct SettingsSectionStyle {
    pub background: zui::ui::Color,
    pub surface: zui::ui::Color,
    pub surface_raised: zui::ui::Color,
    pub surface_hovered: zui::ui::Color,
    pub border: zui::ui::Color,
    pub text: zui::ui::Color,
    pub text_muted: zui::ui::Color,
    pub accent: zui::ui::Color,
    pub error: zui::ui::Color,
    pub scroll_view: ScrollViewStyle,
    pub heading_text: TextStyle,
    pub body_text: TextStyle,
    pub control_text: TextStyle,
    pub label_text: TextStyle,
}

impl SettingsSectionStyle {
    pub fn from_theme(theme: UiTheme, typography: &UiTypography) -> Self {
        Self {
            background: theme.workbench_background,
            surface: theme.content_background,
            surface_raised: theme.side_bar_background,
            surface_hovered: theme.list_hover_background,
            border: theme.border,
            text: theme.foreground,
            text_muted: theme.muted_foreground,
            accent: theme.accent,
            error: theme.error,
            scroll_view: theme.file_list_scroll_view_style(),
            heading_text: typography.heading_text(theme.foreground),
            body_text: typography.body_text(theme.foreground),
            control_text: typography.control_text(theme.foreground),
            label_text: typography.label_text(theme.muted_foreground),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettingsKeybindingRow {
    pub element: ElementId,
    pub label: String,
    pub value: String,
}

pub struct SettingsSectionPane<'a> {
    bounds: Rect,
    section: SettingsPageSection,
    style: SettingsSectionStyle,
    directory_label: &'a str,
    connection_label: &'a str,
    surface_label: &'a str,
    keybinding_rows: &'a [SettingsKeybindingRow],
    keyboard_shortcuts_visible: bool,
    keybinding_diagnostics: &'a [String],
    theme_scheme: &'a str,
    theme_follows_system: bool,
    scroll_state: ScrollState,
    scrollbar_presentation: ScrollbarPresentation,
    dispatch: &'a UiDispatch,
}

impl<'a> SettingsSectionPane<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        bounds: Rect,
        section: SettingsPageSection,
        style: SettingsSectionStyle,
        directory_label: &'a str,
        connection_label: &'a str,
        surface_label: &'a str,
        keybinding_rows: &'a [SettingsKeybindingRow],
        keyboard_shortcuts_visible: bool,
        keybinding_diagnostics: &'a [String],
        theme_scheme: &'a str,
        theme_follows_system: bool,
        scroll_state: ScrollState,
        scrollbar_presentation: ScrollbarPresentation,
        dispatch: &'a UiDispatch,
    ) -> Self {
        Self {
            bounds,
            section,
            style,
            directory_label,
            connection_label,
            surface_label,
            keybinding_rows,
            keyboard_shortcuts_visible,
            keybinding_diagnostics,
            theme_scheme,
            theme_follows_system,
            scroll_state,
            scrollbar_presentation,
            dispatch,
        }
    }

    fn content_bounds(&self) -> Rect {
        SettingsSectionLayout::new(self.bounds).content()
    }

    fn paint_section(&self, scene: &mut UiScene) {
        match self.section {
            SettingsPageSection::General => self.paint_general(scene),
            SettingsPageSection::Appearance => self.paint_appearance(scene),
            SettingsPageSection::Keybindings => self.paint_keybindings_header(scene),
            SettingsPageSection::Remote => {}
        }
    }

    fn paint_general(&self, scene: &mut UiScene) {
        self.paint_header(
            scene,
            "General",
            "Environment and session defaults for this app window.",
        );
        let rows = [
            ("Directory", self.directory_label.to_owned()),
            ("Connection", self.connection_label.to_owned()),
            ("Surface", self.surface_label.to_owned()),
        ];
        self.paint_value_card(scene, 92.0, &rows);
        scene.draw_component(&self.memories_button());
    }

    fn memories_bounds(&self) -> Rect {
        let bounds = self.content_bounds();
        Rect::from_xywh(
            bounds.origin.x,
            bounds.origin.y + 92.0 + card_height(3) + 20.0,
            180.0,
            34.0,
        )
    }
    fn memories_button(&self) -> ash_ui_components::Button {
        let state = if self.dispatch.is_pressed(OPEN_MEMORIES) {
            ash_ui_components::ButtonState::Pressed
        } else if self.dispatch.is_hovered(OPEN_MEMORIES) {
            ash_ui_components::ButtonState::Hovered
        } else if self.dispatch.is_focused(OPEN_MEMORIES) {
            ash_ui_components::ButtonState::Focused
        } else {
            ash_ui_components::ButtonState::Resting
        };
        ash_ui_components::Button::new(
            self.memories_bounds(),
            "Manage memories",
            state,
            ash_ui_components::ButtonStyle::new(
                ash_ui_components::ButtonBackgrounds::new(self.style.surface_raised)
                    .with_hovered(self.style.surface_hovered)
                    .with_focused(self.style.surface_hovered),
                self.style.control_text.clone(),
            )
            .with_border(Border::uniform(1.0, self.style.border))
            .with_corner_radii(CornerRadii::uniform(4.0)),
        )
    }

    fn paint_appearance(&self, scene: &mut UiScene) {
        self.paint_header(
            scene,
            "Appearance",
            "Theme and visual language used by the current window.",
        );
        let theme = if self.theme_follows_system {
            format!("System ({})", self.theme_scheme)
        } else {
            format!("Custom ({})", self.theme_scheme)
        };
        let rows = [
            ("Theme", theme),
            ("Accent", "Current window accent".to_owned()),
        ];
        self.paint_value_card(scene, 92.0, &rows);
        let swatch_y = self.content_bounds().origin.y + 92.0 + card_height(rows.len()) + 24.0;
        let swatch_bounds = Rect::from_xywh(
            self.content_bounds().origin.x,
            swatch_y,
            self.content_bounds().size.width,
            74.0,
        );
        scene.draw_rect(
            PaintRect::new(swatch_bounds, self.style.surface)
                .with_border(Border::uniform(1.0, self.style.border))
                .with_corner_radii(CornerRadii::uniform(6.0)),
        );
        draw_label(
            scene,
            "Current palette",
            Rect::from_xywh(
                swatch_bounds.origin.x + 14.0,
                swatch_bounds.origin.y + 12.0,
                160.0,
                18.0,
            ),
            self.style.label_text.clone(),
        );
        for (index, color) in [
            self.style.background,
            self.style.surface,
            self.style.surface_raised,
            self.style.accent,
        ]
        .into_iter()
        .enumerate()
        {
            scene.draw_rect(
                PaintRect::new(
                    Rect::from_xywh(
                        swatch_bounds.origin.x + 14.0 + index as f32 * 42.0,
                        swatch_bounds.origin.y + 38.0,
                        30.0,
                        22.0,
                    ),
                    color,
                )
                .with_border(Border::uniform(1.0, self.style.border))
                .with_corner_radii(CornerRadii::uniform(4.0)),
            );
        }
    }

    fn paint_keybindings_header(&self, scene: &mut UiScene) {
        self.paint_header(
            scene,
            "Keybindings",
            "Current commands and shortcuts. Select a row to record a new shortcut.",
        );
    }

    fn paint_header(&self, scene: &mut UiScene, title: &str, description: &str) {
        let content = self.content_bounds();
        draw_label(
            scene,
            title,
            Rect::from_xywh(content.origin.x, content.origin.y, content.size.width, 30.0),
            self.style.heading_text.clone(),
        );
        draw_label(
            scene,
            description,
            Rect::from_xywh(
                content.origin.x,
                content.origin.y + 38.0,
                content.size.width,
                22.0,
            ),
            self.style
                .body_text
                .clone()
                .with_color(self.style.text_muted),
        );
    }

    fn paint_value_card(&self, scene: &mut UiScene, y_offset: f32, rows: &[(&str, String)]) {
        let content = self.content_bounds();
        let bounds = Rect::from_xywh(
            content.origin.x,
            content.origin.y + y_offset,
            content.size.width,
            card_height(rows.len()),
        );
        scene.draw_rect(
            PaintRect::new(bounds, self.style.surface)
                .with_border(Border::uniform(1.0, self.style.border))
                .with_corner_radii(CornerRadii::uniform(6.0)),
        );
        for (index, (label, value)) in rows.iter().enumerate() {
            let row_y = bounds.origin.y + 12.0 + index as f32 * ROW_HEIGHT;
            draw_label(
                scene,
                label,
                Rect::from_xywh(bounds.origin.x + 14.0, row_y, 150.0, 20.0),
                self.style.label_text.clone(),
            );
            draw_label(
                scene,
                value,
                Rect::from_xywh(
                    bounds.origin.x + 168.0,
                    row_y,
                    (bounds.size.width - 182.0).max(1.0),
                    20.0,
                ),
                self.style.body_text.clone(),
            );
        }
    }
}

impl Component for SettingsSectionPane<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("SettingsSectionPane")
            .in_bounds(self.bounds)
            .with_identity(SETTINGS_SECTION_CONTENT)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                SETTINGS_SECTION_CONTENT,
                element.bounds(),
                AccessibilityRole::Group,
                self.section_label(),
            )
            .with_parent(SETTINGS_PAGE),
        )
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        self.paint_section(context.scene_mut());
        if self.section == SettingsPageSection::General {
            context.draw_component(
                &ash_ui_components::InteractionRegion::new(
                    "OpenMemories",
                    OPEN_MEMORIES,
                    self.memories_bounds(),
                    AccessibilityRole::Button,
                    "Manage memories",
                )
                .with_parent(SETTINGS_SECTION_CONTENT)
                .with_focus(zui::ui::FocusBehavior::TabStop)
                .with_action(zui::ui::NodeAction::Activate),
            );
        }
        if self.section == SettingsPageSection::Keybindings {
            context.draw_component(&self.keybindings_section());
        }
    }

    fn paint(&self, scene: &mut UiScene) {
        self.paint_section(scene);
        if self.section == SettingsPageSection::Keybindings {
            scene.draw_component(&self.keybindings_section());
        }
    }
}

impl SettingsSectionPane<'_> {
    fn keybindings_section(&self) -> KeybindingsSection<'_> {
        KeybindingsSection::new(
            SettingsSectionLayout::new(self.bounds).keybindings_list(),
            self.keybinding_rows,
            self.keybinding_diagnostics,
            !self.keyboard_shortcuts_visible,
            self.scroll_state,
            self.scrollbar_presentation,
            self.style.clone(),
            self.dispatch,
        )
    }

    fn section_label(&self) -> &'static str {
        match self.section {
            SettingsPageSection::General => "General settings",
            SettingsPageSection::Appearance => "Appearance settings",
            SettingsPageSection::Keybindings => "Keybinding settings",
            SettingsPageSection::Remote => "Remote settings",
        }
    }
}

fn card_height(row_count: usize) -> f32 {
    24.0 + row_count as f32 * ROW_HEIGHT
}

fn draw_label(scene: &mut UiScene, text: &str, bounds: Rect, style: TextStyle) {
    scene.draw_text(TextBlock::new(
        text.to_owned(),
        bounds.origin,
        bounds.size,
        style,
    ));
}

#[cfg(test)]
#[path = "sections_tests.rs"]
mod tests;
