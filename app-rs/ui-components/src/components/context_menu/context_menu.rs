use crate::Color;
use crate::Component;
use crate::ComponentContext;
use crate::ComponentElement;
use crate::ComputedElement;
use crate::ContextView;
use crate::ContextViewPlacement;
use crate::ContextViewStyle;
use crate::Element;
use crate::ElementId;
use crate::Point;
use crate::Rect;
use crate::UiScene;

use super::Menu;
use super::MenuIds;
use super::MenuItem;
use super::MenuSelection;
use super::MenuStyle;

const CONTEXT_MENU_PADDING: f32 = 6.0;

/// Placement and menu presentation used by a [`ContextMenu`].
#[derive(Clone, Debug, PartialEq)]
pub struct ContextMenuStyle {
    menu: MenuStyle,
    placement: ContextViewPlacement,
}

impl ContextMenuStyle {
    pub fn new(menu: MenuStyle) -> Self {
        Self {
            menu: menu.with_padding(CONTEXT_MENU_PADDING),
            placement: ContextViewPlacement::new(),
        }
    }

    pub const fn with_placement(mut self, placement: ContextViewPlacement) -> Self {
        self.placement = placement;
        self
    }
}

/// Anchors a context-click action menu in the topmost context view.
///
/// ContextMenu owns viewport-aware placement and its context-menu component boundary. Menu owns
/// item presentation and interaction; the host owns the context-click trigger, dismissal, focus
/// restoration, and command execution.
#[derive(Clone, Debug, PartialEq)]
pub struct ContextMenu {
    context_view: ContextView,
    menu: Menu,
}

impl ContextMenu {
    pub fn new(
        viewport: Rect,
        anchor: Rect,
        accessibility_label: impl Into<String>,
        items: Vec<MenuItem>,
        ids: MenuIds,
        style: ContextMenuStyle,
    ) -> Self {
        let desired_size = Menu::desired_size(&items, &style.menu, None);
        let context_view = ContextView::new(
            viewport,
            anchor,
            desired_size,
            style.placement,
            ContextViewStyle::new(Color::TRANSPARENT),
        );
        let menu = Menu::new(
            context_view.content_bounds(),
            accessibility_label,
            items,
            ids,
            style.menu,
        );
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
        Element::leaf("ContextMenu").in_bounds(self.bounds())
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

impl Component for ContextMenu {
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
#[path = "context_menu_tests.rs"]
mod tests;
