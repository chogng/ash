//! Session creation, discovery, subscriptions, and lifecycle mutations.

use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::core_error;
use super::decode;
use super::operations::SessionMutation;
use super::result;
use serde_json::Value;
use std::sync::Arc;
use ash_app_server_protocol::protocol::session::SessionCreateParams;
use ash_app_server_protocol::protocol::session::SessionListResult;
use ash_app_server_protocol::protocol::session::SessionReadParams;
use ash_app_server_protocol::protocol::session::SessionResult;
use ash_app_server_protocol::protocol::session::SessionSubscribeParams;
use ash_app_server_protocol::protocol::session::SessionSubscribeResult;
use ash_app_server_protocol::protocol::session::SessionThreadProjection;
use ash_app_server_protocol::protocol::session::SessionUnsubscribeParams;
use ash_core::StartThreadRequest;
use ash_protocol::SessionId;

impl AppServer {
    pub(super) fn agent_read(&self, params: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::agent::AgentReadParams;
        use ash_app_server_protocol::protocol::agent::AgentReadResult;
        use ash_app_server_protocol::protocol::agent::AgentThread;
        let params: AgentReadParams = decode(params)?;
        let agent = self
            .threads
            .read_agent(&params.agent_id)
            .map_err(core_error)?;
        let threads = self
            .threads
            .list_agent_threads(&params.agent_id)
            .map_err(core_error)?
            .into_iter()
            .map(|binding| AgentThread {
                session_id: binding.session_id,
                thread_id: binding.thread_id,
                origin: binding.origin,
            })
            .collect();
        result(&AgentReadResult {
            agent_id: agent.agent_id,
            created_at_unix_ms: agent.created_at_unix_ms,
            threads,
        })
    }

    pub(super) fn session_create(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SessionCreateParams = decode(params)?;
        let created = if let Some(existing) = self
            .threads
            .read_started_thread(&params.command_id)
            .map_err(core_error)?
        {
            let selected = existing
                .agent_configuration()
                .and_then(|agent| agent.role.as_ref())
                .and_then(|role| role.definition.as_ref());
            let matches = match (&params.agent, selected) {
                (ash_protocol::AgentRoleSelection::Default, None) => true,
                (ash_protocol::AgentRoleSelection::Exact { source, name }, Some(definition)) => {
                    source == &definition.source && name == &definition.name
                }
                _ => false,
            };
            let expected_agent_id = params.agent_id.clone().unwrap_or_else(|| {
                ash_protocol::AgentId::new(format!("agent:{}", existing.thread_id))
                    .expect("derived Agent ID is non-empty")
            });
            let legacy_creation = params.agent_id.is_none()
                && existing.agent_id.as_str() == format!("legacy-agent:{}", existing.thread_id);
            if !matches
                || params.title != existing.title
                || (expected_agent_id != existing.agent_id && !legacy_creation)
            {
                return Err(core_error(ash_core::CoreError::CommandConflict));
            }
            existing
        } else {
            let agent = self.resolve_root_agent(&params.agent).map_err(|error| {
                let mut response = core_error(error.clone());
                if let ash_core::CoreError::InvalidInput(detail) = error {
                    response.detail = Some(detail);
                }
                response
            })?;
            self.start_thread(StartThreadRequest {
                agent_id: params.agent_id,
                command_id: params.command_id,
                title: params.title,
                agent,
            })
            .map_err(core_error)?
        };
        self.bind_session_runtime(&created.session_id).map_err(core_error)?;
        self.updates
            .subscribe_session(connection.connection_id, created.session_id.clone());
        result(&self.session_result(&created.session_id)?)
    }

    pub(super) fn bind_session_runtime(
        &self,
        session_id: &SessionId,
    ) -> Result<(), ash_core::CoreError> {
        self.threads
            .install_session_extensions(session_id.clone(), Arc::clone(&self.agent_extensions))?;
        self.updates.bind_session_scope(session_id.clone());
        Ok(())
    }

    pub(super) fn fork_session_request(
        &self,
        mutation: SessionMutation,
        parent_thread_id: ash_protocol::ThreadId,
        title: String,
    ) -> Result<ash_app_server_protocol::protocol::session::SessionThreadResult, RpcError> {
        self.read_session_thread_snapshot(&mutation.session_id, &parent_thread_id)?;
        let forked = self
            .threads
            .fork_session(
                self.thread_worktree_binder.as_ref(),
                ash_core::ForkThreadRequest {
                    command_id: mutation.command_id,
                    source_thread_id: parent_thread_id,
                    title,
                },
            )
            .map_err(core_error)?;
        self.bind_session_runtime(&forked.session_id)
            .map_err(core_error)?;
        self.updates.publish_session_changed(&forked.session_id);
        Ok(
            ash_app_server_protocol::protocol::session::SessionThreadResult {
                session: self.session_view(&forked.session_id)?,
                thread_id: forked.thread_id,
            },
        )
    }

    pub(super) fn session_read(&self, params: &Value) -> Result<Value, RpcError> {
        let params: SessionReadParams = decode(params)?;
        result(&self.session_result(&params.session_id)?)
    }

    pub(super) fn session_list(&self) -> Result<Value, RpcError> {
        result(&SessionListResult {
            sessions: self.session_views()?,
        })
    }

    pub(super) fn session_subscribe(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SessionSubscribeParams = decode(params)?;
        let session = self.session_view(&params.session_id)?;
        let thread_snapshots = self
            .threads
            .list_session_threads(&params.session_id)
            .map_err(core_error)?;
        let thread_projections = thread_snapshots
            .iter()
            .map(|thread| {
                let thread = thread.public_thread();
                let updates = self
                    .threads
                    .thread_updates_after(&thread.thread_id, 0)
                    .map_err(core_error)?;
                Ok(SessionThreadProjection {
                    transcript: self.updates.thread_transcript_snapshot(&thread, true),
                    thread,
                    updates,
                })
            })
            .collect::<Result<Vec<_>, RpcError>>()?;
        self.updates
            .subscribe_session(connection.connection_id, params.session_id.clone());
        for item in &thread_projections {
            self.updates.subscribe_session_thread(
                connection.connection_id,
                params.session_id.clone(),
                item.thread.thread_id.clone(),
                item.thread.sequence,
            );
        }
        for snapshot in &thread_snapshots {
            self.offer_pending_interactions(snapshot);
        }
        result(&SessionSubscribeResult {
            agent_tree: ash_core::project_agent_tree(&thread_snapshots),
            session,
            thread_projections,
        })
    }

    pub(super) fn session_unsubscribe(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SessionUnsubscribeParams = decode(params)?;
        let lost_dynamic_tools = self
            .updates
            .unsubscribe_session(connection.connection_id, &params.session_id);
        self.cancel_lost_dynamic_tool_owners(lost_dynamic_tools);
        Ok(Value::Null)
    }

    pub(super) fn archive_session_request(
        &self,
        mutation: SessionMutation,
    ) -> Result<SessionResult, RpcError> {
        let session_id = mutation.session_id.clone();
        let result = self.lifecycle_request(mutation)?;
        self.clear_session_dirs(&session_id);
        Ok(result)
    }

    pub(super) fn restore_session_request(
        &self,
        mutation: SessionMutation,
    ) -> Result<SessionResult, RpcError> {
        let restored = self
            .threads
            .restore_session(&mutation.session_id)
            .map_err(core_error)?;
        self.notify_thread_updates(&restored.thread_id, restored.sequence.saturating_sub(1))?;
        self.updates.publish_session_changed(&mutation.session_id);
        self.session_result(&mutation.session_id)
    }

    pub(super) fn stop_session_request(
        &self,
        mutation: SessionMutation,
    ) -> Result<SessionResult, RpcError> {
        let thread_sequences = self
            .threads
            .list_session_threads(&mutation.session_id)
            .map_err(core_error)?
            .into_iter()
            .map(|thread| (thread.thread_id, thread.sequence))
            .collect::<Vec<_>>();
        self.threads
            .archive_session_threads(
                &mutation.session_id,
                &mutation.command_id,
                ash_protocol::ThreadArchiveReason::Stopped,
            )
            .map_err(core_error)?;
        self.clear_session_dirs(&mutation.session_id);
        for (thread_id, _) in &thread_sequences {
            self.multi_agent
                .cancel_descendants(thread_id)
                .map_err(core_error)?;
        }
        for (thread_id, sequence) in thread_sequences {
            self.notify_thread_updates(&thread_id, sequence)?;
        }
        self.updates.publish_session_changed(&mutation.session_id);
        self.enforce_turn_changes_cleanup();
        self.session_result(&mutation.session_id)
    }

    pub(super) fn delete_session_request(
        &self,
        mutation: SessionMutation,
    ) -> Result<SessionId, RpcError> {
        let session_id = mutation.session_id.clone();
        let thread_ids = self
            .threads
            .list_session_threads(&session_id)
            .map_err(core_error)?
            .into_iter()
            .map(|thread| thread.thread_id)
            .collect::<Vec<_>>();
        self.threads
            .archive_session_threads(
                &session_id,
                &mutation.command_id,
                ash_protocol::ThreadArchiveReason::Stopped,
            )
            .map_err(core_error)?;
        for thread_id in &thread_ids {
            self.multi_agent
                .cancel_descendants(thread_id)
                .map_err(core_error)?;
        }
        if let Some(queue) = &self.queue {
            queue.delete_session(&session_id).map_err(|_| {
                RpcError::new(
                    -32603,
                    ash_app_server_protocol::protocol::error::AppServerErrorName::InternalError,
                )
            })?;
            self.updates.publish_queue_changed();
        }
        if let Some(notes) = &self.notes {
            notes
                .delete_session(&session_id)
                .map_err(|error| core_error(ash_core::CoreError::Execution(error)))?;
        }
        self.agent_extensions
            .state()
            .remove(&ash_extension_api::ExtensionScope::Session(
                session_id.clone(),
            ));
        self.threads
            .delete_session_threads(&session_id)
            .map_err(core_error)?;
        if let Some(runtime) = &self.git_turn_changes {
            if let Err(error) = self.threads.collect_message_checkpoints(runtime.as_ref()) {
                log::warn!("message checkpoint cleanup remains pending: {error}");
            }
        }
        self.clear_session_dirs(&session_id);
        self.updates.publish_session_deleted(&session_id);
        self.updates.forget_session(&session_id);
        self.enforce_turn_changes_cleanup();
        Ok(session_id)
    }

    fn lifecycle_request(&self, mutation: SessionMutation) -> Result<SessionResult, RpcError> {
        self.threads
            .archive_session_threads(
                &mutation.session_id,
                &mutation.command_id,
                ash_protocol::ThreadArchiveReason::Completed,
            )
            .map_err(core_error)?;
        self.updates.publish_session_changed(&mutation.session_id);
        self.enforce_turn_changes_cleanup();
        self.session_result(&mutation.session_id)
    }

    fn enforce_turn_changes_cleanup(&self) {
        if let Some(runtime) = &self.git_turn_changes
            && let Err(error) = runtime.enforce_cleanup_policy()
        {
            log::warn!("Thread worktree cleanup policy failed: {error}");
        }
    }
}
