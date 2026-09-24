use ash_ui_components::ListView;
use ash_ui_components::ScrollState;
use ash_ui_components::ScrollViewStyle;
use ash_ui_components::ScrollbarLayout;
use ash_ui_components::ScrollbarPresentation;
use zui::ui::AccessibilityRole;
use zui::ui::Component;
use zui::ui::ComponentContext;
use zui::ui::ComponentElement;
use zui::ui::ComputedElement;
use zui::ui::CursorFeedback;
use zui::ui::Element;
use zui::ui::ElementId;
use zui::ui::FocusBehavior;
use zui::ui::FontFamily;
use zui::ui::NavigationAxis;
use zui::ui::NavigationGroupId;
use zui::ui::NodeAction;
use zui::ui::PaintRect;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::TextBlock;
use zui::ui::UiDispatch;
use zui::ui::UiNode;
use zui::ui::UiScene;

use crate::SETTINGS_SECTION_CONTENT;
use crate::SettingsKeybindingRow;
use crate::SettingsSectionStyle;
use crate::section_layout::ROW_HEIGHT;

const SETTINGS_SECTION_SCOPE: u32 = 11;

pub const SETTINGS_KEYBINDINGS_LIST: ElementId = ElementId::scoped(SETTINGS_SECTION_SCOPE, 2);
pub const SETTINGS_KEYBINDINGS_SCROLLBAR: ElementId = ElementId::scoped(SETTINGS_SECTION_SCOPE, 3);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SettingsKeybindingsViewport {
    bounds: Rect,
    item_count: usize,
    style: ScrollViewStyle,
}

impl SettingsKeybindingsViewport {
    pub fn new(
        bounds: Rect,
        keybinding_row_count: usize,
        diagnostic_count: usize,
        style: ScrollViewStyle,
    ) -> Self {
        Self {
            bounds,
            item_count: keybinding_row_count.saturating_add(usize::from(diagnostic_count > 0)),
            style,
        }
    }

    pub(crate) fn list(self, state: ScrollState, presentation: ScrollbarPresentation) -> ListView {
        ListView::new(self.bounds, self.item_count, ROW_HEIGHT, state, self.style)
            .with_scrollbar_presentation(presentation)
    }
}

pub type SettingsScrollbarPointerOutcome = ash_ui_components::ScrollbarInteractionOutcome;

pub(crate) struct KeybindingsSection<'a> {
    bounds: Rect,
    rows: &'a [SettingsKeybindingRow],
    diagnostics: &'a [String],
    interactions_enabled: bool,
    scroll_state: ScrollState,
    scrollbar_presentation: ScrollbarPresentation,
    style: SettingsSectionStyle,
    dispatch: &'a UiDispatch,
}

impl<'a> KeybindingsSection<'a> {
    #[allow(clippy::too_many_arguments)]
    pub(crate) const fn new(
        bounds: Rect,
        rows: &'a [SettingsKeybindingRow],
        diagnostics: &'a [String],
        interactions_enabled: bool,
        scroll_state: ScrollState,
        scrollbar_presentation: ScrollbarPresentation,
        style: SettingsSectionStyle,
        dispatch: &'a UiDispatch,
    ) -> Self {
        Self {
            bounds,
            rows,
            diagnostics,
            interactions_enabled,
            scroll_state,
            scrollbar_presentation,
            style,
            dispatch,
        }
    }

    fn viewport(&self) -> SettingsKeybindingsViewport {
        SettingsKeybindingsViewport::new(
            self.bounds,
            self.rows.len(),
            self.diagnostics.len(),
            self.style.scroll_view,
        )
    }

    fn list(&self) -> ListView {
        self.viewport()
            .list(self.scroll_state, self.scrollbar_presentation)
    }

    fn row(&self, index: usize, bounds: Rect, paint_enabled: bool) -> KeybindingRow<'_> {
        KeybindingRow {
            bounds,
            row: &self.rows[index],
            style: &self.style,
            dispatch: self.dispatch,
            interactions_enabled: self.interactions_enabled,
            paint_enabled,
        }
    }

    fn scrollbar(&self, list: &ListView) -> Option<KeybindingsScrollbar> {
        let view = list.scroll_view();
        let layout = view.vertical_scrollbar()?.layout();
        let maximum = view.metrics().maximum_offset().y;
        let offset = view.viewport().visible_content_bounds().origin.y;
        let percentage = if maximum > 0.0 {
            offset / maximum * 100.0
        } else {
            0.0
        };
        Some(KeybindingsScrollbar { layout, percentage })
    }
}

impl Component for KeybindingsSection<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("SettingsKeybindingsList")
            .in_bounds(self.bounds)
            .with_identity(SETTINGS_KEYBINDINGS_LIST)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                SETTINGS_KEYBINDINGS_LIST,
                element.bounds(),
                AccessibilityRole::List,
                "Keybindings",
            )
            .with_parent(SETTINGS_SECTION_CONTENT),
        )
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        let list = self.list();
        let visible = list.visible_range();
        list.draw_components(context, |context, item| {
            if item.index() < self.rows.len() {
                context.draw_component(&self.row(item.index(), item.bounds(), true));
            } else if let Some(diagnostic) = self.diagnostics.first() {
                draw_diagnostic(context.scene_mut(), diagnostic, item.bounds(), &self.style);
            }
        });
        if self.interactions_enabled {
            for index in 0..self.rows.len() {
                if visible.contains(&index) {
                    continue;
                }
                let bounds = list
                    .item_bounds(index)
                    .expect("keybinding row index")
                    .intersection(self.bounds);
                context.draw_component(&self.row(index, bounds, false));
            }
        }
        if let Some(scrollbar) = self.scrollbar(&list) {
            context.draw_component(&scrollbar);
        }
    }

    fn paint(&self, scene: &mut UiScene) {
        let list = self.list();
        list.draw(scene, |scene, item| {
            if item.index() < self.rows.len() {
                self.row(item.index(), item.bounds(), true).paint(scene);
            } else if let Some(diagnostic) = self.diagnostics.first() {
                draw_diagnostic(scene, diagnostic, item.bounds(), &self.style);
            }
        });
    }
}

struct KeybindingRow<'a> {
    bounds: Rect,
    row: &'a SettingsKeybindingRow,
    style: &'a SettingsSectionStyle,
    dispatch: &'a UiDispatch,
    interactions_enabled: bool,
    paint_enabled: bool,
}

impl Component for KeybindingRow<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("SettingsKeybindingRow")
            .in_bounds(self.bounds)
            .with_identity(self.row.element)
            .with_inspection_label(&self.row.label)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        self.interactions_enabled.then(|| {
            UiNode::new(
                self.row.element,
                element.bounds(),
                AccessibilityRole::Button,
                format!("Record shortcut for {}", self.row.label),
            )
            .with_parent(SETTINGS_KEYBINDINGS_LIST)
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate)
            .with_navigation(
                NavigationGroupId::new(SETTINGS_KEYBINDINGS_LIST),
                NavigationAxis::Vertical,
            )
            .with_value(self.row.value.clone())
        })
    }

    fn paint(&self, scene: &mut UiScene) {
        if !self.paint_enabled {
            return;
        }
        if self.dispatch.is_hovered(self.row.element)
            || self.dispatch.is_focused(self.row.element)
            || self.dispatch.is_pressed(self.row.element)
        {
            scene.draw_rect(
                PaintRect::new(self.bounds, self.style.surface_hovered)
                    .with_corner_radii(zui::ui::CornerRadii::uniform(4.0)),
            );
        }
        draw_row_text(scene, self.bounds, self.row, self.style);
    }
}

struct KeybindingsScrollbar {
    layout: ScrollbarLayout,
    percentage: f32,
}

impl Component for KeybindingsScrollbar {
    fn element(&self) -> ComponentElement {
        Element::leaf("SettingsKeybindingsScrollbar")
            .in_bounds(self.layout.track_bounds())
            .with_identity(SETTINGS_KEYBINDINGS_SCROLLBAR)
            .with_inspection_label("Keybindings scrollbar")
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                SETTINGS_KEYBINDINGS_SCROLLBAR,
                element.bounds(),
                AccessibilityRole::ScrollBar,
                "Keybindings scrollbar",
            )
            .with_parent(SETTINGS_KEYBINDINGS_LIST)
            .with_cursor(CursorFeedback::Pointer)
            .with_value(format!("{:.0} percent", self.percentage)),
        )
    }

    fn paint(&self, _scene: &mut UiScene) {}
}

fn draw_row_text(
    scene: &mut UiScene,
    bounds: Rect,
    row: &SettingsKeybindingRow,
    style: &SettingsSectionStyle,
) {
    scene.draw_text(TextBlock::new(
        &row.label,
        Point::new(bounds.origin.x + 10.0, bounds.origin.y + 8.0),
        zui::ui::Size::new(bounds.size.width * 0.55, 20.0),
        style.control_text.clone().with_line_height(20.0),
    ));
    scene.draw_text(TextBlock::new(
        &row.value,
        Point::new(
            bounds.origin.x + bounds.size.width * 0.58,
            bounds.origin.y + 8.0,
        ),
        zui::ui::Size::new(bounds.size.width * 0.4, 20.0),
        style
            .label_text
            .clone()
            .with_family(FontFamily::Monospace)
            .with_line_height(20.0),
    ));
}

fn draw_diagnostic(
    scene: &mut UiScene,
    diagnostic: &str,
    bounds: Rect,
    style: &SettingsSectionStyle,
) {
    scene.draw_text(TextBlock::new(
        diagnostic,
        Point::new(bounds.origin.x + 10.0, bounds.origin.y + 8.0),
        zui::ui::Size::new((bounds.size.width - 20.0).max(1.0), 20.0),
        style
            .label_text
            .clone()
            .with_color(style.error)
            .with_line_height(20.0),
    ));
}
