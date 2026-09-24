use crate::AccessibilityRole;
use crate::ActionViewItem;
use crate::ButtonState;
use crate::ButtonStyle;
use crate::CaretVisibility;
use crate::Color;
use crate::Component;
use crate::ComponentContext;
use crate::ComponentElement;
use crate::ComputedElement;
use crate::ContextViewAnchorPosition;
use crate::ContextViewPlacement;
use crate::CursorFeedback;
use crate::Dropdown;
use crate::DropdownScrollConfiguration;
use crate::DropdownStyle;
use crate::Element;
use crate::ElementId;
use crate::FocusBehavior;
use crate::InputBoxState;
use crate::InteractionRegion;
use crate::MenuIds;
use crate::MenuItem;
use crate::MenuSelection;
use crate::MenuStyle;
use crate::NavigationAxis;
use crate::NavigationGroupId;
use crate::Rect;
use crate::ScrollMetrics;
use crate::ScrollState;
use crate::ScrollViewStyle;
use crate::SearchBox;
use crate::SearchBoxStyle;
use crate::Size;
use crate::TextInput;
use crate::TextInputLayoutEngine;
use crate::UiDispatch;
use crate::UiScene;

const SEARCH_ROW_HEIGHT: f32 = 36.0;
const SEARCH_INSET: f32 = 4.0;
const VIEWPORT_MARGIN: f32 = 6.0;
const ANCHOR_GAP: f32 = 4.0;

/// Stable host-owned identities used by one anchored picker.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PickerIds {
    parent: ElementId,
    root: ElementId,
    search: ElementId,
}

impl PickerIds {
    pub const fn new(parent: ElementId, root: ElementId, search: ElementId) -> Self {
        Self {
            parent,
            root,
            search,
        }
    }
}

/// One host-owned candidate projected into an anchored picker.
#[derive(Clone, Debug, PartialEq)]
pub struct PickerItem {
    element: ElementId,
    label: String,
    enabled: bool,
    selected: bool,
}

impl PickerItem {
    pub fn new(element: ElementId, label: impl Into<String>) -> Self {
        Self {
            element,
            label: label.into(),
            enabled: true,
            selected: false,
        }
    }

    pub const fn disabled(mut self) -> Self {
        self.enabled = false;
        self
    }

    pub const fn selected(mut self) -> Self {
        self.selected = true;
        self
    }
}

/// Visual tokens and size policy for an anchored picker.
#[derive(Clone, Debug, PartialEq)]
pub struct PickerStyle {
    background: Color,
    button: ButtonStyle,
    search: SearchBoxStyle,
    scroll_view: ScrollViewStyle,
    item_size: Size,
    maximum_visible_items: usize,
}

impl PickerStyle {
    pub fn new(
        background: Color,
        button: ButtonStyle,
        search: SearchBoxStyle,
        scroll_view: ScrollViewStyle,
        item_size: Size,
        maximum_visible_items: usize,
    ) -> Self {
        assert!(
            maximum_visible_items > 0,
            "Picker maximum visible item count must be non-zero"
        );
        Self {
            background,
            button,
            search,
            scroll_view,
            item_size,
            maximum_visible_items,
        }
    }
}

/// Anchored search field and scrollable candidate list used by product-owned pickers.
///
/// Picker owns floating geometry, row presentation, accessibility, and search presentation. The
/// host retains open state, query text, filtering, input routing, and accepted-item effects.
pub struct Picker {
    dropdown: Dropdown,
    search_box: SearchBox,
    search_region: InteractionRegion,
    root: ElementId,
}

impl Picker {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        viewport: Rect,
        anchor: Rect,
        accessibility_label: impl Into<String>,
        placeholder: impl Into<String>,
        search_input: &TextInput,
        caret_visibility: CaretVisibility,
        items: Vec<PickerItem>,
        scroll: ScrollState,
        ids: PickerIds,
        style: PickerStyle,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &UiDispatch,
    ) -> Self {
        let accessibility_label = accessibility_label.into();
        let menu_items = items
            .iter()
            .map(|item| {
                let state = if !item.enabled {
                    ButtonState::Disabled
                } else if dispatch.is_pressed(item.element) {
                    ButtonState::Pressed
                } else if dispatch.is_focused(item.element) {
                    ButtonState::Focused
                } else if dispatch.is_hovered(item.element) {
                    ButtonState::Hovered
                } else {
                    ButtonState::Resting
                };
                MenuItem::action(
                    item.element,
                    ActionViewItem::label(item.label.clone(), state),
                )
            })
            .collect();
        let selection = items
            .iter()
            .position(|item| {
                item.enabled
                    && (dispatch.is_pressed(item.element)
                        || dispatch.is_focused(item.element)
                        || dispatch.is_hovered(item.element))
            })
            .or_else(|| items.iter().position(|item| item.enabled && item.selected))
            .map(MenuSelection::Item)
            .unwrap_or(MenuSelection::None);
        let dropdown = Dropdown::new_scrollable(
            viewport,
            anchor,
            accessibility_label.clone(),
            menu_items,
            MenuIds::new(ids.parent, ids.root),
            DropdownStyle::new(
                MenuStyle::new(style.background, style.button, style.item_size)
                    .with_header_height(SEARCH_ROW_HEIGHT),
            )
            .with_placement(
                ContextViewPlacement::new()
                    .with_position(ContextViewAnchorPosition::Before)
                    .with_gap(ANCHOR_GAP)
                    .with_viewport_margin(VIEWPORT_MARGIN),
            ),
            DropdownScrollConfiguration::new(
                scroll,
                style.maximum_visible_items,
                style.scroll_view,
            ),
        )
        .with_selection(selection);
        let header = dropdown
            .header_bounds()
            .expect("Picker always reserves a search row");
        let search_bounds = Rect::from_xywh(
            header.origin.x + SEARCH_INSET,
            header.origin.y + SEARCH_INSET,
            (header.size.width - SEARCH_INSET * 2.0).max(1.0),
            (header.size.height - SEARCH_INSET * 2.0).max(1.0),
        );
        let search_state = if dispatch.is_focused(ids.search) {
            InputBoxState::Focused(caret_visibility)
        } else if dispatch.is_hovered(ids.search) {
            InputBoxState::Hovered
        } else {
            InputBoxState::Resting
        };
        let search_box = SearchBox::new(
            search_bounds,
            placeholder,
            search_state,
            style.search,
            search_input,
            text_layout,
        );
        let search_region = InteractionRegion::new(
            "PickerSearchInput",
            ids.search,
            search_box.bounds(),
            AccessibilityRole::TextInput,
            format!("Search {accessibility_label}"),
        )
        .with_cursor(CursorFeedback::Text)
        .with_focus(FocusBehavior::TabStop)
        .with_navigation(NavigationGroupId::new(ids.root), NavigationAxis::Vertical)
        .with_value(search_input.text());
        Self {
            dropdown,
            search_box,
            search_region,
            root: ids.root,
        }
    }

    pub const fn bounds(&self) -> Rect {
        self.dropdown.bounds()
    }

    pub const fn search_caret_bounds(&self) -> Option<Rect> {
        self.search_box.caret_bounds()
    }

    pub const fn item_viewport_bounds(&self) -> Rect {
        self.dropdown.item_viewport_bounds()
    }

    pub fn scroll_metrics(&self) -> Option<ScrollMetrics> {
        self.dropdown.scroll_metrics()
    }

    pub fn selected_index(&self) -> Option<usize> {
        self.dropdown.selected_index()
    }

    pub fn item_bounds(&self, index: usize) -> Option<Rect> {
        self.dropdown.item_bounds(index)
    }
}

impl Component for Picker {
    fn element(&self) -> ComponentElement {
        Element::leaf("Picker").in_bounds(self.dropdown.bounds())
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        self.dropdown
            .draw_components_with_header(context, |context, _bounds| {
                context.draw_component(&self.search_region);
                context.draw_component(&self.search_box);
            });
        context.set_modal_root(self.root);
    }

    fn paint(&self, scene: &mut UiScene) {
        self.dropdown.paint_with_header(scene, |scene, _bounds| {
            scene.draw_component(&self.search_box);
        });
    }
}

#[cfg(test)]
#[path = "picker_tests.rs"]
mod tests;
