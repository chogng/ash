use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

static NEXT_STATE_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_SUBSCRIPTION_ID: AtomicU64 = AtomicU64::new(1);

type StateListener = Arc<dyn Fn(StateRevision) + Send + Sync>;

/// Stable identity of one cloneable view-state cell.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ViewStateId(u64);

impl ViewStateId {
    /// Returns the packed process-local state identity.
    pub const fn into_raw(self) -> u64 {
        self.0
    }
}

/// Monotonic revision produced after a view-state mutation.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct StateRevision(u64);

impl StateRevision {
    /// Returns the packed revision counter.
    pub const fn into_raw(self) -> u64 {
        self.0
    }
}

/// Immutable cloned value and revision captured from one [`ViewState`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewStateSnapshot<T> {
    value: T,
    revision: StateRevision,
}

impl<T> ViewStateSnapshot<T> {
    /// Returns the cloned value.
    pub const fn value(&self) -> &T {
        &self.value
    }

    /// Returns the revision captured with the value.
    pub const fn revision(&self) -> StateRevision {
        self.revision
    }

    /// Consumes the snapshot and returns its value.
    pub fn into_value(self) -> T {
        self.value
    }
}

struct ViewStateInner<T> {
    id: ViewStateId,
    value: RwLock<T>,
    revision: AtomicU64,
    listeners: Arc<StateListeners>,
}

#[derive(Default)]
struct StateListeners {
    callbacks: Mutex<BTreeMap<u64, StateListener>>,
}

/// Cloneable observable state intended for reusable component presentation data.
///
/// Domain authority remains with the product reducer. This cell is for view-local or projected
/// state that needs stable cross-frame identity and redraw subscriptions.
pub struct ViewState<T> {
    inner: Arc<ViewStateInner<T>>,
}

impl<T> Clone for ViewState<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl<T> ViewState<T> {
    /// Creates observable view state at revision zero.
    pub fn new(value: T) -> Self {
        Self {
            inner: Arc::new(ViewStateInner {
                id: ViewStateId(NEXT_STATE_ID.fetch_add(1, Ordering::Relaxed)),
                value: RwLock::new(value),
                revision: AtomicU64::new(0),
                listeners: Arc::new(StateListeners::default()),
            }),
        }
    }

    /// Returns the stable identity shared by every clone of this state cell.
    pub fn id(&self) -> ViewStateId {
        self.inner.id
    }

    /// Returns the current monotonic revision.
    pub fn revision(&self) -> StateRevision {
        StateRevision(self.inner.revision.load(Ordering::Acquire))
    }

    /// Reads the current value without exposing its lock guard.
    pub fn read<R>(&self, read: impl FnOnce(&T) -> R) -> R {
        let value = self.inner.value.read().expect("view state read lock");
        read(&value)
    }

    /// Mutates the value, advances its revision, and notifies current subscribers.
    pub fn update<R>(&self, update: impl FnOnce(&mut T) -> R) -> R {
        let (result, revision) = {
            let mut value = self.inner.value.write().expect("view state write lock");
            let result = update(&mut value);
            let previous = self
                .inner
                .revision
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |revision| {
                    Some(revision.saturating_add(1))
                })
                .expect("view state revision update cannot fail");
            (result, StateRevision(previous.saturating_add(1)))
        };
        let listeners = self
            .inner
            .listeners
            .callbacks
            .lock()
            .expect("view state listener lock")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for listener in listeners {
            listener(revision);
        }
        result
    }

    /// Captures a cloned value and its matching revision under one read lock.
    pub fn snapshot(&self) -> ViewStateSnapshot<T>
    where
        T: Clone,
    {
        let value = self.inner.value.read().expect("view state read lock");
        ViewStateSnapshot {
            value: value.clone(),
            revision: self.revision(),
        }
    }

    /// Observes future mutations until the returned subscription is dropped.
    ///
    /// Subscription does not replay the current value; callers read or snapshot before waiting
    /// for later revisions.
    pub fn subscribe(
        &self,
        listener: impl Fn(StateRevision) + Send + Sync + 'static,
    ) -> StateSubscription {
        let id = NEXT_SUBSCRIPTION_ID.fetch_add(1, Ordering::Relaxed);
        self.inner
            .listeners
            .callbacks
            .lock()
            .expect("view state listener lock")
            .insert(id, Arc::new(listener));
        StateSubscription {
            id,
            listeners: Arc::downgrade(&self.inner.listeners),
        }
    }
}

impl<T: Default> Default for ViewState<T> {
    fn default() -> Self {
        Self::new(T::default())
    }
}

/// RAII registration for one [`ViewState`] listener.
#[must_use = "dropping the subscription stops observing view-state revisions"]
pub struct StateSubscription {
    id: u64,
    listeners: Weak<StateListeners>,
}

impl StateSubscription {
    /// Returns whether the observed state still owns this registration.
    pub fn is_active(&self) -> bool {
        self.listeners.upgrade().is_some_and(|listeners| {
            listeners
                .callbacks
                .lock()
                .expect("view state listener lock")
                .contains_key(&self.id)
        })
    }

    /// Stops observing immediately.
    pub fn unsubscribe(self) {}
}

impl Drop for StateSubscription {
    fn drop(&mut self) {
        if let Some(listeners) = self.listeners.upgrade() {
            listeners
                .callbacks
                .lock()
                .expect("view state listener lock")
                .remove(&self.id);
        }
    }
}

#[cfg(test)]
#[path = "view_state_tests.rs"]
mod tests;
