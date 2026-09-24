use std::ops::Range;

use crate::{
    AccessibilityRole, AccessibilitySelection, Border, BoxShadow, Color, Component,
    ComponentContext, ComponentElement, ComputedElement, CornerRadii, CursorFeedback, Edges,
    Element, ElementId, FocusBehavior, ListView, NavigationAxis, NavigationGroupId, NodeAction,
    PaintRect, Point, Rect, ScrollMetrics, ScrollState, ScrollViewStyle, Size, UiNode, UiScene,
    VirtualListLayout,
};

use super::{
    ActionBar, ActionBarItem, ActionBarOrientation, ActionBarSeparatorStyle, ActionBarStyle,
    ActionViewItem, ButtonSelection, ButtonStyle, InteractionRegion,
};

const MENU_PADDING: f32 = 4.0;
const MENU_CORNER_RADIUS: f32 = 4.0;
const MENU_SHADOW: Color = Color::rgba(0, 0, 0, 64);
const MENU_SHADOW_OFFSET_Y: f32 = 4.0;
const MENU_SHADOW_BLUR_RADIUS: f32 = 26.352_942;

/// Stable host-owned identities used by one menu.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MenuIds {
    parent: ElementId,
    root: ElementId,
}

impl MenuIds {
    pub const fn new(parent: ElementId, root: ElementId) -> Self {
        Self { parent, root }
    }
}

/// One action or separator presented by a [`Menu`].
#[derive(Clone, Debug, PartialEq)]
pub enum MenuItem {
    Action {
        element: ElementId,
        view: ActionViewItem,
    },
    Separator,
}

impl MenuItem {
    pub const fn action(element: ElementId, view: ActionViewItem) -> Self {
        Self::Action { element, view }
    }

    pub const fn separator() -> Self {
        Self::Separator
    }

    const fn is_enabled(&self) -> bool {
        match self {
            Self::Action { view, .. } => view.is_enabled(),
            Self::Separator => false,
        }
    }

    fn main_axis_extent(&self, style: &MenuStyle) -> f32 {
        match self {
            Self::Action { view, .. } => view
                .main_axis_extent()
                .unwrap_or(style.item_size.height)
                .max(0.0),
            Self::Separator => style.separator_style.extent().max(0.0),
        }
    }
}

/// Selection policy used when a menu is presented.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum MenuSelection {
    /// Selects the first enabled item. This is the default open-state behavior.
    #[default]
    FirstEnabled,
    /// Selects one item by its presentation index.
    Item(usize),
    /// Presents the menu without a selected item.
    None,
}

/// Retained state and scrollbar style for a scrollable [`Menu`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct MenuScrollConfiguration {
    state: ScrollState,
    style: ScrollViewStyle,
}

impl MenuScrollConfiguration {
    pub(crate) const fn new(state: ScrollState, style: ScrollViewStyle) -> Self {
        Self { state, style }
    }
}

/// Shared surface and item presentation for a [`Menu`].
#[derive(Clone, Debug, PartialEq)]
pub struct MenuStyle {
    background: Color,
    border: Border,
    corner_radii: CornerRadii,
    padding: f32,
    button_style: ButtonStyle,
    item_size: Size,
    header_height: f32,
    separator_style: ActionBarSeparatorStyle,
}

impl MenuStyle {
    pub fn new(background: Color, button_style: ButtonStyle, item_size: Size) -> Self {
        Self {
            background,
            border: Border::default(),
            corner_radii: CornerRadii::uniform(MENU_CORNER_RADIUS),
            padding: MENU_PADDING,
            button_style: button_style.with_leading_text(),
            item_size,
            header_height: 0.0,
            separator_style: ActionBarSeparatorStyle::new(Color::TRANSPARENT),
        }
    }

    /// Reserves a leading row that the caller can fill through the menu composition methods.
    pub const fn with_header_height(mut self, header_height: f32) -> Self {
        self.header_height = header_height;
        self
    }

    pub const fn with_border(mut self, border: Border) -> Self {
        self.border = border;
        self
    }

    pub const fn with_corner_radii(mut self, corner_radii: CornerRadii) -> Self {
        self.corner_radii = corner_radii;
        self
    }

    pub(crate) const fn with_padding(mut self, padding: f32) -> Self {
        self.padding = padding;
        self
    }

    pub const fn with_separator_style(mut self, separator_style: ActionBarSeparatorStyle) -> Self {
        self.separator_style = separator_style;
        self
    }
}

/// Reusable menu content with one interaction and accessibility tree.
///
/// Menu owns its surface, item layout, selection presentation, item interaction regions, and
/// accessibility semantics. The host owns open state, dismissal, focus restoration, and command
/// execution. Anchored placement belongs to [`super::ContextMenu`] and [`super::Dropdown`].
#[derive(Clone, Debug, PartialEq)]
pub struct Menu {
    bounds: Rect,
    content_bounds: Rect,
    item_bounds: Rect,
    header_bounds: Option<Rect>,
    items: Vec<MenuItem>,
    list_view: Option<ListView>,
    ids: MenuIds,
    accessibility_label: String,
    style: MenuStyle,
    selection: MenuSelection,
}

impl Menu {
    pub fn new(
        bounds: Rect,
        accessibility_label: impl Into<String>,
        items: Vec<MenuItem>,
        ids: MenuIds,
        style: MenuStyle,
    ) -> Self {
        Self::build(bounds, accessibility_label, items, ids, style, None)
    }

    pub(crate) fn new_scrollable(
        bounds: Rect,
        accessibility_label: impl Into<String>,
        items: Vec<MenuItem>,
        ids: MenuIds,
        style: MenuStyle,
        scroll: MenuScrollConfiguration,
    ) -> Self {
        Self::build(bounds, accessibility_label, items, ids, style, Some(scroll))
    }

    fn build(
        bounds: Rect,
        accessibility_label: impl Into<String>,
        items: Vec<MenuItem>,
        ids: MenuIds,
        style: MenuStyle,
        scroll: Option<MenuScrollConfiguration>,
    ) -> Self {
        let padding = style.padding.max(0.0);
        let content_bounds = inset_rect(bounds, padding);
        let header_height = style.header_height.max(0.0).min(content_bounds.size.height);
        let header_bounds = (header_height > 0.0).then(|| {
            Rect::from_xywh(
                content_bounds.origin.x,
                content_bounds.origin.y,
                content_bounds.size.width,
                header_height,
            )
        });
        let item_bounds = Rect::from_xywh(
            content_bounds.origin.x,
            content_bounds.origin.y + header_height,
            content_bounds.size.width,
            (content_bounds.size.height - header_height).max(0.0),
        );
        let list_view = scroll.map(|scroll| {
            let layout = VirtualListLayout::variable(
                items
                    .iter()
                    .map(|item| item.main_axis_extent(&style).max(f32::EPSILON)),
            );
            ListView::from_layout(item_bounds, layout, scroll.state, scroll.style)
                .with_overscan_items(1)
        });
        Self {
            bounds,
            content_bounds,
            item_bounds,
            header_bounds,
            items,
            list_view,
            ids,
            accessibility_label: accessibility_label.into(),
            style,
            selection: MenuSelection::default(),
        }
    }

    pub(crate) fn desired_size(
        items: &[MenuItem],
        style: &MenuStyle,
        maximum_visible_items: Option<usize>,
    ) -> Size {
        Size::new(
            style.item_size.width.max(0.0) + style.padding.max(0.0) * 2.0,
            style.header_height.max(0.0)
                + items
                    .iter()
                    .take(maximum_visible_items.unwrap_or(items.len()))
                    .map(|item| item.main_axis_extent(style))
                    .sum::<f32>()
                + style.padding.max(0.0) * 2.0,
        )
    }

    pub const fn with_selection(mut self, selection: MenuSelection) -> Self {
        self.selection = selection;
        self
    }

    pub const fn root(&self) -> ElementId {
        self.ids.root
    }

    /// Returns the interactive menu surface, excluding its visual shadow.
    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    /// Returns the item layout bounds inset by the menu's canonical padding.
    pub const fn content_bounds(&self) -> Rect {
        self.content_bounds
    }

    /// Returns the caller-owned leading row, when one was reserved by the style.
    pub const fn header_bounds(&self) -> Option<Rect> {
        self.header_bounds
    }

    /// Returns the clipped viewport occupied by menu items, excluding the optional header.
    pub const fn item_viewport_bounds(&self) -> Rect {
        self.item_bounds
    }

    pub fn scroll_metrics(&self) -> Option<ScrollMetrics> {
        self.list_view
            .as_ref()
            .map(|list_view| list_view.scroll_view().metrics())
    }

    pub fn selected_index(&self) -> Option<usize> {
        match self.selection {
            MenuSelection::FirstEnabled => self.items.iter().position(MenuItem::is_enabled),
            MenuSelection::Item(index) => self
                .items
                .get(index)
                .filter(|item| item.is_enabled())
                .map(|_| index),
            MenuSelection::None => None,
        }
    }

    pub fn item_bounds(&self, index: usize) -> Option<Rect> {
        let MenuItem::Action { .. } = self.items.get(index)? else {
            return None;
        };
        if let Some(list_view) = &self.list_view {
            return Some(list_view.item_bounds(index)?.intersection(self.item_bounds));
        }
        self.action_bar(0..self.items.len()).item_bounds(index)
    }

    pub fn interactive_item_bounds(&self, index: usize) -> Option<Rect> {
        if !self.items.get(index)?.is_enabled() {
            return None;
        }
        self.item_bounds(index)
    }

    pub fn hit_test(&self, point: Point) -> Option<usize> {
        if let Some(list_view) = &self.list_view {
            let index = list_view.item_at(point)?;
            return self
                .items
                .get(index)
                .is_some_and(MenuItem::is_enabled)
                .then_some(index);
        }
        self.action_bar(0..self.items.len()).hit_test(point)
    }

    /// Paints the canonical menu shell and items with caller-owned content in its header row.
    pub fn paint_with_header(
        &self,
        scene: &mut UiScene,
        paint_header: impl FnOnce(&mut UiScene, Rect),
    ) {
        scene.with_element(self.element_tree(), |scene, _element| {
            self.paint_contents(scene, paint_header)
        });
    }

    /// Composes the menu and caller-owned header content through one interaction tree.
    pub fn draw_components_with_header(
        &self,
        context: &mut ComponentContext<'_, '_>,
        draw_header: impl FnOnce(&mut ComponentContext<'_, '_>, Rect),
    ) {
        context.with_component(self, |context, _element| {
            self.compose_contents(context, draw_header)
        });
    }

    fn action_bar(&self, range: Range<usize>) -> ActionBar {
        let selected_index = self.selected_index();
        let items = self
            .items
            .get(range.clone())
            .unwrap_or_default()
            .iter()
            .enumerate()
            .map(|(local_index, item)| match item {
                MenuItem::Action { view, .. } => {
                    ActionBarItem::Action(view.clone().with_selection(
                        if selected_index == Some(range.start + local_index) {
                            ButtonSelection::Selected
                        } else {
                            ButtonSelection::Unselected
                        },
                    ))
                }
                MenuItem::Separator => ActionBarItem::Separator,
            })
            .collect::<Vec<_>>();
        let origin = self
            .unclipped_item_bounds(range.start)
            .map_or(self.item_bounds.origin, |bounds| bounds.origin);
        let height = self
            .items
            .get(range)
            .unwrap_or_default()
            .iter()
            .map(|item| item.main_axis_extent(&self.style))
            .sum();
        ActionBar::new(
            Rect::from_xywh(origin.x, origin.y, self.item_bounds.size.width, height),
            ActionBarOrientation::Vertical,
            items,
            ActionBarStyle::new(self.style.button_style.clone(), self.style.item_size)
                .with_separator_style(self.style.separator_style),
        )
    }

    fn unclipped_item_bounds(&self, index: usize) -> Option<Rect> {
        if let Some(list_view) = &self.list_view {
            return list_view.item_bounds(index);
        }
        let item = self.items.get(index)?;
        let offset = self
            .items
            .iter()
            .take(index)
            .map(|item| item.main_axis_extent(&self.style))
            .sum::<f32>();
        Some(Rect::from_xywh(
            self.item_bounds.origin.x,
            self.item_bounds.origin.y + offset,
            self.item_bounds.size.width,
            item.main_axis_extent(&self.style),
        ))
    }

    fn projected_range(&self) -> Range<usize> {
        let Some(list_view) = &self.list_view else {
            return 0..self.items.len();
        };
        list_view
            .layout()
            .projected_range(list_view.scroll_view().viewport())
    }

    fn interaction_regions(&self) -> Vec<InteractionRegion> {
        let navigation = NavigationGroupId::new(self.ids.root);
        self.items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                let MenuItem::Action { element, view } = item else {
                    return None;
                };
                let bounds = self.interactive_item_bounds(index)?;
                Some(
                    InteractionRegion::new(
                        "MenuItem",
                        *element,
                        bounds,
                        AccessibilityRole::MenuItem,
                        view.accessible_label(),
                    )
                    .with_cursor(CursorFeedback::Pointer)
                    .with_focus(FocusBehavior::TabStop)
                    .with_action(NodeAction::Activate)
                    .with_navigation(navigation, NavigationAxis::Vertical)
                    .with_selection(if self.selected_index() == Some(index) {
                        AccessibilitySelection::Selected
                    } else {
                        AccessibilitySelection::Unselected
                    }),
                )
            })
            .collect()
    }

    fn element_tree(&self) -> ComponentElement {
        Element::leaf("Menu")
            .padding(Edges::uniform(self.style.padding.max(0.0)))
            .corner_radii(self.style.corner_radii)
            .in_bounds(self.bounds)
            .with_identity(self.ids.root)
    }

    fn paint_surface(&self, scene: &mut UiScene) {
        scene.draw_rect(
            PaintRect::new(self.bounds, self.style.background)
                .with_border(self.style.border)
                .with_shadow(
                    BoxShadow::new(MENU_SHADOW)
                        .with_offset(Point::new(0.0, MENU_SHADOW_OFFSET_Y))
                        .with_blur_radius(MENU_SHADOW_BLUR_RADIUS),
                )
                .with_corner_radii(self.style.corner_radii),
        );
    }

    fn paint_contents(&self, scene: &mut UiScene, paint_header: impl FnOnce(&mut UiScene, Rect)) {
        self.paint_surface(scene);
        if let Some(header_bounds) = self.header_bounds {
            paint_header(scene, header_bounds);
        }
        let action_bar = self.action_bar(self.projected_range());
        if let Some(list_view) = &self.list_view {
            list_view.scroll_view().draw(scene, |scene, _viewport| {
                scene.draw_component(&action_bar);
            });
        } else {
            scene.draw_component(&action_bar);
        }
    }

    fn compose_contents(
        &self,
        context: &mut ComponentContext<'_, '_>,
        draw_header: impl FnOnce(&mut ComponentContext<'_, '_>, Rect),
    ) {
        self.paint_surface(context.scene_mut());
        if let Some(header_bounds) = self.header_bounds {
            draw_header(context, header_bounds);
        }
        for region in self.interaction_regions() {
            context.draw_component(&region);
        }
        let action_bar = self.action_bar(self.projected_range());
        if let Some(list_view) = &self.list_view {
            list_view
                .scroll_view()
                .draw_components(context, |context, _viewport| {
                    context.draw_component(&action_bar);
                });
        } else {
            context.draw_component(&action_bar);
        }
    }
}

impl Component for Menu {
    fn element(&self) -> ComponentElement {
        self.element_tree()
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                self.ids.root,
                element.bounds(),
                AccessibilityRole::Menu,
                self.accessibility_label.clone(),
            )
            .with_parent(self.ids.parent),
        )
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        self.compose_contents(context, |_context, _bounds| {});
    }

    fn paint_element(&self, scene: &mut UiScene, _element: &ComputedElement) {
        self.paint_contents(scene, |_scene, _bounds| {});
    }
}

fn inset_rect(bounds: Rect, inset: f32) -> Rect {
    Rect::from_xywh(
        bounds.origin.x + inset,
        bounds.origin.y + inset,
        (bounds.size.width - inset * 2.0).max(0.0),
        (bounds.size.height - inset * 2.0).max(0.0),
    )
}

#[cfg(test)]
#[path = "menu_tests.rs"]
mod tests;
