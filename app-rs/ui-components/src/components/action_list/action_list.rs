use crate::ActionBar;
use crate::ActionBarItem;
use crate::ActionBarOrientation;
use crate::ActionBarStyle;
use crate::ActionViewItem;
use crate::ButtonStyle;
use crate::Component;
use crate::ComponentContext;
use crate::ComponentElement;
use crate::ComputedElement;
use crate::Element;
use crate::Point;
use crate::Rect;
use crate::Size;
use crate::UiScene;

/// Shared row geometry and button presentation for an [`ActionList`].
#[derive(Clone, Debug, PartialEq)]
pub struct ActionListStyle {
    button_style: ButtonStyle,
    row_height: f32,
    gap: f32,
}

impl ActionListStyle {
    pub fn new(button_style: ButtonStyle, row_height: f32) -> Self {
        Self {
            button_style: button_style.with_leading_text(),
            row_height,
            gap: 0.0,
        }
    }

    pub const fn with_gap(mut self, gap: f32) -> Self {
        self.gap = gap;
        self
    }
}

/// Vertical list of action representations with component-owned row geometry.
///
/// The list arranges and paints [`ActionViewItem`] rows and exposes the same row bounds for host
/// hit testing. Product identity, accessibility, focus, activation, and command execution remain
/// owned by the host that composes the list.
#[derive(Clone, Debug, PartialEq)]
pub struct ActionList {
    bounds: Rect,
    items: Vec<ActionViewItem>,
    style: ActionListStyle,
}

impl ActionList {
    pub fn new(bounds: Rect, items: Vec<ActionViewItem>, style: ActionListStyle) -> Self {
        Self {
            bounds,
            items,
            style,
        }
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    pub fn item_bounds(&self, index: usize) -> Option<Rect> {
        self.action_bar().item_bounds(index)
    }

    pub fn interactive_item_bounds(&self, index: usize) -> Option<Rect> {
        self.action_bar().interactive_item_bounds(index)
    }

    pub fn hit_test(&self, point: Point) -> Option<usize> {
        self.action_bar().hit_test(point)
    }

    fn action_bar(&self) -> ActionBar {
        ActionBar::new(
            self.bounds,
            ActionBarOrientation::Vertical,
            self.items
                .iter()
                .cloned()
                .map(ActionBarItem::Action)
                .collect(),
            ActionBarStyle::new(
                self.style.button_style.clone(),
                Size::new(self.bounds.size.width, self.style.row_height.max(0.0)),
            )
            .with_gap(self.style.gap.max(0.0)),
        )
    }
}

impl Component for ActionList {
    fn element(&self) -> ComponentElement {
        Element::leaf("ActionList").in_bounds(self.bounds)
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        context.draw_component(&self.action_bar());
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_component(&self.action_bar());
    }
}

#[cfg(test)]
#[path = "action_list_tests.rs"]
mod tests;
