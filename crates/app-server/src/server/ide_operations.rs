#[cfg(test)]
#[path = "ide_operations_tests.rs"]
mod tests;

use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::core_error;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::ide::IdeContext;
use ash_app_server_protocol::protocol::ide::IdeHostRequest;
use ash_app_server_protocol::protocol::ide::IdeHostResult;
use ash_app_server_protocol::protocol::ide::IdeRequest;
use ash_app_server_protocol::protocol::ide::IdeResult;
use ash_async_utils::CancellationToken;
use core_api::CoreError;
use serde_json::Value;
use std::path::Path;

impl AppServer {
    pub(super) fn ide_request(
        &self,
        connection: &ConnectionState,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let request: IdeRequest = decode(params)?;
        let owner = connection.connection_id;
        let response = match request {
            IdeRequest::Register { title, roots } => {
                if !connection.allows_product_host_capabilities() {
                    return Err(RpcError::new(
                        -32073,
                        AppServerErrorName::PermissionRequired,
                    ));
                }
                if title.trim().is_empty()
                    || title.len() > 1024
                    || title.chars().any(char::is_control)
                    || roots.is_empty()
                    || roots.len() > 32
                {
                    return Err(invalid());
                }
                let roots = roots
                    .into_iter()
                    .map(|root| {
                        let path = Path::new(&root);
                        if !path.is_absolute() || root.len() > 4096 || root.contains('\0') {
                            return Err(invalid());
                        }
                        ash_file_access::Dir::open_local(path)
                            .map(|dir| dir.canonical_path().to_string_lossy().into_owned())
                            .map_err(|_| invalid())
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let window = self
                    .ide_registry
                    .register(&self.client_host, owner, title, roots)
                    .map_err(ide_error)?;
                IdeResult::Registered { window }
            }
            IdeRequest::Unregister {} => {
                self.ide_registry.unregister(&self.client_host, owner);
                IdeResult::Connected { window: None }
            }
            IdeRequest::List {} => IdeResult::Windows {
                windows: self.ide_registry.list(),
                selected: self
                    .client_host
                    .selected_ide(owner)
                    .map_err(ide_error)?
                    .and_then(|target| self.ide_registry.get(&target.window.id).ok())
                    .map(|target| target.window),
            },
            IdeRequest::Connect { window_id } => {
                if window_id.len() != 32 {
                    return Err(invalid());
                }
                let target = self.ide_registry.get(&window_id).map_err(ide_error)?;
                let window = target.window.clone();
                self.client_host
                    .select_ide(owner, Some(target))
                    .map_err(ide_error)?;
                IdeResult::Connected {
                    window: Some(window),
                }
            }
            IdeRequest::Disconnect {} => {
                self.client_host
                    .select_ide(owner, None)
                    .map_err(ide_error)?;
                IdeResult::Connected { window: None }
            }
            IdeRequest::Context {
                session_id,
                thread_id,
            } => {
                self.read_session_thread_snapshot(&session_id, &thread_id)?;
                let session = self.session_view(&session_id)?;
                match self.client_host.selected_ide(owner).map_err(ide_error)? {
                    None => IdeResult::Context {
                        window: None,
                        context: None,
                    },
                    Some(target) => {
                        let target = self
                            .ide_registry
                            .get(&target.window.id)
                            .map_err(ide_error)?;
                        if matches!(
                            session.execution_target,
                            Some(
                                ash_protocol::SessionExecutionTarget::Ssh { .. }
                                    | ash_protocol::SessionExecutionTarget::Provider { .. }
                            )
                        ) {
                            return Err(core_error(CoreError::Policy(
                                "IDE attachment requires a local execution environment".into(),
                            )));
                        }
                        let authorizations = self
                            .display_read_authorizations(&session_id, &thread_id)
                            .map_err(core_error)?;
                        let mut allowed = authorizations
                            .iter()
                            .flat_map(|authorization| {
                                let root = authorization.dir().canonical_path();
                                target.window.roots.iter().filter_map(move |workspace| {
                                    if root.starts_with(workspace) {
                                        Some(root.to_string_lossy().into_owned())
                                    } else if Path::new(workspace).starts_with(root) {
                                        Some(workspace.clone())
                                    } else {
                                        None
                                    }
                                })
                            })
                            .collect::<Vec<_>>();
                        allowed.sort();
                        allowed.dedup();
                        if allowed.is_empty() {
                            return Err(core_error(CoreError::Policy(
                                "selected IDE does not share a granted session directory".into(),
                            )));
                        }
                        let IdeHostResult::Context { context } = target
                            .request(
                                &IdeHostRequest::Context {
                                    roots: allowed.clone(),
                                },
                                cancellation,
                            )
                            .map_err(ide_error)?
                        else {
                            return Err(invalid());
                        };
                        for authorization in &authorizations {
                            authorization.ensure_active().map_err(|error| {
                                core_error(CoreError::Policy(error.to_string()))
                            })?;
                        }
                        validate_context(&context, &allowed)?;
                        let readable = |path: &String| {
                            std::fs::canonicalize(path).is_ok_and(|canonical| {
                                authorizations.iter().any(|authorization| {
                                    let root = authorization.dir().canonical_path();
                                    canonical.strip_prefix(root).is_ok_and(|relative| {
                                        authorization
                                            .path_policy()
                                            .allows(relative, ash_file_access::PathOperation::Read)
                                    }) && Path::new(path).strip_prefix(root).is_ok_and(|relative| {
                                        authorization
                                            .path_policy()
                                            .allows(relative, ash_file_access::PathOperation::Read)
                                    })
                                })
                            })
                        };
                        if context
                            .open_tabs
                            .iter()
                            .chain(&context.dirty_files)
                            .any(|path| !readable(path))
                            || context
                                .active_file
                                .as_ref()
                                .is_some_and(|file| !readable(&file.path))
                        {
                            return Err(core_error(CoreError::Policy(
                                "IDE context contains a file excluded by directory permissions"
                                    .into(),
                            )));
                        }
                        IdeResult::Context {
                            window: Some(target.window),
                            context: Some(context),
                        }
                    }
                }
            }
        };
        result(&response)
    }
}

fn invalid() -> RpcError {
    RpcError::new(-32602, AppServerErrorName::InvalidParams)
}
fn ide_error(error: crate::client_host::ClientHostError) -> RpcError {
    let error = match error {
        crate::client_host::ClientHostError::Cancelled(reason) => CoreError::Cancelled(reason),
        crate::client_host::ClientHostError::CapabilityUnavailable => CoreError::Execution(
            "IDE disconnected; use /ide to reconnect or /ide disconnect to continue".into(),
        ),
        crate::client_host::ClientHostError::TimedOut => {
            CoreError::Execution("IDE context request timed out".into())
        }
        crate::client_host::ClientHostError::Failed(message) => CoreError::Execution(message),
    };
    core_error(error)
}

// The editor response is a process boundary. Never accept unbounded selections or paths
// from outside the caller's directory grants, even when the window declares a matching root.
fn validate_context(context: &IdeContext, roots: &[String]) -> Result<(), RpcError> {
    let path_allowed = |path: &str| {
        Path::new(path).is_absolute()
            && path.len() <= 4096
            && std::fs::canonicalize(path)
                .is_ok_and(|path| roots.iter().any(|root| path.starts_with(root)))
    };
    if context.open_tabs.len() > 100
        || context.dirty_files.len() > 100
        || context
            .open_tabs
            .iter()
            .chain(&context.dirty_files)
            .any(|path| !path_allowed(path))
    {
        return Err(invalid());
    }
    if let Some(file) = &context.active_file {
        if !path_allowed(&file.path)
            || file.version == 0
            || file.selections.len() > 32
            || file.selections.iter().any(|selection| {
                selection.start_line == 0
                    || selection.start_column == 0
                    || selection.end_line == 0
                    || selection.end_column == 0
                    || (selection.end_line, selection.end_column)
                        < (selection.start_line, selection.start_column)
            })
            || file
                .selections
                .iter()
                .map(|selection| selection.text.len())
                .sum::<usize>()
                > 160_000
        {
            return Err(invalid());
        }
    }
    Ok(())
}
