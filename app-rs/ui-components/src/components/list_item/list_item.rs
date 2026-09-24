use crate::{
    Border, Color, Component, ComponentElement, ComputedElement, CornerRadii, Rect, UiScene,
};

/// Pointer and focus state projected onto one list item by its host.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum ListItemState {
    #[default]
    Resting,
    Hovered,
    Focused,
    Pressed,
}

/// Selection state projected onto one list item by its host.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum ListItemSelection {
    #[default]
    Unselected,
    Selected,
}

/// State-dependent background colors for a list item surface.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ListItemBackgrounds {
    resting: Color,
    hovered: Color,
    focused: Color,
    pressed: Color,
}

impl ListItemBackgrounds {
    pub const fn new(resting: Color) -> Self {
        Self {
            resting,
            hovered: resting,
            focused: resting,
            pressed: resting,
        }
    }

    pub const fn with_hovered(mut self, hovered: Color) -> Self {
        self.hovered = hovered;
        self
    }

    pub const fn with_focused(mut self, focused: Color) -> Self {
        self.focused = focused;
        self
    }

    pub const fn with_pressed(mut self, pressed: Color) -> Self {
        self.pressed = pressed;
        self
    }

    const fn for_state(self, state: ListItemState) -> Color {
        match state {
            ListItemState::Resting => self.resting,
            ListItemState::Hovered => self.hovered,
            ListItemState::Focused => self.focused,
            ListItemState::Pressed => self.pressed,
        }
    }
}

/// Shared surface style for selectable list items.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ListItemStyle {
    backgrounds: ListItemBackgrounds,
    selected_backgrounds: ListItemBackgrounds,
    border: Border,
    corner_radii: CornerRadii,
}

impl ListItemStyle {
    pub const fn new(backgrounds: ListItemBackgrounds) -> Self {
        Self {
            backgrounds,
            selected_backgrounds: backgrounds,
            border: Border::uniform(0.0, Color::TRANSPARENT),
            corner_radii: CornerRadii::uniform(0.0),
        }
    }

    pub const fn with_selected_backgrounds(
        mut self,
        selected_backgrounds: ListItemBackgrounds,
    ) -> Self {
        self.selected_backgrounds = selected_backgrounds;
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

    const fn backgrounds_for(self, selection: ListItemSelection) -> ListItemBackgrounds {
        match selection {
            ListItemSelection::Unselected => self.backgrounds,
            ListItemSelection::Selected => self.selected_backgrounds,
        }
    }
}

/// Presentation-only surface for one selectable row in a list or tree.
///
/// The host owns identity, accessibility, activation, layout, and row content. `ListItem` owns
/// only state-dependent surface paint for the supplied bounds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ListItem {
    bounds: Rect,
    state: ListItemState,
    selection: ListItemSelection,
    style: ListItemStyle,
}

impl ListItem {
    pub const fn new(bounds: Rect, state: ListItemState, style: ListItemStyle) -> Self {
        Self {
            bounds,
            state,
            selection: ListItemSelection::Unselected,
            style,
        }
    }

    pub const fn with_selection(mut self, selection: ListItemSelection) -> Self {
        self.selection = selection;
        self
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }
}

impl Component for ListItem {
    fn element(&self) -> ComponentElement {
        zui::ui! {
            leaf("ListItem") {
                style {
                    background: self.style
                        .backgrounds_for(self.selection)
                        .for_state(self.state);
                    border: self.style.border;
                    radii: self.style.corner_radii;
                }
            }
        }
        .in_bounds(self.bounds)
    }

    fn paint_element(&self, _scene: &mut UiScene, _element: &ComputedElement) {}

    fn paint(&self, scene: &mut UiScene) {
        scene.with_element(self.element(), |_scene, _element| {});
    }
}

#[cfg(test)]
#[path = "list_item_tests.rs"]
mod tests;
