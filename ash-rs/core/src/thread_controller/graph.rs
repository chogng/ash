use super::InMemoryThreadStore;
use agent_graph_store::AgentGraphStore;
use agent_graph_store::AgentGraphStoreError;
use agent_graph_store::AgentRecord;
use agent_graph_store::ThreadBinding;
use ash_protocol::AgentId;
use ash_protocol::ThreadId;
use std::collections::BTreeSet;

impl AgentGraphStore for InMemoryThreadStore {
    fn read_agent(&self, agent_id: &AgentId) -> Result<Option<AgentRecord>, AgentGraphStoreError> {
        Ok(self
            .0
            .lock()
            .map_err(lock_error)?
            .agents
            .get(agent_id)
            .cloned())
    }

    fn read_thread_binding(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<ThreadBinding>, AgentGraphStoreError> {
        Ok(self
            .0
            .lock()
            .map_err(lock_error)?
            .catalog
            .get(thread_id)
            .map(|record| record.binding.clone()))
    }

    fn list_agent_threads(
        &self,
        agent_id: &AgentId,
    ) -> Result<Vec<ThreadBinding>, AgentGraphStoreError> {
        Ok(self
            .0
            .lock()
            .map_err(lock_error)?
            .catalog
            .values()
            .filter(|record| &record.binding.agent_id == agent_id)
            .map(|record| record.binding.clone())
            .collect())
    }

    fn list_spawn_children(
        &self,
        parent_thread_id: &ThreadId,
    ) -> Result<Vec<ThreadId>, AgentGraphStoreError> {
        Ok(self
            .0
            .lock()
            .map_err(lock_error)?
            .catalog
            .values()
            .filter(|record| record.binding.spawn_parent() == Some(parent_thread_id))
            .map(|record| record.thread.thread_id.clone())
            .collect())
    }

    fn list_spawn_descendants(
        &self,
        root_thread_id: &ThreadId,
    ) -> Result<Vec<ThreadId>, AgentGraphStoreError> {
        let state = self.0.lock().map_err(lock_error)?;
        let mut seen = BTreeSet::from([root_thread_id.clone()]);
        let mut level = BTreeSet::from([root_thread_id.clone()]);
        let mut descendants = Vec::new();
        while !level.is_empty() {
            let next = state
                .catalog
                .values()
                .filter(|record| {
                    record
                        .binding
                        .spawn_parent()
                        .is_some_and(|parent| level.contains(parent))
                })
                .map(|record| record.thread.thread_id.clone())
                .filter(|id| seen.insert(id.clone()))
                .collect::<BTreeSet<_>>();
            descendants.extend(next.iter().cloned());
            level = next;
        }
        Ok(descendants)
    }
}

fn lock_error(error: impl std::fmt::Display) -> AgentGraphStoreError {
    AgentGraphStoreError(error.to_string())
}
