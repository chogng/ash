use std::any::Any;
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use std::sync::Arc;

use super::StateSubscription;
use super::ViewState;
use super::ViewStateId;
use crate::ui::foundation::ElementId;

/// Stable name for one state, observation, or retained resource owned by a component.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ComponentSlot(&'static str);

impl ComponentSlot {
    /// Creates a component-local slot name that remains stable across frames.
    pub const fn new(name: &'static str) -> Self {
        Self(name)
    }

    /// Returns the stable slot name.
    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

/// Invalid use of retained state or resources during component composition.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ComponentRuntimeError {
    /// The frame was composed without a retained component runtime.
    RuntimeUnavailable,
    /// The current component did not declare a stable element identity.
    MissingIdentity,
    /// A state slot was reused with a different Rust value type.
    StateTypeMismatch {
        component: ElementId,
        slot: ComponentSlot,
    },
    /// A retained-resource slot was reused with a different Rust value type.
    ResourceTypeMismatch {
        component: ElementId,
        slot: ComponentSlot,
    },
}

impl fmt::Display for ComponentRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RuntimeUnavailable => {
                formatter.write_str("component frame has no retained component runtime")
            }
            Self::MissingIdentity => {
                formatter.write_str("stateful component must declare a stable element identity")
            }
            Self::StateTypeMismatch { component, slot } => write!(
                formatter,
                "component {} reused state slot {} with a different type",
                component.into_raw(),
                slot.as_str()
            ),
            Self::ResourceTypeMismatch { component, slot } => write!(
                formatter,
                "component {} reused resource slot {} with a different type",
                component.into_raw(),
                slot.as_str()
            ),
        }
    }
}

impl Error for ComponentRuntimeError {}

struct RuntimeState<T> {
    state: ViewState<T>,
    _invalidation: StateSubscription,
}

struct ObservedState {
    source: ViewStateId,
    _invalidation: StateSubscription,
}

struct ComponentEntry {
    seen_generation: u64,
    states: BTreeMap<ComponentSlot, Box<dyn Any + Send + Sync>>,
    observations: BTreeMap<ComponentSlot, ObservedState>,
    resources: BTreeMap<ComponentSlot, Box<dyn Any>>,
}

impl ComponentEntry {
    fn new(seen_generation: u64) -> Self {
        Self {
            seen_generation,
            states: BTreeMap::new(),
            observations: BTreeMap::new(),
            resources: BTreeMap::new(),
        }
    }
}

/// Cross-frame state, observation, and resource owner for stable component identities.
///
/// A [`super::UiFrame`] marks every composed component during one frame. Entries not seen by the
/// end of that frame are unmounted, which drops their subscriptions and retained resources.
pub struct ComponentRuntime {
    generation: u64,
    entries: BTreeMap<ElementId, ComponentEntry>,
    invalidate: Arc<dyn Fn(ElementId) + Send + Sync>,
}

impl ComponentRuntime {
    /// Creates a runtime whose state observations invalidate one stable component identity.
    pub fn new(invalidate: impl Fn(ElementId) + Send + Sync + 'static) -> Self {
        Self {
            generation: 0,
            entries: BTreeMap::new(),
            invalidate: Arc::new(invalidate),
        }
    }

    /// Returns whether one stable component currently owns retained resources.
    pub fn contains(&self, component: ElementId) -> bool {
        self.entries.contains_key(&component)
    }

    /// Returns the number of component identities mounted after the latest frame.
    pub fn mounted_count(&self) -> usize {
        self.entries.len()
    }

    /// Immediately unmounts one component and drops its state, observations, and resources.
    pub fn remove(&mut self, component: ElementId) -> bool {
        self.entries.remove(&component).is_some()
    }

    /// Immediately unmounts every retained component.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub(crate) fn begin_frame(&mut self) {
        self.generation = match self.generation.checked_add(1) {
            Some(generation) => generation,
            None => {
                self.entries.clear();
                1
            }
        };
    }

    pub(crate) fn finish_frame(&mut self) {
        let generation = self.generation;
        self.entries
            .retain(|_, entry| entry.seen_generation == generation);
    }

    pub(crate) fn observe_component(&mut self, component: ElementId) {
        self.entries
            .entry(component)
            .and_modify(|entry| entry.seen_generation = self.generation)
            .or_insert_with(|| ComponentEntry::new(self.generation));
    }

    pub(crate) fn local_state<T>(
        &mut self,
        component: ElementId,
        slot: ComponentSlot,
        initialize: impl FnOnce() -> T,
    ) -> Result<ViewState<T>, ComponentRuntimeError>
    where
        T: Send + Sync + 'static,
    {
        self.observe_component(component);
        let invalidate = self.invalidate.clone();
        let entry = self
            .entries
            .get_mut(&component)
            .expect("observed component entry");
        if let Some(state) = entry.states.get(&slot) {
            return state
                .downcast_ref::<RuntimeState<T>>()
                .map(|state| state.state.clone())
                .ok_or(ComponentRuntimeError::StateTypeMismatch { component, slot });
        }
        let state = ViewState::new(initialize());
        let invalidation = state.subscribe(move |_| invalidate(component));
        entry.states.insert(
            slot,
            Box::new(RuntimeState {
                state: state.clone(),
                _invalidation: invalidation,
            }),
        );
        Ok(state)
    }

    pub(crate) fn observe_state<T>(
        &mut self,
        component: ElementId,
        slot: ComponentSlot,
        state: &ViewState<T>,
    ) where
        T: Send + Sync + 'static,
    {
        self.observe_component(component);
        let source = state.id();
        let invalidate = self.invalidate.clone();
        let entry = self
            .entries
            .get_mut(&component)
            .expect("observed component entry");
        if entry
            .observations
            .get(&slot)
            .is_some_and(|observed| observed.source == source)
        {
            return;
        }
        let invalidation = state.subscribe(move |_| invalidate(component));
        entry.observations.insert(
            slot,
            ObservedState {
                source,
                _invalidation: invalidation,
            },
        );
    }

    pub(crate) fn retain_resource<R>(
        &mut self,
        component: ElementId,
        slot: ComponentSlot,
        create: impl FnOnce() -> R,
    ) -> Result<bool, ComponentRuntimeError>
    where
        R: 'static,
    {
        self.observe_component(component);
        let entry = self
            .entries
            .get_mut(&component)
            .expect("observed component entry");
        if let Some(resource) = entry.resources.get(&slot) {
            return resource
                .is::<R>()
                .then_some(false)
                .ok_or(ComponentRuntimeError::ResourceTypeMismatch { component, slot });
        }
        entry.resources.insert(slot, Box::new(create()));
        Ok(true)
    }
}

impl Default for ComponentRuntime {
    fn default() -> Self {
        Self::new(|_| {})
    }
}

#[cfg(test)]
#[path = "component_runtime_tests.rs"]
mod tests;
