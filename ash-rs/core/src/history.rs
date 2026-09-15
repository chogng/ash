use crate::CoreError;
use crate::ThreadSnapshot;
use crate::thread_reducer::reduce_thread_event_with_prefix;
use ash_history::HistoryPrefix;
use ash_history::StoredEvent;
use ash_protocol::HistoryPrefixRef;
use ash_protocol::ThreadEvent;
use ash_thread_store::ThreadStore;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;

/// Resolves immutable source streams independently before importing their visible history.
pub(crate) struct HistoryReader<'a> {
    store: &'a dyn ThreadStore,
    staged: &'a [HistoryPrefix],
    snapshots: BTreeMap<String, Arc<ThreadSnapshot>>,
}

impl<'a> HistoryReader<'a> {
    pub(crate) fn new(store: &'a dyn ThreadStore, staged: &'a [HistoryPrefix]) -> Self {
        Self {
            store,
            staged,
            snapshots: BTreeMap::new(),
        }
    }

    pub(crate) fn reduce(
        &mut self,
        snapshot: Option<ThreadSnapshot>,
        event: &StoredEvent,
    ) -> Result<ThreadSnapshot, CoreError> {
        let source = match &event.event {
            ThreadEvent::HistoryPrefixBound { prefix, .. } => Some(self.resolve(prefix)?),
            _ => None,
        };
        reduce_thread_event_with_prefix(snapshot, event, source.as_deref())
    }

    fn resolve(&mut self, reference: &HistoryPrefixRef) -> Result<Arc<ThreadSnapshot>, CoreError> {
        let mut todo = vec![(reference.clone(), false)];
        let mut visiting = BTreeSet::new();
        let mut pending = BTreeMap::<String, HistoryPrefix>::new();
        while let Some((reference, finish)) = todo.pop() {
            let key = reference.digest.as_str().to_string();
            if self.snapshots.contains_key(&key) {
                continue;
            }
            if !finish {
                if !visiting.insert(key.clone()) {
                    return Err(CoreError::Journal(
                        "history prefix graph contains a cycle".into(),
                    ));
                }
                let prefix = self
                    .staged
                    .iter()
                    .find(|prefix| {
                        prefix
                            .reference()
                            .is_ok_and(|candidate| candidate == reference)
                    })
                    .cloned()
                    .map(Ok)
                    .unwrap_or_else(|| self.store.load_history_prefix(&reference))?;
                prefix.validate(&reference).map_err(CoreError::Journal)?;
                todo.push((reference.clone(), true));
                for event in prefix.events.iter().rev() {
                    if let ThreadEvent::HistoryPrefixBound { prefix, .. } = &event.event {
                        todo.push((prefix.clone(), false));
                    }
                }
                pending.insert(key, prefix);
            } else {
                let prefix = pending.remove(&key).ok_or_else(|| {
                    CoreError::Journal("history prefix resolution lost its source".into())
                })?;
                let mut snapshot = None;
                for event in &prefix.events {
                    let source = match &event.event {
                        ThreadEvent::HistoryPrefixBound { prefix, .. } => Some(
                            self.snapshots
                                .get(prefix.digest.as_str())
                                .ok_or_else(|| {
                                    CoreError::Journal(
                                        "nested history prefix was not resolved".into(),
                                    )
                                })?
                                .as_ref(),
                        ),
                        _ => None,
                    };
                    snapshot = Some(reduce_thread_event_with_prefix(snapshot, event, source)?);
                }
                self.snapshots.insert(
                    key.clone(),
                    Arc::new(
                        snapshot
                            .ok_or_else(|| CoreError::Journal("history prefix is empty".into()))?,
                    ),
                );
                visiting.remove(&key);
            }
        }
        self.snapshots
            .get(reference.digest.as_str())
            .cloned()
            .ok_or_else(|| CoreError::Journal("history prefix was not resolved".into()))
    }
}
