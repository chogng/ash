use std::time::Instant;

use crate::ui::foundation::ElementId;

use super::animation::AnimationAdvanceReport;
use super::animation::AnimationRegistry;
use super::frame_scheduler::FrameSchedule;
use super::frame_scheduler::FrameScheduler;
use super::retained::RetainedFragmentAdvanceReport;
use super::retained::RetainedFragmentError;
use super::retained::RetainedFragmentExit;
use super::retained::RetainedFragmentMount;
use super::retained::RetainedFragmentRegistry;

/// The combined cross-frame report for retained fragments and their property animations.
///
/// Fragment expiration is applied before animation advancement. This guarantees that an
/// animation track owned by an expired identity cannot appear as changed work in the same report.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RetainedRuntimeAdvanceReport {
    fragment: RetainedFragmentAdvanceReport,
    animation: AnimationAdvanceReport,
    removed_animation_tracks: usize,
    next_deadline: Option<Instant>,
}

impl RetainedRuntimeAdvanceReport {
    /// Returns the fragment lifecycle report produced by this sample.
    pub const fn fragment(&self) -> &RetainedFragmentAdvanceReport {
        &self.fragment
    }

    /// Returns the animation report for tracks that remained mounted during this sample.
    pub const fn animation(&self) -> &AnimationAdvanceReport {
        &self.animation
    }

    /// Returns the number of animation property tracks removed with expired fragments.
    pub const fn removed_animation_tracks(&self) -> usize {
        self.removed_animation_tracks
    }

    /// Returns the earliest retained-fragment or animation deadline still active.
    pub const fn next_deadline(&self) -> Option<Instant> {
        self.next_deadline
    }

    /// Projects all frame work from this report into the host scheduler.
    pub fn schedule(&self, scheduler: &mut FrameScheduler) -> Option<FrameSchedule> {
        let mut schedule = self.fragment.schedule(scheduler);
        if let Some(next) = self.animation.schedule(scheduler) {
            schedule = Some(merge_schedule(schedule, next));
        }
        schedule
    }
}

/// Owns retained fragment lifecycle and property-animation cleanup as one backend-neutral runtime.
///
/// The runtime does not own scene primitives, interaction nodes, platform timers, or product
/// state. Hosts use [`Self::mount`] and [`Self::begin_exit`] while composing stable identities,
/// advance at an explicit monotonic time, apply [`RetainedRuntimeAdvanceReport::fragment`] to
/// scene and interaction checkpoints, and use the report's deadline to drive their event loop.
/// Animation tracks are removed automatically when their owning fragment is unmounted or expires.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RetainedRuntime {
    fragments: RetainedFragmentRegistry,
    animations: AnimationRegistry,
}

impl RetainedRuntime {
    /// Marks a stable identity as present in the current composition.
    pub fn mount(&mut self, id: ElementId) -> RetainedFragmentMount {
        self.fragments.mount(id)
    }

    /// Starts or retargets exit retention for a mounted identity.
    pub fn begin_exit(
        &mut self,
        id: ElementId,
        remove_at: Instant,
    ) -> Result<RetainedFragmentExit, RetainedFragmentError> {
        self.fragments.begin_exit(id, remove_at)
    }

    /// Immediately unmounts an identity and removes all of its animation tracks.
    ///
    /// The returned count is useful for host diagnostics and makes cleanup observable without
    /// exposing animation-track ownership to the product layer.
    pub fn unmount(&mut self, id: ElementId) -> Result<usize, RetainedFragmentError> {
        self.fragments.unmount(id)?;
        Ok(self.animations.remove_element(id))
    }

    /// Advances fragment exits first, removes expired owners' animation tracks, then samples the
    /// remaining animation tracks at `now`.
    pub fn advance(&mut self, now: Instant) -> RetainedRuntimeAdvanceReport {
        let fragment = self.fragments.advance(now);
        let removed_animation_tracks = fragment
            .removed_ids()
            .iter()
            .map(|id| self.animations.remove_element(*id))
            .sum();
        let animation = self.animations.advance(now);
        let next_deadline = earliest(fragment.next_deadline(), animation.next_deadline());
        RetainedRuntimeAdvanceReport {
            fragment,
            animation,
            removed_animation_tracks,
            next_deadline,
        }
    }

    /// Borrows the lifecycle registry for state inspection and host diagnostics.
    pub const fn fragment_registry(&self) -> &RetainedFragmentRegistry {
        &self.fragments
    }

    /// Borrows the lifecycle registry for composition-driven mount and exit operations.
    pub const fn fragment_registry_mut(&mut self) -> &mut RetainedFragmentRegistry {
        &mut self.fragments
    }

    /// Borrows the property-animation registry for component-owned target projection.
    pub const fn animation_registry(&self) -> &AnimationRegistry {
        &self.animations
    }

    /// Borrows the property-animation registry for explicit target and retarget operations.
    pub const fn animation_registry_mut(&mut self) -> &mut AnimationRegistry {
        &mut self.animations
    }

    /// Returns the earliest exit or animation deadline still active.
    pub fn next_deadline(&self) -> Option<Instant> {
        earliest(
            self.fragments.next_deadline(),
            self.animations.next_deadline(),
        )
    }
}

fn earliest(first: Option<Instant>, second: Option<Instant>) -> Option<Instant> {
    match (first, second) {
        (Some(first), Some(second)) => Some(first.min(second)),
        (Some(deadline), None) | (None, Some(deadline)) => Some(deadline),
        (None, None) => None,
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
#[path = "retained_runtime_tests.rs"]
mod tests;
