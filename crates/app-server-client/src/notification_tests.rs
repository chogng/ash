use super::ServerNotification;
use super::decode;
use ash_app_server_protocol::protocol::collaboration::DocumentCollaborationPresenceSnapshot;
use ash_app_server_protocol::protocol::collaboration::DocumentCollaborationUpdate;
use ash_app_server_protocol::protocol::config::ConfigChanged;
use ash_app_server_protocol::protocol::connectors::ConnectorsChanged;
use ash_app_server_protocol::protocol::fs::FsChanged;
use ash_app_server_protocol::protocol::git::{GitChangeStatusDto, GitHeadDto};
use ash_app_server_protocol::protocol::language::LanguageCodeActionDiagnosticDto;
use ash_app_server_protocol::protocol::language::LanguageDiagnosticSeverityDto;
use ash_app_server_protocol::protocol::language::LanguageDiagnosticsNotification;
use ash_app_server_protocol::protocol::language::LanguagePositionDto;
use ash_app_server_protocol::protocol::language::LanguageRangeDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceChanged;
use ash_app_server_protocol::protocol::plugins::PluginsChanged;

#[test]
fn decodes_owner_directed_agent_request_notification() {
    let notification = decode(
        r#"{
            "jsonrpc": "2.0",
            "method": "agent/request",
            "params": {
                "sessionId": "session-1",
                "threadId": "thread-1",
                "turnId": "turn-1",
                "interaction": {
                    "requestId": "approval-1",
                    "itemId": null,
                    "request": {
                        "type": "approval",
                        "request": {
                            "actionDigest": "digest",
                            "policyRevision": "policy-1",
                            "capabilities": [{"kind":"network","scope":"api.example.test"}],
                            "reason": "connect to the service"
                        }
                    },
                    "deadline": null
                }
            }
        }"#,
    )
    .expect("agent request notification decodes");

    let ServerNotification::AgentRequest(request) = notification else {
        panic!("expected owner-directed Agent request");
    };
    assert_eq!(request.interaction.request_id.as_str(), "approval-1");
    assert!(matches!(
        request.interaction.request,
        ash_protocol::AgentRequest::Approval { .. }
    ));
}

#[test]
fn decodes_git_status_changed_notification() {
    let notification = decode(
        r#"{
            "jsonrpc": "2.0",
            "method": "git/statusChanged",
            "params": {
                "status": {
                    "repositoryId": "repository-root",
                    "streamInstanceId": "git_stream_1",
                    "workspacePath": "/workspace",
                    "revision": 7,
                    "path": ".",
                    "head": {
                        "type": "branch",
                        "name": "main",
                        "objectId": "0123456789abcdef",
                        "upstream": null
                    },
                    "changes": [{
                        "path": "src/lib.rs",
                        "originalPath": null,
                        "indexStatus": "unmodified",
                        "worktreeStatus": "modified",
                        "conflicted": false,
                        "submodule": {
                            "isSubmodule": false,
                            "commitChanged": false,
                            "trackedChanges": false,
                            "untrackedChanges": false
                        }
                    }]
                }
            }
        }"#,
    )
    .expect("git status notification decodes");

    let ServerNotification::GitStatusChanged(changed) = notification else {
        panic!("expected git status notification");
    };
    assert_eq!(changed.status.repository_id, "repository-root");
    assert_eq!(changed.status.stream_instance_id.as_str(), "git_stream_1");
    assert_eq!(changed.status.revision, 7);
    assert!(matches!(
        changed.status.head,
        GitHeadDto::Branch { ref name, .. } if name == "main"
    ));
    assert_eq!(
        changed.status.changes[0].worktree_status,
        GitChangeStatusDto::Modified
    );
}

#[test]
fn decodes_document_collaboration_update_notification() {
    let notification = decode(
        r#"{
            "jsonrpc": "2.0",
            "method": "document/collaboration/update",
            "params": {
                "roomId": "document-room",
                "clientId": "client-a",
                "sequence": 1,
                "baseVersion": 0,
                "version": 1,
                "transaction": "{\"format\":\"ash.document.transaction\"}"
            }
        }"#,
    )
    .expect("collaboration update notification decodes");

    assert_eq!(
        notification,
        ServerNotification::DocumentCollaborationUpdate(DocumentCollaborationUpdate {
            room_id: "document-room".into(),
            client_id: "client-a".into(),
            sequence: 1,
            base_version: 0,
            version: 1,
            transaction: "{\"format\":\"ash.document.transaction\"}".into(),
        })
    );
}

#[test]
fn decodes_document_collaboration_presence_notification() {
    let notification = decode(
        r#"{
            "jsonrpc": "2.0",
            "method": "document/collaboration/presence",
            "params": {
                "roomId": "document-room",
                "generation": 3,
                "presences": [{"clientId": "client-a", "selection": "anchor=0"}]
            }
        }"#,
    )
    .expect("collaboration presence notification decodes");

    assert_eq!(
        notification,
        ServerNotification::DocumentCollaborationPresence(DocumentCollaborationPresenceSnapshot {
            room_id: "document-room".into(),
            generation: 3,
            presences: vec![
                ash_app_server_protocol::protocol::collaboration::DocumentCollaborationPresence {
                    client_id: "client-a".into(),
                    selection: "anchor=0".into(),
                }
            ],
        })
    );
}

#[test]
fn decodes_file_system_changed_notification() {
    let notification = decode(
        r#"{
            "jsonrpc": "2.0",
            "method": "fs/changed",
            "params": {
                "type": "pathsChanged",
                "paths": ["src/lib.rs", "README.md"]
            }
        }"#,
    )
    .expect("filesystem notification decodes");

    assert_eq!(
        notification,
        ServerNotification::FsChanged(FsChanged::PathsChanged {
            dir_id: None,
            paths: vec!["src/lib.rs".into(), "README.md".into()],
        })
    );
}

#[test]
fn decodes_language_diagnostics_notification() {
    let notification = decode(
        r#"{
            "jsonrpc": "2.0",
            "method": "language/diagnostics",
            "params": {
                "path": "src/main.rs",
                "revision": 2,
                "diagnostics": [{
                    "range": {"start": {"lineIndex": 0, "columnIndex": 3}, "end": {"lineIndex": 0, "columnIndex": 7}},
                    "severity": "error",
                    "message": "broken",
                    "code": "E1",
                    "source": "fixture"
                }]
            }
        }"#,
    )
    .expect("language diagnostics notification decodes");

    assert_eq!(
        notification,
        ServerNotification::LanguageDirectoryDiagnostics(LanguageDiagnosticsNotification {
            dir_id: None,
            path: "src/main.rs".into(),
            revision: 2,
            diagnostics: vec![LanguageCodeActionDiagnosticDto {
                range: LanguageRangeDto {
                    start: LanguagePositionDto {
                        line_index: 0,
                        column_index: 3
                    },
                    end: LanguagePositionDto {
                        line_index: 0,
                        column_index: 7
                    },
                },
                severity: LanguageDiagnosticSeverityDto::Error,
                message: "broken".into(),
                code: Some(serde_json::Value::String("E1".into())),
                source: Some("fixture".into()),
            }],
        })
    );
}

#[test]
fn decodes_config_changed_notification() {
    let notification = decode(
        r#"{
            "jsonrpc": "2.0",
            "method": "config/changed",
            "params": {"revision": 3, "generation": 2}
        }"#,
    )
    .expect("config notification decodes");

    assert_eq!(
        notification,
        ServerNotification::ConfigChanged(ConfigChanged {
            revision: 3,
            generation: 2,
        })
    );
}

#[test]
fn decodes_connectors_changed_notification() {
    let notification = decode(
        r#"{
            "jsonrpc": "2.0",
            "method": "connector/changed",
            "params": {"generation": 9}
        }"#,
    )
    .expect("Connector notification decodes");

    assert_eq!(
        notification,
        ServerNotification::ConnectorsChanged(ConnectorsChanged { generation: 9 })
    );
}

#[test]
fn decodes_plugins_changed_notification() {
    let notification = decode(
        r#"{
            "jsonrpc": "2.0",
            "method": "plugin/changed",
            "params": {"revision": 7, "activationGeneration": 3}
        }"#,
    )
    .expect("Plugin notification decodes");

    assert_eq!(
        notification,
        ServerNotification::PluginsChanged(PluginsChanged {
            revision: 7,
            activation_generation: 3,
        })
    );
}

#[test]
fn decodes_marketplace_changed_notification() {
    let notification = decode(
        r#"{
            "jsonrpc": "2.0",
            "method": "marketplace/changed",
            "params": {"instanceId": "marketplace-runtime-1", "generation": 4}
        }"#,
    )
    .expect("Marketplace notification decodes");

    assert_eq!(
        notification,
        ServerNotification::MarketplaceChanged(MarketplaceChanged {
            instance_id: "marketplace-runtime-1".into(),
            generation: 4,
        })
    );
}
