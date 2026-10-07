use super::message_queue::MessageBudget;
use super::message_queue::MessageBytes;
use super::message_queue::serialized_value_bytes;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::marker::PhantomData;
use std::ops::Deref;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::Weak;

const MAX_NOTIFICATION_QUEUE_LEN: usize = 4_096;

thread_local! {
    // Only synchronous notifications caused by this request on its issuing connection are held.
    // Background producers and server requests must continue while the request is running.
    static DEFERRED: RefCell<Vec<DeferredNotifications>> = const { RefCell::new(Vec::new()) };
}

struct DeferredNotifications {
    owner: Arc<NotificationQueueInner>,
    state: NotificationQueueState,
}

pub(super) struct NotificationDeferral {
    queue: NotificationQueue,
    session_id: Option<String>,
    _thread: PhantomData<Rc<()>>,
}

impl Drop for NotificationDeferral {
    fn drop(&mut self) {
        let deferred = DEFERRED.with(|pending| {
            pending
                .borrow_mut()
                .pop()
                .expect("request notification scope exists")
        });
        assert!(
            Arc::ptr_eq(&self.queue.inner, &deferred.owner),
            "request notification scopes close in stack order"
        );
        self.queue.extend_queued(deferred.state.values);
        if deferred.state.closed {
            self.queue.close();
        }
        if let Some(session_id) = &self.session_id {
            self.queue.release_session_notifications(session_id);
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct NotificationQueue {
    inner: Arc<NotificationQueueInner>,
}

#[derive(Debug, Default)]
struct NotificationQueueInner {
    state: Mutex<NotificationQueueState>,
    changed: Condvar,
}

#[derive(Debug)]
struct NotificationQueueState {
    values: VecDeque<QueuedNotification>,
    budget: MessageBudget,
    closed: bool,
    sessions: BTreeMap<String, SessionNotifications>,
    initialized: bool,
}

impl Default for NotificationQueueState {
    fn default() -> Self {
        Self::new(MessageBudget::new(
            ash_app_server_transport::DEFAULT_MAX_MESSAGE_BYTES,
        ))
    }
}

#[derive(Debug)]
struct QueuedNotification {
    value: Value,
    _bytes: MessageBytes,
}

impl Deref for QueuedNotification {
    type Target = Value;
    fn deref(&self) -> &Value {
        &self.value
    }
}

impl NotificationQueueState {
    fn new(budget: MessageBudget) -> Self {
        Self {
            values: VecDeque::new(),
            budget,
            closed: false,
            sessions: BTreeMap::new(),
            initialized: true,
        }
    }
}

#[derive(Debug)]
struct SessionNotifications {
    active: usize,
    pending: NotificationQueueState,
}

impl NotificationQueueState {
    fn prune_transient(&mut self) {
        let resets = transcript_resets_for_dropped_notifications(&self.values);
        self.values
            .retain(|queued| !is_transient_notification(queued));
        for reset in resets {
            self.push_value(reset);
        }
    }

    fn push_value(&mut self, value: Value) {
        if self.closed {
            return;
        }
        if let Some(session_id) = value.pointer("/params/sessionId").and_then(Value::as_str)
            && value.get("id").is_none()
            && let Some(session) = self.sessions.get_mut(session_id)
        {
            session.pending.push_value(value);
            return;
        }
        let size = serialized_value_bytes(&value);
        let mut bytes = self.budget.try_reserve(size);
        if self.values.len() >= MAX_NOTIFICATION_QUEUE_LEN || bytes.is_none() {
            // Apply the existing transcript reset contract at both limits. Durable events and
            // host calls are never silently dropped when a peer falls behind.
            self.prune_transient();
            if bytes.is_none() {
                bytes = self.budget.try_reserve(size);
            }
        }
        let Some(bytes) = bytes else {
            self.closed = true;
            return;
        };
        self.extend([QueuedNotification {
            value,
            _bytes: bytes,
        }]);
    }

    fn extend(&mut self, values: impl IntoIterator<Item = QueuedNotification>) {
        for value in values {
            if self.closed {
                break;
            }
            if let Some(session_id) = value.pointer("/params/sessionId").and_then(Value::as_str)
                && value.get("id").is_none()
                && let Some(session) = self.sessions.get_mut(session_id)
            {
                session.pending.extend([value]);
                continue;
            }
            if self.values.len() >= MAX_NOTIFICATION_QUEUE_LEN {
                self.prune_transient();
            }
            if self.values.len() >= MAX_NOTIFICATION_QUEUE_LEN {
                self.closed = true;
                break;
            }
            self.values.push_back(value);
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct NotificationQueueHandle {
    inner: Weak<NotificationQueueInner>,
}

pub(crate) struct NotificationListener {
    queue: NotificationQueue,
}

impl NotificationQueue {
    pub(super) fn before_initialize() -> Self {
        Self {
            inner: Arc::new(NotificationQueueInner {
                state: Mutex::new(NotificationQueueState {
                    initialized: false,
                    ..NotificationQueueState::default()
                }),
                changed: Condvar::new(),
            }),
        }
    }

    pub(super) fn initialized(&self) {
        self.inner.state.lock().unwrap().initialized = true;
        self.inner.changed.notify_all();
    }

    pub(super) fn defer_causal_notifications(
        &self,
        session_id: Option<&str>,
    ) -> NotificationDeferral {
        let budget = {
            let mut state = self.inner.state.lock().unwrap();
            let budget = state.budget.clone();
            if let Some(session_id) = session_id {
                state
                    .sessions
                    .entry(session_id.to_owned())
                    .or_insert_with(|| SessionNotifications {
                        active: 0,
                        pending: NotificationQueueState::new(budget.clone()),
                    })
                    .active += 1;
            }
            budget
        };
        DEFERRED.with(|pending| {
            pending.borrow_mut().push(DeferredNotifications {
                owner: Arc::clone(&self.inner),
                state: NotificationQueueState::new(budget),
            })
        });
        NotificationDeferral {
            queue: self.clone(),
            session_id: session_id.map(str::to_owned),
            _thread: PhantomData,
        }
    }

    fn release_session_notifications(&self, session_id: &str) {
        let mut state = self.inner.state.lock().unwrap();
        let session = state
            .sessions
            .get_mut(session_id)
            .expect("request owns its Session notification scope");
        session.active -= 1;
        if session.active == 0 {
            let pending = state
                .sessions
                .remove(session_id)
                .expect("completed Session notification scope exists")
                .pending;
            state.extend(pending.values);
            state.closed |= pending.closed;
            self.inner.changed.notify_all();
        }
    }

    pub(super) fn downgrade(&self) -> NotificationQueueHandle {
        NotificationQueueHandle {
            inner: Arc::downgrade(&self.inner),
        }
    }

    pub(crate) fn listener(&self) -> NotificationListener {
        NotificationListener {
            queue: self.clone(),
        }
    }

    pub(crate) fn push(&self, value: Value) {
        self.extend([value]);
    }

    pub(crate) fn extend(&self, values: impl IntoIterator<Item = Value>) {
        let immediate = DEFERRED.with(|pending| {
            let mut pending = pending.borrow_mut();
            let deferred = pending
                .iter_mut()
                .rev()
                .find(|pending| Arc::ptr_eq(&pending.owner, &self.inner));
            let Some(deferred) = deferred else {
                return values.into_iter().collect::<Vec<_>>();
            };
            let mut immediate = Vec::new();
            for value in values {
                if value.get("id").is_some() {
                    immediate.push(value);
                } else {
                    deferred.state.push_value(value);
                }
            }
            immediate
        });
        if let Ok(mut state) = self.inner.state.lock() {
            let was_empty = state.values.is_empty();
            for value in immediate {
                state.push_value(value);
            }
            if (was_empty && !state.values.is_empty()) || state.closed {
                self.inner.changed.notify_all();
            }
        }
    }

    fn extend_queued(&self, values: impl IntoIterator<Item = QueuedNotification>) {
        let immediate = DEFERRED.with(|pending| {
            let mut pending = pending.borrow_mut();
            let deferred = pending
                .iter_mut()
                .rev()
                .find(|pending| Arc::ptr_eq(&pending.owner, &self.inner));
            let Some(deferred) = deferred else {
                return values.into_iter().collect::<Vec<_>>();
            };
            let mut immediate = Vec::new();
            for value in values {
                if value.get("id").is_some() {
                    immediate.push(value);
                } else {
                    deferred.state.extend([value]);
                }
            }
            immediate
        });
        let mut state = self.inner.state.lock().unwrap();
        state.extend(immediate);
        if !state.values.is_empty() || state.closed {
            self.inner.changed.notify_all();
        }
    }

    pub(crate) fn drain(&self) -> Vec<Value> {
        self.inner
            .state
            .lock()
            .map(|mut state| state.values.drain(..).map(|queued| queued.value).collect())
            .unwrap_or_default()
    }

    pub(crate) fn close(&self) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.closed = true;
            self.inner.changed.notify_all();
        }
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.inner
            .state
            .lock()
            .map(|state| state.values.len())
            .unwrap_or_default()
    }
}

impl NotificationQueueHandle {
    pub(super) fn upgrade(&self) -> Option<NotificationQueue> {
        self.inner
            .upgrade()
            .map(|inner| NotificationQueue { inner })
    }
}

impl NotificationListener {
    pub(crate) fn wait(&self) -> bool {
        let Ok(mut state) = self.queue.inner.state.lock() else {
            return false;
        };
        while (!state.initialized || state.values.is_empty()) && !state.closed {
            let Ok(next) = self.queue.inner.changed.wait(state) else {
                return false;
            };
            state = next;
        }
        state.initialized && !state.values.is_empty()
    }

    pub(crate) fn drain(&self) -> Vec<Value> {
        self.queue.drain()
    }

    pub(crate) fn close(&self) {
        self.queue.close();
    }
}

fn is_transient_notification(value: &Value) -> bool {
    let method = value.get("method").and_then(Value::as_str);
    method == Some("language/diagnostics")
        || method == Some("session/thread/transcript/update")
            && value.pointer("/params/streamCursor").is_some()
        || method == Some("session/thread/update")
            && value
                .pointer("/params/update/type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind != "committed")
}

fn transcript_resets_for_dropped_notifications(
    values: &VecDeque<QueuedNotification>,
) -> Vec<Value> {
    let mut scopes = BTreeMap::<(String, String), (u64, u64)>::new();
    for value in values {
        if value.get("method").and_then(Value::as_str) != Some("session/thread/transcript/update")
            || value.pointer("/params/streamCursor").is_none()
        {
            continue;
        }
        let Some(session_id) = value.pointer("/params/sessionId").and_then(Value::as_str) else {
            continue;
        };
        let Some(thread_id) = value.pointer("/params/threadId").and_then(Value::as_str) else {
            continue;
        };
        let durable_sequence = value
            .pointer("/params/durableSequence")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let revision = value
            .pointer("/params/revision")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        scopes
            .entry((session_id.to_owned(), thread_id.to_owned()))
            .and_modify(|watermark| {
                watermark.0 = watermark.0.max(durable_sequence);
                watermark.1 = watermark.1.max(revision);
            })
            .or_insert((durable_sequence, revision));
    }
    scopes
        .into_iter()
        .map(|((session_id, thread_id), (durable_sequence, revision))| {
            serde_json::json!({
                "jsonrpc": "2.0",
                "method": "session/thread/transcript/update",
                "params": {
                    "sessionId": session_id,
                    "threadId": thread_id,
                    "durableSequence": durable_sequence,
                    "revision": revision,
                    "changes": [{ "type": "clearTransient" }]
                }
            })
        })
        .collect()
}

#[cfg(test)]
#[path = "notification_queue_tests.rs"]
mod tests;
