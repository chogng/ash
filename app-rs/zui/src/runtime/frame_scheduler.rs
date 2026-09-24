use crate::ui::foundation::ElementId;
use crate::ui::foundation::FrameInvalidation;

/// Whether a host must wake its platform event loop after scheduling frame work.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FrameSchedule {
    /// No frame was pending, so the host must request one from the platform.
    RequestFrame,
    /// An existing frame request now owns the additional work.
    Coalesced,
}

/// Coalesces invalidation produced between platform frames.
///
/// Hosts call [`FrameScheduler::request`] when state changes and wake the platform only for
/// [`FrameSchedule::RequestFrame`]. At the start of a redraw callback, the host consumes the
/// strongest pending invalidation with [`FrameScheduler::take`]. Requests arriving before that
/// callback are therefore reduced to one frame without zui depending on a windowing backend.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct FrameScheduler {
    pending: Option<FrameInvalidation>,
    fragment_ids: Option<Vec<ElementId>>,
}

impl FrameScheduler {
    /// Adds frame work and reports whether the platform needs a new frame request.
    pub fn request(&mut self, invalidation: FrameInvalidation) -> FrameSchedule {
        let schedule = if self.pending.is_some() {
            FrameSchedule::Coalesced
        } else {
            FrameSchedule::RequestFrame
        };
        if matches!(
            invalidation,
            FrameInvalidation::Rebuild | FrameInvalidation::Fragment
        ) {
            self.fragment_ids = None;
        }
        self.pending = Some(
            self.pending
                .map_or(invalidation, |pending| pending.max(invalidation)),
        );
        schedule
    }

    /// Schedules one stable retained fragment without invalidating unrelated presentation.
    ///
    /// Multiple IDs are retained until the next frame. A generic [`FrameInvalidation::Fragment`]
    /// request supersedes the ID set and asks the host to rebuild its whole fragment scope.
    pub fn request_fragment(&mut self, id: ElementId) -> FrameSchedule {
        let schedule = if self.pending.is_some() {
            FrameSchedule::Coalesced
        } else {
            FrameSchedule::RequestFrame
        };
        if self.pending == Some(FrameInvalidation::Rebuild) {
            return schedule;
        }
        match self.pending {
            Some(FrameInvalidation::Fragment) => {
                let Some(fragment_ids) = self.fragment_ids.as_mut() else {
                    return schedule;
                };
                if !fragment_ids.contains(&id) {
                    fragment_ids.push(id);
                }
            }
            Some(FrameInvalidation::Render) | None => {
                self.pending = Some(FrameInvalidation::Fragment);
                self.fragment_ids = Some(vec![id]);
            }
            Some(FrameInvalidation::Rebuild) => {}
        }
        schedule
    }

    /// Consumes the strongest work requested for the next frame.
    pub fn take(&mut self) -> Option<FrameInvalidation> {
        self.pending.take()
    }

    /// Takes the stable fragment IDs attached to the most recent fragment request.
    ///
    /// `None` means the pending fragment work was generic and the host should use its normal
    /// fragment rebuild path. `Some` contains exactly the IDs requested for local replacement.
    pub fn take_fragment_ids(&mut self) -> Option<Vec<ElementId>> {
        self.fragment_ids.take()
    }

    /// Discards pending work after a host completed an equivalent rebuild synchronously.
    pub fn clear(&mut self) {
        self.pending = None;
        self.fragment_ids = None;
    }

    pub const fn pending(&self) -> Option<FrameInvalidation> {
        self.pending
    }
}

#[cfg(test)]
#[path = "frame_scheduler_tests.rs"]
mod tests;
