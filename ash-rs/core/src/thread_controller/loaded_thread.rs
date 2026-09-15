use crate::CoreError;
use crate::ThreadSnapshot;
use crate::ThreadStore;
use crate::context_manager::ContextManager;

use ash_protocol::ThreadId;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

/// Identifies one process-local load of a durable Thread.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ThreadIncarnationId(u64);

pub(super) struct LoadedThreadState {
    pub(super) incarnation: ThreadIncarnationId,
    pub(super) snapshot: ThreadSnapshot,
    pub(super) context: ContextManager,
}

pub(super) struct ThreadSlot {
    pub(super) loaded: Mutex<Option<LoadedThreadState>>,
    pub(super) activity: ash_async_utils::Notify,
    mutation_gate: MutationGate,
}

impl ThreadSlot {
    pub(super) fn enter_mutation(&self) -> Result<MutationPermit<'_>, CoreError> {
        let ticket = {
            let mut state = self.mutation_gate.state.lock().map_err(|_| {
                CoreError::Journal("loaded Thread mutation gate lock poisoned".into())
            })?;
            let ticket = state.next_ticket;
            state.next_ticket = state.next_ticket.saturating_add(1);
            ticket
        };
        let mut state =
            self.mutation_gate.state.lock().map_err(|_| {
                CoreError::Journal("loaded Thread mutation gate lock poisoned".into())
            })?;
        while state.serving != ticket {
            state = self.mutation_gate.changed.wait(state).map_err(|_| {
                CoreError::Journal("loaded Thread mutation gate lock poisoned".into())
            })?;
        }
        Ok(MutationPermit {
            gate: &self.mutation_gate,
        })
    }
}

/// Keeps small stable Thread slots while allowing their loaded projections to be evicted.
///
/// The registry lock protects only the ID-to-slot map. Durable loading and mutation happen under
/// each slot's independent lock, so one Thread's store I/O cannot block another Thread's commit.
pub(super) struct LoadedThreads {
    store: Arc<dyn ThreadStore>,
    slots: Mutex<BTreeMap<ThreadId, Arc<ThreadSlot>>>,
    next_incarnation: AtomicU64,
}

impl LoadedThreads {
    pub(super) fn new(store: Arc<dyn ThreadStore>) -> Self {
        Self {
            store,
            slots: Mutex::new(BTreeMap::new()),
            next_incarnation: AtomicU64::new(1),
        }
    }

    pub(super) fn slot(&self, thread_id: &ThreadId) -> Result<Arc<ThreadSlot>, CoreError> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| CoreError::Journal("loaded Thread registry lock poisoned".into()))?;
        Ok(slots
            .entry(thread_id.clone())
            .or_insert_with(|| {
                Arc::new(ThreadSlot {
                    loaded: Mutex::new(None),
                    activity: ash_async_utils::Notify::default(),
                    mutation_gate: MutationGate::default(),
                })
            })
            .clone())
    }

    pub(super) fn existing_slot(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<Arc<ThreadSlot>>, CoreError> {
        Ok(self
            .slots
            .lock()
            .map_err(|_| CoreError::Journal("loaded Thread registry lock poisoned".into()))?
            .get(thread_id)
            .cloned())
    }

    pub(super) fn install(&self, snapshot: ThreadSnapshot) -> LoadedThreadState {
        LoadedThreadState {
            incarnation: self.next_incarnation(),
            snapshot,
            context: ContextManager::default(),
        }
    }

    pub(super) fn current_incarnation(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<ThreadIncarnationId>, CoreError> {
        let Some(slot) = self.existing_slot(thread_id)? else {
            return Ok(None);
        };
        Ok(slot
            .loaded
            .lock()
            .map_err(|_| CoreError::Journal("loaded Thread state lock poisoned".into()))?
            .as_ref()
            .map(|loaded| loaded.incarnation))
    }

    pub(super) fn snapshots(&self) -> Result<Vec<ThreadSnapshot>, CoreError> {
        let slots = self
            .slots
            .lock()
            .map_err(|_| CoreError::Journal("loaded Thread registry lock poisoned".into()))?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        slots
            .into_iter()
            .filter_map(|slot| match slot.loaded.lock() {
                Ok(loaded) => loaded.as_ref().map(|loaded| Ok(loaded.snapshot.clone())),
                Err(_) => Some(Err(CoreError::Journal(
                    "loaded Thread state lock poisoned".into(),
                ))),
            })
            .collect()
    }

    pub(super) fn forget(&self, thread_ids: &[ThreadId]) -> Result<(), CoreError> {
        let removed = {
            let mut slots = self
                .slots
                .lock()
                .map_err(|_| CoreError::Journal("loaded Thread registry lock poisoned".into()))?;
            thread_ids
                .iter()
                .filter_map(|thread_id| slots.remove(thread_id))
                .collect::<Vec<_>>()
        };
        for slot in removed {
            *slot
                .loaded
                .lock()
                .map_err(|_| CoreError::Journal("loaded Thread state lock poisoned".into()))? =
                None;
        }
        Ok(())
    }

    pub(super) fn ensure_loaded_incarnation(
        &self,
        thread_id: &ThreadId,
    ) -> Result<ThreadIncarnationId, CoreError> {
        let slot = self.slot(thread_id)?;
        let mut loaded = slot
            .loaded
            .lock()
            .map_err(|_| CoreError::Journal("loaded Thread state lock poisoned".into()))?;
        if loaded.is_none() {
            let snapshot = self.load_snapshot(thread_id)?;
            *loaded = Some(self.install(snapshot));
        }
        Ok(loaded
            .as_ref()
            .expect("loaded Thread state was installed above")
            .incarnation)
    }

    pub(super) fn is_current(
        &self,
        thread_id: &ThreadId,
        incarnation: ThreadIncarnationId,
    ) -> bool {
        self.current_incarnation(thread_id)
            .ok()
            .flatten()
            .is_some_and(|current| current == incarnation)
    }

    pub(super) fn evict_if_current(
        &self,
        thread_id: &ThreadId,
        incarnation: ThreadIncarnationId,
    ) -> Result<bool, CoreError> {
        let Some(slot) = self.existing_slot(thread_id)? else {
            return Ok(false);
        };
        let mut loaded = slot
            .loaded
            .lock()
            .map_err(|_| CoreError::Journal("loaded Thread state lock poisoned".into()))?;
        if loaded
            .as_ref()
            .is_some_and(|current| current.incarnation == incarnation)
        {
            *loaded = None;
            return Ok(true);
        }
        Ok(false)
    }

    fn next_incarnation(&self) -> ThreadIncarnationId {
        ThreadIncarnationId(self.next_incarnation.fetch_add(1, Ordering::Relaxed))
    }

    fn load_snapshot(&self, thread_id: &ThreadId) -> Result<ThreadSnapshot, CoreError> {
        let events = self.store.load(thread_id)?;
        if events.is_empty() {
            return Err(CoreError::NotFound(thread_id.to_string()));
        }
        let mut reader = crate::history::HistoryReader::new(self.store.as_ref(), &[]);
        events
            .iter()
            .try_fold(None, |snapshot, event| {
                reader.reduce(snapshot, event).map(Some)
            })?
            .ok_or_else(|| CoreError::Journal("cannot recover an empty rollout".into()))
    }
}

#[derive(Default)]
struct MutationGate {
    state: Mutex<MutationGateState>,
    changed: Condvar,
}

#[derive(Default)]
struct MutationGateState {
    next_ticket: u64,
    serving: u64,
}

pub(super) struct MutationPermit<'a> {
    gate: &'a MutationGate,
}

impl Drop for MutationPermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.state.lock() {
            state.serving = state.serving.saturating_add(1);
            self.gate.changed.notify_all();
        }
    }
}
