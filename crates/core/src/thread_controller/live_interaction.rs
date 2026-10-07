use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;

use ash_async_utils::CancellationToken;
use ash_protocol::AgentResponse;
use ash_protocol::InteractionCancelReason;
use ash_protocol::RequestId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;

use crate::CoreError;

const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct LiveInteractionKey {
    pub(crate) thread_id: ThreadId,
    pub(crate) turn_id: TurnId,
    pub(crate) request_id: RequestId,
}

pub(crate) enum LiveInteractionOutcome {
    Response(AgentResponse),
    Cancelled(InteractionCancelReason),
}

#[derive(Clone, Default)]
pub(crate) struct LiveInteractionWaiters {
    senders: Arc<Mutex<BTreeMap<LiveInteractionKey, mpsc::Sender<LiveInteractionOutcome>>>>,
}

impl LiveInteractionWaiters {
    pub(crate) fn register(
        &self,
        key: LiveInteractionKey,
    ) -> Result<LiveInteractionWaiter, CoreError> {
        let (sender, receiver) = mpsc::channel();
        let previous = self
            .senders
            .lock()
            .map_err(|_| CoreError::Journal("live interaction lock poisoned".into()))?
            .insert(key.clone(), sender);
        if previous.is_some() {
            return Err(CoreError::Journal(
                "duplicate live interaction identity".into(),
            ));
        }
        Ok(LiveInteractionWaiter {
            key,
            waiters: self.clone(),
            receiver,
        })
    }

    pub(super) fn resolve(&self, key: &LiveInteractionKey, response: AgentResponse) -> bool {
        self.send(key, LiveInteractionOutcome::Response(response))
    }

    pub(super) fn cancel(&self, key: &LiveInteractionKey, reason: InteractionCancelReason) -> bool {
        self.send(key, LiveInteractionOutcome::Cancelled(reason))
    }

    pub(super) fn cancel_turn(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        reason: InteractionCancelReason,
    ) -> bool {
        let sender = self.senders.lock().ok().and_then(|mut senders| {
            let key = senders
                .keys()
                .find(|key| &key.thread_id == thread_id && &key.turn_id == turn_id)
                .cloned()?;
            senders.remove(&key)
        });
        sender.is_some_and(|sender| {
            sender
                .send(LiveInteractionOutcome::Cancelled(reason))
                .is_ok()
        })
    }

    fn send(&self, key: &LiveInteractionKey, outcome: LiveInteractionOutcome) -> bool {
        self.senders
            .lock()
            .ok()
            .and_then(|mut senders| senders.remove(key))
            .is_some_and(|sender| sender.send(outcome).is_ok())
    }

    fn unregister(&self, key: &LiveInteractionKey) {
        if let Ok(mut senders) = self.senders.lock() {
            senders.remove(key);
        }
    }
}

pub(crate) struct LiveInteractionWaiter {
    key: LiveInteractionKey,
    waiters: LiveInteractionWaiters,
    receiver: mpsc::Receiver<LiveInteractionOutcome>,
}

impl LiveInteractionWaiter {
    pub(crate) fn wait(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<LiveInteractionOutcome, CoreError> {
        loop {
            cancellation
                .check()
                .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
            match self.receiver.recv_timeout(CANCELLATION_POLL_INTERVAL) {
                Ok(outcome) => return Ok(outcome),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(CoreError::Execution(
                        "live Tool interaction stopped before resolution".into(),
                    ));
                }
            }
        }
    }
}

impl Drop for LiveInteractionWaiter {
    fn drop(&mut self) {
        self.waiters.unregister(&self.key);
    }
}
