use crate::NotificationWatch;
use crate::RemoteMessageBoard;
use agent_message_board::BoardBackend;
use agent_message_board::BoardTurnHost;
use agent_message_board::Error;
use agent_message_board::RemoteUnread;
use async_utils::CancelOnDrop;
use async_utils::CancellationSource;
use extension_api::ExtensionError;
use extension_api::ExtensionRegistryBuilder;
use extension_api::ExtensionScope;
use extension_api::ExtensionState;
use extension_api::LifecycleObserver;
use extension_api::PromptFragment;
use extension_api::ThreadContext;
use extension_api::ThreadLifecycle;
use extension_api::TurnInputContext;
use extension_api::TurnInputContributor;
use protocol::SessionId;
use protocol::ThreadId;
use protocol::TurnId;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

/// Refreshes unread context in the background for each active Turn. The Turn scope
/// owns cancellation and discards the snapshot even if a request completes late.
pub fn install_notifications(
    registry: &mut ExtensionRegistryBuilder,
    host: Arc<dyn BoardTurnHost>,
    board: Arc<RemoteMessageBoard>,
) {
    let notifications = Arc::new(Notifications {
        host,
        state: registry.state(),
        board,
    });
    registry.lifecycle_observer("agent-message-board-remote", notifications.clone());
    registry.turn_input_contributor("agent-message-board-remote", notifications);
}

struct Notifications {
    host: Arc<dyn BoardTurnHost>,
    state: Arc<ExtensionState>,
    board: Arc<RemoteMessageBoard>,
}

#[derive(Default)]
struct Receiver(Mutex<Option<CancelOnDrop>>);

impl Notifications {
    fn ensure(
        &self,
        session: &SessionId,
        caller: &ThreadId,
        turn: &TurnId,
    ) -> Result<(), ExtensionError> {
        let scope = ExtensionScope::Turn(session.clone(), caller.clone(), turn.clone());
        let receiver = self.state.get_or_insert::<Receiver>(scope.clone())?;
        let mut owner = receiver
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if owner.is_some() {
            return Ok(());
        }
        let unread = self.state.get_or_insert::<RemoteUnread>(scope)?;
        let cancellation = CancellationSource::new();
        let token = cancellation.token();
        let host = self.host.clone();
        let board = self.board.clone();
        let session = session.clone();
        let caller = caller.clone();
        let turn_id = turn.clone();
        std::thread::Builder::new()
            .name("agent-board-notifications".into())
            .spawn(move || {
                let mut after = 0;
                while !token.is_cancelled() {
                    let observation = unread.start_observation(&token);
                    let attempt = (|| {
                        let (scope, members) = host.tree_members(&caller)?;
                        if scope.session != session {
                            return Err(Error::Input(
                                "board receiver belongs to another Session".into(),
                            ));
                        }
                        board.register_members(&scope, &members, &observation)?;
                        let refresh = || -> agent_message_board::Result<()> {
                            let revision = unread.revision();
                            let snapshot = board.unread(&scope, &caller, &observation)?;
                            if !observation.is_cancelled() {
                                unread.publish(revision, snapshot);
                            }
                            Ok(())
                        };
                        refresh()?;
                        board.notifications(
                            &NotificationWatch {
                                scope: scope.clone(),
                                caller: caller.clone(),
                                turn_id: turn_id.clone(),
                                after,
                            },
                            &observation,
                            &mut |notice| {
                                // Use the durable unread page so replayed SSE frames cannot
                                // restore notices that have already been acknowledged.
                                refresh()?;
                                if let Some(id) = notice.post["id"].as_i64() {
                                    after = after.max(id);
                                }
                                Ok(())
                            },
                        )
                    })();
                    if observation.is_cancelled() {
                        // A local acknowledgement or unsubscribe requests a fresh observation.
                        continue;
                    }
                    if let Err(error) = attempt {
                        log::warn!("Board notification connection failed: {error}");
                    }
                    for _ in 0..10 {
                        if observation.is_cancelled() {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            })
            .map_err(|error| ExtensionError::new(error.to_string()))?;
        *owner = Some(cancellation.cancel_on_drop());
        Ok(())
    }
}

impl LifecycleObserver for Notifications {
    fn config_changed(&self, _: u64) {}

    fn thread_changed(&self, context: ThreadContext<'_>, event: &ThreadLifecycle) {
        if let ThreadLifecycle::TurnStarted(turn) = event
            && let Err(error) = self.ensure(context.session_id, context.thread_id, turn)
        {
            log::warn!("Could not start board notification receiver: {error}");
        }
    }
}

impl TurnInputContributor for Notifications {
    fn contribute(
        &self,
        context: TurnInputContext<'_>,
    ) -> Result<Vec<PromptFragment>, ExtensionError> {
        let (Some(session), Some(caller), Some(turn)) =
            (context.session_id(), context.thread_id(), context.turn_id())
        else {
            return Ok(Vec::new());
        };
        let scope = ExtensionScope::Turn(session.clone(), caller.clone(), turn.clone());
        if !context.cancellation().is_cancelled()
            && self.state.get::<RemoteUnread>(&scope)?.is_none()
            && let Err(error) = self.host.with_active_turn(caller, session, turn, &mut || {
                if let Err(error) = self.ensure(session, caller, turn) {
                    log::warn!("Could not restart board notification receiver: {error}");
                }
            })
        {
            log::warn!("Could not verify the board notification Turn: {error}");
        }
        Ok(Vec::new())
    }
}

#[cfg(test)]
#[path = "notifications_tests.rs"]
mod tests;
