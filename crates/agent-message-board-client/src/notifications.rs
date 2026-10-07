use crate::NotificationWatch;
use crate::RemoteMessageBoard;
use agent_message_board::BoardBackend;
use async_utils::CancellationSource;
use extension_api::ExtensionRegistryBuilder;
use extension_api::ExtensionScope;
use extension_api::ExtensionState;
use extension_api::LifecycleObserver;
use extension_api::ThreadContext;
use extension_api::ThreadLifecycle;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

/// Installs receivers owned by exact Turn extension scopes. Shutdown cancels I/O;
/// admission rechecks the Turn under Core's lock so late frames cannot reach its successor.
pub fn install_notifications(
    registry: &mut ExtensionRegistryBuilder,
    host: Arc<dyn NotificationHost>,
    board: Arc<RemoteMessageBoard>,
) {
    let state = registry.state();
    registry.lifecycle_observer(
        "agent-message-board-remote",
        Arc::new(Notifications { host, state, board }),
    );
}
struct Notifications {
    host: Arc<dyn NotificationHost>,
    state: Arc<ExtensionState>,
    board: Arc<RemoteMessageBoard>,
}
#[derive(Default)]
struct Receiver(Mutex<Option<ReceiverTask>>);
struct ReceiverTask {
    cancellation: CancellationSource,
}
impl Drop for ReceiverTask {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}
impl LifecycleObserver for Notifications {
    fn config_changed(&self, _: u64) {}
    fn thread_changed(&self, context: ThreadContext<'_>, event: &ThreadLifecycle) {
        let ThreadLifecycle::TurnStarted(turn) = event else {
            return;
        };
        let scope = ExtensionScope::Turn(
            context.session_id.clone(),
            context.thread_id.clone(),
            turn.clone(),
        );
        let Ok(receiver) = self.state.get_or_insert::<Receiver>(scope) else {
            return;
        };
        let mut owner = receiver
            .0
            .lock()
            .expect("receiver registration contains no callbacks");
        if owner.is_some() {
            return;
        }
        let cancellation = CancellationSource::new();
        let token = cancellation.token();
        let host = self.host.clone();
        let board = self.board.clone();
        let caller = context.thread_id.clone();
        let turn_id = turn.clone();
        let task = std::thread::Builder::new()
            .name("agent-board-notifications".into())
            .spawn(move || {
                let mut after = 0;
                while !token.is_cancelled() {
                    let attempt = (|| {
                        let (scope, members) = host.members(&caller)?;
                        board.register_members(&scope, &members, &token)?;
                        board.notifications(
                            &NotificationWatch {
                                scope,
                                caller: caller.clone(),
                                turn_id: turn_id.clone(),
                                after,
                            },
                            &token,
                            &mut |notice| {
                                let id = notice.post["id"].as_i64().unwrap_or(0);
                                let accepted = host.accept(notice)?;
                                if accepted {
                                    after = after.max(id);
                                }
                                Ok(())
                            },
                        )
                    })();
                    if let Err(error) = attempt
                        && !token.is_cancelled()
                    {
                        log::warn!("Board notification connection failed: {error}");
                    }
                    // Connection loss never changes the selected backend. Reconnect within
                    // this Turn; durable unread pages retain every outstanding post.
                    for _ in 0..10 {
                        if token.is_cancelled() {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            });
        match task {
            Ok(_) => *owner = Some(ReceiverTask { cancellation }),
            Err(error) => {
                log::error!("Could not start board notification receiver: {error}");
            }
        }
    }
}
/// Runtime authority used by the remote receiver without importing the execution engine.
/// Hosts resolve registered tree members and admit a preview only under the exact Turn lock.
pub trait NotificationHost: Send + Sync {
    fn members(
        &self,
        caller: &protocol::ThreadId,
    ) -> agent_message_board::Result<(agent_message_board::Scope, Vec<protocol::ThreadId>)>;
    fn accept(
        &self,
        notice: agent_message_board::BoardNotification,
    ) -> agent_message_board::Result<bool>;
}

#[cfg(test)]
#[path = "notifications_tests.rs"]
mod tests;
