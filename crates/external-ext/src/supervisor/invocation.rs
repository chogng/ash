use std::num::NonZeroU64;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use serde_json::Value;

use super::ExtensionHostSupervisor;
use super::require_success;
use crate::CancelParams;
use crate::CancelReason;
use crate::ExtensionHostError;
use crate::ExtensionHostProcess;
use crate::ExtensionHostRequest;
use crate::HostRequestKind;
use crate::HostSuccess;
use crate::InvokeParams;
use crate::InvokeResult;
use crate::PendingHostRequest;

const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// One brokered provider invocation. `deadline_unix_millis` is an absolute UTC deadline.
#[derive(Clone, Debug, PartialEq)]
pub struct ExtensionInvocation {
    pub registration_id: String,
    pub operation: String,
    pub payload: Value,
    pub deadline_unix_millis: NonZeroU64,
}

impl ExtensionHostSupervisor {
    pub fn begin_invoke(
        &self,
        invocation: ExtensionInvocation,
    ) -> Result<ExtensionInvocationHandle, ExtensionHostError> {
        self.begin_invoke_inner(None, invocation)
    }

    /// Starts an invocation only if the ready process still matches one advertised target.
    ///
    /// App Server uses this method to prevent a request fenced to an older snapshot from being
    /// silently replayed against a process recovered between snapshot validation and dispatch.
    pub fn begin_fenced_invoke(
        &self,
        target: ExtensionInvocationTarget,
        invocation: ExtensionInvocation,
    ) -> Result<ExtensionInvocationHandle, ExtensionHostError> {
        self.begin_invoke_inner(Some(target), invocation)
    }

    fn begin_invoke_inner(
        &self,
        target: Option<ExtensionInvocationTarget>,
        invocation: ExtensionInvocation,
    ) -> Result<ExtensionInvocationHandle, ExtensionHostError> {
        self.ensure_ready()?;
        let lease = self
            .inner
            .activation
            .acquire()
            .ok_or(ExtensionHostError::AuthorityDenied)?;
        let wait_timeout = invocation_wait_timeout(
            invocation.deadline_unix_millis,
            self.inner.limits.request_timeout,
        )?;
        let (process, incarnation, request_id, request) = {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| ExtensionHostError::HostExited)?;
            if state.status != super::ExtensionHostStatus::Ready
                || target.is_some_and(|target| {
                    target.incarnation.get() != state.incarnation
                        || target.activation_generation
                            != self.inner.activation.activation_generation()
                })
                || !state
                    .registrations
                    .iter()
                    .any(|item| item.registration_id == invocation.registration_id)
            {
                return Err(ExtensionHostError::RegistrationNotFound);
            }
            let process = state
                .process
                .clone()
                .ok_or(ExtensionHostError::HostExited)?;
            let incarnation = state.incarnation;
            let context = self.context(incarnation)?;
            let request_id = context.request_id;
            let request = ExtensionHostRequest {
                context,
                request: HostRequestKind::Invoke(InvokeParams {
                    extension_id: self.inner.activation.params().extension_id.clone(),
                    registration_id: invocation.registration_id,
                    operation: invocation.operation,
                    payload: invocation.payload,
                    deadline_unix_millis: invocation.deadline_unix_millis.get(),
                }),
            };
            state.invocation_leases.insert(request_id, lease);
            (process, incarnation, request_id, request)
        };
        let pending = match process.dispatch(request) {
            Ok(pending) => pending,
            Err(error) => {
                self.release_invocation(request_id);
                return Err(error);
            }
        };
        Ok(ExtensionInvocationHandle {
            client_cancellation: ash_async_utils::CancellationSource::new(),
            supervisor: self.clone(),
            process,
            incarnation,
            request_id: pending.request_id(),
            wait_timeout,
            pending: Mutex::new(Some(pending)),
            cancelled: AtomicBool::new(false),
            completed: AtomicBool::new(false),
        })
    }

    pub fn invoke(
        &self,
        invocation: ExtensionInvocation,
    ) -> Result<InvokeResult, ExtensionHostError> {
        self.begin_invoke(invocation)?.wait()
    }
}

/// Exact advertised process incarnation and activation generation required for one dispatch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExtensionInvocationTarget {
    pub incarnation: NonZeroU64,
    pub activation_generation: NonZeroU64,
}

/// In-flight invocation that can be cancelled from another thread while `wait` is blocked.
pub struct ExtensionInvocationHandle {
    client_cancellation: ash_async_utils::CancellationSource,
    supervisor: ExtensionHostSupervisor,
    process: Arc<dyn ExtensionHostProcess>,
    incarnation: u64,
    request_id: u64,
    wait_timeout: Duration,
    pending: Mutex<Option<PendingHostRequest>>,
    cancelled: AtomicBool,
    completed: AtomicBool,
}

impl ExtensionInvocationHandle {
    pub fn request_id(&self) -> u64 {
        self.request_id
    }

    pub fn cancel(&self, reason: CancelReason) -> Result<(), ExtensionHostError> {
        self.client_cancellation.cancel();
        if self.cancelled.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let cancel = ExtensionHostRequest {
            context: self.supervisor.context(self.incarnation)?,
            request: HostRequestKind::Cancel(CancelParams {
                target_request_id: self.request_id,
                reason,
            }),
        };
        self.process.dispatch(cancel).map(|_| ())
    }

    pub fn wait(&self) -> Result<InvokeResult, ExtensionHostError> {
        self.wait_with_client(|_, _, _| {
            Err(crate::HostFailure {
                code: crate::HostErrorCode::OperationNotSupported,
                message: "this caller does not provide editor services".into(),
            })
        })
    }

    /// Services child calls on the initiating owner's thread, within the parent deadline.
    /// The handler must observe both cancellation and the supplied remaining duration.
    pub fn wait_with_client(
        &self,
        mut handler: impl FnMut(
            external_ext_protocol::ExtensionClientOperation,
            &ash_async_utils::CancellationToken,
            Duration,
        ) -> Result<
            external_ext_protocol::ExtensionClientResult,
            crate::HostFailure,
        >,
    ) -> Result<InvokeResult, ExtensionHostError> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?
            .take()
            .ok_or(ExtensionHostError::HostExited)?;
        let started = Instant::now();
        let response = loop {
            let elapsed = started.elapsed();
            if elapsed >= self.wait_timeout || self.cancelled.load(Ordering::Acquire) {
                let reason = if self.cancelled.load(Ordering::Acquire) {
                    CancelReason::Caller
                } else {
                    CancelReason::Deadline
                };
                let _ = self.cancel(reason);
                let grace = Instant::now();
                // Drain already-sent child calls with cancellation, without executing them. Their
                // replies let the host release promises while a cooperative callback winds down.
                break loop {
                    let remaining = self
                        .supervisor
                        .inner
                        .limits
                        .cancellation_grace
                        .saturating_sub(grace.elapsed());
                    match pending.recv_next_timeout(remaining) {
                        Ok(Some(crate::process::PendingMessage::Response(response))) => {
                            break Ok(Some(response));
                        }
                        Ok(Some(crate::process::PendingMessage::ClientRequest(request))) => {
                            if let Err(error) = self.process.respond_client(
                                external_ext_protocol::ExtensionClientResponse {
                                    context: request.context,
                                    call_id: request.call_id,
                                    outcome: Err(crate::HostFailure {
                                        code: crate::HostErrorCode::Cancelled,
                                        message: "parent invocation cancelled".into(),
                                    }),
                                },
                            ) {
                                break Err(error);
                            }
                        }
                        Ok(None) => break Ok(None),
                        Err(error) => break Err(error),
                    }
                    if grace.elapsed() >= self.supervisor.inner.limits.cancellation_grace {
                        break Ok(None);
                    }
                };
            }
            let poll = WAIT_POLL_INTERVAL.min(self.wait_timeout.saturating_sub(elapsed));
            match pending.recv_next_timeout(poll) {
                Ok(Some(crate::process::PendingMessage::Response(response))) => {
                    break Ok(Some(response));
                }
                Ok(Some(crate::process::PendingMessage::ClientRequest(request))) => {
                    let outcome = self.supervisor.inner.service_client_operation(
                        self.incarnation,
                        request.operation,
                        |operation| {
                            handler(
                                operation,
                                &self.client_cancellation.token(),
                                self.wait_timeout.saturating_sub(started.elapsed()),
                            )
                        },
                    )?;
                    if let Err(error) = self.process.respond_client(
                        external_ext_protocol::ExtensionClientResponse {
                            context: request.context,
                            call_id: request.call_id,
                            outcome,
                        },
                    ) {
                        break Err(error);
                    }
                }
                Ok(None) => {}
                Err(error) => break Err(error),
            }
        };
        let result = match response {
            Ok(Some(response)) => require_success(Some(response), |success| {
                matches!(success, HostSuccess::Invoked(_))
            })
            .and_then(|success| match success {
                HostSuccess::Invoked(result) => Ok(result),
                _ => unreachable!(),
            }),
            Ok(None) => Err(ExtensionHostError::OutcomeIndeterminate),
            Err(error) => Err(error),
        };
        let requires_recovery = matches!(
            result,
            Err(ExtensionHostError::OutcomeIndeterminate)
                | Err(ExtensionHostError::HostExited)
                | Err(ExtensionHostError::InvalidProtocol(_))
        );
        if requires_recovery {
            let _ = self.process.terminate();
        }
        self.client_cancellation.cancel();
        self.release_lease();
        self.completed.store(true, Ordering::Release);
        if requires_recovery {
            let _ = self.supervisor.recover_failed_incarnation(self.incarnation);
        }
        result
    }

    fn release_lease(&self) {
        self.supervisor.release_invocation(self.request_id);
    }
}

impl Drop for ExtensionInvocationHandle {
    fn drop(&mut self) {
        if !self.completed.load(Ordering::Acquire) {
            let _ = self.cancel(CancelReason::Caller);
            let _ = self.process.terminate();
            self.release_lease();
        }
    }
}

fn invocation_wait_timeout(
    deadline: NonZeroU64,
    maximum: Duration,
) -> Result<Duration, ExtensionHostError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ExtensionHostError::RequestTimedOut)?;
    let deadline = Duration::from_millis(deadline.get());
    if deadline <= now {
        return Err(ExtensionHostError::RequestTimedOut);
    }
    Ok(deadline.saturating_sub(now).min(maximum))
}
