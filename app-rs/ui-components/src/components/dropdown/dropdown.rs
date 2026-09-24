use crate::{
    Color, Component, ComponentContext, ComponentElement, ComputedElement, ContextView,
    ContextViewPlacement, ContextViewStyle, Element, ElementId, Point, Rect, ScrollMetrics,
    ScrollState, ScrollViewStyle, UiScene,
};

use super::menu::MenuScrollConfiguration;
use super::{Menu, MenuIds, MenuItem, MenuSelection, MenuStyle};

/// Placement and menu presentation used by a [`Dropdown`].
#[derive(Clone, Debug, PartialEq)]
pub struct DropdownStyle {
    menu: MenuStyle,
    placement: ContextViewPlacement,
}

impl DropdownStyle {
    pub fn new(menu: MenuStyle) -> Self {
        Self {
            menu,
            placement: ContextViewPlacement::new(),
        }
    }

    pub const fn with_placement(mut self, placement: ContextViewPlacement) -> Self {
        self.placement = placement;
        self
    }
}

/// Retained state, viewport limit, and scrollbar style for a scrollable [`Dropdown`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DropdownScrollConfiguration {
    state: ScrollState,
    maximum_visible_items: usize,
    style: ScrollViewStyle,
}

impl DropdownScrollConfiguration {
    pub fn new(state: ScrollState, maximum_visible_items: usize, style: ScrollViewStyle) -> Self {
        assert!(
            maximum_visible_items > 0,
            "Dropdown maximum visible item count must be non-zero"
        );
        Self {
            state,
            maximum_visible_items,
            style,
        }
    }

    const fn menu(self) -> MenuScrollConfiguration {
        MenuScrollConfiguration::new(self.state, self.style)
    }
}

/// Anchors reusable [`Menu`] content in a topmost context view.
///
/// Dropdown owns viewport-aware placement and overlay composition. Menu owns the surface, item
/// geometry, interaction, accessibility, and optional scrolling. The host owns the trigger, open
/// state, dismissal, focus restoration, and command execution.
#[derive(Clone, Debug, PartialEq)]
pub struct Dropdown {
    context_view: ContextView,
    menu: Menu,
}

impl Dropdown {
    pub fn new(
        viewport: Rect,
        anchor: Rect,
        accessibility_label: impl Into<String>,
        items: Vec<MenuItem>,
        ids: MenuIds,
        style: DropdownStyle,
    ) -> Self {
        Self::build(
            viewport,
            anchor,
            accessibility_label,
            items,
            ids,
            style,
            None,
        )
    }

    pub fn new_scrollable(
        viewport: Rect,
        anchor: Rect,
        accessibility_label: impl Into<String>,
        items: Vec<MenuItem>,
        ids: MenuIds,
        style: DropdownStyle,
        scroll: DropdownScrollConfiguration,
    ) -> Self {
        Self::build(
            viewport,
            anchor,
            accessibility_label,
            items,
            ids,
            style,
            Some(scroll),
        )
    }

    fn build(
        viewport: Rect,
        anchor: Rect,
        accessibility_label: impl Into<String>,
        items: Vec<MenuItem>,
        ids: MenuIds,
        style: DropdownStyle,
        scroll: Option<DropdownScrollConfiguration>,
    ) -> Self {
        let desired_size = Menu::desired_size(
            &items,
            &style.menu,
            scroll.map(|scroll| scroll.maximum_visible_items),
        );
        let context_view = ContextView::new(
            viewport,
            anchor,
            desired_size,
            style.placement,
            ContextViewStyle::new(Color::TRANSPARENT),
        );
        let menu = match scroll {
            Some(scroll) => Menu::new_scrollable(
                context_view.content_bounds(),
                accessibility_label,
                items,
                ids,
                style.menu,
                scroll.menu(),
            ),
            None => Menu::new(
                context_view.content_bounds(),
                accessibility_label,
                items,
                ids,
                style.menu,
            ),
        };
        Self { context_view, menu }
    }

    pub fn with_selection(mut self, selection: MenuSelection) -> Self {
        self.menu = self.menu.with_selection(selection);
        self
    }

    pub const fn menu_root(&self) -> ElementId {
        self.menu.root()
    }

    /// Returns the interactive menu surface, excluding its visual shadow.
    pub const fn bounds(&self) -> Rect {
        self.menu.bounds()
    }

    /// Returns the item layout bounds inset by the menu's canonical padding.
    pub const fn content_bounds(&self) -> Rect {
        self.menu.content_bounds()
    }

    /// Returns the caller-owned leading row, when one was reserved by the menu style.
    pub const fn header_bounds(&self) -> Option<Rect> {
        self.menu.header_bounds()
    }

    pub const fn item_viewport_bounds(&self) -> Rect {
        self.menu.item_viewport_bounds()
    }

    pub fn scroll_metrics(&self) -> Option<ScrollMetrics> {
        self.menu.scroll_metrics()
    }

    pub fn selected_index(&self) -> Option<usize> {
        self.menu.selected_index()
    }

    pub fn item_bounds(&self, index: usize) -> Option<Rect> {
        self.menu.item_bounds(index)
    }

    pub fn interactive_item_bounds(&self, index: usize) -> Option<Rect> {
        self.menu.interactive_item_bounds(index)
    }

    pub fn hit_test(&self, point: Point) -> Option<usize> {
        self.menu.hit_test(point)
    }

    /// Paints the anchored menu with caller-owned content in its header row.
    pub fn paint_with_header(
        &self,
        scene: &mut UiScene,
        paint_header: impl FnOnce(&mut UiScene, Rect),
    ) {
        scene.with_element(self.element_tree(), |scene, _element| {
            self.paint_contents(scene, paint_header)
        });
    }

    /// Composes the anchored menu and caller-owned header through one interaction tree.
    pub fn draw_components_with_header(
        &self,
        context: &mut ComponentContext<'_, '_>,
        draw_header: impl FnOnce(&mut ComponentContext<'_, '_>, Rect),
    ) {
        context.with_component(self, |context, _element| {
            self.compose_contents(context, draw_header)
        });
    }

    fn element_tree(&self) -> ComponentElement {
        Element::leaf("Dropdown").in_bounds(self.bounds())
    }

    fn paint_contents(&self, scene: &mut UiScene, paint_header: impl FnOnce(&mut UiScene, Rect)) {
        self.context_view.draw_overflow(scene, |scene, _bounds| {
            self.menu.paint_with_header(scene, paint_header)
        });
    }

    fn compose_contents(
        &self,
        context: &mut ComponentContext<'_, '_>,
        draw_header: impl FnOnce(&mut ComponentContext<'_, '_>, Rect),
    ) {
        self.context_view
            .draw_components_overflow(context, |context, _bounds| {
                self.menu.draw_components_with_header(context, draw_header)
            });
    }
}

impl Component for Dropdown {
    fn element(&self) -> ComponentElement {
        self.element_tree()
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        self.compose_contents(context, |_context, _bounds| {});
    }

    fn paint_element(&self, scene: &mut UiScene, _element: &ComputedElement) {
        self.paint_contents(scene, |_scene, _bounds| {});
    }
}

#[cfg(test)]
#[path = "dropdown_tests.rs"]
mod tests;
