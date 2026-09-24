use std::collections::BTreeMap;
use std::collections::btree_map::Entry;
use std::time::Instant;

use crate::ui::foundation::ElementId;

use super::frame_scheduler::FrameSchedule;
use super::frame_scheduler::FrameScheduler;

/// The cross-frame lifecycle state of one retained presentation fragment.
///
/// `Mounted` means the current composition owns the fragment. `Exiting` means the current
/// composition has stopped exposing it, but the host may keep its paint fragment alive until
/// `remove_at`. Exiting fragments must not be re-added to the current interaction or inspection
/// frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetainedFragmentState {
    /// The fragment is part of the current composition.
    Mounted,
    /// The fragment is retained for exit presentation until the given monotonic deadline.
    Exiting { remove_at: Instant },
}

/// Result of presenting a fragment to [`RetainedFragmentRegistry::mount`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetainedFragmentMount {
    /// The identity was not tracked and is now mounted.
    Inserted,
    /// The identity was already mounted; its retained state was preserved.
    Updated,
    /// The identity was exiting and its exit was cancelled by re-entering the composition.
    Resumed,
}

/// Result of scheduling an exit for a retained fragment.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetainedFragmentExit {
    /// The mounted fragment entered the exit state.
    Scheduled { remove_at: Instant },
    /// An existing exit deadline was replaced by a new one.
    Rescheduled {
        previous_remove_at: Instant,
        remove_at: Instant,
    },
}

/// Failure returned when a lifecycle operation references an unknown retained fragment.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetainedFragmentError {
    /// The identity has not been mounted in this registry.
    Missing(ElementId),
}

/// The cleanup work produced when retained exit deadlines are reached.
///
/// The report is deliberately output-only. The registry does not own a `UiScene` or an
/// interaction frame, so the host applies each ID to its paired scene/interaction checkpoints.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RetainedFragmentAdvanceReport {
    removed_ids: Vec<ElementId>,
    next_deadline: Option<Instant>,
}

impl RetainedFragmentAdvanceReport {
    /// Returns the fragment identities that reached their exit deadline at or before the sampled
    /// time.
    pub fn removed_ids(&self) -> &[ElementId] {
        &self.removed_ids
    }

    /// Returns the next exit deadline still owned by the registry.
    pub const fn next_deadline(&self) -> Option<Instant> {
        self.next_deadline
    }

    /// Requests fragment-local redraws for all removed identities.
    ///
    /// The host should call this after removing the corresponding scene fragments. If a scene
    /// fragment cannot be removed locally because it is not terminal, the host must request a
    /// full [`crate::ui::FrameInvalidation::Rebuild`] instead.
    pub fn schedule(&self, scheduler: &mut FrameScheduler) -> Option<FrameSchedule> {
        let mut schedule = None;
        for id in &self.removed_ids {
            schedule = Some(merge_schedule(schedule, scheduler.request_fragment(*id)));
        }
        schedule
    }
}

/// Owns mount/update/unmount state for stable retained presentation fragments.
///
/// This registry is backend-neutral and does not paint, register interaction nodes, or create
/// timers. A host calls [`Self::mount`] whenever a retained identity is present in the current
/// composition, [`Self::begin_exit`] when it leaves that composition, and [`Self::advance`] at an
/// explicit monotonic time. The resulting IDs are then applied to the host's retained scene and
/// interaction checkpoints. Re-entering an exiting identity cancels removal without resetting
/// any animation track keyed by that identity.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RetainedFragmentRegistry {
    fragments: BTreeMap<ElementId, RetainedFragmentState>,
}

impl RetainedFragmentRegistry {
    /// Marks one stable identity as present in the current composition.
    pub fn mount(&mut self, id: ElementId) -> RetainedFragmentMount {
        match self.fragments.entry(id) {
            Entry::Vacant(entry) => {
                entry.insert(RetainedFragmentState::Mounted);
                RetainedFragmentMount::Inserted
            }
            Entry::Occupied(mut entry) => match entry.get() {
                RetainedFragmentState::Mounted => RetainedFragmentMount::Updated,
                RetainedFragmentState::Exiting { .. } => {
                    entry.insert(RetainedFragmentState::Mounted);
                    RetainedFragmentMount::Resumed
                }
            },
        }
    }

    /// Starts or retargets exit retention for a mounted identity.
    ///
    /// The fragment remains eligible for paint until `remove_at`, but it must not be emitted into
    /// the current interaction or inspection frame while exiting.
    pub fn begin_exit(
        &mut self,
        id: ElementId,
        remove_at: Instant,
    ) -> Result<RetainedFragmentExit, RetainedFragmentError> {
        let Some(state) = self.fragments.get_mut(&id) else {
            return Err(RetainedFragmentError::Missing(id));
        };
        match state {
            RetainedFragmentState::Mounted => {
                *state = RetainedFragmentState::Exiting { remove_at };
                Ok(RetainedFragmentExit::Scheduled { remove_at })
            }
            RetainedFragmentState::Exiting {
                remove_at: previous_remove_at,
            } => {
                let previous_remove_at = *previous_remove_at;
                *state = RetainedFragmentState::Exiting { remove_at };
                Ok(RetainedFragmentExit::Rescheduled {
                    previous_remove_at,
                    remove_at,
                })
            }
        }
    }

    /// Removes an identity immediately and ends all retention for it.
    pub fn unmount(&mut self, id: ElementId) -> Result<(), RetainedFragmentError> {
        self.fragments
            .remove(&id)
            .map(|_| ())
            .ok_or(RetainedFragmentError::Missing(id))
    }

    /// Samples exit deadlines and removes every fragment whose deadline has elapsed.
    pub fn advance(&mut self, now: Instant) -> RetainedFragmentAdvanceReport {
        let removed_ids = self
            .fragments
            .iter()
            .filter_map(|(&id, state)| match state {
                RetainedFragmentState::Mounted => None,
                RetainedFragmentState::Exiting { remove_at } => (*remove_at <= now).then_some(id),
            })
            .collect::<Vec<_>>();
        for id in &removed_ids {
            self.fragments.remove(id);
        }
        RetainedFragmentAdvanceReport {
            removed_ids,
            next_deadline: self.next_deadline(),
        }
    }

    /// Returns the current lifecycle state for one stable identity.
    pub fn state(&self, id: ElementId) -> Option<RetainedFragmentState> {
        self.fragments.get(&id).copied()
    }

    /// Returns the earliest exit deadline still owned by the registry.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.fragments
            .values()
            .filter_map(|state| match state {
                RetainedFragmentState::Mounted => None,
                RetainedFragmentState::Exiting { remove_at } => Some(*remove_at),
            })
            .min()
    }

    /// Returns the number of identities currently retained by the registry.
    pub fn len(&self) -> usize {
        self.fragments.len()
    }

    /// Returns whether the registry has no mounted or exiting identities.
    pub fn is_empty(&self) -> bool {
        self.fragments.is_empty()
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
#[path = "retained_tests.rs"]
mod tests;
