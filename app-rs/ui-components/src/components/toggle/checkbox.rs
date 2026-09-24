use super::ToggleState;
use super::centered_bounds;
use crate::Border;
use crate::Color;
use crate::Component;
use crate::ComponentElement;
use crate::CornerRadii;
use crate::Element;
use crate::Icon;
use crate::PaintIcon;
use crate::PaintRect;
use crate::Rect;
use crate::Size;
use crate::UiScene;

/// Selection presented by one [`Checkbox`].
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum CheckboxSelection {
    #[default]
    Unchecked,
    Checked,
    Mixed,
}

/// Background, border, and mark colors for one checkbox state.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct CheckboxColors {
    background: Color,
    border: Color,
    mark: Color,
}

impl CheckboxColors {
    pub const fn new(background: Color, border: Color, mark: Color) -> Self {
        Self {
            background,
            border,
            mark,
        }
    }

    pub const fn background(self) -> Color {
        self.background
    }

    pub const fn border(self) -> Color {
        self.border
    }

    pub const fn mark(self) -> Color {
        self.mark
    }
}

/// Interaction-state colors for one checkbox selection.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct CheckboxStateColors {
    resting: CheckboxColors,
    hovered: CheckboxColors,
    focused: CheckboxColors,
    pressed: CheckboxColors,
    disabled: CheckboxColors,
}

impl CheckboxStateColors {
    pub const fn new(resting: CheckboxColors) -> Self {
        Self {
            resting,
            hovered: resting,
            focused: resting,
            pressed: resting,
            disabled: resting,
        }
    }

    pub const fn with_hovered(mut self, hovered: CheckboxColors) -> Self {
        self.hovered = hovered;
        self
    }

    pub const fn with_focused(mut self, focused: CheckboxColors) -> Self {
        self.focused = focused;
        self
    }

    pub const fn with_pressed(mut self, pressed: CheckboxColors) -> Self {
        self.pressed = pressed;
        self
    }

    pub const fn with_disabled(mut self, disabled: CheckboxColors) -> Self {
        self.disabled = disabled;
        self
    }

    const fn for_state(self, state: ToggleState) -> CheckboxColors {
        match state {
            ToggleState::Resting => self.resting,
            ToggleState::Hovered => self.hovered,
            ToggleState::Focused => self.focused,
            ToggleState::Pressed => self.pressed,
            ToggleState::Disabled => self.disabled,
        }
    }
}

/// Geometry, icons, and state colors for a [`Checkbox`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CheckboxStyle {
    unchecked: CheckboxStateColors,
    checked: CheckboxStateColors,
    mixed: CheckboxStateColors,
    checked_icon: Icon,
    mixed_icon: Icon,
    box_extent: f32,
    border_width: f32,
    mark_inset: f32,
    corner_radii: CornerRadii,
}

impl CheckboxStyle {
    pub const fn new(
        unchecked: CheckboxStateColors,
        checked: CheckboxStateColors,
        mixed: CheckboxStateColors,
        checked_icon: Icon,
        mixed_icon: Icon,
    ) -> Self {
        Self {
            unchecked,
            checked,
            mixed,
            checked_icon,
            mixed_icon,
            box_extent: 18.0,
            border_width: 1.0,
            mark_inset: 3.0,
            corner_radii: CornerRadii::uniform(3.0),
        }
    }

    pub const fn with_box_extent(mut self, box_extent: f32) -> Self {
        self.box_extent = box_extent;
        self
    }

    pub const fn with_border_width(mut self, border_width: f32) -> Self {
        self.border_width = border_width;
        self
    }

    pub const fn with_mark_inset(mut self, mark_inset: f32) -> Self {
        self.mark_inset = mark_inset;
        self
    }

    pub const fn with_corner_radii(mut self, corner_radii: CornerRadii) -> Self {
        self.corner_radii = corner_radii;
        self
    }

    const fn colors_for(self, selection: CheckboxSelection, state: ToggleState) -> CheckboxColors {
        match selection {
            CheckboxSelection::Unchecked => self.unchecked.for_state(state),
            CheckboxSelection::Checked => self.checked.for_state(state),
            CheckboxSelection::Mixed => self.mixed.for_state(state),
        }
    }
}

/// Checkbox presentation with unchecked, checked, and mixed selections.
///
/// The host owns the authoritative value, input routing, and accessibility semantics. The
/// component owns only box geometry, state-dependent paint, and selection artwork.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Checkbox {
    bounds: Rect,
    selection: CheckboxSelection,
    state: ToggleState,
    style: CheckboxStyle,
}

impl Checkbox {
    pub const fn new(
        bounds: Rect,
        selection: CheckboxSelection,
        state: ToggleState,
        style: CheckboxStyle,
    ) -> Self {
        Self {
            bounds,
            selection,
            state,
            style,
        }
    }

    pub const fn bounds(self) -> Rect {
        self.bounds
    }

    pub const fn selection(self) -> CheckboxSelection {
        self.selection
    }

    pub const fn state(self) -> ToggleState {
        self.state
    }

    pub fn box_bounds(self) -> Rect {
        centered_bounds(
            self.bounds,
            Size::new(self.style.box_extent, self.style.box_extent),
        )
    }

    pub fn mark_bounds(self) -> Rect {
        let bounds = self.box_bounds();
        let inset = self
            .style
            .mark_inset
            .max(0.0)
            .min(bounds.size.width * 0.5)
            .min(bounds.size.height * 0.5);
        Rect::from_xywh(
            bounds.origin.x + inset,
            bounds.origin.y + inset,
            (bounds.size.width - inset * 2.0).max(0.0),
            (bounds.size.height - inset * 2.0).max(0.0),
        )
    }
}

impl Component for Checkbox {
    fn element(&self) -> ComponentElement {
        Element::leaf("Checkbox").in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        let colors = self.style.colors_for(self.selection, self.state);
        scene.draw_rect(
            PaintRect::new(self.box_bounds(), colors.background())
                .with_border(Border::uniform(
                    self.style.border_width.max(0.0),
                    colors.border(),
                ))
                .with_corner_radii(self.style.corner_radii),
        );
        let icon = match self.selection {
            CheckboxSelection::Unchecked => return,
            CheckboxSelection::Checked => self.style.checked_icon,
            CheckboxSelection::Mixed => self.style.mixed_icon,
        };
        scene.draw_icon(PaintIcon::new(icon, self.mark_bounds(), colors.mark()));
    }
}

#[cfg(test)]
#[path = "checkbox_tests.rs"]
mod tests;
