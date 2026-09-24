use ash_icons::icons;
use ash_ui_components::{
    ActionBar, ActionBarItem, ActionBarOrientation, ActionBarStyle, ActionViewItem,
    ButtonBackgrounds, ButtonState, ButtonStyle, InteractionRegion,
};
#[cfg(test)]
use zui::ui::Point;
use zui::ui::{
    Border, Component, ComponentContext, ComponentElement, ComputedElement, CornerRadii, Edges,
    Element, Rect, Size, TextInputLayoutEngine, TextSpan, TextStyle, UiScene,
};

use crate::SessionPaneContext;
use crate::SessionPaneStyle;
use crate::interaction::COMPOSER_PANEL;
use crate::interaction::CONTEXT_TOOLBAR;
use crate::interaction::ContextAction;
use zui::ui::{
    AccessibilityRole, CursorFeedback, FocusBehavior, NavigationAxis, NavigationGroupId,
    NodeAction, UiDispatch, UiNode,
};

const TOOLBAR_ITEM_HEIGHT: f32 = 24.0;
const TOOLBAR_ITEM_GAP: f32 = 6.0;
const TOOLBAR_HORIZONTAL_PADDING: f32 = 7.0;
const TOOLBAR_ICON_SIZE: f32 = 14.0;
const TOOLBAR_CONTENT_GAP: f32 = 4.0;
/// Product-owned action toolbar shared by command and future chat input surfaces.
pub(crate) struct ChatInputToolbar {
    action_bar: ActionBar,
    accessibility_labels: Vec<String>,
    bounds: Rect,
}

impl ChatInputToolbar {
    pub(crate) fn new(
        bounds: Rect,
        context: &SessionPaneContext,
        style: SessionPaneStyle,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &UiDispatch,
    ) -> Self {
        let labels = [
            context.location().to_string(),
            context.working_directory().to_string(),
            context.git_branch().to_string(),
            context.diff_summary().to_string(),
        ];
        let accessibility_labels = vec![
            format!("Environment: {}", labels[0]),
            format!("Working directory: {}", labels[1]),
            format!("Git branch: {}", labels[2]),
            format!("Git {}", labels[3]),
        ];
        let natural_text_style = style.compact_action_label.text_style(style.accent);
        let natural_button_style = button_style(style, natural_text_style.clone(), 1.0);
        let item_widths = labels
            .iter()
            .map(|label| {
                let text_width = text_layout.measure_text(label, &natural_text_style).width;
                natural_button_style.preferred_icon_and_label_width(text_width)
            })
            .collect::<Vec<_>>();
        let total_width =
            item_widths.iter().sum::<f32>() + TOOLBAR_ITEM_GAP * (item_widths.len() - 1) as f32;
        let scale = (bounds.size.width / total_width).clamp(0.0, 1.0);
        let scaled_text_style = style
            .compact_action_label
            .scaled_text_style(style.accent, scale);
        let button_style = button_style(style, scaled_text_style.clone(), scale);
        let item = |target, icon, label: String, index: usize| {
            ActionBarItem::Action(
                ActionViewItem::icon_and_label(icon, label, button_state(target, dispatch))
                    .with_main_axis_extent(item_widths[index] * scale),
            )
        };
        let items = vec![
            item(
                ContextAction::ALL[0].element_id(),
                icons::TERMINAL,
                labels[0].clone(),
                0,
            ),
            item(
                ContextAction::ALL[1].element_id(),
                icons::NEW_FOLDER,
                labels[1].clone(),
                1,
            ),
            item(
                ContextAction::ALL[2].element_id(),
                icons::GIT_BRANCH,
                labels[2].clone(),
                2,
            ),
            ActionBarItem::Action(
                ActionViewItem::icon_and_styled_label(
                    icons::DIFF,
                    labels[3].clone(),
                    diff_summary_spans(labels[3].as_str(), &scaled_text_style, style),
                    button_state(ContextAction::ALL[3].element_id(), dispatch),
                )
                .with_main_axis_extent(item_widths[3] * scale),
            ),
        ];
        Self {
            action_bar: ActionBar::new(
                bounds,
                ActionBarOrientation::Horizontal,
                items,
                ActionBarStyle::new(
                    button_style,
                    Size::new(item_widths[0] * scale, TOOLBAR_ITEM_HEIGHT),
                )
                .with_gap(TOOLBAR_ITEM_GAP * scale),
            ),
            accessibility_labels,
            bounds,
        }
    }

    fn child_interaction_regions(&self) -> Vec<InteractionRegion> {
        let navigation_group = NavigationGroupId::new(CONTEXT_TOOLBAR);
        let mut regions = Vec::new();
        for (index, action) in ContextAction::ALL.into_iter().enumerate() {
            if let Some(bounds) = self.action_bar.interactive_item_bounds(index) {
                regions.push(
                    InteractionRegion::new(
                        "InputContextAction",
                        action.element_id(),
                        bounds,
                        AccessibilityRole::Button,
                        self.accessibility_labels[index].clone(),
                    )
                    .with_cursor(CursorFeedback::Pointer)
                    .with_focus(FocusBehavior::TabStop)
                    .with_action(NodeAction::Activate)
                    .with_navigation(navigation_group, NavigationAxis::Horizontal),
                );
            }
        }
        regions
    }

    #[cfg(test)]
    pub(crate) fn item_bounds(&self, index: usize) -> Option<Rect> {
        self.action_bar.item_bounds(index)
    }

    #[cfg(test)]
    pub(crate) fn hit_test(&self, point: Point) -> Option<usize> {
        self.action_bar.hit_test(point)
    }
}

fn button_state(target: zui::ui::ElementId, dispatch: &UiDispatch) -> ButtonState {
    if dispatch.is_pressed(target) {
        ButtonState::Pressed
    } else if dispatch.is_focused(target) {
        ButtonState::Focused
    } else if dispatch.is_hovered(target) {
        ButtonState::Hovered
    } else {
        ButtonState::Resting
    }
}

fn diff_summary_spans(
    label: &str,
    scaled_text_style: &TextStyle,
    style: SessionPaneStyle,
) -> Vec<TextSpan> {
    label
        .split_inclusive(' ')
        .map(|part| {
            let token = part.trim_end();
            let color = if numeric_delta(token, '+') {
                style.success
            } else if numeric_delta(token, '-') {
                style.error
            } else {
                style.text
            };
            TextSpan::new(part, scaled_text_style.clone().with_color(color))
        })
        .collect()
}

fn numeric_delta(token: &str, sign: char) -> bool {
    token.strip_prefix(sign).is_some_and(|digits| {
        !digits.is_empty() && digits.chars().all(|digit| digit.is_ascii_digit())
    })
}

fn button_style(style: SessionPaneStyle, text_style: TextStyle, scale: f32) -> ButtonStyle {
    ButtonStyle::new(
        ButtonBackgrounds::new(style.surface_raised)
            .with_hovered(style.surface_hovered)
            .with_focused(style.surface_hovered)
            .with_pressed(style.border),
        text_style,
    )
    .with_border(Border::uniform(1.0, style.border))
    .with_corner_radii(CornerRadii::uniform(4.0))
    .with_padding(Edges::new(
        0.0,
        TOOLBAR_HORIZONTAL_PADDING * scale,
        0.0,
        TOOLBAR_HORIZONTAL_PADDING * scale,
    ))
    .with_icon_size(TOOLBAR_ICON_SIZE * scale)
    .with_content_gap(TOOLBAR_CONTENT_GAP * scale)
}

impl Component for ChatInputToolbar {
    fn element(&self) -> ComponentElement {
        Element::leaf("ChatInputToolbar")
            .in_bounds(self.bounds)
            .with_identity(CONTEXT_TOOLBAR)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                CONTEXT_TOOLBAR,
                element.bounds(),
                AccessibilityRole::Toolbar,
                "Input context",
            )
            .with_parent(COMPOSER_PANEL),
        )
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        for region in self.child_interaction_regions() {
            context.draw_component(&region);
        }
        context.draw_component(&self.action_bar);
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_component(&self.action_bar);
    }
}

#[cfg(test)]
#[path = "toolbar_tests.rs"]
mod tests;
