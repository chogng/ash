use super::CreateThreadRequest;
use super::ReplaceThreadRequest;
use super::ThreadController;
use super::command_thread_id;
use super::validate_thread_title;
use crate::CoreError;
use crate::ThreadSnapshot;
use crate::ThreadWorktreeBinder;
use crate::ThreadWorktreeBindingRequest;
use agent_graph_store::AgentRecord;
use agent_graph_store::ThreadBinding;
use ash_protocol::AgentId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadOrigin;
use ash_protocol::ThreadStatus;

impl ThreadController {
    pub fn read_agent(&self, agent_id: &AgentId) -> Result<AgentRecord, CoreError> {
        self.store
            .read_agent(agent_id)?
            .ok_or_else(|| CoreError::NotFound(agent_id.to_string()))
    }

    pub fn list_agent_threads(&self, agent_id: &AgentId) -> Result<Vec<ThreadBinding>, CoreError> {
        self.read_agent(agent_id)?;
        self.store
            .list_agent_threads(agent_id)
            .map_err(CoreError::from)
    }

    pub(super) fn select_agent_id(
        &self,
        selected: Option<&AgentId>,
        thread_id: &ThreadId,
    ) -> Result<AgentId, CoreError> {
        match selected {
            Some(agent_id) => self.read_agent(agent_id).map(|record| record.agent_id),
            None => AgentId::new(format!("agent:{thread_id}"))
                .map_err(|error| CoreError::InvalidInput(error.to_string())),
        }
    }

    /// Creates a fresh replacement for an archived branch. History and delegations remain
    /// attached to the old branch; only the Agent identity and execution configuration carry on.
    pub fn replace_thread(
        &self,
        binder: &dyn ThreadWorktreeBinder,
        request: ReplaceThreadRequest,
    ) -> Result<ThreadSnapshot, CoreError> {
        validate_thread_title(&request.command_id, &request.title)?;
        let source = self.read_thread(&request.source_thread_id)?;
        let thread_id = command_thread_id("replace", &request.command_id)?;
        if let Some(existing) = self.store.read_thread_binding(&thread_id)? {
            if existing.agent_id == source.agent_id
                && matches!(&existing.origin, ThreadOrigin::Replacement { source_thread_id, .. }
                    if source_thread_id == &source.thread_id)
            {
                let snapshot = self.read_thread(&thread_id)?;
                if snapshot.title == request.title {
                    return Ok(snapshot);
                }
            }
            return Err(CoreError::CommandConflict);
        }
        if source.status != ThreadStatus::Archived {
            return Err(CoreError::InvalidInput(
                "replacement requires an archived source Thread".into(),
            ));
        }
        let origin = ThreadOrigin::Replacement {
            source_thread_id: source.thread_id.clone(),
            source_sequence: source.sequence,
        };
        binder.provision(&ThreadWorktreeBindingRequest {
            session_id: source.session_id.clone(),
            thread_id: thread_id.clone(),
            origin: origin.clone(),
            branch_name: None,
        })?;
        self.create_thread(CreateThreadRequest {
            agent_id: source.agent_id.clone(),
            origin,
            agent: source.agent_configuration().cloned(),
            session_id: source.session_id,
            thread_id,
            title: request.title,
        })
    }
}
