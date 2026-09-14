use super::ClientEvent;
use super::map_event;
use ash_app_server_client::{AppServerEvent, ConnectionCloseReason, ServerNotification};
use ash_app_server_protocol::protocol::config::ConfigChanged;
use ash_app_server_protocol::protocol::connectors::ConnectorsChanged;
use ash_app_server_protocol::protocol::fs::FsChanged;
use ash_app_server_protocol::protocol::git::{GitHeadDto, GitStatusChanged, GitStatusResult};
use ash_app_server_protocol::protocol::marketplace::MarketplaceChanged;
use ash_app_server_protocol::protocol::notification::{SkillsChanged, ThreadUpdateEnvelope};
use ash_app_server_protocol::protocol::plugins::PluginsChanged;
use ash_app_server_protocol::protocol::session::SessionChanged;
use ash_protocol::SessionId;
use ash_protocol::StreamInstanceId;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::ThreadUpdate;

#[test]
fn skills_changed_is_mapped_without_exposing_the_wire_notification() {
    assert_eq!(
        map_event(AppServerEvent::Notification(
            ServerNotification::SkillsChanged(SkillsChanged { generation: 7 })
        )),
        Some(ClientEvent::SkillsChanged)
    );
}

#[test]
fn instruction_file_changes_refresh_the_tui_completion_catalog() {
    assert_eq!(
        map_event(AppServerEvent::Notification(ServerNotification::FsChanged(
            FsChanged::PathsChanged {
                dir_id: None,
                paths: vec![".ash/instructions/manual.md".into()],
            }
        ))),
        Some(ClientEvent::InstructionsChanged)
    );
    assert_eq!(
        map_event(AppServerEvent::Notification(ServerNotification::FsChanged(
            FsChanged::PathsChanged {
                dir_id: None,
                paths: vec!["src/lib.rs".into()],
            }
        ))),
        None
    );
}

#[test]
fn config_changed_requests_a_tui_config_refresh() {
    assert_eq!(
        map_event(AppServerEvent::Notification(
            ServerNotification::ConfigChanged(ConfigChanged {
                revision: 4,
                generation: 6,
            })
        )),
        Some(ClientEvent::ConfigChanged)
    );
}

#[test]
fn connectors_changed_requests_a_connector_catalog_refresh() {
    assert_eq!(
        map_event(AppServerEvent::Notification(
            ServerNotification::ConnectorsChanged(ConnectorsChanged { generation: 9 })
        )),
        Some(ClientEvent::ConnectorsChanged)
    );
}

#[test]
fn package_source_changes_request_shared_capability_refresh() {
    for notification in [
        ServerNotification::MarketplaceChanged(MarketplaceChanged {
            instance_id: "marketplace-runtime-1".into(),
            generation: 3,
        }),
        ServerNotification::PluginsChanged(PluginsChanged {
            revision: 4,
            activation_generation: 2,
        }),
    ] {
        assert_eq!(
            map_event(AppServerEvent::Notification(notification)),
            Some(ClientEvent::PackageSourcesChanged)
        );
    }
}

#[test]
fn thread_update_preserves_typed_scope_and_sequence() {
    let session_id = SessionId::new("session-1").unwrap();
    let thread_id = ThreadId::new("thread-1").unwrap();
    let update = ThreadUpdateEnvelope {
        session_id: session_id.clone(),
        thread_id: thread_id.clone(),
        durable_sequence: 1,
        stream_cursor: None,
        update: ThreadUpdate::Committed {
            event: ThreadEvent::ThreadCreated {
                agent_id: Some(ash_protocol::AgentId::new("agent-test").unwrap()),
                origin: Default::default(),
                agent: None,
                session_id,
                thread_id,
                title: "Thread".into(),
            },
        },
    };
    let Some(ClientEvent::ThreadUpdated(update)) = map_event(AppServerEvent::Notification(
        ServerNotification::SessionThreadUpdate(Box::new(update)),
    )) else {
        panic!("typed Thread update should be preserved");
    };
    assert_eq!(update.session_id.as_str(), "session-1");
    assert_eq!(update.thread_id.as_str(), "thread-1");
    assert_eq!(update.durable_sequence, 1);
}

#[test]
fn session_change_preserves_the_invalidated_tree_identity() {
    let session_id = SessionId::new("session-1").unwrap();
    let Some(ClientEvent::SessionChanged(changed_session_id)) = map_event(
        AppServerEvent::Notification(ServerNotification::SessionChanged(SessionChanged {
            session_id: session_id.clone(),
        })),
    ) else {
        panic!("Session invalidation should be preserved");
    };
    assert_eq!(changed_session_id, session_id);
}

#[test]
fn git_status_change_updates_tui_owned_status_state() {
    let changed = GitStatusChanged {
        status: GitStatusResult {
            repository_id: "repository-1".into(),
            stream_instance_id: StreamInstanceId::new("git-stream").unwrap(),
            revision: 1,
            path: String::new(),
            head: GitHeadDto::Unborn {
                name: "main".into(),
            },
            changes: Vec::new(),
        },
    };

    let Some(ClientEvent::GitStatusChanged(status)) = map_event(AppServerEvent::Notification(
        ServerNotification::GitStatusChanged(changed),
    )) else {
        panic!("Git status notification should be mapped");
    };
    assert_eq!(status.revision, 1);
    assert!(matches!(status.head, GitHeadDto::Unborn { name } if name == "main"));
}

#[test]
fn unowned_notifications_do_not_enter_tui_state() {
    assert_eq!(
        map_event(AppServerEvent::Notification(ServerNotification::Unknown {
            method: "future/changed".into(),
            params: serde_json::json!({ "generation": 4 }),
        })),
        None
    );
}

#[test]
fn account_notifications_reach_the_subscription_owner() {
    use crate::config::SubscriptionEvent;
    use ash_app_server_protocol::protocol::account::AccountReadResult;
    use ash_app_server_protocol::protocol::account::AccountUpdated;
    let account = AccountReadResult {
        revision: 3,
        accounts: vec![],
    };
    assert_eq!(
        map_event(AppServerEvent::Notification(
            ServerNotification::AccountUpdated(AccountUpdated {
                account: account.clone()
            })
        )),
        Some(ClientEvent::Account(SubscriptionEvent::Updated(account)))
    );
}

#[test]
fn notification_failure_becomes_a_client_event() {
    assert_eq!(
        map_event(AppServerEvent::ConnectionClosed(
            ConnectionCloseReason::DriverStopped
        )),
        Some(ClientEvent::ConnectionClosed(
            ConnectionCloseReason::DriverStopped
        ))
    );
}
