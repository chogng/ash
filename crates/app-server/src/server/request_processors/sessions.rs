//! Session creation, discovery, subscriptions, and lifecycle mutations.
use core_api::AgentRuntime;

use super::ConnectionState;
use super::RpcError;
use super::core_error;
use super::decode;
use super::operations::SessionMutation;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::session::SessionCatalogReadResult;
use ash_app_server_protocol::protocol::session::SessionCreateParams;
use ash_app_server_protocol::protocol::session::SessionListResult;
use ash_app_server_protocol::protocol::session::SessionReadParams;
use ash_app_server_protocol::protocol::session::SessionResult;
use ash_app_server_protocol::protocol::session::SessionSubscribeParams;
use ash_app_server_protocol::protocol::session::SessionSubscribeResult;
use ash_app_server_protocol::protocol::session::SessionThreadProjection;
use ash_app_server_protocol::protocol::session::SessionUnsubscribeParams;
use ash_protocol::CommandId;
use ash_protocol::HookEvent;
use ash_protocol::SessionExecutionTarget;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use core_api::HookEventRequest;
use core_api::HookEventScope;
use core_api::StartThreadRequest;
use serde_json::Value;

/// Coordinates the existing owners needed by the sessions adapter.
/// This contract deliberately exposes no server object or unrestricted service registry.
pub(super) trait SessionRequestProcessorContext: Send + Sync {
    fn agent_runtime(&self) -> impl core_api::AgentRuntime + '_;
    fn bind_session_runtime(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<(), core_api::CoreError>;
    fn cancel_lost_dynamic_tool_owners(&self, requests: Vec<ash_protocol::AgentRequestEnvelope>);
    fn clear_session_dirs(&self, session_id: &ash_protocol::SessionId);
    fn collect_message_checkpoints(
        &self,
        source: &dyn core_api::MessageCheckpointSource,
    ) -> Result<(), core_api::CoreError>;
    fn emit_hook_event(
        &self,
        request: &core_api::HookEventRequest,
    ) -> Result<core_api::HookEventDecision, super::RpcError>;
    fn git_turn_changes_runtime(
        &self,
    ) -> Result<
        std::sync::Arc<super::git_turn_changes_runtime::GitTurnChangesRuntime>,
        super::RpcError,
    >;
    fn notify_thread_updates(
        &self,
        thread_id: &ash_protocol::ThreadId,
        after_sequence: u64,
    ) -> Result<(), super::RpcError>;
    fn offer_pending_interactions(&self, thread: &core_api::ThreadView);
    fn read_session_thread_snapshot(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<core_api::ThreadView, super::RpcError>;
    fn resolve_root_agent(
        &self,
        selection: &ash_protocol::AgentRoleSelection,
    ) -> Result<Option<ash_protocol::AgentConfiguration>, core_api::CoreError>;
    fn session_catalog_view(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<Option<ash_protocol::Session>, super::RpcError>;
    fn session_result(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<ash_app_server_protocol::protocol::session::SessionResult, super::RpcError>;
    fn session_view(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<ash_protocol::Session, super::RpcError>;
    fn session_views(&self) -> Result<Vec<ash_protocol::Session>, super::RpcError>;
    fn stop_session_automations(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<(), super::RpcError>;
    fn thread_directory(
        &self,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<Option<ash_protocol::SessionExecutionTarget>, super::RpcError>;
    fn trace_reader(&self) -> ash_rollout_trace::TraceReader;
}

pub(super) struct SessionRequestProcessor<'ctx, C: SessionRequestProcessorContext + ?Sized> {
    context: &'ctx C,
    agent_extensions: &'ctx super::Arc<super::ExtensionRegistry>,
    dir_services: &'ctx Option<super::Arc<super::thread_dirs::ThreadDirs>>,
    env_runtime: &'ctx super::Arc<super::RwLock<super::EnvRuntime>>,
    git_turn_changes:
        &'ctx Option<super::Arc<super::git_turn_changes_runtime::GitTurnChangesRuntime>>,
    message_board: &'ctx Option<super::Arc<dyn agent_message_board::BoardBackend>>,
    notes: &'ctx Option<super::Arc<history_notes::NotesStore>>,
    queue: &'ctx Option<super::Arc<queue::QueueStore>>,
    trace_recorder: &'ctx super::Arc<ash_rollout_trace::TraceRecorder>,
    updates: &'ctx super::Arc<super::UpdateBroker>,
    workflows: &'ctx super::Arc<workflows::Store>,
}

impl<'ctx, C: SessionRequestProcessorContext + ?Sized> SessionRequestProcessor<'ctx, C> {
    pub(super) fn new(
        context: &'ctx C,
        agent_extensions: &'ctx super::Arc<super::ExtensionRegistry>,
        dir_services: &'ctx Option<super::Arc<super::thread_dirs::ThreadDirs>>,
        env_runtime: &'ctx super::Arc<super::RwLock<super::EnvRuntime>>,
        git_turn_changes: &'ctx Option<
            super::Arc<super::git_turn_changes_runtime::GitTurnChangesRuntime>,
        >,
        message_board: &'ctx Option<super::Arc<dyn agent_message_board::BoardBackend>>,
        notes: &'ctx Option<super::Arc<history_notes::NotesStore>>,
        queue: &'ctx Option<super::Arc<queue::QueueStore>>,
        trace_recorder: &'ctx super::Arc<ash_rollout_trace::TraceRecorder>,
        updates: &'ctx super::Arc<super::UpdateBroker>,
        workflows: &'ctx super::Arc<workflows::Store>,
    ) -> Self {
        Self {
            context,
            agent_extensions,
            dir_services,
            env_runtime,
            git_turn_changes,
            message_board,
            notes,
            queue,
            trace_recorder,
            updates,
            workflows,
        }
    }
}

impl<'ctx, C: SessionRequestProcessorContext + ?Sized> SessionRequestProcessor<'ctx, C> {
    pub(super) fn delete_worktree_session(
        &self,
        owner_thread_id: &str,
        command_id: &CommandId,
    ) -> Result<(), RpcError> {
        let thread_id = ThreadId::new(owner_thread_id.to_owned()).map_err(|_| {
            RpcError::new(
                -32061,
                ash_app_server_protocol::protocol::error::AppServerErrorName::GitOperationFailed,
            )
        })?;
        let runtime = self.context.git_turn_changes_runtime()?;
        if runtime.binding(&thread_id).is_none() {
            return Err(RpcError::new(
                -32061,
                ash_app_server_protocol::protocol::error::AppServerErrorName::GitOperationFailed,
            ));
        }
        let agent_runtime = self.context.agent_runtime();
        match agent_runtime.read_thread(&thread_id) {
            Ok(thread) => {
                let session_id = thread.session_id;
                let thread_ids = agent_runtime
                    .read_session(&session_id)
                    .map_err(core_error)?
                    .threads
                    .into_iter()
                    .map(|thread| thread.thread_id)
                    .filter(|thread_id| runtime.binding(thread_id).is_some())
                    .collect::<Vec<_>>();
                // Keep bindings until filesystem cleanup succeeds so a failed removal can be retried
                // from the remaining worktree after the Session history is gone.
                self.delete_session_request(SessionMutation {
                    command_id: command_id.clone(),
                    session_id,
                })?;
                for thread_id in thread_ids {
                    runtime
                        .cleanup_deleted_thread(&thread_id)
                        .map_err(|_| RpcError::new(-32061, ash_app_server_protocol::protocol::error::AppServerErrorName::GitOperationFailed))?;
                }
            }
            Err(core_api::CoreError::NotFound(_)) => runtime
                .cleanup_deleted_thread(&thread_id)
                .map_err(|_| RpcError::new(-32061, ash_app_server_protocol::protocol::error::AppServerErrorName::GitOperationFailed))?,
            Err(error) => return Err(core_error(error)),
        }
        Ok(())
    }

    pub(super) fn agent_roles_list(&self) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::agent::AgentRoleEntry;
        use ash_app_server_protocol::protocol::agent::AgentRoleListResult;
        let environment = self.env_runtime.read().map_err(|_| {
            core_error(core_api::CoreError::Execution(
                "Environment runtime lock poisoned".into(),
            ))
        })?;
        let contributions = environment._dir_contributions.clone();
        drop(environment);
        // Before Session creation, only the environment grant can authorize a root definition.
        let snapshot = contributions
            .as_ref()
            .map(|catalog| catalog.refresh_root_agents());
        let agents = snapshot
            .as_ref()
            .map(|catalog| catalog.entries())
            .unwrap_or_default()
            .iter()
            .map(|role| AgentRoleEntry {
                name: role.name().to_owned(),
                description: role.description().to_owned(),
                source: match role.source() {
                    agent_roles::AgentRoleSource::BuiltIn => ash_protocol::AgentRoleSource::BuiltIn,
                    agent_roles::AgentRoleSource::Directory { id } => {
                        ash_protocol::AgentRoleSource::Directory { id: id.clone() }
                    }
                },
            })
            .collect();
        result(&AgentRoleListResult { agents })
    }

    pub(super) fn agent_read(&self, params: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::agent::AgentReadParams;
        use ash_app_server_protocol::protocol::agent::AgentReadResult;
        use ash_app_server_protocol::protocol::agent::AgentThread;
        let params: AgentReadParams = decode(params)?;
        let agent = self
            .context
            .agent_runtime()
            .read_agent(&params.agent_id)
            .map_err(core_error)?;
        let threads = self
            .context
            .agent_runtime()
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
        let created = self.create_session(params)?;
        self.updates
            .subscribe_session(connection.connection_id, created.session.session_id.clone());
        result(&created)
    }

    pub(super) fn create_session(
        &self,
        params: SessionCreateParams,
    ) -> Result<SessionResult, RpcError> {
        let execution_target = match &params.execution_target {
            None => None,
            Some(SessionExecutionTarget::Local { root }) => {
                let selected = self.dir_services.as_ref().ok_or_else(|| {
                    core_error(core_api::CoreError::InvalidInput(
                        "Session execution directory is unavailable".into(),
                    ))
                })?;
                let requested = ash_file_access::Dir::open_local(root).map_err(|error| {
                    core_error(core_api::CoreError::InvalidInput(error.to_string()))
                })?;
                if requested.id() != selected.id {
                    return Err(core_error(core_api::CoreError::InvalidInput(
                        "Session execution directory belongs to a different directory runtime"
                            .into(),
                    )));
                }
                Some(SessionExecutionTarget::Local {
                    root: selected.root.clone(),
                })
            }
            Some(SessionExecutionTarget::Ssh { .. } | SessionExecutionTarget::Provider { .. }) => {
                return Err(core_error(core_api::CoreError::InvalidInput(
                    "Remote Session execution target must be routed through the profile host"
                        .into(),
                )));
            }
        };
        if params.branch_name.is_some() && self.git_turn_changes.is_none() {
            return Err(core_error(core_api::CoreError::InvalidInput(
                "creating a named worktree requires a Git worktree runtime".into(),
            )));
        }
        let (created, is_new) = if let Some(existing) = self
            .context
            .agent_runtime()
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
            let existing_execution_target = self
                .context
                .agent_runtime()
                .read_session_catalog(&existing.session_id)
                .map_err(core_error)?
                .and_then(|session| session.execution_target);
            if !matches
                || params.title != existing.title
                || existing_execution_target != execution_target
                || (expected_agent_id != existing.agent_id && !legacy_creation)
                || params.branch_name.as_deref().is_some_and(|name| {
                    self.git_turn_changes
                        .as_ref()
                        .and_then(|runtime| runtime.binding(&existing.thread_id))
                        .and_then(|binding| binding.target_branch().map(str::to_owned))
                        .as_deref()
                        != Some(name)
                })
            {
                return Err(core_error(core_api::CoreError::CommandConflict));
            }
            (existing, false)
        } else {
            let agent = self
                .context
                .resolve_root_agent(&params.agent)
                .map_err(|error| {
                    let mut response = core_error(error.clone());
                    if let core_api::CoreError::InvalidInput(detail) = error {
                        response.detail = Some(detail);
                    }
                    response
                })?;
            let created = self
                .context
                .agent_runtime()
                .start_thread(StartThreadRequest {
                    agent_id: params.agent_id,
                    command_id: params.command_id,
                    title: params.title,
                    agent,
                    branch_name: params.branch_name,
                    execution_target,
                })
                .map_err(core_error)?;
            (created, true)
        };
        self.context
            .bind_session_runtime(&created.session_id)
            .map_err(core_error)?;
        if is_new {
            let _ = self.context.emit_hook_event(&HookEventRequest {
                event: HookEvent::SessionStart,
                scope: HookEventScope::Session {
                    session_id: created.session_id.clone(),
                },
                subject: None,
                tool_name: None,
            });
        }
        self.updates.publish_session_changed(&created.session_id);
        self.context.session_result(&created.session_id)
    }

    pub(super) fn fork_session_request(
        &self,
        mutation: SessionMutation,
        parent_thread_id: ash_protocol::ThreadId,
        title: String,
    ) -> Result<ash_app_server_protocol::protocol::session::SessionThreadResult, RpcError> {
        self.context
            .read_session_thread_snapshot(&mutation.session_id, &parent_thread_id)?;
        let forked = self
            .context
            .agent_runtime()
            .fork_session(core_api::ForkThreadRequest {
                command_id: mutation.command_id,
                source_thread_id: parent_thread_id,
                title,
            })
            .map_err(core_error)?;
        self.context
            .bind_session_runtime(&forked.session_id)
            .map_err(core_error)?;
        let _ = self.context.emit_hook_event(&HookEventRequest {
            event: HookEvent::SessionStart,
            scope: HookEventScope::Session {
                session_id: forked.session_id.clone(),
            },
            subject: Some("fork".into()),
            tool_name: None,
        });
        self.updates.publish_session_changed(&forked.session_id);
        Ok(
            ash_app_server_protocol::protocol::session::SessionThreadResult {
                session: self.context.session_view(&forked.session_id)?,
                thread_id: forked.thread_id,
            },
        )
    }

    pub(super) fn session_read(&self, params: &Value) -> Result<Value, RpcError> {
        let params: SessionReadParams = decode(params)?;
        result(&self.context.session_result(&params.session_id)?)
    }

    pub(super) fn session_trace_read(&self, params: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::session::SessionTraceReadParams;
        use ash_app_server_protocol::protocol::session::SessionTraceReadResult;

        let params: SessionTraceReadParams = decode(params)?;
        let page = self
            .context
            .trace_reader()
            .read_session_trace_page(&params.session_id, &params.after, params.limit as usize)
            .map_err(trace_error)?;
        result(&SessionTraceReadResult {
            trace: result(&page.trace)?,
            cursors: page.cursors,
            has_more: page.has_more,
        })
    }

    pub(super) fn session_trace_diagnostics_read(&self, params: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::session::SessionTraceDiagnosticsReadParams;
        use ash_app_server_protocol::protocol::session::SessionTraceDiagnosticsReadResult;
        let params: SessionTraceDiagnosticsReadParams = decode(params)?;
        let page = self
            .context
            .trace_reader()
            .read_trace_diagnostics(&params.session_id, params.after, params.limit as usize)
            .map_err(trace_error)?;
        result(&SessionTraceDiagnosticsReadResult {
            diagnostics: result(&page.diagnostics)?,
            cursor: page.cursor,
            has_more: page.has_more,
        })
    }

    pub(super) fn session_trace_payload_read(&self, params: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::session::SessionTracePayloadReadParams;
        use ash_app_server_protocol::protocol::session::SessionTracePayloadReadResult;
        let params: SessionTracePayloadReadParams = decode(params)?;
        result(&SessionTracePayloadReadResult {
            payload: self
                .context
                .trace_reader()
                .read_trace_payload(&params.session_id, &params.capture_id, &params.payload_id)
                .map_err(trace_error)?,
        })
    }

    pub(super) fn session_trace_graph_read(&self, params: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::session::SessionTraceGraphReadResult;
        let params: SessionReadParams = decode(params)?;
        result(&SessionTraceGraphReadResult {
            graph: result(
                &self
                    .context
                    .trace_reader()
                    .read_trace_graph(&params.session_id)
                    .map_err(trace_error)?,
            )?,
        })
    }

    pub(super) fn session_catalog_read(&self, params: &Value) -> Result<Value, RpcError> {
        let params: SessionReadParams = decode(params)?;
        result(&SessionCatalogReadResult {
            session: self.context.session_catalog_view(&params.session_id)?,
        })
    }

    pub(super) fn session_list(&self) -> Result<Value, RpcError> {
        result(&SessionListResult {
            sessions: self.context.session_views()?,
        })
    }

    pub(super) fn session_catalog_subscribe(
        &self,
        connection: &ConnectionState,
    ) -> Result<Value, RpcError> {
        self.updates.subscribe_catalog(connection.connection_id);
        self.session_list()
    }

    pub(super) fn session_catalog_unsubscribe(
        &self,
        connection: &ConnectionState,
    ) -> Result<Value, RpcError> {
        self.updates.unsubscribe_catalog(connection.connection_id);
        Ok(Value::Null)
    }

    pub(super) fn session_subscribe(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SessionSubscribeParams = decode(params)?;
        let session = self.context.session_view(&params.session_id)?;
        let view = self
            .context
            .agent_runtime()
            .read_session(&params.session_id)
            .map_err(core_error)?;
        let thread_snapshots = view.threads;
        let registrations = thread_snapshots
            .iter()
            .map(|thread| {
                self.updates
                    .begin_session_thread_subscription(
                        connection.connection_id,
                        params.session_id.clone(),
                        thread.thread_id.clone(),
                    )
                    .ok_or_else(|| RpcError::new(-32000, AppServerErrorName::ServerOverloaded))
            })
            .collect::<Result<Vec<_>, RpcError>>()?;
        let thread_projections = thread_snapshots
            .iter()
            .map(|thread| {
                let thread = thread.public_thread();
                let updates = self
                    .context
                    .agent_runtime()
                    .thread_updates_after(&thread.thread_id, 0)
                    .map_err(core_error)?;
                let voice_transcripts = self
                    .context
                    .agent_runtime()
                    .read_voice_transcripts(&thread.thread_id, thread.sequence)
                    .map_err(core_error)?;
                Ok(SessionThreadProjection {
                    directory: self.context.thread_directory(&thread.thread_id)?,
                    transcript: self.updates.thread_transcript_snapshot(
                        &thread,
                        true,
                        &voice_transcripts,
                    ),
                    thread,
                    updates,
                })
            })
            .collect::<Result<Vec<_>, RpcError>>()?;
        let watermarks = thread_projections
            .iter()
            .map(|item| {
                (
                    item.updates.last().map_or(item.thread.sequence, |update| {
                        update.durable_sequence.max(item.thread.sequence)
                    }),
                    item.transcript.revision,
                )
            })
            .collect::<Vec<_>>();
        let response = result(&SessionSubscribeResult {
            agent_tree: view.agent_tree,
            session,
            thread_projections,
        })?;
        for (registration, (sequence, revision)) in registrations.into_iter().zip(watermarks) {
            self.updates.commit_session_thread_subscription(
                registration,
                sequence,
                revision,
                super::update_broker::ThreadSubscriptionScope::Session,
            );
        }
        for snapshot in &thread_snapshots {
            self.context.offer_pending_interactions(snapshot);
        }
        Ok(response)
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
        self.context
            .cancel_lost_dynamic_tool_owners(lost_dynamic_tools);
        Ok(Value::Null)
    }

    pub(super) fn archive_session_request(
        &self,
        mutation: SessionMutation,
    ) -> Result<SessionResult, RpcError> {
        let session_id = mutation.session_id.clone();
        let result = self.lifecycle_request(mutation)?;
        self.context.clear_session_dirs(&session_id);
        Ok(result)
    }

    pub(super) fn restore_session_request(
        &self,
        mutation: SessionMutation,
    ) -> Result<SessionResult, RpcError> {
        let restored = self
            .context
            .agent_runtime()
            .restore_session(&mutation.session_id)
            .map_err(core_error)?;
        self.context
            .notify_thread_updates(&restored.thread_id, restored.sequence.saturating_sub(1))?;
        self.updates.publish_session_changed(&mutation.session_id);
        self.context.session_result(&mutation.session_id)
    }

    pub(super) fn stop_session_request(
        &self,
        mutation: SessionMutation,
    ) -> Result<SessionResult, RpcError> {
        self.context
            .agent_runtime()
            .archive_session(
                &mutation.session_id,
                &mutation.command_id,
                ash_protocol::ThreadArchiveReason::Stopped,
            )
            .map_err(core_error)?;
        self.notify_session_end(&mutation.session_id);
        self.context
            .stop_session_automations(&mutation.session_id)?;
        self.context.clear_session_dirs(&mutation.session_id);
        self.updates.publish_session_changed(&mutation.session_id);
        self.enforce_turn_changes_cleanup();
        self.context.session_result(&mutation.session_id)
    }

    pub(super) fn delete_session_request(
        &self,
        mutation: SessionMutation,
    ) -> Result<SessionId, RpcError> {
        let session_id = mutation.session_id.clone();
        if let Some(runtime) = &self.git_turn_changes {
            runtime
                .require_session_publications_settled(&session_id)
                .map_err(|error| core_error(core_api::CoreError::Execution(error)))?;
        }
        self.context
            .agent_runtime()
            .archive_session(
                &session_id,
                &mutation.command_id,
                ash_protocol::ThreadArchiveReason::Stopped,
            )
            .map_err(core_error)?;
        self.notify_session_end(&session_id);
        self.context.stop_session_automations(&session_id)?;
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
                .map_err(|error| core_error(core_api::CoreError::Execution(error)))?;
        }
        if let Some(board) = &self.message_board {
            board
                .delete_session(&session_id)
                .map_err(|error| core_error(core_api::CoreError::Execution(error.to_string())))?;
        }
        self.workflows
            .delete_session(&session_id)
            .map_err(core_error)?;
        self.agent_extensions
            .state()
            .remove(&ash_extension_api::ExtensionScope::Session(
                session_id.clone(),
            ));
        self.context
            .agent_runtime()
            .delete_session_threads(&session_id)
            .map_err(core_error)?;
        self.trace_recorder.remove_session(&session_id);
        if let Some(runtime) = &self.git_turn_changes {
            if let Err(error) = self.context.collect_message_checkpoints(runtime.as_ref()) {
                log::warn!("message checkpoint cleanup remains pending: {error}");
            }
        }
        self.context.clear_session_dirs(&session_id);
        self.updates.publish_session_deleted(&session_id);
        self.updates.forget_session(&session_id);
        self.enforce_turn_changes_cleanup();
        Ok(session_id)
    }

    fn lifecycle_request(&self, mutation: SessionMutation) -> Result<SessionResult, RpcError> {
        self.context
            .agent_runtime()
            .archive_session(
                &mutation.session_id,
                &mutation.command_id,
                ash_protocol::ThreadArchiveReason::Completed,
            )
            .map_err(core_error)?;
        self.notify_session_end(&mutation.session_id);
        self.updates.publish_session_changed(&mutation.session_id);
        self.enforce_turn_changes_cleanup();
        self.context.session_result(&mutation.session_id)
    }

    fn enforce_turn_changes_cleanup(&self) {
        if let Some(runtime) = &self.git_turn_changes
            && let Err(error) = runtime.enforce_cleanup_policy()
        {
            log::warn!("Thread worktree cleanup policy failed: {error}");
        }
    }

    fn notify_session_end(&self, session_id: &SessionId) {
        let _ = self.context.emit_hook_event(&HookEventRequest {
            event: HookEvent::SessionEnd,
            scope: HookEventScope::Session {
                session_id: session_id.clone(),
            },
            subject: None,
            tool_name: None,
        });
    }
}

// Cursor and capture identity failures are RPC parameter errors, while storage and missing
// Session/payload failures retain the ordinary Core error contract.
fn trace_error(error: core_api::CoreError) -> RpcError {
    match error {
        core_api::CoreError::InvalidInput(_) => RpcError::new(
            -32602,
            ash_app_server_protocol::protocol::error::AppServerErrorName::InvalidParams,
        ),
        error => core_error(error),
    }
}
