use std::collections::BTreeMap;
use std::time::Duration;
use std::time::Instant;

use crate::ui::foundation::AnimationBinding;
use crate::ui::foundation::AnimationEasing;
use crate::ui::foundation::AnimationKey;
use crate::ui::foundation::ElementId;
use crate::ui::foundation::FrameInvalidation;
use crate::ui::foundation::ScalarAnimationSpec;

use super::frame_scheduler::FrameSchedule;
use super::frame_scheduler::FrameScheduler;

const ANIMATION_FRAME_INTERVAL: Duration = Duration::from_millis(16);

/// Result of advancing a scalar animation to a host-provided time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AnimationAdvance {
    /// The current value did not change.
    Unchanged,
    /// The current value changed and the host should rebuild or redraw its presentation.
    Changed,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ScalarTransition {
    started_at: Instant,
    duration: Duration,
    from: f32,
    to: f32,
    easing: AnimationEasing,
}

impl ScalarTransition {
    fn value_at(self, now: Instant) -> f32 {
        if now <= self.started_at {
            return self.from;
        }
        let progress =
            now.duration_since(self.started_at).as_secs_f32() / self.duration.as_secs_f32();
        let progress = progress.clamp(0.0, 1.0);
        self.from + (self.to - self.from) * self.easing.apply(progress)
    }

    fn ends_at(self) -> Instant {
        self.started_at
            .checked_add(self.duration)
            .unwrap_or(self.started_at)
    }
}

/// Backend-neutral animation state for one interpolated scalar value.
///
/// The animation never creates timers, wakes a platform, or requests a redraw. A host starts or
/// retargets it with its current [`Instant`], calls [`Self::advance`] when the reported deadline
/// is reached, and uses [`Self::next_deadline`] to integrate the animation with its event loop.
#[derive(Clone, Debug, PartialEq)]
pub struct ScalarAnimation {
    value: f32,
    transition: Option<ScalarTransition>,
    next_deadline: Option<Instant>,
}

impl ScalarAnimation {
    /// Creates an idle animation at `initial`.
    ///
    /// # Panics
    ///
    /// Panics when `initial` is not finite.
    pub fn new(initial: f32) -> Self {
        assert!(initial.is_finite(), "animation value must be finite");
        Self {
            value: initial,
            transition: None,
            next_deadline: None,
        }
    }

    /// Returns the value to use for the current presentation.
    pub const fn value(&self) -> f32 {
        self.value
    }

    /// Returns the next time at which the host should advance this animation.
    pub const fn next_deadline(&self) -> Option<Instant> {
        self.next_deadline
    }

    /// Starts or retargets a transition from the value at `now` to `target`.
    ///
    /// Retargeting an in-flight transition first resolves its current value, so reversing a
    /// switch does not jump back to the previous endpoint. A zero duration snaps immediately.
    ///
    /// # Panics
    ///
    /// Panics when `target` is not finite.
    pub fn transition_to(
        &mut self,
        target: f32,
        duration: Duration,
        easing: AnimationEasing,
        now: Instant,
    ) {
        assert!(target.is_finite(), "animation target must be finite");
        self.resolve(now);
        if duration.is_zero() || (self.value - target).abs() <= f32::EPSILON {
            self.snap_to(target);
            return;
        }
        if self.transition.is_some_and(|transition| {
            transition.to == target
                && transition.duration == duration
                && transition.easing == easing
        }) {
            return;
        }
        self.transition = Some(ScalarTransition {
            started_at: now,
            duration,
            from: self.value,
            to: target,
            easing,
        });
        self.schedule_next_frame(now);
    }

    /// Stops any transition and sets the current value without scheduling a frame.
    ///
    /// # Panics
    ///
    /// Panics when `value` is not finite.
    pub fn snap_to(&mut self, value: f32) {
        assert!(value.is_finite(), "animation value must be finite");
        self.value = value;
        self.transition = None;
        self.next_deadline = None;
    }

    /// Stops an in-flight transition while preserving its current value.
    pub fn cancel(&mut self, now: Instant) {
        self.resolve(now);
        self.transition = None;
        self.next_deadline = None;
    }

    /// Advances the transition and reports whether its presentation value changed.
    pub fn advance(&mut self, now: Instant) -> AnimationAdvance {
        if self
            .next_deadline
            .is_some_and(|next_deadline| now < next_deadline)
        {
            return AnimationAdvance::Unchanged;
        }
        let previous = self.value;
        self.resolve(now);
        if (self.value - previous).abs() <= f32::EPSILON {
            AnimationAdvance::Unchanged
        } else {
            AnimationAdvance::Changed
        }
    }

    fn resolve(&mut self, now: Instant) {
        let Some(transition) = self.transition else {
            return;
        };
        self.value = transition.value_at(now);
        if now >= transition.ends_at() {
            self.value = transition.to;
            self.transition = None;
            self.next_deadline = None;
        } else {
            self.schedule_next_frame(now);
        }
    }

    fn schedule_next_frame(&mut self, now: Instant) {
        let frame_deadline = now.checked_add(ANIMATION_FRAME_INTERVAL);
        let transition_end = self.transition.map(ScalarTransition::ends_at);
        self.next_deadline = match (frame_deadline, transition_end) {
            (Some(frame_deadline), Some(transition_end)) => {
                Some(if transition_end < frame_deadline {
                    transition_end
                } else {
                    frame_deadline
                })
            }
            (Some(frame_deadline), None) => Some(frame_deadline),
            (None, Some(transition_end)) => Some(transition_end),
            (None, None) => None,
        };
    }
}

#[derive(Clone, Debug, PartialEq)]
struct AnimationTrack {
    animation: ScalarAnimation,
    invalidation: FrameInvalidation,
}

impl AnimationTrack {
    fn new(initial: f32, invalidation: FrameInvalidation) -> Self {
        Self {
            animation: ScalarAnimation::new(initial),
            invalidation,
        }
    }
}

/// The result of advancing all registered animation tracks to one host-provided time.
///
/// The report contains both the changed stable keys and the smallest frame work needed to
/// present them. Hosts may inspect the report for diagnostics and call [`Self::schedule`] to
/// project that work into their existing [`FrameScheduler`].
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AnimationAdvanceReport {
    changed_keys: Vec<AnimationKey>,
    invalidation: Option<FrameInvalidation>,
    fragment_ids: Option<Vec<ElementId>>,
    next_deadline: Option<Instant>,
}

impl AnimationAdvanceReport {
    /// Returns the stable properties whose sampled values changed at this time.
    pub fn changed_keys(&self) -> &[AnimationKey] {
        &self.changed_keys
    }

    /// Returns the strongest presentation work required by this report.
    pub const fn invalidation(&self) -> Option<FrameInvalidation> {
        self.invalidation
    }

    /// Returns fragment identities when every required update is fragment-local.
    pub fn fragment_ids(&self) -> Option<&[ElementId]> {
        self.fragment_ids.as_deref()
    }

    /// Returns the earliest deadline among tracks that are still in flight.
    pub const fn next_deadline(&self) -> Option<Instant> {
        self.next_deadline
    }

    /// Projects this report into the host's frame scheduler.
    ///
    /// `None` means that no track changed and no track remains active. The returned schedule is
    /// `RequestFrame` when this report caused the first pending work, otherwise `Coalesced`.
    pub fn schedule(&self, scheduler: &mut FrameScheduler) -> Option<FrameSchedule> {
        let invalidation = self.invalidation?;
        match invalidation {
            FrameInvalidation::Render | FrameInvalidation::Rebuild => {
                Some(scheduler.request(invalidation))
            }
            FrameInvalidation::Fragment => {
                let mut schedule = None;
                if let Some(fragment_ids) = self.fragment_ids() {
                    for id in fragment_ids {
                        schedule = Some(merge_schedule(schedule, scheduler.request_fragment(*id)));
                    }
                } else {
                    schedule = Some(scheduler.request(FrameInvalidation::Fragment));
                }
                schedule
            }
        }
    }

    fn record_track(&mut self, key: AnimationKey, track: &AnimationTrack, changed: bool) {
        if changed {
            self.changed_keys.push(key);
        }
        if track.animation.next_deadline().is_none() && !changed {
            return;
        }
        self.invalidation = Some(self.invalidation.map_or(track.invalidation, |current| {
            current.max(track.invalidation)
        }));
        if track.invalidation == FrameInvalidation::Fragment
            && self.invalidation == Some(FrameInvalidation::Fragment)
        {
            let fragment_ids = self.fragment_ids.get_or_insert_with(Vec::new);
            if !fragment_ids.contains(&key.element()) {
                fragment_ids.push(key.element());
            }
        } else if track.invalidation != FrameInvalidation::Fragment {
            self.fragment_ids = None;
        }
        if let Some(deadline) = track.animation.next_deadline() {
            self.next_deadline = Some(
                self.next_deadline
                    .map_or(deadline, |current| current.min(deadline)),
            );
        }
    }
}

/// Retained scalar animation tracks keyed by stable component identity and property.
///
/// The registry owns animation continuity and deadline aggregation, but it does not own timers,
/// platform wakeups, component state, or paint. A host updates targets, advances the registry at
/// an explicit time, and schedules the returned report through its platform-neutral
/// [`FrameScheduler`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AnimationRegistry {
    tracks: BTreeMap<AnimationKey, AnimationTrack>,
}

impl AnimationRegistry {
    /// Binds a component property to a stable target and returns its sampled presentation value.
    ///
    /// The first `initial` value is used only when `key` is first seen. Later compositions retain
    /// the current value and retarget from it, so component rebuilds do not restart a transition.
    pub fn bind_scalar(
        &mut self,
        key: AnimationKey,
        initial: f32,
        target: f32,
        spec: ScalarAnimationSpec,
        now: Instant,
    ) -> f32 {
        self.transition_to(key, initial, target, spec, now)
    }

    /// Creates or retargets a scalar track and returns its current sampled value.
    ///
    /// `initial` is used only when `key` is first seen. Rebuilding a component with the same key
    /// therefore preserves the in-flight value instead of restarting from a list index's value.
    pub fn transition_to(
        &mut self,
        key: AnimationKey,
        initial: f32,
        target: f32,
        spec: ScalarAnimationSpec,
        now: Instant,
    ) -> f32 {
        let track = self
            .tracks
            .entry(key)
            .or_insert_with(|| AnimationTrack::new(initial, spec.invalidation()));
        track.invalidation = spec.invalidation();
        track
            .animation
            .transition_to(target, spec.duration(), spec.easing(), now);
        track.animation.value()
    }

    /// Returns the current sampled value for a registered key.
    pub fn value(&self, key: AnimationKey) -> Option<f32> {
        self.tracks.get(&key).map(|track| track.animation.value())
    }

    /// Returns the earliest deadline among all active tracks.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.tracks
            .values()
            .filter_map(|track| track.animation.next_deadline())
            .min()
    }

    /// Advances every track and aggregates its changed keys, invalidation, and next deadline.
    pub fn advance(&mut self, now: Instant) -> AnimationAdvanceReport {
        let mut report = AnimationAdvanceReport::default();
        for (key, track) in &mut self.tracks {
            let changed = track.animation.advance(now) == AnimationAdvance::Changed;
            report.record_track(*key, track, changed);
        }
        report
    }

    /// Removes one property track when its owning component is unmounted.
    pub fn remove(&mut self, key: AnimationKey) -> Option<f32> {
        self.tracks
            .remove(&key)
            .map(|track| track.animation.value())
    }

    /// Removes every property track owned by one mounted element.
    pub fn remove_element(&mut self, element: ElementId) -> usize {
        let before = self.tracks.len();
        self.tracks.retain(|key, _| key.element() != element);
        before - self.tracks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tracks.is_empty()
    }

    pub fn len(&self) -> usize {
        self.tracks.len()
    }
}

impl AnimationBinding for AnimationRegistry {
    fn bind_scalar(
        &mut self,
        key: AnimationKey,
        initial: f32,
        target: f32,
        spec: ScalarAnimationSpec,
        now: Instant,
    ) -> f32 {
        AnimationRegistry::bind_scalar(self, key, initial, target, spec, now)
    }
}

fn merge_schedule(current: Option<FrameSchedule>, next: FrameSchedule) -> FrameSchedule {
    match (current, next) {
        (Some(FrameSchedule::RequestFrame), _) | (_, FrameSchedule::RequestFrame) => {
            FrameSchedule::RequestFrame
        }
        (Some(FrameSchedule::Coalesced) | None, FrameSchedule::Coalesced) => {
            FrameSchedule::Coalesced
        }
    }
}

#[cfg(test)]
#[path = "animation_tests.rs"]
mod tests;
