use crate::{Color, Component, ComponentElement, Element, PaintRect, Rect, UiScene};

/// Physical direction of a Sash separator and its resize cursor.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum SashOrientation {
    #[default]
    Vertical,
    Horizontal,
}

/// Sash interaction presentation consumed by the visual component.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum SashState {
    #[default]
    Resting,
    Hovered,
    Active,
}

/// Shared hit-target and feedback-line metrics for a [`Sash`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SashStyle {
    drag_area_size: f32,
    feedback_size: f32,
    feedback_color: Color,
}

impl SashStyle {
    pub const fn new(feedback_color: Color) -> Self {
        Self {
            drag_area_size: 8.0,
            feedback_size: 2.0,
            feedback_color,
        }
    }

    pub const fn with_drag_area_size(mut self, drag_area_size: f32) -> Self {
        self.drag_area_size = drag_area_size;
        self
    }

    pub const fn with_feedback_size(mut self, feedback_size: f32) -> Self {
        self.feedback_size = feedback_size;
        self
    }
}

/// Presentation-only resize separator derived from a caller-provided zero-area track.
///
/// The host owns pointer capture, cursor selection, accessibility, and authoritative pane sizes.
/// [`super::Resizable`] owns the generic drag state; this component owns the shared relationship
/// between the separator track, its wider interaction target, and its visible hover/active
/// feedback line.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sash {
    track_bounds: Rect,
    orientation: SashOrientation,
    state: SashState,
    style: SashStyle,
}

impl Sash {
    pub fn new(
        track_bounds: Rect,
        orientation: SashOrientation,
        state: SashState,
        style: SashStyle,
    ) -> Self {
        assert!(
            track_bounds.origin.x.is_finite()
                && track_bounds.origin.y.is_finite()
                && track_bounds.size.width.is_finite()
                && track_bounds.size.height.is_finite()
                && track_bounds.size.width >= 0.0
                && track_bounds.size.height >= 0.0,
            "Sash track bounds must be finite with non-negative dimensions"
        );
        assert!(
            style.drag_area_size.is_finite() && style.drag_area_size > 0.0,
            "Sash drag area size must be positive and finite"
        );
        assert!(
            style.feedback_size.is_finite() && style.feedback_size > 0.0,
            "Sash feedback size must be positive and finite"
        );
        match orientation {
            SashOrientation::Vertical => {
                assert_eq!(
                    track_bounds.size.width, 0.0,
                    "vertical Sash track must have zero width"
                );
            }
            SashOrientation::Horizontal => {
                assert_eq!(
                    track_bounds.size.height, 0.0,
                    "horizontal Sash track must have zero height"
                );
            }
        }
        Self {
            track_bounds,
            orientation,
            state,
            style,
        }
    }

    pub fn interaction_bounds(self) -> Rect {
        centered_bounds(
            self.track_bounds,
            self.orientation,
            self.style.drag_area_size,
        )
    }

    pub fn feedback_bounds(self) -> Rect {
        centered_bounds(
            self.track_bounds,
            self.orientation,
            self.style.feedback_size,
        )
    }
}

impl Component for Sash {
    fn element(&self) -> ComponentElement {
        Element::leaf("Sash").in_bounds(self.interaction_bounds())
    }

    fn paint(&self, scene: &mut UiScene) {
        if matches!(self.state, SashState::Hovered | SashState::Active) {
            scene.draw_rect(PaintRect::new(
                self.feedback_bounds(),
                self.style.feedback_color,
            ));
        }
    }
}

fn centered_bounds(track: Rect, orientation: SashOrientation, size: f32) -> Rect {
    match orientation {
        SashOrientation::Vertical => Rect::from_xywh(
            track.origin.x - size / 2.0,
            track.origin.y,
            size,
            track.size.height,
        ),
        SashOrientation::Horizontal => Rect::from_xywh(
            track.origin.x,
            track.origin.y - size / 2.0,
            track.size.width,
            size,
        ),
    }
}

#[cfg(test)]
#[path = "sash_tests.rs"]
mod tests;
