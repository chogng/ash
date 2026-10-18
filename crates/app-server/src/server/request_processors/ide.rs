#[cfg(test)]
#[path = "../ide_operations_tests.rs"]
mod tests;

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

/// Coordinates the existing owners needed by the ide adapter.
/// This contract deliberately exposes no server object or unrestricted service registry.
pub(super) trait IdeRequestProcessorContext: Send + Sync {
    fn display_read_authorizations(
        &self,
        session: &ash_protocol::SessionId,
        thread: &ash_protocol::ThreadId,
    ) -> Result<Vec<ash_file_access::Authorization>, core_api::CoreError>;
    fn read_session_thread_snapshot(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<core_api::ThreadView, super::RpcError>;
    fn session_view(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<ash_protocol::Session, super::RpcError>;
}

pub(super) struct IdeRequestProcessor<'ctx, C: IdeRequestProcessorContext + ?Sized> {
    context: &'ctx C,
    client_host: &'ctx super::Arc<crate::client_host::ClientHost>,
    ide_registry: &'ctx super::Arc<crate::ide_registry::IdeRegistry>,
    queue: &'ctx Option<super::Arc<queue::QueueStore>>,
}

impl<'ctx, C: IdeRequestProcessorContext + ?Sized> IdeRequestProcessor<'ctx, C> {
    pub(super) fn new(
        context: &'ctx C,
        client_host: &'ctx super::Arc<crate::client_host::ClientHost>,
        ide_registry: &'ctx super::Arc<crate::ide_registry::IdeRegistry>,
        queue: &'ctx Option<super::Arc<queue::QueueStore>>,
    ) -> Self {
        Self {
            context,
            client_host,
            ide_registry,
            queue,
        }
    }
}

impl<'ctx, C: IdeRequestProcessorContext + ?Sized> IdeRequestProcessor<'ctx, C> {
    pub(super) fn ide_request(
        &self,
        connection: &ConnectionState,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let request: IdeRequest = decode(params)?;
        let owner = connection.connection_id;
        let response = match request {
            IdeRequest::Register {
                title,
                roots,
                window_key,
            } => {
                if !connection.allows_product_host_capabilities() {
                    return Err(RpcError::new(
                        -32073,
                        AppServerErrorName::PermissionRequired,
                    ));
                }
                if window_key
                    .as_ref()
                    .is_some_and(|key| !valid_window_key(key))
                {
                    return Err(invalid());
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
                    .register(&self.client_host, owner, title, roots, window_key)
                    .map_err(ide_error)?;
                IdeResult::Registered { window }
            }
            IdeRequest::Attach { window_key } => {
                if !valid_window_key(&window_key) {
                    return Err(invalid());
                }
                self.client_host
                    .set_ide_window_key(owner, window_key.clone())
                    .map_err(ide_error)?;
                let target = self.ide_registry.find_window_key(&window_key);
                let window = target.as_ref().map(|target| target.window.clone());
                self.client_host
                    .select_ide(owner, target)
                    .map_err(ide_error)?;
                IdeResult::Connected { window }
            }
            IdeRequest::Unregister {} => {
                self.ide_registry.unregister(&self.client_host, owner);
                IdeResult::Connected { window: None }
            }
            IdeRequest::List {} => IdeResult::Windows {
                windows: self.ide_registry.list(),
                preferred: self
                    .client_host
                    .ide_window_key(owner)
                    .map_err(ide_error)?
                    .map(|key| match self.ide_registry.find_window_key(&key) {
                        Some(target) => {
                            ash_app_server_protocol::protocol::ide::IdeOrigin::Available {
                                window: target.window,
                            }
                        }
                        None => ash_app_server_protocol::protocol::ide::IdeOrigin::Unavailable {},
                    }),
                selected: self
                    .client_host
                    .selected_ide(owner)
                    .map_err(ide_error)?
                    .map(|target| {
                        // A lost window does not switch context sharing off. Retain the selection
                        // so `/ide` can still disable it, while refreshing live window labels.
                        self.ide_registry
                            .get(&target.window.id)
                            .map(|live| live.window)
                            .unwrap_or(target.window)
                    }),
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
            IdeRequest::OpenConversation {
                session_id,
                thread_id,
            } => {
                let snapshot = self
                    .context
                    .read_session_thread_snapshot(&session_id, &thread_id)?;
                let session = self.context.session_view(&session_id)?;
                if snapshot.status != ash_protocol::ThreadStatus::Active
                    || session.status != ash_protocol::SessionStatus::Active
                    || !matches!(
                        session.execution_target,
                        Some(ash_protocol::SessionExecutionTarget::Local { .. })
                    )
                {
                    return result(&IdeResult::ConversationUnavailable {});
                }
                // The initiating client still owns outstanding tools and approvals. Opening the
                // desktop must never dispose that connection while it has accepted work.
                let active = matches!(
                    session.manager.status,
                    ash_protocol::SessionManagerStatus::Working
                        | ash_protocol::SessionManagerStatus::NeedsInput
                );
                // Core owns the Session's activity classification, including background branches.
                // Queue delivery is independent, so inspect the pending work of each branch too.
                let queued = if let Some(queue) = &self.queue {
                    session
                        .threads
                        .iter()
                        .try_fold(false, |pending, thread| {
                            queue.list(&session_id, &thread.thread_id).map(|messages| {
                                pending
                                    || messages.iter().any(|message| match message.status {
                                        queue::QueueStatus::Pending
                                        | queue::QueueStatus::Paused
                                        | queue::QueueStatus::Delivering => true,
                                        queue::QueueStatus::Started
                                        | queue::QueueStatus::Rejected
                                        | queue::QueueStatus::Cancelled => false,
                                    })
                            })
                        })
                        .map_err(|error| core_error(CoreError::Execution(error.to_string())))?
                } else {
                    false
                };
                if active
                    || queued
                    || self
                        .client_host
                        .has_pending_turns(owner)
                        .map_err(ide_error)?
                {
                    IdeResult::ConversationBusy {}
                } else {
                    // Provenance remains available when /ide has disabled context sharing.
                    // Never silently choose another window when the original has disappeared.
                    let key = self.client_host.ide_window_key(owner).map_err(ide_error)?;
                    let target = if let Some(key) = key {
                        self.ide_registry.find_window_key(&key)
                    } else {
                        self.client_host
                            .selected_ide(owner)
                            .map_err(ide_error)?
                            .and_then(|target| self.ide_registry.get(&target.window.id).ok())
                    };
                    if let Some(target) = target {
                        match target
                            .request(
                                &IdeHostRequest::OpenConversation {
                                    session_id,
                                    thread_id,
                                },
                                cancellation,
                            )
                            .map_err(ide_error)?
                        {
                            // Loading the desktop can take time. Accepted work may appear on
                            // another peer while we await its acknowledgement.
                            IdeHostResult::Opened {}
                                if self
                                    .client_host
                                    .has_pending_turns(owner)
                                    .map_err(ide_error)? =>
                            {
                                IdeResult::ConversationBusy {}
                            }
                            IdeHostResult::Opened {} => IdeResult::ConversationOpened {},
                            IdeHostResult::Context { .. } => return Err(invalid()),
                        }
                    } else {
                        IdeResult::ConversationUnavailable {}
                    }
                }
            }
            IdeRequest::Context {
                session_id,
                thread_id,
            } => {
                self.context
                    .read_session_thread_snapshot(&session_id, &thread_id)?;
                let session = self.context.session_view(&session_id)?;
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
                            .context
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
                            // An integrated terminal can cd outside its editor workspace. Keep the
                            // attachment, but share no content beyond the current directory grants.
                            return result(&IdeResult::Context {
                                window: Some(target.window),
                                context: None,
                            });
                        }
                        let IdeHostResult::Context { mut context } = target
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
                            // Match Dir's canonical namespace, including Windows verbatim paths.
                            // Keep the lexical name too: resolving it must not bypass a deny rule.
                            dunce::canonicalize(path).is_ok_and(|canonical| {
                                authorizations.iter().any(|authorization| {
                                    let root = authorization.dir().canonical_path();
                                    canonical.strip_prefix(root).is_ok_and(|relative| {
                                        authorization
                                            .path_policy()
                                            .allows(relative, ash_file_access::PathOperation::Read)
                                    }) && dunce::simplified(Path::new(path))
                                        .strip_prefix(root)
                                        .is_ok_and(|relative| {
                                            authorization.path_policy().allows(
                                                relative,
                                                ash_file_access::PathOperation::Read,
                                            )
                                        })
                                })
                            })
                        };
                        // An IDE may have a denied file open (for example a secret). Omit it
                        // without preventing an otherwise valid terminal message from being sent.
                        context.open_tabs.retain(readable);
                        context.dirty_files.retain(readable);
                        if context
                            .active_file
                            .as_ref()
                            .is_some_and(|file| !readable(&file.path))
                        {
                            context.active_file = None;
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

fn valid_window_key(key: &str) -> bool {
    key.len() == 32 && key.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn invalid() -> RpcError {
    RpcError::new(-32602, AppServerErrorName::InvalidParams)
}
fn ide_error(error: crate::client_host::ClientHostError) -> RpcError {
    let error = match error {
        crate::client_host::ClientHostError::Cancelled(reason) => CoreError::Cancelled(reason),
        crate::client_host::ClientHostError::CapabilityUnavailable => CoreError::Execution(
            "IDE disconnected; run /ide to disable editor context and continue".into(),
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
            // Registration and directory grants already use Dir's dunce canonicalization.
            && dunce::canonicalize(path)
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
