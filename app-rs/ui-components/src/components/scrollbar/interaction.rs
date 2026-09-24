use std::time::Duration;
use std::time::Instant;

use zui::ui::AnimationEasing;
use zui::ui::Hover;
use zui::ui::HoverPresence;
use zui::ui::ScalarAnimation;

use crate::Point;
use crate::ScrollAxis;
use crate::ScrollState;
use crate::ScrollView;

use super::ScrollbarAxis;
use super::ScrollbarDrag;
use super::ScrollbarPart;

const DEFAULT_HOLD_DURATION: Duration = Duration::from_millis(700);
const DEFAULT_FADE_IN_DURATION: Duration = Duration::from_millis(120);
const DEFAULT_FADE_OUT_DURATION: Duration = Duration::from_millis(220);

/// Interaction state used by scrollbar styles to select semantic colors.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum ScrollbarState {
    #[default]
    Resting,
    Hovered,
    Active,
}

/// Current visual state supplied to one scrollbar.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollbarPresentation {
    state: ScrollbarState,
    opacity: f32,
}

/// Result of routing one pointer event through a scrollbar controller.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ScrollbarInteractionOutcome {
    pub handled: bool,
    pub presentation_changed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum ScrollbarCapture {
    Thumb(ScrollbarDrag),
    Track,
}

impl ScrollbarPresentation {
    pub const fn new(state: ScrollbarState, opacity: f32) -> Self {
        Self { state, opacity }
    }

    pub const fn state(self) -> ScrollbarState {
        self.state
    }

    pub fn opacity(self) -> f32 {
        self.opacity.clamp(0.0, 1.0)
    }
}

impl Default for ScrollbarPresentation {
    fn default() -> Self {
        Self::new(ScrollbarState::Resting, 1.0)
    }
}

/// Platform-independent hover, capture, active, and fade state for one scroll viewport.
///
/// The controller does not install timers or read platform events. Hosts route logical pointer
/// positions with the current [`ScrollView`], call [`Self::activity`] after wheel or keyboard
/// scrolling, and schedule [`Self::advance`] using [`Self::next_deadline`]. One controller covers
/// every horizontal and vertical scrollbar composed by that view.
#[derive(Clone, Debug)]
pub struct ScrollbarController {
    hold_duration: Duration,
    fade_in_duration: Duration,
    fade_out_duration: Duration,
    hover: Hover,
    opacity: ScalarAnimation,
    visible_until: Option<Instant>,
    capture: Option<ScrollbarCapture>,
}

impl ScrollbarController {
    /// Creates an initially hidden controller with explicit animation timing.
    ///
    /// # Panics
    ///
    /// Panics when either fade duration is zero.
    pub fn new(
        hold_duration: Duration,
        fade_in_duration: Duration,
        fade_out_duration: Duration,
    ) -> Self {
        assert!(
            !fade_in_duration.is_zero() && !fade_out_duration.is_zero(),
            "scrollbar fade durations must be non-zero"
        );
        Self {
            hold_duration,
            fade_in_duration,
            fade_out_duration,
            hover: Hover::default(),
            opacity: ScalarAnimation::new(0.0),
            visible_until: None,
            capture: None,
        }
    }

    pub fn presentation(&self) -> ScrollbarPresentation {
        let state = if self.capture.is_some() {
            ScrollbarState::Active
        } else if self.hover.is_hovered() {
            ScrollbarState::Hovered
        } else {
            ScrollbarState::Resting
        };
        ScrollbarPresentation::new(state, self.opacity.value())
    }

    pub const fn next_deadline(&self) -> Option<Instant> {
        match self.opacity.next_deadline() {
            Some(deadline) => Some(deadline),
            None => match self.hover.next_deadline() {
                Some(deadline) => Some(deadline),
                None => self.visible_until,
            },
        }
    }

    /// Reveals the scrollbar and extends its resting hold period after scroll activity.
    pub fn activity(&mut self, now: Instant) {
        self.resolve_transition(now);
        self.visible_until = now.checked_add(self.hold_duration);
        self.transition_to(1.0, self.fade_in_duration, now);
    }

    /// Projects whether the pointer is currently over the owning scroll viewport.
    pub fn pointer_presence(&mut self, presence: HoverPresence, now: Instant) {
        self.resolve_transition(now);
        if self.capture.is_some() || !self.hover.pointer_presence(presence, now) {
            return;
        }
        if self.hover.is_hovered() {
            self.visible_until = None;
            self.transition_to(1.0, self.fade_in_duration, now);
        } else {
            self.visible_until = None;
            self.transition_to(0.0, self.fade_out_duration, now);
        }
    }

    /// Routes pointer movement through the same geometry used to paint the scrollbar.
    ///
    /// An active thumb capture updates retained scroll state. Without capture, movement only
    /// updates hover and visibility, so the host can continue routing the event to nested content.
    pub fn pointer_moved(
        &mut self,
        view: ScrollView,
        state: &mut ScrollState,
        point: Point,
        now: Instant,
    ) -> ScrollbarInteractionOutcome {
        let previous_presentation = self.presentation();
        let offset_changed = match self.capture {
            Some(ScrollbarCapture::Thumb(drag)) => state.apply(
                drag.command_at(point),
                view.metrics(),
                scroll_axis(drag.axis()),
            ),
            Some(ScrollbarCapture::Track) => false,
            None => {
                let presence = if view.bounds().contains(point) {
                    HoverPresence::Over
                } else {
                    HoverPresence::Outside
                };
                self.pointer_presence(presence, now);
                false
            }
        };
        ScrollbarInteractionOutcome {
            handled: self.capture.is_some(),
            presentation_changed: offset_changed || self.presentation() != previous_presentation,
        }
    }

    /// Begins thumb capture or applies one track-page command under the pointer.
    pub fn press(
        &mut self,
        view: ScrollView,
        state: &mut ScrollState,
        point: Point,
        now: Instant,
    ) -> ScrollbarInteractionOutcome {
        let Some(hit) = view.hit_test_scrollbar(point) else {
            return ScrollbarInteractionOutcome::default();
        };
        let previous_presentation = self.presentation();
        let mut offset_changed = false;
        self.capture = match hit.part() {
            ScrollbarPart::Thumb => Some(ScrollbarCapture::Thumb(
                view.begin_scrollbar_drag(hit, point)
                    .expect("scrollbar thumb hit must begin a drag with the same geometry"),
            )),
            ScrollbarPart::Track => {
                if let Some(command) = view.track_click_command(hit, point) {
                    offset_changed = state.apply(command, view.metrics(), scroll_axis(hit.axis()));
                }
                Some(ScrollbarCapture::Track)
            }
        };
        self.begin_drag(now);
        ScrollbarInteractionOutcome {
            handled: true,
            presentation_changed: offset_changed || self.presentation() != previous_presentation,
        }
    }

    /// Releases active pointer capture and preserves hover when release remains in the viewport.
    pub fn release(
        &mut self,
        view: ScrollView,
        point: Point,
        now: Instant,
    ) -> ScrollbarInteractionOutcome {
        let previous_presentation = self.presentation();
        if self.capture.take().is_none() {
            return ScrollbarInteractionOutcome::default();
        }
        let presence = if view.bounds().contains(point) {
            HoverPresence::Over
        } else {
            HoverPresence::Outside
        };
        self.end_drag(presence, now);
        ScrollbarInteractionOutcome {
            handled: true,
            presentation_changed: self.presentation() != previous_presentation,
        }
    }

    /// Clears hover when the pointer leaves the window without cancelling an active capture.
    pub fn pointer_left(&mut self, now: Instant) -> bool {
        if self.capture.is_some() {
            return false;
        }
        let previous = self.presentation();
        self.pointer_presence(HoverPresence::Outside, now);
        self.presentation() != previous
    }

    fn begin_drag(&mut self, now: Instant) {
        self.resolve_transition(now);
        self.hover.cancel();
        self.visible_until = None;
        self.transition_to(1.0, self.fade_in_duration, now);
    }

    fn end_drag(&mut self, presence: HoverPresence, now: Instant) {
        self.resolve_transition(now);
        match presence {
            HoverPresence::Over => {
                self.hover.hover_now();
                self.visible_until = None;
                self.transition_to(1.0, self.fade_in_duration, now);
            }
            HoverPresence::Outside => {
                self.hover.cancel();
                self.visible_until = None;
                self.transition_to(0.0, self.fade_out_duration, now);
            }
        }
    }

    /// Cancels hover, capture, and animation when the owning window becomes inactive.
    pub fn cancel(&mut self) {
        self.capture = None;
        self.hover.cancel();
        self.opacity.snap_to(0.0);
        self.visible_until = None;
    }

    /// Advances an in-flight fade and returns whether the painted presentation changed.
    pub fn advance(&mut self, now: Instant) -> bool {
        let previous = self.presentation();
        let _ = self.hover.advance(now);
        self.resolve_transition(now);
        if self.opacity.next_deadline().is_none()
            && self.capture.is_none()
            && !self.hover.is_hovered()
            && self
                .visible_until
                .is_some_and(|visible_until| now >= visible_until)
        {
            self.visible_until = None;
            self.transition_to(0.0, self.fade_out_duration, now);
            self.resolve_transition(now);
        }
        self.presentation() != previous
    }

    fn resolve_transition(&mut self, now: Instant) {
        let _ = self.opacity.advance(now);
    }

    fn transition_to(&mut self, target: f32, duration: Duration, now: Instant) {
        self.opacity
            .transition_to(target, duration, AnimationEasing::Linear, now);
    }
}

const fn scroll_axis(axis: ScrollbarAxis) -> ScrollAxis {
    match axis {
        ScrollbarAxis::Horizontal => ScrollAxis::Horizontal,
        ScrollbarAxis::Vertical => ScrollAxis::Vertical,
    }
}

impl Default for ScrollbarController {
    fn default() -> Self {
        Self::new(
            DEFAULT_HOLD_DURATION,
            DEFAULT_FADE_IN_DURATION,
            DEFAULT_FADE_OUT_DURATION,
        )
    }
}

#[cfg(test)]
#[path = "interaction_tests.rs"]
mod tests;
