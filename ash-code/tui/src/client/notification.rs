use ash_app_server_client::AppServerEvent;
use ash_app_server_client::ConnectionCloseReason;
use ash_app_server_client::ServerNotification;
use ash_app_server_protocol::protocol::git::GitStatusResult;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;
use ash_protocol::AgentRequestEnvelope;
use ash_protocol::SessionId;
use ash_protocol::ThreadUpdateEnvelope;

/// A connection-layer fact understood by the TUI event loop.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ClientEvent {
    Account(crate::config::SubscriptionEvent),
    AgentRequest(Box<AgentRequestEnvelope>),
    ConfigChanged,
    QueueChanged,
    ConnectionClosed(ConnectionCloseReason),
    GitStatusChanged(GitStatusResult),
    ConnectorsChanged,
    PackageSourcesChanged,
    SkillsChanged,
    InstructionsChanged,
    MemoriesChanged,
    SessionChanged(SessionId),
    ThreadUpdated(Box<ThreadUpdateEnvelope>),
    ThreadTranscriptUpdated(Box<ThreadTranscriptUpdateEnvelope>),
}

pub(crate) fn map_event(event: AppServerEvent) -> Option<ClientEvent> {
    match event {
        AppServerEvent::Notification(notification) => project_notification(notification),
        AppServerEvent::ConnectionClosed(reason) => Some(ClientEvent::ConnectionClosed(reason)),
    }
}

fn project_notification(notification: ServerNotification) -> Option<ClientEvent> {
    match notification {
        ServerNotification::AccountUpdated(updated) => Some(ClientEvent::Account(
            crate::config::SubscriptionEvent::Updated(updated.account),
        )),
        ServerNotification::AccountLoginCompleted(completed) => Some(ClientEvent::Account(
            crate::config::SubscriptionEvent::Completed(completed),
        )),
        ServerNotification::AgentRequest(request) => {
            Some(ClientEvent::AgentRequest(Box::new(request)))
        }
        ServerNotification::ConnectorsChanged(_) => Some(ClientEvent::ConnectorsChanged),
        ServerNotification::QueueChanged(_) => Some(ClientEvent::QueueChanged),
        ServerNotification::ConfigChanged(_) => Some(ClientEvent::ConfigChanged),
        ServerNotification::MarketplaceChanged(_) | ServerNotification::PluginsChanged(_) => {
            Some(ClientEvent::PackageSourcesChanged)
        }
        ServerNotification::MemoryChanged(_) => Some(ClientEvent::MemoriesChanged),
        ServerNotification::SkillsChanged(_) => Some(ClientEvent::SkillsChanged),
        ServerNotification::FsChanged(changed) => match changed {
            ash_app_server_protocol::protocol::fs::FsChanged::RescanRequired { .. } => {
                Some(ClientEvent::InstructionsChanged)
            }
            ash_app_server_protocol::protocol::fs::FsChanged::PathsChanged { paths, .. }
                if paths.iter().any(|path| {
                    path.starts_with(".ash/instructions") || path.starts_with("instructions")
                }) =>
            {
                Some(ClientEvent::InstructionsChanged)
            }
            _ => None,
        },
        ServerNotification::GitStatusChanged(changed) => {
            Some(ClientEvent::GitStatusChanged(changed.status))
        }
        ServerNotification::SessionThreadUpdate(update) => Some(ClientEvent::ThreadUpdated(update)),
        ServerNotification::SessionChanged(changed) => {
            Some(ClientEvent::SessionChanged(changed.session_id))
        }
        ServerNotification::SessionThreadTranscriptUpdate(update) => {
            Some(ClientEvent::ThreadTranscriptUpdated(Box::new(update)))
        }
        _ => None,
    }
}

#[cfg(test)]
#[path = "notification_tests.rs"]
mod tests;
