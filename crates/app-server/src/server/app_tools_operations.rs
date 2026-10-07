use super::AppServer;
use super::operations::SessionMutation;
use super::project_projection;
use app_tools::AppToolContext;
use app_tools::AppToolHost;
use app_tools::AppToolOperation;
use app_tools::AutomationOperation;
use app_tools::OpenTarget;
use ash_app_server_protocol::protocol::app_tools::AppHostOperation;
use ash_app_server_protocol::protocol::app_tools::AppHostRequestParams;
use ash_app_server_protocol::protocol::app_tools::AppHostResult;
use ash_app_server_protocol::protocol::automation::AutomationDeleteParams;
use ash_app_server_protocol::protocol::automation::AutomationRunParams;
use ash_app_server_protocol::protocol::automation::AutomationRunsParams;
use ash_app_server_protocol::protocol::automation::AutomationStopParams;
use ash_app_server_protocol::protocol::automation::AutomationWriteParams;
use ash_app_server_protocol::protocol::registry::HostMethod;
use ash_app_server_protocol::protocol::session::SessionCreateParams;
use ash_async_utils::CancellationToken;
use ash_protocol::CommandId;
use ash_protocol::SessionStatus;
use core_api::CoreError;
use serde_json::Value;
use serde_json::json;

impl AppToolHost for AppServer {
    fn execute(
        &self,
        operation: AppToolOperation,
        context: &AppToolContext,
        cancellation: &CancellationToken,
    ) -> Result<Value, CoreError> {
        self.read_session_thread_snapshot(&context.session_id, &context.thread_id)
            .map_err(rpc_error)?;
        let command_id = CommandId::new(format!(
            "app-tool:{}:{}:{}",
            context.thread_id, context.turn_id, context.call_id
        ))
        .map_err(|error| CoreError::Execution(error.to_string()))?;
        let value = match operation {
            AppToolOperation::ListThreads { archived } => json!({"sessions": self.session_views().map_err(rpc_error)?.into_iter().filter(|session| (session.status == SessionStatus::Archived) == archived).collect::<Vec<_>>() }),
            AppToolOperation::ReadThread { session_id, thread_id } => self.session_thread_read(&json!({"sessionId":session_id,"threadId":thread_id,"history":{"type":"latest","turnLimit":20}})).map_err(rpc_error)?,
            AppToolOperation::CreateThread { title } => {
                let caller = self.session_view(&context.session_id).map_err(rpc_error)?;
                serde_json::to_value(self.create_session(SessionCreateParams { agent_id: None, agent: Default::default(), command_id, title, execution_target: caller.execution_target, branch_name: None }).map_err(rpc_error)?).map_err(json_error)?
            }
            AppToolOperation::ForkThread { session_id, thread_id, title } => serde_json::to_value(self.fork_session_request(SessionMutation { command_id, session_id }, thread_id, title).map_err(rpc_error)?).map_err(json_error)?,
            AppToolOperation::SetThreadArchived { session_id, archived } => {
                if archived && session_id == context.session_id { return Err(CoreError::Execution("cannot archive the task executing this tool".into())); }
                let mutation = SessionMutation { command_id, session_id };
                let result = if archived { self.archive_session_request(mutation) } else { self.restore_session_request(mutation) };
                serde_json::to_value(result.map_err(rpc_error)?).map_err(json_error)?
            }
            AppToolOperation::ListProjects {} => json!({"projects":self.projects.as_deref().ok_or_else(|| CoreError::Execution("projects are unavailable".into()))?.list().map_err(|error| CoreError::Execution(error.to_string()))?.iter().map(project_projection::summary).collect::<Vec<_>>() }),
            AppToolOperation::AutomationUpdate { operation } => self.execute_app_automation(operation, &command_id, context)?,
            other => {
                let operation = match other {
                    AppToolOperation::OpenInAsh { target } => match target {
                        OpenTarget::File { path, line } => { self.validate_app_path(&path, context)?; AppHostOperation::OpenFile { path, line } }
                        OpenTarget::Browser { url } => {
                            let parsed = url::Url::parse(&url).map_err(|error| CoreError::Policy(error.to_string()))?;
                            if !matches!(parsed.scheme(), "http" | "https") { return Err(CoreError::Policy("browser targets require http or https".into())); }
                            AppHostOperation::OpenBrowser { url }
                        }
                        OpenTarget::Terminal {} => AppHostOperation::OpenTerminal {},
                        OpenTarget::Review { original, modified } => { self.validate_app_path(&original, context)?; self.validate_app_path(&modified, context)?; AppHostOperation::OpenReview { original, modified } }
                    },
                    AppToolOperation::NavigateToAshPage { session_id, thread_id } => { self.read_session_thread_snapshot(&session_id, &thread_id).map_err(rpc_error)?; AppHostOperation::Navigate { session_id, thread_id } }
                    AppToolOperation::ListSidebarSections {} => AppHostOperation::ListSections {},
                    AppToolOperation::CreateSidebarSection { name } => AppHostOperation::CreateSection { name },
                    AppToolOperation::RenameSidebarSection { section_id, name } => AppHostOperation::RenameSection { section_id, name },
                    AppToolOperation::DeleteSidebarSection { section_id } => AppHostOperation::DeleteSection { section_id },
                    AppToolOperation::MoveThreadToSidebarSection { session_id, section_id } => { self.session_view(&session_id).map_err(rpc_error)?; AppHostOperation::MoveSession { session_id, section_id } }
                    AppToolOperation::ReorderSection { section_id, session_ids } => AppHostOperation::ReorderSection { section_id, session_ids },
                    AppToolOperation::CheckAppUpdate {} => AppHostOperation::CheckUpdate {},
                    AppToolOperation::FireConfetti {} => AppHostOperation::Confetti {},
                    _ => unreachable!("business operations were handled above"),
                };
                self.execute_app_host(operation, context, cancellation)?
            }
        };
        Ok(value)
    }
}

impl AppServer {
    fn validate_app_path(&self, path: &str, context: &AppToolContext) -> Result<(), CoreError> {
        let path = std::path::Path::new(path);
        if !path.is_absolute() {
            return Err(CoreError::Policy(
                "application file targets require absolute paths".into(),
            ));
        }
        // Canonical paths prevent '..' and symlinks from escaping the caller's granted directory.
        let path = path
            .canonicalize()
            .map_err(|error| CoreError::Execution(error.to_string()))?;
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !runtime
            .dir_grants
            .list(&context.session_id)
            .iter()
            .any(|entry| {
                entry
                    .permissions()
                    .allows(ash_file_access::Permission::ReadFiles)
                    && path.starts_with(entry.dir().canonical_path())
            })
        {
            return Err(CoreError::Policy(
                "application target is outside the task's granted directories".into(),
            ));
        }
        Ok(())
    }

    fn execute_app_automation(
        &self,
        operation: AutomationOperation,
        command_id: &CommandId,
        context: &AppToolContext,
    ) -> Result<Value, CoreError> {
        let result = match operation {
            AutomationOperation::List {} => self.automation_list(),
            AutomationOperation::View { id } => {
                let list = self.automation_list().map_err(rpc_error)?;
                return list["automations"]
                    .as_array()
                    .and_then(|items| items.iter().find(|item| item["id"].as_str() == Some(&id)))
                    .cloned()
                    .ok_or_else(|| CoreError::Execution("automation not found".into()));
            }
            AutomationOperation::Save {
                id,
                expected_revision,
                definition,
                status,
            } => {
                self.validate_app_path(&definition.directory, context)?;
                if let ash_protocol::AutomationSession::Continue {
                    session_id,
                    thread_id,
                } = &definition.session
                {
                    self.read_session_thread_snapshot(session_id, thread_id)
                        .map_err(rpc_error)?;
                }
                self.automation_write(
                    &serde_json::to_value(AutomationWriteParams {
                        command_id: command_id.to_string(),
                        id,
                        expected_revision,
                        definition,
                        status,
                    })
                    .map_err(json_error)?,
                )
            }
            AutomationOperation::Delete {
                id,
                expected_revision,
            } => self.automation_delete(
                &serde_json::to_value(AutomationDeleteParams {
                    id,
                    expected_revision,
                })
                .map_err(json_error)?,
            ),
            AutomationOperation::Run { id } => self.automation_run(
                &serde_json::to_value(AutomationRunParams {
                    id,
                    command_id: command_id.to_string(),
                })
                .map_err(json_error)?,
            ),
            AutomationOperation::Runs { id } => self.automation_runs(
                &serde_json::to_value(AutomationRunsParams { id, limit: 20 })
                    .map_err(json_error)?,
            ),
            AutomationOperation::Stop { run_id } => self.automation_stop(
                &serde_json::to_value(AutomationStopParams { run_id }).map_err(json_error)?,
            ),
        };
        result.map_err(rpc_error)
    }

    fn execute_app_host(
        &self,
        operation: AppHostOperation,
        context: &AppToolContext,
        cancellation: &CancellationToken,
    ) -> Result<Value, CoreError> {
        let binding = self
            .client_host
            .binding(&context.thread_id, &context.turn_id)
            .map_err(host_error)?
            .ok_or_else(|| CoreError::Execution("this turn has no application window".into()))?;
        let capability = self
            .client_host
            .app_tools_capability(binding.connection_id)
            .ok_or_else(|| {
                CoreError::Execution(
                    "the initiating window does not support application tools".into(),
                )
            })?;
        if !capability.agents
            || matches!(operation, AppHostOperation::CheckUpdate {}) && !capability.desktop
        {
            return Err(CoreError::Execution(
                "application capability is unavailable in the initiating window".into(),
            ));
        }
        let response: AppHostResult = self
            .client_host
            .request(
                binding.connection_id,
                HostMethod::AppHostRequest,
                &AppHostRequestParams {
                    session_id: context.session_id.clone(),
                    thread_id: context.thread_id.clone(),
                    turn_id: context.turn_id.clone(),
                    operation,
                },
                cancellation,
            )
            .map_err(host_error)?;
        if response.json.len() > 1_048_576 {
            return Err(CoreError::Execution(
                "application host response exceeds 1 MiB".into(),
            ));
        }
        serde_json::from_str(&response.json).map_err(json_error)
    }
}

fn rpc_error(error: super::RpcError) -> CoreError {
    CoreError::Execution(format!("application operation failed: {}", error))
}
fn json_error(error: serde_json::Error) -> CoreError {
    CoreError::Execution(error.to_string())
}

fn host_error(error: crate::client_host::ClientHostError) -> CoreError {
    match error {
        crate::client_host::ClientHostError::Cancelled(reason) => CoreError::Cancelled(reason),
        other => CoreError::Execution(format!("{other:?}")),
    }
}
