use crate::server::notification_queue::NotificationQueue;
use crate::server::notification_queue::NotificationQueueHandle;
use ash_app_server_protocol::protocol::account::AccountLoginCompleted;
use ash_app_server_protocol::protocol::account::AccountUpdated;
use ash_app_server_protocol::protocol::collaboration::DocumentCollaborationPresenceSnapshot;
use ash_app_server_protocol::protocol::collaboration::DocumentCollaborationUpdate;
use ash_app_server_protocol::protocol::common::AgentInteractionCapability;
use ash_app_server_protocol::protocol::common::EmptyParams;
use ash_app_server_protocol::protocol::config::ConfigChanged;
use ash_app_server_protocol::protocol::connectors::ConnectorsChanged;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostChanged;
use ash_app_server_protocol::protocol::extension_packages::ExtensionsChanged;
use ash_app_server_protocol::protocol::fs::FsChanged;
use ash_app_server_protocol::protocol::git::GitIgnoreChanged;
use ash_app_server_protocol::protocol::git::GitStatusChanged;
use ash_app_server_protocol::protocol::git::GitStatusResult;
use ash_app_server_protocol::protocol::goal::ThreadGoalClearedNotification;
use ash_app_server_protocol::protocol::goal::ThreadGoalUpdatedNotification;
use ash_app_server_protocol::protocol::language::LanguageDiagnosticsNotification;
use ash_app_server_protocol::protocol::language::LanguageServerMessageNotification;
use ash_app_server_protocol::protocol::language::LanguageServerProgressNotification;
use ash_app_server_protocol::protocol::language::LanguageServerStateNotification;
use ash_app_server_protocol::protocol::memory::MemoryChanged;
use ash_app_server_protocol::protocol::plugins::PluginsChanged;
use ash_app_server_protocol::protocol::projects::ProjectChanged;
use ash_app_server_protocol::protocol::provider::ProviderModelsUpdated;
use ash_app_server_protocol::protocol::registry::ServerNotificationMethod;
use ash_app_server_protocol::protocol::session::SessionChanged;
use ash_app_server_protocol::protocol::session::SessionDeleted;
use ash_app_server_protocol::protocol::skills::SkillsChanged;
use ash_app_server_protocol::protocol::turn_changes::TurnChangesChanged;
use ash_app_server_protocol::rpc::JsonRpcNotification;
use ash_config::ConfigChange;
use ash_protocol::AgentRequestEnvelope;
use ash_protocol::HookEvent;
use ash_protocol::RequestId;
use ash_protocol::SessionId;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::ThreadUpdate;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::TurnId;
use ash_thread_transcript::ThreadTranscriptChange;
use ash_thread_transcript::ThreadTranscriptEntry;
use ash_thread_transcript::ThreadTranscriptUpdateEnvelope;
use ash_thread_transcript::TranscriptAccumulator;
use ash_thread_transcript::TranscriptApplyResult;
use core_api::HookEventRequest;
use core_api::HookEventScope;
use core_api::HookService;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc;

pub(super) fn unix_time_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

pub(crate) struct UpdateBroker {
    hooks: Arc<RwLock<Option<Arc<dyn HookService>>>>,
    hook_events: Arc<Mutex<Option<mpsc::SyncSender<HookEventRequest>>>>,
    state: Arc<Mutex<BrokerState>>,
    transcripts: Arc<Mutex<BTreeMap<(SessionId, ThreadId), TranscriptAccumulator>>>,
    next_connection_id: Arc<AtomicU64>,
    next_scope_id: Arc<AtomicU64>,
    extension_packages_instance_id: Arc<str>,
    extension_packages_generation: Arc<AtomicU64>,
    extension_packages_change_gate: Arc<Mutex<()>>,
    extension_packages_source_generations: Arc<Mutex<BTreeMap<String, u64>>>,
    scope_id: u64,
}

#[derive(Default)]
struct BrokerState {
    subscribers: BTreeMap<u64, Subscriber>,
    session_scopes: BTreeMap<SessionId, u64>,
    interaction_assignments: BTreeMap<RequestId, u64>,
    pending_interactions: BTreeMap<RequestId, AgentRequestEnvelope>,
    interaction_versions: BTreeMap<(ThreadId, TurnId), InteractionDeliveryVersion>,
    next_subscription_ticket: u64,
    // Login IDs belong to a directory service; connections are profile-wide.
    login_owners: BTreeMap<(u64, String), u64>,
}

struct InteractionDeliveryVersion {
    session_id: SessionId,
    sequence: u64,
    status: InteractionDeliveryStatus,
}

#[derive(Clone, Eq, PartialEq)]
enum InteractionDeliveryStatus {
    Pending(RequestId),
    Retired(RequestId),
    TurnEnded,
}

impl InteractionDeliveryStatus {
    fn matches_request(&self, id: &RequestId) -> bool {
        match self {
            Self::Pending(request_id) | Self::Retired(request_id) => request_id == id,
            Self::TurnEnded => false,
        }
    }
}

struct Subscriber {
    queue: NotificationQueueHandle,
    scope_id: u64,
    agent_interactions: Option<AgentInteractionCapability>,
    product_host: bool,
    collaboration_rooms: BTreeSet<String>,
    catalog: bool,
    sessions: BTreeSet<SessionId>,
    threads: BTreeMap<ThreadId, ThreadSubscription>,
}

#[derive(Default)]
struct ThreadSubscription {
    sequence: u64,
    session_owners: BTreeSet<SessionId>,
    pending: BTreeMap<u64, PendingSubscription>,
}

struct PendingSubscription {
    session_id: SessionId,
    delivery: SubscriptionDelivery,
}

enum SubscriptionDelivery {
    Active,
    Buffered(NotificationQueue),
}

pub(super) struct ThreadSubscriptionRegistration {
    state: Arc<Mutex<BrokerState>>,
    connection_id: u64,
    thread_id: ThreadId,
    ticket: u64,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum ThreadSubscriptionScope {
    Thread,
    Session,
}

impl Drop for ThreadSubscriptionRegistration {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock()
            && let Some(subscriber) = state.subscribers.get_mut(&self.connection_id)
            && let Some(subscription) = subscriber.threads.get_mut(&self.thread_id)
        {
            subscription.pending.remove(&self.ticket);
            if subscription.session_owners.is_empty() && subscription.pending.is_empty() {
                subscriber.threads.remove(&self.thread_id);
            }
        }
    }
}

impl ThreadSubscription {
    fn publish(&self, session_id: &SessionId, value: Value, queue: &NotificationQueue) {
        if self.session_owners.contains(session_id) {
            queue.push(value.clone());
        }
        for pending in self.pending.values() {
            if &pending.session_id == session_id
                && let SubscriptionDelivery::Buffered(buffer) = &pending.delivery
            {
                buffer.push(value.clone());
            }
        }
    }
}

impl Default for UpdateBroker {
    fn default() -> Self {
        Self {
            hooks: Arc::new(RwLock::new(None)),
            hook_events: Arc::new(Mutex::new(None)),
            state: Arc::new(Mutex::new(BrokerState::default())),
            transcripts: Arc::new(Mutex::new(BTreeMap::new())),
            next_connection_id: Arc::new(AtomicU64::new(1)),
            next_scope_id: Arc::new(AtomicU64::new(2)),
            extension_packages_instance_id: Arc::from(new_extension_packages_instance_id()),
            extension_packages_generation: Arc::new(AtomicU64::new(1)),
            extension_packages_change_gate: Arc::new(Mutex::new(())),
            extension_packages_source_generations: Arc::new(Mutex::new(BTreeMap::new())),
            scope_id: 1,
        }
    }
}

impl UpdateBroker {
    pub(super) fn publish_dictation_model_changed(&self, model_id: String) {
        let params =
            ash_app_server_protocol::protocol::dictation::DictationModelChanged { model_id };
        let mut state = self.state.lock().expect("update broker state");
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if subscriber.product_host {
                queue.push(notification(
                    ServerNotificationMethod::DictationModelChanged,
                    &params,
                ));
            }
            true
        });
    }
    pub(super) fn bind_hooks(&self, hooks: Arc<dyn HookService>) {
        *self
            .hooks
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(hooks);
    }

    fn emit_ui_event(&self, request: HookEventRequest) {
        enqueue_hook_event(&self.hooks, &self.hook_events, request);
    }

    pub(crate) fn fork_scope(&self) -> Self {
        Self {
            hooks: Arc::clone(&self.hooks),
            hook_events: Arc::clone(&self.hook_events),
            state: Arc::clone(&self.state),
            transcripts: Arc::clone(&self.transcripts),
            next_connection_id: Arc::clone(&self.next_connection_id),
            next_scope_id: Arc::clone(&self.next_scope_id),
            extension_packages_instance_id: Arc::clone(&self.extension_packages_instance_id),
            extension_packages_generation: Arc::clone(&self.extension_packages_generation),
            extension_packages_change_gate: Arc::clone(&self.extension_packages_change_gate),
            extension_packages_source_generations: Arc::clone(
                &self.extension_packages_source_generations,
            ),
            scope_id: self.next_scope_id.fetch_add(1, Ordering::Relaxed),
        }
    }

    pub(super) fn allocate_connection_id(&self) -> u64 {
        self.next_connection_id.fetch_add(1, Ordering::Relaxed)
    }

    pub(super) fn publish_account_login_completed(&self, completed: AccountLoginCompleted) {
        let mut state = self.state.lock().expect("update broker state");
        if let Some(owner) = state
            .login_owners
            .remove(&(self.scope_id, completed.login_id.clone()))
            && let Some(queue) = state
                .subscribers
                .get(&owner)
                .and_then(|subscriber| subscriber.queue.upgrade())
        {
            queue.push(notification(
                ServerNotificationMethod::AccountLoginCompleted,
                &completed,
            ));
        }
    }

    pub(super) fn register_login_owner(&self, login_id: &str, connection_id: u64) {
        self.state
            .lock()
            .expect("update broker state")
            .login_owners
            .insert((self.scope_id, login_id.to_owned()), connection_id);
    }

    pub(super) fn owns_login(&self, login_id: &str, connection_id: u64) -> bool {
        self.state
            .lock()
            .expect("update broker state")
            .login_owners
            .get(&(self.scope_id, login_id.to_owned()))
            == Some(&connection_id)
    }

    pub(super) fn forget_login_owner(&self, login_id: &str) {
        self.state
            .lock()
            .expect("update broker state")
            .login_owners
            .remove(&(self.scope_id, login_id.to_owned()));
    }

    pub(super) fn take_connection_logins(&self, connection_id: u64) -> Vec<String> {
        let mut state = self.state.lock().expect("update broker state");
        let logins = state
            .login_owners
            .iter()
            .filter_map(|((scope, login), owner)| {
                (*scope == self.scope_id && *owner == connection_id).then_some(login.clone())
            })
            .collect::<Vec<_>>();
        for login in &logins {
            state.login_owners.remove(&(self.scope_id, login.clone()));
        }
        logins
    }

    pub(super) fn publish_account_updated(&self, updated: AccountUpdated) {
        self.broadcast_notification(ServerNotificationMethod::AccountUpdated, &updated);
    }

    pub(super) fn publish_provider_models_updated(&self, updated: ProviderModelsUpdated) {
        self.broadcast_notification(ServerNotificationMethod::ProviderModelsUpdated, &updated);
    }

    pub(super) fn publish_provider_api_key_changed(
        &self,
        changed: ash_app_server_protocol::protocol::provider::ProviderApiKeySetResult,
    ) {
        self.broadcast_notification(ServerNotificationMethod::ProviderApiKeyChanged, &changed);
    }

    pub(super) fn register(
        &self,
        connection_id: u64,
        product_host: bool,
        queue: &NotificationQueue,
    ) {
        if let Ok(mut state) = self.state.lock() {
            state.subscribers.insert(
                connection_id,
                Subscriber {
                    queue: queue.downgrade(),
                    scope_id: self.scope_id,
                    agent_interactions: None,
                    product_host,
                    collaboration_rooms: BTreeSet::new(),
                    catalog: false,
                    sessions: BTreeSet::new(),
                    threads: BTreeMap::new(),
                },
            );
        }
    }

    pub(super) fn unregister(&self, connection_id: u64) -> Vec<AgentRequestEnvelope> {
        if let Ok(mut state) = self.state.lock() {
            let lost = take_owned_dynamic_interactions(&mut state, connection_id, |_| true);
            state.subscribers.remove(&connection_id);
            state
                .interaction_assignments
                .retain(|_, owner| *owner != connection_id);
            reconcile_interaction_assignments(&mut state, &self.hooks, &self.hook_events);
            return lost;
        }
        Vec::new()
    }

    pub(super) fn set_agent_interaction_capability(
        &self,
        connection_id: u64,
        capability: Option<AgentInteractionCapability>,
    ) {
        if let Ok(mut state) = self.state.lock()
            && let Some(subscriber) = state.subscribers.get_mut(&connection_id)
        {
            subscriber.agent_interactions = capability;
            reconcile_interaction_assignments(&mut state, &self.hooks, &self.hook_events);
        }
    }

    pub(super) fn offer_agent_request(&self, request: AgentRequestEnvelope, sequence: u64) {
        if let Ok(mut state) = self.state.lock() {
            if !record_interaction_version(
                &mut state,
                &request.session_id,
                &request.thread_id,
                &request.turn_id,
                sequence,
                InteractionDeliveryStatus::Pending(request.interaction.request_id.clone()),
            ) {
                return;
            }
            state
                .pending_interactions
                .insert(request.interaction.request_id.clone(), request);
            reconcile_interaction_assignments(&mut state, &self.hooks, &self.hook_events);
        }
    }

    pub(super) fn is_agent_interaction_owner(
        &self,
        connection_id: u64,
        request_id: &RequestId,
    ) -> bool {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.interaction_assignments.get(request_id).copied())
            == Some(connection_id)
    }

    pub(super) fn is_agent_interaction_expired(
        &self,
        request_id: &RequestId,
        now_unix_ms: u64,
    ) -> bool {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.pending_interactions.get(request_id).cloned())
            .and_then(|request| request.interaction.deadline)
            .is_some_and(|deadline| deadline.expires_at_unix_ms <= now_unix_ms)
    }

    pub(super) fn expired_agent_requests(&self, now_unix_ms: u64) -> Vec<AgentRequestEnvelope> {
        self.state
            .lock()
            .map(|state| {
                state
                    .pending_interactions
                    .values()
                    .filter(|request| {
                        request
                            .interaction
                            .deadline
                            .is_some_and(|deadline| deadline.expires_at_unix_ms <= now_unix_ms)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(super) fn retire_agent_request(&self, request_id: &RequestId) {
        if let Ok(mut state) = self.state.lock() {
            retire_interaction_delivery(&mut state, request_id);
        }
    }

    pub(super) fn subscribe_catalog(&self, connection_id: u64) {
        if let Ok(mut state) = self.state.lock()
            && let Some(subscriber) = state.subscribers.get_mut(&connection_id)
        {
            subscriber.catalog = true;
        }
    }

    pub(super) fn unsubscribe_catalog(&self, connection_id: u64) {
        if let Ok(mut state) = self.state.lock()
            && let Some(subscriber) = state.subscribers.get_mut(&connection_id)
        {
            subscriber.catalog = false;
        }
    }

    pub(super) fn subscribe_session(&self, connection_id: u64, session_id: SessionId) {
        if let Ok(mut state) = self.state.lock()
            && let Some(subscriber) = state.subscribers.get_mut(&connection_id)
        {
            subscriber.sessions.insert(session_id);
            reconcile_interaction_assignments(&mut state, &self.hooks, &self.hook_events);
        }
    }

    pub(super) fn bind_session_scope(&self, session_id: SessionId) {
        if let Ok(mut state) = self.state.lock() {
            state.session_scopes.insert(session_id, self.scope_id);
            reconcile_interaction_assignments(&mut state, &self.hooks, &self.hook_events);
        }
    }

    pub(crate) fn publish_session_changed(&self, session_id: &SessionId) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if subscriber.catalog || subscriber_observes_session(subscriber, session_id) {
                queue.push(notification(
                    ServerNotificationMethod::SessionChanged,
                    &SessionChanged {
                        session_id: session_id.clone(),
                        agent_tree_changed: false,
                    },
                ));
            }
            true
        });
    }

    pub(super) fn publish_session_deleted(&self, session_id: &SessionId) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if subscriber.catalog || subscriber_observes_session(subscriber, session_id) {
                queue.push(notification(
                    ServerNotificationMethod::SessionDeleted,
                    &SessionDeleted {
                        session_id: session_id.clone(),
                    },
                ));
            }
            true
        });
    }

    pub(super) fn unsubscribe_session(
        &self,
        connection_id: u64,
        session_id: &SessionId,
    ) -> Vec<AgentRequestEnvelope> {
        if let Ok(mut state) = self.state.lock()
            && let Some(subscriber) = state.subscribers.get_mut(&connection_id)
        {
            subscriber.sessions.remove(session_id);
            subscriber.threads.retain(|_, subscription| {
                subscription.session_owners.remove(session_id);
                subscription
                    .pending
                    .retain(|_, pending| &pending.session_id != session_id);
                !subscription.session_owners.is_empty() || !subscription.pending.is_empty()
            });
            let lost = take_owned_dynamic_interactions(&mut state, connection_id, |request| {
                &request.session_id == session_id
            });
            reconcile_interaction_assignments(&mut state, &self.hooks, &self.hook_events);
            return lost;
        }
        Vec::new()
    }

    pub(super) fn forget_session(&self, session_id: &SessionId) {
        if let Ok(mut state) = self.state.lock() {
            state.session_scopes.remove(session_id);
            state
                .interaction_versions
                .retain(|_, version| &version.session_id != session_id);
            let request_ids = state
                .pending_interactions
                .iter()
                .filter(|(_, request)| &request.session_id == session_id)
                .map(|(request_id, _)| request_id.clone())
                .collect::<Vec<_>>();
            for request_id in request_ids {
                state.pending_interactions.remove(&request_id);
                state.interaction_assignments.remove(&request_id);
            }
            for subscriber in state.subscribers.values_mut() {
                subscriber.sessions.remove(session_id);
                subscriber.threads.retain(|_, subscription| {
                    subscription.session_owners.remove(session_id);
                    subscription
                        .pending
                        .retain(|_, pending| &pending.session_id != session_id);
                    !subscription.session_owners.is_empty() || !subscription.pending.is_empty()
                });
            }
            reconcile_interaction_assignments(&mut state, &self.hooks, &self.hook_events);
        }
        if let Ok(mut transcripts) = self.transcripts.lock() {
            transcripts.retain(|(transcript_session_id, _), _| transcript_session_id != session_id);
        }
    }

    pub(super) fn subscribe_document_collaboration(&self, connection_id: u64, room_id: String) {
        if let Ok(mut state) = self.state.lock()
            && let Some(subscriber) = state.subscribers.get_mut(&connection_id)
        {
            subscriber.collaboration_rooms.insert(room_id);
        }
    }

    pub(super) fn publish_document_collaboration(&self, update: DocumentCollaborationUpdate) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if subscriber.scope_id == self.scope_id
                && subscriber.collaboration_rooms.contains(&update.room_id)
            {
                queue.push(notification(
                    ServerNotificationMethod::DocumentCollaborationUpdate,
                    &update,
                ));
            }
            true
        });
    }

    pub(super) fn publish_document_collaboration_presence(
        &self,
        snapshot: DocumentCollaborationPresenceSnapshot,
    ) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if subscriber.scope_id == self.scope_id
                && subscriber.collaboration_rooms.contains(&snapshot.room_id)
            {
                queue.push(notification(
                    ServerNotificationMethod::DocumentCollaborationPresence,
                    &snapshot,
                ));
            }
            true
        });
    }

    pub(super) fn subscribe_session_thread(
        &self,
        connection_id: u64,
        session_id: SessionId,
        thread_id: ThreadId,
        sequence: u64,
    ) -> bool {
        if let Ok(mut state) = self.state.lock()
            && let Some(subscriber) = state.subscribers.get_mut(&connection_id)
        {
            let subscription = subscriber.threads.entry(thread_id).or_default();
            subscription.sequence = subscription.sequence.max(sequence);
            let inserted = subscription.session_owners.insert(session_id);
            reconcile_interaction_assignments(&mut state, &self.hooks, &self.hook_events);
            return inserted;
        }
        false
    }

    pub(super) fn begin_session_thread_subscription(
        &self,
        connection_id: u64,
        session_id: SessionId,
        thread_id: ThreadId,
    ) -> Option<ThreadSubscriptionRegistration> {
        let mut state = self.state.lock().ok()?;
        let ticket = state.next_subscription_ticket;
        state.next_subscription_ticket = ticket.checked_add(1)?;
        let subscriber = state.subscribers.get_mut(&connection_id)?;
        let queue = subscriber.queue.upgrade()?;
        let subscription = subscriber.threads.entry(thread_id.clone()).or_default();
        let delivery = if subscription.session_owners.contains(&session_id) {
            SubscriptionDelivery::Active
        } else {
            SubscriptionDelivery::Buffered(queue.buffer())
        };
        subscription.pending.insert(
            ticket,
            PendingSubscription {
                session_id,
                delivery,
            },
        );
        Some(ThreadSubscriptionRegistration {
            state: Arc::clone(&self.state),
            connection_id,
            thread_id,
            ticket,
        })
    }

    pub(super) fn commit_session_thread_subscription(
        &self,
        registration: ThreadSubscriptionRegistration,
        sequence: u64,
        transcript_revision: u64,
        scope: ThreadSubscriptionScope,
    ) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let Some(subscriber) = state.subscribers.get_mut(&registration.connection_id) else {
            return;
        };
        let Some(queue) = subscriber.queue.upgrade() else {
            return;
        };
        let Some(subscription) = subscriber.threads.get_mut(&registration.thread_id) else {
            return;
        };
        let Some(pending) = subscription.pending.remove(&registration.ticket) else {
            return;
        };
        if scope == ThreadSubscriptionScope::Session {
            subscriber.sessions.insert(pending.session_id.clone());
        }
        match pending.delivery {
            SubscriptionDelivery::Active => {
                if subscription.session_owners.contains(&pending.session_id) {
                    subscription.sequence = subscription.sequence.max(sequence);
                }
            }
            SubscriptionDelivery::Buffered(buffer) => {
                subscription.sequence = subscription.sequence.max(sequence);
                if subscription.session_owners.insert(pending.session_id) {
                    let mut delivered_sequence = sequence;
                    buffer.forward_to(&queue, |value| {
                        if value["method"] == "session/thread/transcript/update" {
                            return value["params"]["revision"]
                                .as_u64()
                                .is_some_and(|revision| revision > transcript_revision);
                        }
                        if value["params"]["update"]["type"] == "committed" {
                            let cursor = value["params"]["durableSequence"]
                                .as_u64()
                                .unwrap_or_default();
                            delivered_sequence = delivered_sequence.max(cursor);
                            return cursor > sequence;
                        }
                        true
                    });
                    subscription.sequence = subscription.sequence.max(delivered_sequence);
                }
            }
        }
        reconcile_interaction_assignments(&mut state, &self.hooks, &self.hook_events);
        // Registration Drop takes the same lock to discard failed subscriptions.
        drop(state);
    }

    pub(super) fn unsubscribe_session_thread(
        &self,
        connection_id: u64,
        session_id: &SessionId,
        thread_id: &ThreadId,
    ) -> Vec<AgentRequestEnvelope> {
        if let Ok(mut state) = self.state.lock()
            && let Some(subscriber) = state.subscribers.get_mut(&connection_id)
        {
            if let Some(subscription) = subscriber.threads.get_mut(thread_id) {
                subscription.session_owners.remove(session_id);
                subscription
                    .pending
                    .retain(|_, pending| &pending.session_id != session_id);
                if subscription.session_owners.is_empty() && subscription.pending.is_empty() {
                    subscriber.threads.remove(thread_id);
                }
            }
            let lost = take_owned_dynamic_interactions(&mut state, connection_id, |request| {
                &request.session_id == session_id && &request.thread_id == thread_id
            });
            reconcile_interaction_assignments(&mut state, &self.hooks, &self.hook_events);
            return lost;
        }
        Vec::new()
    }

    pub(super) fn publish_thread(&self, thread_id: &ThreadId, updates: &[ThreadUpdateEnvelope]) {
        // Committed events may change the durable Session summary even when no Thread is open.
        let sessions_with_catalog_change = updates
            .iter()
            .filter_map(|update| match &update.update {
                ThreadUpdate::Committed { event } => {
                    Some((&update.session_id, event_changes_agent_tree(event)))
                }
                _ => None,
            })
            .fold(
                BTreeMap::<&SessionId, bool>::new(),
                |mut sessions, (session_id, changed)| {
                    *sessions.entry(session_id).or_default() |= changed;
                    sessions
                },
            );
        let sessions_with_timing_change = updates
            .iter()
            .filter_map(|update| match &update.update {
                ThreadUpdate::Committed {
                    event:
                        ThreadEvent::TurnStarted { .. }
                        | ThreadEvent::TurnCompleted { .. }
                        | ThreadEvent::TurnFailed { .. }
                        | ThreadEvent::TurnInterrupted { .. },
                } => Some(&update.session_id),
                _ => None,
            })
            .collect::<BTreeSet<_>>();
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        for update in updates {
            let ThreadUpdate::Committed { event } = &update.update else {
                continue;
            };
            match event {
                ThreadEvent::InteractionRequested {
                    turn_id,
                    interaction,
                    ..
                } => {
                    if !record_interaction_version(
                        &mut state,
                        &update.session_id,
                        &update.thread_id,
                        turn_id,
                        update.durable_sequence,
                        InteractionDeliveryStatus::Pending(interaction.request_id.clone()),
                    ) {
                        continue;
                    }
                    state.pending_interactions.insert(
                        interaction.request_id.clone(),
                        AgentRequestEnvelope {
                            session_id: update.session_id.clone(),
                            thread_id: update.thread_id.clone(),
                            turn_id: turn_id.clone(),
                            interaction: interaction.clone(),
                        },
                    );
                }
                ThreadEvent::InteractionResolved {
                    turn_id,
                    request_id,
                    ..
                }
                | ThreadEvent::InteractionCancelled {
                    turn_id,
                    request_id,
                    ..
                } => {
                    if !record_interaction_version(
                        &mut state,
                        &update.session_id,
                        &update.thread_id,
                        turn_id,
                        update.durable_sequence,
                        InteractionDeliveryStatus::Retired(request_id.clone()),
                    ) {
                        continue;
                    }
                    state.pending_interactions.remove(request_id);
                    state.interaction_assignments.remove(request_id);
                }
                ThreadEvent::TurnCompleted { turn_id, .. }
                | ThreadEvent::TurnFailed { turn_id, .. }
                | ThreadEvent::TurnInterrupted { turn_id, .. } => {
                    record_interaction_version(
                        &mut state,
                        &update.session_id,
                        &update.thread_id,
                        turn_id,
                        update.durable_sequence,
                        InteractionDeliveryStatus::TurnEnded,
                    );
                }
                _ => {}
            }
        }
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if let Some(subscription) = subscriber.threads.get_mut(thread_id) {
                for update in updates
                    .iter()
                    .filter(|update| update.durable_sequence > subscription.sequence)
                {
                    subscription.publish(
                        &update.session_id,
                        notification(ServerNotificationMethod::SessionThreadUpdate, update),
                        &queue,
                    );
                }
                if !subscription.session_owners.is_empty()
                    && let Some(last) = updates.last()
                {
                    subscription.sequence = subscription.sequence.max(last.durable_sequence);
                }
            }
            for (session_id, agent_tree_changed) in &sessions_with_catalog_change {
                if subscriber.catalog {
                    queue.push(notification(
                        ServerNotificationMethod::SessionChanged,
                        &SessionChanged {
                            session_id: (*session_id).clone(),
                            agent_tree_changed: *agent_tree_changed,
                        },
                    ));
                }
            }
            for session_id in &sessions_with_timing_change {
                if !subscriber.catalog && subscriber_observes_session(subscriber, session_id) {
                    queue.push(notification(
                        ServerNotificationMethod::SessionChanged,
                        &SessionChanged {
                            session_id: (*session_id).clone(),
                            agent_tree_changed: true,
                        },
                    ));
                }
            }
            true
        });
        reconcile_interaction_assignments(&mut state, &self.hooks, &self.hook_events);
    }

    pub(super) fn publish_thread_update(&self, update: ThreadUpdateEnvelope) {
        let transcript = self.assemble_transcript_update(&update);
        match &update.update {
            ThreadUpdate::Committed { .. } => {
                self.publish_thread(&update.thread_id, std::slice::from_ref(&update));
            }
            ThreadUpdate::ItemStarted { .. }
            | ThreadUpdate::ItemDelta { .. }
            | ThreadUpdate::ToolOutputDelta { .. } => self.publish_thread_transient(&update),
        }
        if let Some(transcript) = transcript {
            self.publish_thread_transcript(&transcript);
        }
    }

    fn assemble_transcript_update(
        &self,
        update: &ThreadUpdateEnvelope,
    ) -> Option<ThreadTranscriptUpdateEnvelope> {
        let Ok(mut transcripts) = self.transcripts.lock() else {
            return None;
        };
        let accumulator = transcripts
            .entry((update.session_id.clone(), update.thread_id.clone()))
            .or_insert_with(|| {
                TranscriptAccumulator::new(update.session_id.clone(), update.thread_id.clone())
            });
        let result = accumulator.apply(update);
        match result {
            TranscriptApplyResult::Applied(update) => Some(update),
            TranscriptApplyResult::Ignored => None,
        }
    }

    pub(super) fn thread_transcript_snapshot(
        &self,
        thread: &ash_protocol::Thread,
        include_transient: bool,
        voice_transcripts: &[ash_protocol::VoiceTranscript],
    ) -> ash_thread_transcript::ThreadTranscriptSnapshot {
        if include_transient
            && let Ok(transcripts) = self.transcripts.lock()
            && let Some(accumulator) =
                transcripts.get(&(thread.session_id.clone(), thread.thread_id.clone()))
            && let Some(snapshot) = accumulator.snapshot(thread)
        {
            return snapshot.with_voice_transcripts(voice_transcripts);
        }
        ash_thread_transcript::ThreadTranscriptSnapshot::from_thread(thread)
            .with_voice_transcripts(voice_transcripts)
    }

    fn publish_thread_transcript(&self, update: &ThreadTranscriptUpdateEnvelope) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let mut delivered = false;
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            let Some(subscription) = subscriber.threads.get(&update.thread_id) else {
                return true;
            };
            subscription.publish(
                &update.session_id,
                notification(
                    ServerNotificationMethod::SessionThreadTranscriptUpdate,
                    update,
                ),
                &queue,
            );
            delivered |= subscription.session_owners.contains(&update.session_id);
            true
        });
        drop(state);
        if delivered {
            for change in &update.changes {
                if let ThreadTranscriptChange::Upsert {
                    entry:
                        ThreadTranscriptEntry::Item {
                            entry_id: _,
                            turn_id,
                            item: ash_protocol::ThreadItem::AgentMessage { text, .. },
                            ..
                        },
                } = change
                    && !text.is_empty()
                {
                    self.emit_ui_event(HookEventRequest {
                        event: HookEvent::MessageDisplay,
                        scope: HookEventScope::Turn {
                            session_id: update.session_id.clone(),
                            thread_id: update.thread_id.clone(),
                            turn_id: turn_id.clone(),
                        },
                        subject: Some(text.clone()),
                        tool_name: None,
                    });
                }
            }
        }
    }

    pub(super) fn publish_thread_goal_updated(&self, updated: ThreadGoalUpdatedNotification) {
        self.publish_thread_goal_notification(
            &updated.thread_id,
            ServerNotificationMethod::ThreadGoalUpdated,
            &updated,
        );
    }

    pub(super) fn publish_thread_goal_cleared(&self, cleared: ThreadGoalClearedNotification) {
        self.publish_thread_goal_notification(
            &cleared.thread_id,
            ServerNotificationMethod::ThreadGoalCleared,
            &cleared,
        );
    }

    fn publish_thread_goal_notification<T: Serialize>(
        &self,
        thread_id: &ThreadId,
        method: ServerNotificationMethod,
        params: &T,
    ) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if subscriber
                .threads
                .get(thread_id)
                .is_some_and(|subscription| !subscription.session_owners.is_empty())
            {
                queue.push(notification(method, params));
            }
            true
        });
    }

    pub(super) fn publish_skills_changed(&self, generation: u64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            queue.push(notification(
                ServerNotificationMethod::SkillsChanged,
                &SkillsChanged { generation },
            ));
            true
        });
    }

    pub(super) fn publish_config_changed(&self, change: ConfigChange) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            queue.push(notification(
                ServerNotificationMethod::ConfigChanged,
                &ConfigChanged {
                    revision: change.revision.get(),
                    generation: change.generation.get(),
                },
            ));
            true
        });
    }

    pub(super) fn publish_connectors_changed(&self, generation: u64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            queue.push(notification(
                ServerNotificationMethod::ConnectorsChanged,
                &ConnectorsChanged { generation },
            ));
            true
        });
    }

    pub(super) fn publish_plugins_changed(&self, revision: u64, activation_generation: u64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            queue.push(notification(
                ServerNotificationMethod::PluginsChanged,
                &PluginsChanged {
                    revision,
                    activation_generation,
                },
            ));
            true
        });
    }

    pub(super) fn extension_packages_generation(&self) -> u64 {
        self.extension_packages_generation.load(Ordering::Acquire)
    }

    pub(super) fn extension_packages_instance_id(&self) -> &str {
        &self.extension_packages_instance_id
    }

    pub(super) fn lock_extension_packages_change(&self) -> Option<std::sync::MutexGuard<'_, ()>> {
        self.extension_packages_change_gate.lock().ok()
    }

    pub(super) fn publish_extension_packages_changed(&self) -> u64 {
        self.publish_next_extension_packages_generation()
    }

    pub(super) fn publish_extension_packages_manager_changed(
        &self,
        source_id: &str,
        source_generation: u64,
    ) -> u64 {
        let Ok(mut sources) = self.extension_packages_source_generations.lock() else {
            return self.extension_packages_generation();
        };
        if sources
            .get(source_id)
            .is_some_and(|observed| *observed >= source_generation)
        {
            return self.extension_packages_generation();
        }
        sources.insert(source_id.to_owned(), source_generation);
        drop(sources);
        self.publish_next_extension_packages_generation()
    }

    fn publish_next_extension_packages_generation(&self) -> u64 {
        let previous = self
            .extension_packages_generation
            .try_update(Ordering::AcqRel, Ordering::Acquire, |generation| {
                Some(generation.saturating_add(1))
            })
            .unwrap_or_else(|generation| generation);
        let generation = previous.saturating_add(1);
        self.broadcast_notification(
            ServerNotificationMethod::ExtensionsChanged,
            &ExtensionsChanged {
                instance_id: self.extension_packages_instance_id.to_string(),
                generation,
            },
        );
        generation
    }

    pub(super) fn publish_extension_host_changed(&self, generation: u64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            queue.push(notification(
                ServerNotificationMethod::ExtensionHostChanged,
                &ExtensionHostChanged { generation },
            ));
            true
        });
    }

    pub(super) fn publish_git_status_changed(&self, status: GitStatusResult) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if subscriber.scope_id != self.scope_id {
                return true;
            }
            queue.push(notification(
                ServerNotificationMethod::GitStatusChanged,
                &GitStatusChanged {
                    status: status.clone(),
                },
            ));
            true
        });
    }

    pub(super) fn publish_git_ignore_changed(&self, change: GitIgnoreChanged) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if subscriber.scope_id == self.scope_id {
                queue.push(notification(
                    ServerNotificationMethod::GitIgnoreChanged,
                    &change,
                ));
            }
            true
        });
    }

    pub(super) fn publish_agent_tools_changed(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if subscriber.scope_id == self.scope_id {
                queue.push(notification(
                    ServerNotificationMethod::AgentToolsChanged,
                    &EmptyParams {},
                ));
            }
            true
        });
    }

    pub(super) fn publish_git_repositories_changed(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if subscriber.scope_id == self.scope_id {
                queue.push(notification(
                    ServerNotificationMethod::GitRepositoriesChanged,
                    &EmptyParams {},
                ));
            }
            true
        });
    }

    pub(super) fn publish_fs_changed(&self, changed: FsChanged) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if subscriber.scope_id != self.scope_id {
                return true;
            }
            queue.push(notification(ServerNotificationMethod::FsChanged, &changed));
            true
        });
    }

    pub(super) fn publish_turn_changes_changed(&self, changed: TurnChangesChanged) {
        self.broadcast_notification(ServerNotificationMethod::TurnChangesChanged, &changed);
    }

    pub(crate) fn publish_queue_changed(&self) {
        self.broadcast_notification(
            ServerNotificationMethod::QueueChanged,
            &serde_json::json!({}),
        );
    }

    pub(crate) fn publish_memory_changed(&self, changed: MemoryChanged) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if subscriber.product_host {
                queue.push(notification(
                    ServerNotificationMethod::MemoryChanged,
                    &changed,
                ));
            }
            true
        });
    }

    pub(crate) fn publish_symphony_changed(&self) {
        self.broadcast_notification(
            ServerNotificationMethod::SymphonyChanged,
            &serde_json::json!({}),
        );
    }

    pub(crate) fn publish_automation_changed(&self) {
        self.broadcast_notification(
            ServerNotificationMethod::AutomationChanged,
            &serde_json::json!({}),
        );
    }

    pub(super) fn publish_project_changed(&self, changed: ProjectChanged) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if subscriber.scope_id == self.scope_id && subscriber.product_host {
                queue.push(notification(
                    ServerNotificationMethod::ProjectChanged,
                    &changed,
                ));
            }
            true
        });
    }

    pub(super) fn publish_language_diagnostics(
        &self,
        connection_id: Option<u64>,
        diagnostics: LanguageDiagnosticsNotification,
    ) {
        self.publish_language_notification(
            ServerNotificationMethod::LanguageDirectoryDiagnostics,
            &diagnostics,
            connection_id,
        );
    }

    fn broadcast_notification(&self, method: ServerNotificationMethod, params: &impl Serialize) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            queue.push(notification(method, params));
            true
        });
    }

    pub(super) fn publish_language_server_message(
        &self,
        connection_id: Option<u64>,
        message: LanguageServerMessageNotification,
    ) {
        self.publish_language_notification(
            ServerNotificationMethod::LanguageServerMessage,
            &message,
            connection_id,
        );
    }

    pub(super) fn publish_language_server_progress(
        &self,
        connection_id: Option<u64>,
        progress: LanguageServerProgressNotification,
    ) {
        self.publish_language_notification(
            ServerNotificationMethod::LanguageServerProgress,
            &progress,
            connection_id,
        );
    }

    pub(super) fn publish_language_server_state(
        &self,
        connection_id: Option<u64>,
        state: LanguageServerStateNotification,
    ) {
        self.publish_language_notification(
            ServerNotificationMethod::LanguageServerState,
            &state,
            connection_id,
        );
    }

    pub(super) fn publish_language_server_capabilities(
        &self,
        connection_id: Option<u64>,
        capabilities: ash_app_server_protocol::protocol::language::LanguageServerCapabilitiesNotification,
    ) {
        self.publish_language_notification(
            ServerNotificationMethod::LanguageServerCapabilities,
            &capabilities,
            connection_id,
        );
    }

    fn publish_language_notification<T: Serialize>(
        &self,
        method: ServerNotificationMethod,
        params: &T,
        connection_id: Option<u64>,
    ) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|id, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            if subscriber.scope_id != self.scope_id
                || connection_id.is_some_and(|owner| owner != *id)
            {
                return true;
            }
            if method == ServerNotificationMethod::LanguageServerProgress {
                queue.push_progress(notification(method, params));
            } else {
                queue.push(notification(method, params));
            }
            true
        });
    }

    fn publish_thread_transient(&self, update: &ThreadUpdateEnvelope) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.subscribers.retain(|_, subscriber| {
            let Some(queue) = subscriber.queue.upgrade() else {
                return false;
            };
            let Some(subscription) = subscriber.threads.get(&update.thread_id) else {
                return true;
            };
            subscription.publish(
                &update.session_id,
                notification(ServerNotificationMethod::SessionThreadUpdate, update),
                &queue,
            );
            true
        });
    }
}

fn event_changes_agent_tree(event: &ThreadEvent) -> bool {
    matches!(
        event,
        ThreadEvent::ThreadCreated { .. }
            | ThreadEvent::ThreadHistoryMoved { .. }
            | ThreadEvent::ThreadArchived { .. }
            | ThreadEvent::ThreadRestored { .. }
            | ThreadEvent::ThreadTitleChanged { .. }
            | ThreadEvent::HistoryImported { .. }
            | ThreadEvent::ForkHistoryImported { .. }
            | ThreadEvent::ForkTurnImported { .. }
            | ThreadEvent::ForkHistoryImportCompleted { .. }
            | ThreadEvent::GoalCreated { .. }
            | ThreadEvent::GoalUpdated { .. }
            | ThreadEvent::GoalCleared { .. }
            | ThreadEvent::TurnAccepted { .. }
            | ThreadEvent::TurnStarted { .. }
            | ThreadEvent::TurnModeChanged { .. }
            | ThreadEvent::TurnCancelling { .. }
            | ThreadEvent::TurnCompleted { .. }
            | ThreadEvent::TurnFailed { .. }
            | ThreadEvent::TurnInterrupted { .. }
            | ThreadEvent::InteractionRequested { .. }
            | ThreadEvent::InteractionResolved { .. }
            | ThreadEvent::InteractionCancelled { .. }
            | ThreadEvent::ModelUsageRecorded { .. }
            | ThreadEvent::ModelInvocationRecorded { .. }
            | ThreadEvent::DelegationResultReceived { .. }
            | ThreadEvent::AgentJoinRequested { .. }
            | ThreadEvent::AgentJoinSatisfied { .. }
    )
}

fn subscriber_observes_session(subscriber: &Subscriber, session_id: &SessionId) -> bool {
    subscriber.sessions.contains(session_id)
        || subscriber
            .threads
            .values()
            .any(|subscription| subscription.session_owners.contains(session_id))
}

fn new_extension_packages_instance_id() -> String {
    let mut random = [0_u8; 16];
    if getrandom::getrandom(&mut random).is_ok() {
        return format!("extension_packages-{}", hex_bytes(&random));
    }
    format!(
        "extension_packages-{}-{}",
        std::process::id(),
        unix_time_millis()
    )
}

fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[usize::from(byte >> 4)] as char);
        encoded.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

// One watermark per Turn is enough because Core admits only one pending interaction per Turn.
// Retired identities also reject snapshots read before cancellation or connection cleanup.
fn record_interaction_version(
    state: &mut BrokerState,
    session_id: &SessionId,
    thread_id: &ThreadId,
    turn_id: &TurnId,
    sequence: u64,
    status: InteractionDeliveryStatus,
) -> bool {
    let key = (thread_id.clone(), turn_id.clone());
    if state.interaction_versions.get(&key).is_some_and(|version| {
        version.sequence >= sequence
            || version.status == InteractionDeliveryStatus::TurnEnded
            || matches!((&status, &version.status),
                (InteractionDeliveryStatus::Pending(id), InteractionDeliveryStatus::Retired(retired)) if id == retired)
    }) {
        return false;
    }
    state.interaction_versions.insert(
        key,
        InteractionDeliveryVersion {
            session_id: session_id.clone(),
            sequence,
            status: status.clone(),
        },
    );
    let stale = state
        .pending_interactions
        .iter()
        .filter_map(|(id, request)| {
            (&request.thread_id == thread_id
                && &request.turn_id == turn_id
                && match &status {
                    InteractionDeliveryStatus::Pending(request_id) => id != request_id,
                    InteractionDeliveryStatus::Retired(_)
                    | InteractionDeliveryStatus::TurnEnded => true,
                })
            .then(|| id.clone())
        })
        .collect::<Vec<_>>();
    for id in stale {
        state.pending_interactions.remove(&id);
        state.interaction_assignments.remove(&id);
    }
    true
}

fn retire_interaction_delivery(
    state: &mut BrokerState,
    request_id: &RequestId,
) -> Option<AgentRequestEnvelope> {
    state.interaction_assignments.remove(request_id);
    let request = state.pending_interactions.remove(request_id)?;
    if let Some(version) = state
        .interaction_versions
        .get_mut(&(request.thread_id.clone(), request.turn_id.clone()))
        && version.status.matches_request(request_id)
    {
        version.status = InteractionDeliveryStatus::Retired(request_id.clone());
    }
    Some(request)
}

fn take_owned_dynamic_interactions(
    state: &mut BrokerState,
    connection_id: u64,
    matches_scope: impl Fn(&AgentRequestEnvelope) -> bool,
) -> Vec<AgentRequestEnvelope> {
    let request_ids = state
        .interaction_assignments
        .iter()
        .filter_map(|(request_id, owner)| {
            if *owner != connection_id {
                return None;
            }
            let request = state.pending_interactions.get(request_id)?;
            (matches!(
                &request.interaction.request,
                ash_protocol::AgentRequest::DynamicTool { .. }
            ) && matches_scope(request))
            .then(|| request_id.clone())
        })
        .collect::<Vec<_>>();
    request_ids
        .into_iter()
        .filter_map(|request_id| retire_interaction_delivery(state, &request_id))
        .collect()
}

impl ash_skills_extension::SkillRuntimeEventSink for UpdateBroker {
    fn skills_changed(&self, generation: u64) {
        self.publish_skills_changed(generation);
    }
}

fn enqueue_hook_event(
    hooks: &Arc<RwLock<Option<Arc<dyn HookService>>>>,
    hook_events: &Arc<Mutex<Option<mpsc::SyncSender<HookEventRequest>>>>,
    request: HookEventRequest,
) {
    let runtime = hooks
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let Some(runtime) = runtime else {
        return;
    };
    if !runtime.has_enabled_event(request.event) {
        return;
    }
    let mut sender = hook_events
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let sender = sender.get_or_insert_with(|| {
        let (sender, pending) = mpsc::sync_channel(256);
        let worker_hooks = Arc::clone(hooks);
        std::thread::spawn(move || {
            while let Ok(request) = pending.recv() {
                let runtime = worker_hooks
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone();
                if let Some(runtime) = runtime {
                    let cancellation = ash_async_utils::CancellationSource::new();
                    if let Err(error) = runtime.event(&request, &cancellation.token()) {
                        log::warn!("UI Hook event failed: {error}");
                    }
                }
            }
        });
        sender
    });
    if let Err(error) = sender.try_send(request) {
        log::warn!("UI Hook queue is unavailable: {error}");
    }
}

fn reconcile_interaction_assignments(
    state: &mut BrokerState,
    hooks: &Arc<RwLock<Option<Arc<dyn HookService>>>>,
    hook_events: &Arc<Mutex<Option<mpsc::SyncSender<HookEventRequest>>>>,
) {
    let invalid_assignments = state
        .interaction_assignments
        .iter()
        .filter_map(|(request_id, connection_id)| {
            let Some(request) = state.pending_interactions.get(request_id) else {
                return Some(request_id.clone());
            };
            let required_scope = state.session_scopes.get(&request.session_id).copied();
            let valid = state
                .subscribers
                .get(connection_id)
                .is_some_and(|subscriber| {
                    interaction_owner_matches(subscriber, request, required_scope)
                });
            (!valid).then_some(request_id.clone())
        })
        .collect::<Vec<_>>();
    for request_id in invalid_assignments {
        state.interaction_assignments.remove(&request_id);
    }

    let unassigned = state
        .pending_interactions
        .keys()
        .filter(|request_id| !state.interaction_assignments.contains_key(*request_id))
        .cloned()
        .collect::<Vec<_>>();
    for request_id in unassigned {
        let Some(request) = state.pending_interactions.get(&request_id) else {
            continue;
        };
        if request
            .interaction
            .deadline
            .is_some_and(|deadline| deadline.expires_at_unix_ms <= unix_time_millis())
        {
            continue;
        }
        let required_scope = state.session_scopes.get(&request.session_id).copied();
        let owner = state
            .subscribers
            .iter()
            .find_map(|(connection_id, subscriber)| {
                interaction_owner_matches(subscriber, request, required_scope)
                    .then(|| subscriber.queue.upgrade())
                    .flatten()
                    .map(|queue| (*connection_id, queue))
            });
        if let Some((connection_id, queue)) = owner {
            queue.push(notification(
                ServerNotificationMethod::AgentRequest,
                request,
            ));
            enqueue_hook_event(
                hooks,
                hook_events,
                HookEventRequest {
                    event: HookEvent::Notification,
                    scope: HookEventScope::Turn {
                        session_id: request.session_id.clone(),
                        thread_id: request.thread_id.clone(),
                        turn_id: request.turn_id.clone(),
                    },
                    subject: Some(request.interaction.request_id.to_string()),
                    tool_name: None,
                },
            );
            state
                .interaction_assignments
                .insert(request_id, connection_id);
        }
    }
}

fn interaction_owner_matches(
    subscriber: &Subscriber,
    request: &AgentRequestEnvelope,
    required_scope: Option<u64>,
) -> bool {
    let supports_kind = subscriber
        .agent_interactions
        .as_ref()
        .is_some_and(|capability| {
            let supports_exact_dynamic_tool = match &request.interaction.request {
                ash_protocol::AgentRequest::DynamicTool { call } => capability
                    .dynamic_tools
                    .as_ref()
                    .is_some_and(|tools| tools.contains(&call.name)),
                _ => true,
            };
            capability.version == 1
                && capability
                    .kinds
                    .contains(&request.interaction.request.kind())
                && supports_exact_dynamic_tool
        });
    required_scope == Some(subscriber.scope_id)
        && supports_kind
        && subscriber
            .threads
            .get(&request.thread_id)
            .is_some_and(|subscription| subscription.session_owners.contains(&request.session_id))
}

pub(super) fn notification<T: Serialize>(method: ServerNotificationMethod, params: &T) -> Value {
    serde_json::to_value(JsonRpcNotification::new(
        method.as_str().into(),
        serde_json::to_value(params).expect("notification params must serialize"),
    ))
    .expect("JSON-RPC notification must serialize")
}

#[cfg(test)]
#[path = "update_broker_tests.rs"]
mod tests;
