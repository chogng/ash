use super::request_dispatch::OutgoingMessage;
use ash_app_server_transport::DEFAULT_MAX_MESSAGE_BYTES;
use std::io;
use std::io::Write;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::mpsc;

const CONTROL_BYTES: usize = 16 * 1024 * 1024;

pub(super) fn serialized_value_bytes(value: &serde_json::Value) -> usize {
    struct Counter(usize);
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value).expect("JSON value serializes");
    counter.0
}

#[derive(Debug)]
struct BudgetState {
    used: usize,
    closed: bool,
}

#[derive(Debug)]
struct BudgetInner {
    limit: usize,
    state: Mutex<BudgetState>,
    changed: Condvar,
}

/// Counts retained wire bytes across queues and their active consumers. A lease follows the
/// message until execution or writing finishes; moving between owners does not charge twice.
#[derive(Clone, Debug)]
pub(crate) struct MessageBudget(Arc<BudgetInner>);

#[derive(Debug)]
pub(crate) struct MessageBytes {
    budget: MessageBudget,
    bytes: usize,
}

impl Drop for MessageBytes {
    fn drop(&mut self) {
        let mut state = self.budget.0.state.lock().unwrap();
        state.used -= self.bytes;
        self.budget.0.changed.notify_all();
    }
}

impl MessageBudget {
    pub(crate) fn new(limit: usize) -> Self {
        Self(Arc::new(BudgetInner {
            limit,
            state: Mutex::new(BudgetState {
                used: 0,
                closed: false,
            }),
            changed: Condvar::new(),
        }))
    }

    pub(crate) fn try_reserve(&self, bytes: usize) -> Option<MessageBytes> {
        let mut state = self.0.state.lock().unwrap();
        if state.closed || bytes > self.0.limit - state.used {
            return None;
        }
        state.used += bytes;
        Some(MessageBytes {
            budget: self.clone(),
            bytes,
        })
    }

    fn reserve(&self, bytes: usize) -> io::Result<MessageBytes> {
        if bytes > self.0.limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Message exceeds outbound byte capacity",
            ));
        }
        let mut state = self.0.state.lock().unwrap();
        while !state.closed && bytes > self.0.limit - state.used {
            state = self.0.changed.wait(state).unwrap();
        }
        if state.closed {
            return Err(io::Error::from(io::ErrorKind::BrokenPipe));
        }
        state.used += bytes;
        Ok(MessageBytes {
            budget: self.clone(),
            bytes,
        })
    }

    fn close(&self) {
        self.0.state.lock().unwrap().closed = true;
        self.0.changed.notify_all();
    }
}

#[derive(Clone)]
pub(crate) struct InputBudgets {
    pub(crate) ordinary: MessageBudget,
    pub(crate) control: MessageBudget,
    pub(crate) host_replies: MessageBudget,
}

impl Default for InputBudgets {
    fn default() -> Self {
        Self {
            ordinary: MessageBudget::new(DEFAULT_MAX_MESSAGE_BYTES),
            control: MessageBudget::new(CONTROL_BYTES),
            host_replies: MessageBudget::new(DEFAULT_MAX_MESSAGE_BYTES),
        }
    }
}

#[derive(Clone)]
pub(crate) struct OutboundSender {
    sender: mpsc::SyncSender<OutgoingMessage>,
    budget: MessageBudget,
}

pub(crate) struct OutboundReceiver {
    receiver: mpsc::Receiver<OutgoingMessage>,
    budget: MessageBudget,
}

/// All outputs for one connection share a byte ceiling, including the frame being written.
/// Preserve the largest valid editor frame; several large frames must wait for the writer.
pub(crate) fn outbound_queue(capacity: usize) -> (OutboundSender, OutboundReceiver) {
    let budget = MessageBudget::new(DEFAULT_MAX_MESSAGE_BYTES);
    let (sender, receiver) = mpsc::sync_channel(capacity);
    (
        OutboundSender {
            sender,
            budget: budget.clone(),
        },
        OutboundReceiver { receiver, budget },
    )
}

impl OutboundSender {
    pub(crate) fn send(&self, mut message: OutgoingMessage) -> io::Result<()> {
        message.bytes = Some(self.budget.reserve(message.raw.len())?);
        self.sender
            .send(message)
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))
    }
}

impl OutboundReceiver {
    pub(crate) fn recv(&self) -> Result<OutgoingMessage, mpsc::RecvError> {
        self.receiver.recv()
    }
    pub(crate) fn recv_timeout(
        &self,
        timeout: std::time::Duration,
    ) -> Result<OutgoingMessage, mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(timeout)
    }
}

impl Drop for OutboundReceiver {
    fn drop(&mut self) {
        // A failed socket writer must wake producers waiting for bytes before its owner joins.
        self.budget.close();
    }
}

#[cfg(test)]
#[path = "message_queue_tests.rs"]
mod tests;
