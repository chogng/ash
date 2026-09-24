use ash_icons::icons;
use ash_ui_components::{
    ActionBar, ActionBarItem, ActionBarOrientation, ActionBarStyle, ActionViewItem,
    ButtonSelection, ButtonState, InteractionRegion, SearchBox,
};
use zui::ui::{
    AccessibilityRole, CursorFeedback, FocusBehavior, NavigationAxis, NavigationGroupId,
    NodeAction, UiDispatch, UiNode,
};
use zui::ui::{
    Border, CaretVisibility, Color, Component, ComponentContext, ComponentElement, ComputedElement,
    Edges, Element, PaintRect, Rect, Size, TextInputLayoutEngine, UiScene,
};

use super::FilesState;
use crate::FILE_SEARCH_INPUT;
use crate::FILES_ACTION_BAR;
use crate::FILES_REFRESH;
use crate::FILES_SEARCH;
use crate::FILES_TOOLBAR;
use crate::FilesToolbarStyle;

const PADDING: f32 = 8.0;
const ACTION_SIZE: f32 = 28.0;
const STATUS_WIDTH: f32 = 62.0;
const ACTION_BAR_WIDTH: f32 = ACTION_SIZE * 2.0 + STATUS_WIDTH;

/// Files-owned functional toolbar for refresh, search, and search input.
pub struct FilesToolbar {
    bounds: Rect,
    parent: zui::ui::ElementId,
    surface: Color,
    border: Color,
    search_box: Option<SearchBox>,
    search_value: String,
    action_bar: ActionBar,
}

impl FilesToolbar {
    pub fn new(
        bounds: Rect,
        files: &FilesState,
        upstream_distance: Option<(usize, usize)>,
        caret_visibility: CaretVisibility,
        palette: FilesToolbarStyle,
        parent: zui::ui::ElementId,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &UiDispatch,
    ) -> Self {
        let action_bounds = Rect::from_xywh(
            (bounds.right() - ACTION_BAR_WIDTH - PADDING).max(bounds.origin.x),
            bounds.origin.y + (bounds.size.height - ACTION_SIZE) * 0.5,
            ACTION_BAR_WIDTH.min(bounds.size.width),
            ACTION_SIZE,
        );
        let button_style = palette.button_style();
        let state = |id| {
            if dispatch.is_pressed(id) {
                ButtonState::Pressed
            } else if dispatch.is_focused(id) {
                ButtonState::Focused
            } else if dispatch.is_hovered(id) {
                ButtonState::Hovered
            } else {
                ButtonState::Resting
            }
        };
        let distance = upstream_distance
            .map(|(ahead, behind)| format!("↑{ahead} ↓{behind}"))
            .unwrap_or_else(|| "↑— ↓—".to_string());
        let action_bar = ActionBar::new(
            action_bounds,
            ActionBarOrientation::Horizontal,
            vec![
                ActionBarItem::Action(
                    ActionViewItem::icon_and_label(icons::REFRESH, distance, state(FILES_REFRESH))
                        .with_main_axis_extent(ACTION_SIZE + STATUS_WIDTH),
                ),
                ActionBarItem::Action(
                    ActionViewItem::icon(icons::SEARCH, "Search files", state(FILES_SEARCH))
                        .with_selection(if files.search_visible() {
                            ButtonSelection::Selected
                        } else {
                            ButtonSelection::Unselected
                        }),
                ),
            ],
            ActionBarStyle::new(button_style, Size::new(ACTION_SIZE, ACTION_SIZE)),
        );
        let search_box = files.search_visible().then(|| {
            let search_bounds = Rect::from_xywh(
                bounds.origin.x + PADDING,
                bounds.origin.y + 6.0,
                (action_bounds.origin.x - bounds.origin.x - PADDING * 2.0).max(1.0),
                (bounds.size.height - 12.0).max(1.0),
            );
            let search_state = if dispatch.is_focused(FILE_SEARCH_INPUT) {
                ash_ui_components::InputBoxState::Focused(caret_visibility)
            } else if dispatch.is_hovered(FILE_SEARCH_INPUT) {
                ash_ui_components::InputBoxState::Hovered
            } else {
                ash_ui_components::InputBoxState::Resting
            };
            SearchBox::new(
                search_bounds,
                "Search files...",
                search_state,
                palette.search_style(),
                files.search_input(),
                text_layout,
            )
        });
        Self {
            bounds,
            parent,
            surface: palette.surface(),
            border: palette.border(),
            search_box,
            search_value: files.search_input().text().to_owned(),
            action_bar,
        }
    }

    fn child_interaction_regions(&self) -> Vec<InteractionRegion> {
        let mut regions = Vec::new();
        if let Some(search_box) = self.search_box.as_ref() {
            regions.push(
                InteractionRegion::new(
                    "FilesSearchInput",
                    FILE_SEARCH_INPUT,
                    search_box.bounds(),
                    AccessibilityRole::TextInput,
                    "Search files",
                )
                .with_cursor(CursorFeedback::Text)
                .with_focus(FocusBehavior::TabStop)
                .with_value(&self.search_value),
            );
        }
        let navigation = NavigationGroupId::new(FILES_ACTION_BAR);
        let actions = [
            (FILES_REFRESH, "Refresh Git status"),
            (FILES_SEARCH, "Search files"),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (id, label))| {
            let bounds = self
                .action_bar
                .interactive_item_bounds(index)
                .expect("Files toolbar actions are enabled");
            InteractionRegion::new(
                "FilesToolbarAction",
                id,
                bounds,
                AccessibilityRole::Button,
                label,
            )
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate)
            .with_navigation(navigation, NavigationAxis::Horizontal)
        })
        .collect::<Vec<_>>();
        regions.push(
            InteractionRegion::new(
                "FilesActionBar",
                FILES_ACTION_BAR,
                self.action_bar.bounds(),
                AccessibilityRole::Toolbar,
                "Files actions",
            )
            .with_children(actions),
        );
        regions
    }

    pub const fn search_caret_bounds(&self) -> Option<Rect> {
        match self.search_box.as_ref() {
            Some(search_box) => search_box.caret_bounds(),
            None => None,
        }
    }

    fn paint_surface(&self, scene: &mut UiScene) {
        scene.draw_rect(
            PaintRect::new(self.bounds, self.surface)
                .with_border(Border::new(Edges::new(0.0, 0.0, 1.0, 0.0), self.border)),
        );
    }
}

impl Component for FilesToolbar {
    fn element(&self) -> ComponentElement {
        Element::leaf("FilesToolbar")
            .in_bounds(self.bounds)
            .with_identity(FILES_TOOLBAR)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                FILES_TOOLBAR,
                element.bounds(),
                AccessibilityRole::Toolbar,
                "Files toolbar",
            )
            .with_parent(self.parent),
        )
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        for region in self.child_interaction_regions() {
            context.draw_component(&region);
        }
        if let Some(search_box) = self.search_box.as_ref() {
            context.draw_component(search_box);
        }
        context.draw_component(&self.action_bar);
    }

    fn paint(&self, scene: &mut UiScene) {
        self.paint_surface(scene);
        if let Some(search_box) = self.search_box.as_ref() {
            scene.draw_component(search_box);
        }
        scene.draw_component(&self.action_bar);
    }
}
