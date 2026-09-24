//! Session search and creation controls for Sidebar content.

use crate::{
    ActionBar, ActionBarItem, ActionBarOrientation, ActionBarStyle, ActionViewItem,
    ButtonBackgrounds, ButtonState, ButtonStyle, CaretVisibility, Component, ComponentContext,
    ComponentElement, ComputedElement, CornerRadii, Edges, Element, InteractionRegion, Rect,
    SearchBox, Size, TextInput, TextInputLayoutEngine, UiScene,
};
use zui::ui::{
    AccessibilityRole, CursorFeedback, FocusBehavior, NavigationAxis, NavigationGroupId,
    NodeAction, UiDispatch, UiNode,
};

use super::WorkbenchUiStyle;
use super::identity::{
    ADD_SESSION, SESSION_SEARCH_INPUT, TAB_CONTAINER, TAB_CONTAINER_ACTION_BAR,
    TAB_CONTAINER_TOOLBAR,
};

pub const TOOLBAR_HEIGHT: f32 = 24.0;
const ACTION_SIZE: f32 = TOOLBAR_HEIGHT;
const TOOLBAR_HORIZONTAL_PADDING: f32 = 10.0;
const TOOLBAR_GAP: f32 = 6.0;

/// Tab Container toolbar with a leading Session SearchBox and trailing creation ActionBar.
pub struct SessionsToolbar {
    bounds: Rect,
    search_box: SearchBox,
    search_value: String,
    action_bar: ActionBar,
}

impl SessionsToolbar {
    pub fn new(
        bounds: Rect,
        search_input: &TextInput,
        caret_visibility: CaretVisibility,
        style: WorkbenchUiStyle,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &UiDispatch,
    ) -> Self {
        let content_bounds = Rect::from_xywh(
            bounds.origin.x + TOOLBAR_HORIZONTAL_PADDING,
            bounds.origin.y,
            (bounds.size.width - TOOLBAR_HORIZONTAL_PADDING * 2.0).max(1.0),
            bounds.size.height,
        );
        let action_width = ACTION_SIZE;
        let action_bounds = Rect::from_xywh(
            content_bounds.right() - action_width,
            content_bounds.origin.y,
            action_width,
            ACTION_SIZE,
        );
        let search_bounds = Rect::from_xywh(
            content_bounds.origin.x,
            content_bounds.origin.y,
            (action_bounds.origin.x - TOOLBAR_GAP - content_bounds.origin.x).max(1.0),
            content_bounds.size.height,
        );
        let search_state = if dispatch.is_focused(SESSION_SEARCH_INPUT) {
            crate::InputBoxState::Focused(caret_visibility)
        } else if dispatch.is_hovered(SESSION_SEARCH_INPUT) {
            crate::InputBoxState::Hovered
        } else {
            crate::InputBoxState::Resting
        };
        let add_button_state = if dispatch.is_pressed(ADD_SESSION) {
            ButtonState::Pressed
        } else if dispatch.is_focused(ADD_SESSION) {
            ButtonState::Focused
        } else if dispatch.is_hovered(ADD_SESSION) {
            ButtonState::Hovered
        } else {
            ButtonState::Resting
        };
        let button_backgrounds = ButtonBackgrounds::new(crate::Color::TRANSPARENT)
            .with_hovered(style.colors.control_hover_background)
            .with_focused(style.colors.control_hover_background)
            .with_pressed(style.colors.control_hover_background);
        let button_style = ButtonStyle::new(button_backgrounds, style.label_text.clone())
            .with_corner_radii(CornerRadii::uniform(4.0))
            .with_padding(Edges::uniform(3.0))
            .with_icon_size(18.0);
        let action_bar = ActionBar::new(
            action_bounds,
            ActionBarOrientation::Horizontal,
            vec![ActionBarItem::Action(ActionViewItem::icon(
                style.add_icon,
                "Add new session",
                add_button_state,
            ))],
            ActionBarStyle::new(button_style, Size::new(ACTION_SIZE, ACTION_SIZE)),
        );
        Self {
            bounds,
            search_box: SearchBox::new(
                search_bounds,
                "Search sessions...",
                search_state,
                style.search,
                search_input,
                text_layout,
            ),
            search_value: search_input.text().to_owned(),
            action_bar,
        }
    }

    fn child_interaction_regions(&self) -> Vec<InteractionRegion> {
        let search = InteractionRegion::new(
            "SessionSearchInput",
            SESSION_SEARCH_INPUT,
            self.search_box.bounds(),
            AccessibilityRole::TextInput,
            "Search sessions",
        )
        .with_cursor(CursorFeedback::Text)
        .with_focus(FocusBehavior::TabStop)
        .with_value(&self.search_value);
        let add_bounds = self
            .action_bar
            .interactive_item_bounds(0)
            .expect("Add session action is enabled");
        let action = InteractionRegion::new(
            "AddSessionButton",
            ADD_SESSION,
            add_bounds,
            AccessibilityRole::Button,
            "Add new session",
        )
        .with_cursor(CursorFeedback::Pointer)
        .with_focus(FocusBehavior::TabStop)
        .with_action(NodeAction::Activate)
        .with_navigation(
            NavigationGroupId::new(TAB_CONTAINER_ACTION_BAR),
            NavigationAxis::Horizontal,
        );
        vec![
            search,
            InteractionRegion::new(
                "SessionActions",
                TAB_CONTAINER_ACTION_BAR,
                self.action_bar.bounds(),
                AccessibilityRole::Toolbar,
                "Session actions",
            )
            .with_children([action]),
        ]
    }

    pub const fn search_caret_bounds(&self) -> Option<Rect> {
        self.search_box.caret_bounds()
    }
}

impl Component for SessionsToolbar {
    fn element(&self) -> ComponentElement {
        Element::leaf("SessionsToolbar")
            .padding(Edges::new(
                0.0,
                TOOLBAR_HORIZONTAL_PADDING,
                0.0,
                TOOLBAR_HORIZONTAL_PADDING,
            ))
            .in_bounds(self.bounds)
            .with_identity(TAB_CONTAINER_TOOLBAR)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                TAB_CONTAINER_TOOLBAR,
                element.bounds(),
                AccessibilityRole::Toolbar,
                "Sessions toolbar",
            )
            .with_parent(TAB_CONTAINER),
        )
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        for region in self.child_interaction_regions() {
            context.draw_component(&region);
        }
        context.draw_component(&self.search_box);
        context.draw_component(&self.action_bar);
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_component(&self.search_box);
        scene.draw_component(&self.action_bar);
    }
}

#[cfg(test)]
#[path = "sessions_toolbar_tests.rs"]
mod tests;
