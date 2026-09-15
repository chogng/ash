use crate::ExtensionError;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use std::any::Any;
use std::any::TypeId;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

/// Exact lifetime and authority boundary for extension-owned transient data.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ExtensionScope {
    Session(SessionId),
    Thread(SessionId, ThreadId),
    Turn(SessionId, ThreadId, TurnId),
}

type Values = HashMap<TypeId, Arc<dyn Any + Send + Sync>>;

/// Typed attachments shared by contributors in the same installed registry.
/// Durable domain state belongs in its domain store; these attachments are retired with their scope.
#[derive(Default)]
pub struct ExtensionState {
    scopes: Mutex<BTreeMap<ExtensionScope, Values>>,
}
impl ExtensionState {
    pub fn get_or_insert<T: Default + Send + Sync + 'static>(
        &self,
        scope: ExtensionScope,
    ) -> Result<Arc<T>, ExtensionError> {
        let created = Arc::new(T::default());
        let mut scopes = self
            .scopes
            .lock()
            .map_err(|_| ExtensionError::new("extension state lock poisoned"))?;
        let value = scopes
            .entry(scope)
            .or_default()
            .entry(TypeId::of::<T>())
            .or_insert(created);
        value
            .clone()
            .downcast()
            .map_err(|_| ExtensionError::new("extension state type mismatch"))
    }
    pub fn remove(&self, scope: &ExtensionScope) {
        let mut scopes = self
            .scopes
            .lock()
            .expect("extension state mutations contain no callbacks");
        let keys = scopes
            .keys()
            .filter(|key| match (scope, *key) {
                (
                    ExtensionScope::Session(a),
                    ExtensionScope::Session(b)
                    | ExtensionScope::Thread(b, _)
                    | ExtensionScope::Turn(b, _, _),
                ) => a == b,
                (
                    ExtensionScope::Thread(a, b),
                    ExtensionScope::Thread(c, d) | ExtensionScope::Turn(c, d, _),
                ) => a == c && b == d,
                _ => scope == *key,
            })
            .cloned()
            .collect::<Vec<_>>();
        let removed = keys
            .into_iter()
            .filter_map(|key| scopes.remove(&key))
            .collect::<Vec<_>>();
        drop(scopes);
        drop(removed);
    }
}
