use crate::WorkbenchUiStyle;
use crate::{
    ActionBar, ActionBarItem, ActionBarOrientation, ActionBarStyle, ActionViewItem, Border,
    ButtonBackgrounds, ButtonState, ButtonStyle, Component, ComponentContext, ComponentElement,
    ComputedElement, CornerRadii, Edges, Element, InteractionRegion, PaintRect, Rect, Size,
    TextStyle, UiScene,
};

use crate::CHANGES_PANE_BUTTON;
use crate::TAB_CONTAINER_TOGGLE;
use crate::WINDOW;
use zui::ui::{
    AccessibilityRole, CursorFeedback, ElementId, FocusBehavior, NodeAction, UiDispatch, UiNode,
};

pub const TITLEBAR_HEIGHT: f32 = 32.0;
pub const TITLEBAR: ElementId = ElementId::scoped(1, 2);
pub const TITLEBAR_SETTINGS_BUTTON: ElementId = ElementId::scoped(1, 55);
const TITLEBAR_ACTION_GAP: f32 = 8.0;
const TITLEBAR_ACTION_ITEM_GAP: f32 = 4.0;
const TOGGLE_SIZE: f32 = 24.0;
const TOGGLE_ICON_SIZE: f32 = 18.0;
const CHANGES_ACTION_LABEL: &str = "Show changes";

/// Logical space reserved for platform window controls on each titlebar edge.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TitlebarInsets {
    left: f32,
    right: f32,
}

impl TitlebarInsets {
    #[cfg(test)]
    pub const NONE: Self = Self::new(0.0, 0.0);

    pub const fn new(left: f32, right: f32) -> Self {
        Self { left, right }
    }
}

/// Application-owned draggable titlebar for the single terminal surface.
pub struct Titlebar {
    bounds: Rect,
    style: WorkbenchUiStyle,
    left_action_bar: ActionBar,
    right_action_bar: ActionBar,
    settings_action_index: Option<usize>,
    tab_container_toggle_label: &'static str,
}

impl Titlebar {
    pub fn new(
        bounds: Rect,
        style: WorkbenchUiStyle,
        tabs_expanded: bool,
        window_control_insets: TitlebarInsets,
        dispatch: &UiDispatch,
    ) -> Self {
        let content_left = bounds.origin.x + window_control_insets.left;
        let content_right = (bounds.right() - window_control_insets.right).max(content_left);
        let tab_container_toggle_x = (content_left + TITLEBAR_ACTION_GAP)
            .min((content_right - TOGGLE_SIZE).max(content_left));
        let tab_container_toggle_bounds = Rect::from_xywh(
            tab_container_toggle_x,
            bounds.origin.y + (bounds.size.height - TOGGLE_SIZE) / 2.0,
            TOGGLE_SIZE,
            TOGGLE_SIZE,
        );
        let settings_action_visible = true;
        let right_action_count = 2.0;
        let right_action_width = right_action_count * TOGGLE_SIZE
            + (right_action_count - 1.0) * TITLEBAR_ACTION_ITEM_GAP;
        let right_action_max_x = (content_right - right_action_width).max(content_left);
        let right_action_x = (content_right - TITLEBAR_ACTION_GAP - right_action_width)
            .max(tab_container_toggle_bounds.right() + TITLEBAR_ACTION_GAP)
            .min(right_action_max_x);
        let right_action_bounds = Rect::from_xywh(
            right_action_x,
            bounds.origin.y + (bounds.size.height - TOGGLE_SIZE) / 2.0,
            right_action_width,
            TOGGLE_SIZE,
        );
        let tab_container_toggle_state = if dispatch.is_pressed(TAB_CONTAINER_TOGGLE) {
            ButtonState::Pressed
        } else if dispatch.is_focused(TAB_CONTAINER_TOGGLE) {
            ButtonState::Focused
        } else if dispatch.is_hovered(TAB_CONTAINER_TOGGLE) {
            ButtonState::Hovered
        } else {
            ButtonState::Resting
        };
        let changes_action_state = if dispatch.is_pressed(CHANGES_PANE_BUTTON) {
            ButtonState::Pressed
        } else if dispatch.is_focused(CHANGES_PANE_BUTTON) {
            ButtonState::Focused
        } else if dispatch.is_hovered(CHANGES_PANE_BUTTON) {
            ButtonState::Hovered
        } else {
            ButtonState::Resting
        };
        let settings_action_state = if dispatch.is_pressed(TITLEBAR_SETTINGS_BUTTON) {
            ButtonState::Pressed
        } else if dispatch.is_focused(TITLEBAR_SETTINGS_BUTTON) {
            ButtonState::Focused
        } else if dispatch.is_hovered(TITLEBAR_SETTINGS_BUTTON) {
            ButtonState::Hovered
        } else {
            ButtonState::Resting
        };
        let tab_container_toggle_label = if tabs_expanded {
            "Collapse sidebar"
        } else {
            "Expand sidebar"
        };
        let tab_container_toggle_icon = if tabs_expanded {
            style.tabs_expanded_icon
        } else {
            style.tabs_collapsed_icon
        };
        let button_style = ButtonStyle::new(
            ButtonBackgrounds::new(style.colors.title_bar_background)
                .with_hovered(style.colors.title_bar_hover_background)
                .with_focused(style.colors.title_bar_hover_background)
                .with_pressed(style.colors.border),
            TextStyle::new(12.0, style.colors.title_bar_action_foreground),
        )
        .with_corner_radii(CornerRadii::uniform(4.0))
        .with_padding(Edges::uniform(3.0))
        .with_icon_size(TOGGLE_ICON_SIZE);
        let left_action_bar = ActionBar::new(
            tab_container_toggle_bounds,
            ActionBarOrientation::Horizontal,
            vec![ActionBarItem::Action(ActionViewItem::icon(
                tab_container_toggle_icon,
                tab_container_toggle_label,
                tab_container_toggle_state,
            ))],
            ActionBarStyle::new(button_style.clone(), Size::new(TOGGLE_SIZE, TOGGLE_SIZE)),
        );
        let mut right_actions = vec![ActionBarItem::Action(ActionViewItem::icon(
            style.changes_icon,
            CHANGES_ACTION_LABEL,
            changes_action_state,
        ))];
        let settings_action_index = settings_action_visible.then(|| {
            let index = right_actions.len();
            right_actions.push(ActionBarItem::Action(ActionViewItem::icon(
                style.settings_icon,
                "Open Settings",
                settings_action_state,
            )));
            index
        });
        let right_action_bar = ActionBar::new(
            right_action_bounds,
            ActionBarOrientation::Horizontal,
            right_actions,
            ActionBarStyle::new(button_style, Size::new(TOGGLE_SIZE, TOGGLE_SIZE))
                .with_gap(TITLEBAR_ACTION_ITEM_GAP),
        );
        Self {
            bounds,
            style: style.clone(),
            left_action_bar,
            right_action_bar,
            settings_action_index,
            tab_container_toggle_label,
        }
    }

    fn child_interaction_regions(&self) -> Vec<InteractionRegion> {
        let mut regions = vec![
            InteractionRegion::new(
                "TabContainerToggle",
                TAB_CONTAINER_TOGGLE,
                self.left_action_bar
                    .interactive_item_bounds(0)
                    .expect("Tab Container toggle is enabled"),
                AccessibilityRole::Button,
                self.tab_container_toggle_label,
            )
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate),
            InteractionRegion::new(
                "ChangesPaneButton",
                CHANGES_PANE_BUTTON,
                self.right_action_bar
                    .interactive_item_bounds(0)
                    .expect("changes action is enabled"),
                AccessibilityRole::Button,
                CHANGES_ACTION_LABEL,
            )
            .with_cursor(CursorFeedback::Pointer)
            .with_focus(FocusBehavior::TabStop)
            .with_action(NodeAction::Activate),
        ];
        if let Some(index) = self.settings_action_index {
            regions.push(
                InteractionRegion::new(
                    "TitlebarSettingsButton",
                    TITLEBAR_SETTINGS_BUTTON,
                    self.right_action_bar
                        .interactive_item_bounds(index)
                        .expect("titlebar Settings action is enabled"),
                    AccessibilityRole::Button,
                    "Open Settings",
                )
                .with_cursor(CursorFeedback::Pointer)
                .with_focus(FocusBehavior::TabStop)
                .with_action(NodeAction::Activate),
            );
        }
        regions
    }
}

impl Component for Titlebar {
    fn element(&self) -> ComponentElement {
        Element::leaf("Titlebar")
            .in_bounds(self.bounds)
            .with_identity(TITLEBAR)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                TITLEBAR,
                element.bounds(),
                AccessibilityRole::Group,
                "Window titlebar",
            )
            .with_parent(WINDOW)
            .with_action(NodeAction::StartWindowDrag),
        )
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        for region in self.child_interaction_regions() {
            context.draw_component(&region);
        }
        context.scene_mut().draw_rect(
            PaintRect::new(self.bounds, self.style.colors.title_bar_background).with_border(
                Border::new(Edges::new(0.0, 0.0, 1.0, 0.0), self.style.colors.border),
            ),
        );
        context.draw_component(&self.left_action_bar);
        context.draw_component(&self.right_action_bar);
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_rect(
            PaintRect::new(self.bounds, self.style.colors.title_bar_background).with_border(
                Border::new(Edges::new(0.0, 0.0, 1.0, 0.0), self.style.colors.border),
            ),
        );
        scene.draw_component(&self.left_action_bar);
        scene.draw_component(&self.right_action_bar);
    }
}

#[cfg(test)]
#[path = "titlebar_tests.rs"]
mod tests;
