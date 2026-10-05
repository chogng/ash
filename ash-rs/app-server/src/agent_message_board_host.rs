//! Binds remote board previews to the existing Thread and extension-state owners.
use agent_message_board::BoardNotification;
use agent_message_board::LiveNotices;
use agent_message_board::Result;
use agent_message_board::Scope;
use agent_message_board::tree_members;
use agent_message_board_client::NotificationHost;
use agent_message_board_client::RemoteMessageBoard;
use ash_core::ThreadController;
use ash_extension_api::ExtensionRegistryBuilder;
use ash_extension_api::ExtensionScope;
use ash_extension_api::ExtensionState;
use ash_protocol::ThreadId;
use std::sync::Arc;
use std::sync::Weak;

pub(crate) fn install_notifications(
    registry: &mut ExtensionRegistryBuilder,
    threads: &Arc<ThreadController>,
    board: Arc<RemoteMessageBoard>,
) {
    let host = Arc::new(Host {
        threads: Arc::downgrade(threads),
        state: Arc::downgrade(&registry.state()),
    });
    agent_message_board_client::install_notifications(registry, host, board);
}
struct Host {
    threads: Weak<ThreadController>,
    state: Weak<ExtensionState>,
}
impl NotificationHost for Host {
    fn members(&self, caller: &ThreadId) -> Result<(Scope, Vec<ThreadId>)> {
        let threads = self
            .threads
            .upgrade()
            .ok_or_else(|| agent_message_board::Error::Runtime("Thread owner closed".into()))?;
        tree_members(&threads, caller)
    }
    fn accept(&self, notice: BoardNotification) -> Result<bool> {
        let Some(threads) = self.threads.upgrade() else {
            return Ok(false);
        };
        let Some(state) = self.state.upgrade() else {
            return Ok(false);
        };
        let (scope, _) = tree_members(&threads, &notice.recipient)?;
        if scope != notice.scope {
            return Ok(false);
        }
        let accepted = threads
            .with_running_turn(&notice.recipient, |session, turn| {
                if session != &notice.scope.session || turn != &notice.turn_id {
                    return Ok(false);
                }
                let live = state
                    .get_or_insert::<LiveNotices>(ExtensionScope::Turn(
                        session.clone(),
                        notice.recipient.clone(),
                        turn.clone(),
                    ))
                    .map_err(|error| core_api::CoreError::Context(error.to_string()))?;
                match live.accept(notice.post) {
                    Ok(()) => Ok(true),
                    Err(agent_message_board::Error::Input(_)) => Ok(false),
                    Err(error) => Err(core_api::CoreError::Context(error.to_string())),
                }
            })
            .map_err(|error| agent_message_board::Error::Runtime(error.to_string()))?;
        Ok(accepted == Some(true))
    }
}

#[cfg(test)]
#[path = "agent_message_board_host_tests.rs"]
mod tests;
