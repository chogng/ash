use crate::MessageHistoryPage;
use crate::MessageHistoryQuery;
use crate::MessageHistoryStore;
use crate::MessageHistorySubmission;
use std::sync::Arc;
use std::sync::mpsc;
use std::thread;

enum Work {
    Append(MessageHistorySubmission, mpsc::Sender<Result<(), String>>),
    Read(
        MessageHistoryQuery,
        mpsc::Sender<Result<MessageHistoryPage, String>>,
    ),
    Clear(mpsc::Sender<Result<(), String>>),
}

struct Worker {
    sender: Option<mpsc::SyncSender<Work>>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// A bounded, ordered background connection to local input history. Dropping the last client
/// drains accepted writes before joining the worker; neither reads nor writes block a UI thread.
#[derive(Clone)]
pub struct MessageHistory {
    worker: Arc<Worker>,
}

impl std::fmt::Debug for MessageHistory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MessageHistory").finish_non_exhaustive()
    }
}

impl MessageHistory {
    pub fn new(store: Arc<dyn MessageHistoryStore>) -> std::io::Result<Self> {
        Self::with_waker(store, || {})
    }

    /// Wakes the product event loop after a result becomes available.
    pub fn with_waker(
        store: Arc<dyn MessageHistoryStore>,
        wake: impl Fn() + Send + 'static,
    ) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel(128);
        let thread = thread::Builder::new()
            .name("message-history".into())
            .spawn(move || {
                while let Ok(work) = receiver.recv() {
                    match work {
                        Work::Append(submission, reply) => {
                            let _ = reply.send(store.append(submission).map(|_| ()));
                        }
                        Work::Read(query, reply) => {
                            let _ = reply.send(store.read(&query));
                        }
                        Work::Clear(reply) => {
                            let _ = reply.send(store.clear());
                        }
                    }
                    wake();
                }
            })?;
        Ok(Self {
            worker: Arc::new(Worker {
                sender: Some(sender),
                thread: Some(thread),
            }),
        })
    }

    pub fn append(
        &self,
        submission: MessageHistorySubmission,
    ) -> Result<MessageHistoryTask<()>, String> {
        submission.validate()?;
        let (reply, receiver) = mpsc::channel();
        self.send(Work::Append(submission, reply))?;
        Ok(MessageHistoryTask {
            receiver: Some(receiver),
        })
    }

    pub fn read(
        &self,
        query: MessageHistoryQuery,
    ) -> Result<MessageHistoryTask<MessageHistoryPage>, String> {
        query.validate()?;
        let (reply, receiver) = mpsc::channel();
        self.send(Work::Read(query, reply))?;
        Ok(MessageHistoryTask {
            receiver: Some(receiver),
        })
    }

    pub fn clear(&self) -> Result<MessageHistoryTask<()>, String> {
        let (reply, receiver) = mpsc::channel();
        self.send(Work::Clear(reply))?;
        Ok(MessageHistoryTask {
            receiver: Some(receiver),
        })
    }

    fn send(&self, work: Work) -> Result<(), String> {
        self.worker
            .sender
            .as_ref()
            .expect("a live client owns its sender")
            .try_send(work)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => {
                    "Input history is busy; the request was not saved".into()
                }
                mpsc::TrySendError::Disconnected(_) => "Input history worker stopped".into(),
            })
    }
}

/// One nonblocking result. Dropping a read task discards its result without changing a newer UI
/// query. Accepted writes still finish when their result is no longer observed.
#[derive(Debug)]
pub struct MessageHistoryTask<T> {
    receiver: Option<mpsc::Receiver<Result<T, String>>>,
}

impl<T> MessageHistoryTask<T> {
    pub fn poll(&mut self) -> Option<Result<T, String>> {
        let receiver = self.receiver.take()?;
        match receiver.try_recv() {
            Ok(result) => Some(result),
            Err(mpsc::TryRecvError::Empty) => {
                self.receiver = Some(receiver);
                None
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                Some(Err("Input history worker stopped".into()))
            }
        }
    }
}
