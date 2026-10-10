use std::sync::Arc;
use std::thread;
use std::thread::JoinHandle;
use std::time::Duration;

use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use extension_protocol::ExtensionBackgroundClientResponse;
use extension_protocol::ExtensionClientOperation;
use extension_protocol::ExtensionClientResult;

use crate::ExtensionActivationSpec;
use crate::ExtensionHostError;
use crate::ExtensionHostProcess;
use crate::HostErrorCode;
use crate::HostEventContext;
use crate::HostFailure;

/// The trusted product caller binds its window and extension identity before activation.
/// Implementations must observe cancellation and the supplied timeout, including during startup.
/// Each call holds a fresh live authority lease; this handler never selects a window from child data.
pub type ExtensionBackgroundClientHandler = dyn Fn(
        HostEventContext,
        ExtensionClientOperation,
        &CancellationToken,
        Duration,
    ) -> Result<ExtensionClientResult, HostFailure>
    + Send
    + Sync;

/// One process's independent client service pump. It must run while activation awaits editor IO.
pub(super) struct BackgroundClientWorker {
    cancellation: CancellationSource,
    thread: Option<JoinHandle<()>>,
}

impl BackgroundClientWorker {
    pub(super) fn start(
        process: Arc<dyn ExtensionHostProcess>,
        activation: ExtensionActivationSpec,
        handler: Arc<ExtensionBackgroundClientHandler>,
        timeout: Duration,
    ) -> Result<Self, ExtensionHostError> {
        let cancellation = CancellationSource::new();
        let source = cancellation.clone();
        let token = source.token();
        let thread = thread::Builder::new()
            .name("ash-extension-client".into())
            .spawn(move || {
                let mut calls: Vec<JoinHandle<()>> = Vec::new();
                let mut failed = false;
                while !token.is_cancelled() && !process.has_exited() {
                    let mut index = 0;
                    while index < calls.len() {
                        if calls[index].is_finished() {
                            if calls.swap_remove(index).join().is_err() {
                                failed = true;
                                source.cancel();
                                break;
                            }
                        } else {
                            index += 1;
                        }
                    }
                    if token.is_cancelled() {
                        break;
                    }
                    // The process bounds queued plus outstanding calls. Separate workers prevent
                    // a launch request waiting on a provider from blocking that provider's IO.
                    for request in process.drain_background_client_requests() {
                        let process = Arc::clone(&process);
                        let activation = activation.clone();
                        let handler = Arc::clone(&handler);
                        let token = token.clone();
                        let call = thread::Builder::new()
                            .name("ash-extension-client-call".into())
                            .spawn(move || {
                                let outcome = match activation.acquire() {
                                    Some(_lease) if !token.is_cancelled() => {
                                        handler(request.context, request.operation, &token, timeout)
                                    }
                                    Some(_) | None => Err(HostFailure {
                                        code: HostErrorCode::Cancelled,
                                        message: "extension activation is no longer authorized"
                                            .into(),
                                    }),
                                };
                                if !token.is_cancelled() {
                                    let _ = process.respond_background_client(
                                        ExtensionBackgroundClientResponse {
                                            context: request.context,
                                            call_id: request.call_id,
                                            outcome,
                                        },
                                    );
                                }
                            });
                        match call {
                            Ok(call) => calls.push(call),
                            Err(_) => {
                                failed = true;
                                source.cancel();
                                break;
                            }
                        }
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                source.cancel();
                for call in calls {
                    failed |= call.join().is_err();
                }
                if failed {
                    let _ = process.terminate();
                }
            })
            .map_err(|_| ExtensionHostError::SpawnFailed)?;
        Ok(Self {
            cancellation,
            thread: Some(thread),
        })
    }
}

impl Drop for BackgroundClientWorker {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

enum StatusBarUpdate {
    Unchanged,
    Rejected,
    Replace {
        registration_id: String,
        revision: u64,
        entries: Vec<extension_protocol::ExtensionStatusBarEntry>,
    },
}

impl super::SupervisorInner {
    pub(super) fn service_client_operation(
        &self,
        incarnation: u64,
        operation: ExtensionClientOperation,
        handler: impl FnOnce(ExtensionClientOperation) -> Result<ExtensionClientResult, HostFailure>,
    ) -> Result<Result<ExtensionClientResult, HostFailure>, ExtensionHostError> {
        let status_update = match self.prepare_client_operation(incarnation, &operation)? {
            Ok(update) => update,
            Err(failure) => return Ok(Err(failure)),
        };
        let outcome = handler(operation);
        self.acknowledge_client_operation(incarnation, status_update, &outcome)?;
        Ok(outcome)
    }

    fn prepare_client_operation(
        &self,
        incarnation: u64,
        operation: &ExtensionClientOperation,
    ) -> Result<Result<StatusBarUpdate, HostFailure>, ExtensionHostError> {
        {
            let state = self
                .state
                .lock()
                .map_err(|_| ExtensionHostError::HostExited)?;
            if state.incarnation != incarnation
                || !matches!(
                    state.status,
                    super::ExtensionHostStatus::Starting | super::ExtensionHostStatus::Ready
                )
            {
                return Ok(Err(HostFailure {
                    code: HostErrorCode::Cancelled,
                    message: "extension incarnation is no longer active".into(),
                }));
            }
            // Both invocation and background requests require the same live resolver registration.
            if matches!(
                operation,
                ExtensionClientOperation::OpenRemoteConnection { .. }
            ) && !state.registrations.iter().any(|registration| {
                matches!(
                    registration.kind,
                    extension_protocol::RegistrationKind::RemoteAuthorityResolver { .. }
                        | extension_protocol::RegistrationKind::RemoteConnectionResolver { .. }
                )
            }) {
                return Ok(Err(HostFailure {
                    code: HostErrorCode::PermissionDenied,
                    message:
                        "Remote connection requests require an active Remote resolver registration"
                            .into(),
                }));
            }
        }
        let status_update = match operation {
            extension_protocol::ExtensionClientOperation::SetStatusBarEntries {
                registration_id,
                revision,
                entries,
            } => {
                let state = self
                    .state
                    .lock()
                    .map_err(|_| ExtensionHostError::HostExited)?;
                let valid = state.incarnation == incarnation
                    && state.registrations.iter().any(|registration| {
                        registration.registration_id == *registration_id
                            && matches!(
                                registration.kind,
                                extension_protocol::RegistrationKind::StatusBar { .. }
                            )
                    });
                if valid {
                    StatusBarUpdate::Replace {
                        registration_id: registration_id.clone(),
                        revision: *revision,
                        entries: entries.clone(),
                    }
                } else {
                    StatusBarUpdate::Rejected
                }
            }
            _ => StatusBarUpdate::Unchanged,
        };
        if matches!(status_update, StatusBarUpdate::Rejected) {
            return Ok(Err(HostFailure {
                code: HostErrorCode::RegistrationNotFound,
                message: "status bar registration is not owned by this incarnation".into(),
            }));
        }
        Ok(Ok(status_update))
    }

    fn acknowledge_client_operation(
        &self,
        incarnation: u64,
        status_update: StatusBarUpdate,
        outcome: &Result<ExtensionClientResult, HostFailure>,
    ) -> Result<(), ExtensionHostError> {
        // Retain only the latest acknowledged UI value for reconnects. Concurrent older
        // callbacks cannot restore a hidden entry or keep a history of command arguments.
        if matches!(outcome, Ok(extension_protocol::ExtensionClientResult::Done))
            && let StatusBarUpdate::Replace {
                registration_id,
                revision,
                entries,
            } = status_update
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| ExtensionHostError::HostExited)?;
            if state.incarnation == incarnation
                && let Some(registration) = state
                    .registrations
                    .iter_mut()
                    .find(|registration| registration.registration_id == registration_id)
                && let extension_protocol::RegistrationKind::StatusBar {
                    revision: previous,
                    entries: current,
                } = &mut registration.kind
                && revision > *previous
            {
                *previous = revision;
                *current = entries;
            }
        }
        Ok(())
    }
}

pub(super) fn service_background_operation(
    supervisor: &std::sync::Weak<super::SupervisorInner>,
    incarnation: u64,
    operation: ExtensionClientOperation,
    handler: impl FnOnce(ExtensionClientOperation) -> Result<ExtensionClientResult, HostFailure>,
) -> Result<ExtensionClientResult, HostFailure> {
    let retired = || HostFailure {
        code: HostErrorCode::Cancelled,
        message: "extension supervisor retired".into(),
    };
    let inner = supervisor.upgrade().ok_or_else(retired)?;
    let update = inner
        .prepare_client_operation(incarnation, &operation)
        .map_err(|_| retired())??;
    // A call waiting on editor IO cannot retain the owner that must cancel and join that call.
    drop(inner);
    let outcome = handler(operation);
    if let Some(inner) = supervisor.upgrade() {
        inner
            .acknowledge_client_operation(incarnation, update, &outcome)
            .map_err(|_| retired())?;
    }
    outcome
}
