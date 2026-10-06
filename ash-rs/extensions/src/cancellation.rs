use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use crate::CancelReason;
use crate::ExtensionError;
use crate::HostErrorCode;

/// Cooperative cancellation and the host's absolute deadline for one invocation.
///
/// Waiting callbacks remain cancellable while the SDK's input loop handles host control requests.
/// This token never claims that a side effect has been undone; a callback decides its terminal outcome.
#[derive(Clone)]
pub struct CancellationToken {
    pub(crate) context: extension_protocol::RequestContext,
    state: Arc<State>,
    deadline: SystemTime,
}

struct State {
    reason: Mutex<Option<CancelReason>>,
    changed: Condvar,
}

impl CancellationToken {
    pub(crate) fn new(
        deadline_unix_millis: u64,
        context: extension_protocol::RequestContext,
    ) -> Self {
        Self {
            context,
            state: Arc::new(State {
                reason: Mutex::new(None),
                changed: Condvar::new(),
            }),
            deadline: UNIX_EPOCH + Duration::from_millis(deadline_unix_millis),
        }
    }

    pub fn is_cancellation_requested(&self) -> bool {
        self.reason().is_some()
    }

    pub fn check_cancelled(&self) -> Result<(), ExtensionError> {
        match self.reason() {
            Some(CancelReason::Deadline) => Err(ExtensionError::new(
                HostErrorCode::DeadlineExceeded,
                "invocation deadline exceeded",
            )),
            Some(
                CancelReason::Caller | CancelReason::AuthorityRevoked | CancelReason::Shutdown,
            ) => Err(ExtensionError::new(
                HostErrorCode::Cancelled,
                "invocation cancelled",
            )),
            None => Ok(()),
        }
    }

    /// Waits for caller cancellation or the host deadline, then returns its typed error.
    pub fn wait_for_cancellation(&self) -> ExtensionError {
        let mut reason = self
            .state
            .reason
            .lock()
            .expect("cancellation state is not poisoned");
        while reason.is_none() {
            let Ok(remaining) = self.deadline.duration_since(SystemTime::now()) else {
                *reason = Some(CancelReason::Deadline);
                break;
            };
            reason = self
                .state
                .changed
                .wait_timeout(reason, remaining)
                .expect("cancellation state is not poisoned")
                .0;
        }
        drop(reason);
        self.check_cancelled()
            .expect_err("waiting ends only on cancellation or deadline")
    }

    pub(crate) fn cancel(&self, reason: CancelReason) {
        let mut current = self
            .state
            .reason
            .lock()
            .expect("cancellation state is not poisoned");
        if current.is_none() {
            *current = Some(reason);
        }
        self.state.changed.notify_all();
    }

    fn reason(&self) -> Option<CancelReason> {
        let reason = *self
            .state
            .reason
            .lock()
            .expect("cancellation state is not poisoned");
        reason.or_else(|| (SystemTime::now() >= self.deadline).then_some(CancelReason::Deadline))
    }
}
