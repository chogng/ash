use crate::{
    AccessibilityRole, CaretVisibility, Color, Component, ComponentContext, ComponentElement,
    ComputedElement, CornerRadii, CursorFeedback, Element, ElementId, FocusBehavior,
    InteractionRegion, ListView, NavigationAxis, NavigationGroupId, NodeAction, PaintRect, Point,
    QuickInput, QuickInputIds, QuickInputMessageKind, QuickInputStyle, Rect, ScrollAxis,
    ScrollState, ScrollViewStyle, TextBlock, TextInput, TextInputLayoutEngine, TextStyle,
    UiDispatch, UiScene,
};

const ROW_HEIGHT: f32 = 34.0;

/// One host-owned item exposed through a quick pick list.
#[derive(Clone, Debug, PartialEq)]
pub struct QuickPickItem {
    element: ElementId,
    label: String,
    value: Option<String>,
}

impl QuickPickItem {
    pub fn new(element: ElementId, label: impl Into<String>) -> Self {
        Self {
            element,
            label: label.into(),
            value: None,
        }
    }

    pub fn with_value(mut self, value: impl Into<String>) -> Self {
        self.value = Some(value.into());
        self
    }
}

/// Visual tokens for quick input chrome and selectable list rows.
#[derive(Clone, Debug, PartialEq)]
pub struct QuickPickStyle {
    input: QuickInputStyle,
    item_hovered: Color,
    item_selected: Color,
    scroll_view: ScrollViewStyle,
}

impl QuickPickStyle {
    pub const fn new(
        input: QuickInputStyle,
        item_hovered: Color,
        item_selected: Color,
        scroll_view: ScrollViewStyle,
    ) -> Self {
        Self {
            input,
            item_hovered,
            item_selected,
            scroll_view,
        }
    }

    pub const fn text(&self) -> Color {
        self.input.text()
    }

    pub const fn text_muted(&self) -> Color {
        self.input.text_muted()
    }
}

/// Selection projected into a quick pick list.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum QuickPickSelection {
    #[default]
    None,
    Item(usize),
}

/// One visible quick pick row supplied to host-owned accessory paint.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct QuickPickItemLayout {
    index: usize,
    bounds: Rect,
}

impl QuickPickItemLayout {
    pub const fn index(self) -> usize {
        self.index
    }

    pub const fn bounds(self) -> Rect {
        self.bounds
    }
}

/// Searchable quick input whose content is a clipped, selectable list.
///
/// QuickPick owns list geometry, row semantics, selection paint, and automatic reveal. The host
/// retains search text, selection identity, input routing, filtering, and accepted-item effects.
pub struct QuickPick<'a> {
    input: QuickInput<'a>,
    items: Vec<QuickPickItem>,
    selection: QuickPickSelection,
    style: QuickPickStyle,
    dispatch: &'a UiDispatch,
}

impl<'a> QuickPick<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        viewport: Rect,
        title: impl Into<String>,
        placeholder: impl Into<String>,
        search_input: &TextInput,
        caret_visibility: CaretVisibility,
        items: Vec<QuickPickItem>,
        ids: QuickInputIds,
        style: QuickPickStyle,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &'a UiDispatch,
    ) -> Self {
        let input = QuickInput::new(
            viewport,
            title,
            placeholder,
            search_input,
            caret_visibility,
            ids,
            style.input.clone(),
            text_layout,
            dispatch,
        );
        Self {
            input,
            items,
            selection: QuickPickSelection::default(),
            style,
            dispatch,
        }
    }

    pub const fn with_selection(mut self, selection: QuickPickSelection) -> Self {
        self.selection = selection;
        self
    }

    pub fn with_message(mut self, message: impl Into<String>, kind: QuickInputMessageKind) -> Self {
        self.input = self.input.with_message(message, kind);
        self
    }

    pub const fn bounds(&self) -> Rect {
        self.input.bounds()
    }

    pub const fn search_caret_bounds(&self) -> Option<Rect> {
        self.input.search_caret_bounds()
    }

    pub const fn style(&self) -> &QuickPickStyle {
        &self.style
    }

    fn list_view(&self) -> ListView {
        let mut scroll = ScrollState::default();
        let initial = ListView::new(
            self.input.content_bounds(),
            self.items.len(),
            ROW_HEIGHT,
            scroll,
            self.style.scroll_view,
        );
        if let QuickPickSelection::Item(selected) = self.selection
            && let Some(command) = initial.ensure_visible_command(selected)
        {
            scroll.apply(
                command,
                initial.scroll_view().metrics(),
                ScrollAxis::Vertical,
            );
        }
        ListView::new(
            self.input.content_bounds(),
            self.items.len(),
            ROW_HEIGHT,
            scroll,
            self.style.scroll_view,
        )
    }

    fn item_region(&self, item: &QuickPickItem, bounds: Rect) -> InteractionRegion {
        let navigation = NavigationGroupId::new(self.input.root_id());
        let region = InteractionRegion::new(
            "QuickPickItem",
            item.element,
            bounds,
            AccessibilityRole::Button,
            item.label.clone(),
        )
        .with_cursor(CursorFeedback::Pointer)
        .with_focus(FocusBehavior::TabStop)
        .with_action(NodeAction::Activate)
        .with_navigation(navigation, NavigationAxis::Vertical);
        match &item.value {
            Some(value) => region.with_value(value.clone()),
            None => region,
        }
    }

    fn paint_item(&self, scene: &mut UiScene, index: usize, bounds: Rect) {
        let item = &self.items[index];
        let selected = self.selection == QuickPickSelection::Item(index);
        if selected
            || self.dispatch.is_hovered(item.element)
            || self.dispatch.is_focused(item.element)
            || self.dispatch.is_pressed(item.element)
        {
            let fill = if selected {
                self.style.item_selected
            } else {
                self.style.item_hovered
            };
            scene.draw_rect(
                PaintRect::new(bounds, fill).with_corner_radii(CornerRadii::uniform(4.0)),
            );
        }
        scene.draw_text(TextBlock::new(
            item.label.clone(),
            Point::new(bounds.origin.x + 10.0, bounds.origin.y + 8.0),
            crate::Size::new((bounds.size.width * 0.5).max(1.0), 18.0),
            TextStyle::new(13.0, self.style.text()).with_line_height(18.0),
        ));
    }

    pub fn draw_components(
        &self,
        context: &mut ComponentContext<'_, '_>,
        mut draw_accessory: impl FnMut(&mut ComponentContext<'_, '_>, QuickPickItemLayout),
    ) {
        self.input.draw_components(context, |context, _bounds| {
            self.list_view()
                .draw_components(context, |context, layout| {
                    let index = layout.index();
                    let bounds = layout.bounds();
                    self.paint_item(context.scene_mut(), index, bounds);
                    context.draw_component(&self.item_region(&self.items[index], bounds));
                    draw_accessory(context, QuickPickItemLayout { index, bounds });
                });
        });
    }

    pub fn paint_items(
        &self,
        scene: &mut UiScene,
        mut paint_accessory: impl FnMut(&mut UiScene, QuickPickItemLayout),
    ) {
        self.input.paint_content(scene, |scene, _bounds| {
            self.list_view().draw(scene, |scene, layout| {
                let index = layout.index();
                let bounds = layout.bounds();
                self.paint_item(scene, index, bounds);
                paint_accessory(scene, QuickPickItemLayout { index, bounds });
            });
        });
    }
}

impl Component for QuickPick<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("QuickPick").in_overlay(self.input.bounds())
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        self.draw_components(context, |_context, _layout| {});
    }

    fn paint_element(&self, scene: &mut UiScene, _element: &ComputedElement) {
        self.paint_items(scene, |_scene, _layout| {});
    }
}

#[cfg(test)]
#[path = "quick_pick_tests.rs"]
mod tests;
