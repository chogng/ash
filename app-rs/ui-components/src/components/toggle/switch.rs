use super::ToggleState;
use super::centered_bounds;
use crate::Border;
use crate::Color;
use crate::Component;
use crate::ComponentElement;
use crate::CornerRadii;
use crate::Element;
use crate::PaintRect;
use crate::Rect;
use crate::Size;
use crate::UiScene;
/// On/off presentation projected onto one [`Switch`] by its host.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum SwitchSelection {
    #[default]
    Off,
    On,
}

impl SwitchSelection {
    const fn progress(self) -> f32 {
        match self {
            Self::Off => 0.0,
            Self::On => 1.0,
        }
    }
}

/// Track and thumb colors for one switch state.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct SwitchColors {
    track: Color,
    thumb: Color,
}

impl SwitchColors {
    pub const fn new(track: Color, thumb: Color) -> Self {
        Self { track, thumb }
    }

    pub const fn track(self) -> Color {
        self.track
    }

    pub const fn thumb(self) -> Color {
        self.thumb
    }
}

/// State-dependent track and thumb colors for one on/off position.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct SwitchStateColors {
    resting: SwitchColors,
    hovered: SwitchColors,
    focused: SwitchColors,
    pressed: SwitchColors,
    disabled: SwitchColors,
}

impl SwitchStateColors {
    pub const fn new(resting: SwitchColors) -> Self {
        Self {
            resting,
            hovered: resting,
            focused: resting,
            pressed: resting,
            disabled: resting,
        }
    }

    pub const fn with_hovered(mut self, hovered: SwitchColors) -> Self {
        self.hovered = hovered;
        self
    }

    pub const fn with_focused(mut self, focused: SwitchColors) -> Self {
        self.focused = focused;
        self
    }

    pub const fn with_pressed(mut self, pressed: SwitchColors) -> Self {
        self.pressed = pressed;
        self
    }

    pub const fn with_disabled(mut self, disabled: SwitchColors) -> Self {
        self.disabled = disabled;
        self
    }

    const fn for_state(self, state: ToggleState) -> SwitchColors {
        match state {
            ToggleState::Resting => self.resting,
            ToggleState::Hovered => self.hovered,
            ToggleState::Focused => self.focused,
            ToggleState::Pressed => self.pressed,
            ToggleState::Disabled => self.disabled,
        }
    }
}

/// Geometry and state presentation for a [`Switch`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SwitchStyle {
    off: SwitchStateColors,
    on: SwitchStateColors,
    track_size: Size,
    thumb_diameter: f32,
    thumb_inset: f32,
    track_border: Border,
    thumb_border: Border,
    track_corner_radii: CornerRadii,
    thumb_corner_radii: CornerRadii,
}

impl SwitchStyle {
    pub const fn new(off: SwitchStateColors, on: SwitchStateColors) -> Self {
        Self {
            off,
            on,
            track_size: Size::new(32.0, 18.0),
            thumb_diameter: 14.0,
            thumb_inset: 2.0,
            track_border: Border::uniform(0.0, Color::TRANSPARENT),
            thumb_border: Border::uniform(0.0, Color::TRANSPARENT),
            track_corner_radii: CornerRadii::uniform(9.0),
            thumb_corner_radii: CornerRadii::uniform(7.0),
        }
    }

    pub const fn with_track_size(mut self, track_size: Size) -> Self {
        self.track_size = track_size;
        self
    }

    pub const fn with_thumb_diameter(mut self, thumb_diameter: f32) -> Self {
        self.thumb_diameter = thumb_diameter;
        self
    }

    pub const fn with_thumb_inset(mut self, thumb_inset: f32) -> Self {
        self.thumb_inset = thumb_inset;
        self
    }

    pub const fn with_track_border(mut self, track_border: Border) -> Self {
        self.track_border = track_border;
        self
    }

    pub const fn with_thumb_border(mut self, thumb_border: Border) -> Self {
        self.thumb_border = thumb_border;
        self
    }

    pub const fn with_track_corner_radii(mut self, corner_radii: CornerRadii) -> Self {
        self.track_corner_radii = corner_radii;
        self
    }

    pub const fn with_thumb_corner_radii(mut self, corner_radii: CornerRadii) -> Self {
        self.thumb_corner_radii = corner_radii;
        self
    }

    const fn colors_for(self, selection: SwitchSelection, state: ToggleState) -> SwitchColors {
        match selection {
            SwitchSelection::Off => self.off.for_state(state),
            SwitchSelection::On => self.on.for_state(state),
        }
    }
}

/// Presentation-only on/off control with a rounded track and movable thumb.
///
/// The host owns the authoritative value, input routing, accessibility semantics, and toggle
/// transition clock. This component only projects the host-provided selection, animation progress,
/// and interaction state into shared geometry and paint primitives.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Switch {
    bounds: Rect,
    selection: SwitchSelection,
    state: ToggleState,
    style: SwitchStyle,
    thumb_progress: f32,
}

impl Switch {
    pub const fn new(
        bounds: Rect,
        selection: SwitchSelection,
        state: ToggleState,
        style: SwitchStyle,
    ) -> Self {
        Self {
            bounds,
            selection,
            state,
            style,
            thumb_progress: selection.progress(),
        }
    }

    pub const fn bounds(self) -> Rect {
        self.bounds
    }

    pub const fn selection(self) -> SwitchSelection {
        self.selection
    }

    pub const fn state(self) -> ToggleState {
        self.state
    }

    /// Returns the normalized thumb position, where `0.0` is off and `1.0` is on.
    pub const fn progress(self) -> f32 {
        self.thumb_progress
    }

    /// Uses a normalized thumb position supplied by the retained animation binding.
    pub fn with_progress(mut self, progress: f32) -> Self {
        assert!(
            progress.is_finite(),
            "switch animation progress must be finite"
        );
        self.thumb_progress = progress.clamp(0.0, 1.0);
        self
    }

    /// Returns the visual track bounds centered inside the host-provided hit bounds.
    pub fn track_bounds(self) -> Rect {
        centered_bounds(self.bounds, self.style.track_size)
    }

    /// Returns the visual thumb bounds for the projected on/off selection.
    pub fn thumb_bounds(self) -> Rect {
        let track = self.track_bounds();
        let requested_inset = self.style.thumb_inset.max(0.0);
        let requested_diameter = self.style.thumb_diameter.max(0.0);
        let diameter = requested_diameter
            .min(track.size.height.max(0.0))
            .min(track.size.width.max(0.0));
        let inset = requested_inset
            .min((track.size.height - diameter).max(0.0) * 0.5)
            .min((track.size.width - diameter).max(0.0) * 0.5);
        let travel = (track.size.width - inset * 2.0 - diameter).max(0.0);
        let x = track.origin.x + inset + travel * self.thumb_progress;
        let y = track.origin.y + (track.size.height - diameter) * 0.5;
        Rect::from_xywh(x, y, diameter, diameter)
    }
}

impl Component for Switch {
    fn element(&self) -> ComponentElement {
        Element::leaf("Switch").in_bounds(self.bounds)
    }

    fn paint(&self, scene: &mut UiScene) {
        let colors = self.style.colors_for(self.selection, self.state);
        scene.draw_rect(
            PaintRect::new(self.track_bounds(), colors.track())
                .with_border(self.style.track_border)
                .with_corner_radii(self.style.track_corner_radii),
        );
        scene.draw_rect(
            PaintRect::new(self.thumb_bounds(), colors.thumb())
                .with_border(self.style.thumb_border)
                .with_corner_radii(self.style.thumb_corner_radii),
        );
    }
}

#[cfg(test)]
#[path = "switch_tests.rs"]
mod tests;
