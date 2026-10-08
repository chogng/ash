use super::ConnectorsChanged;
use super::ServerNotification;
use super::decode_server_notification;
use crate::protocol::memory::MemoryChanged;
use crate::protocol::provider::ProviderModelsListResult;
use crate::protocol::provider::ProviderModelsUpdated;
use crate::protocol::session::SessionDeleted;
use serde_json::json;

#[test]
fn registry_decodes_known_notification_payloads() {
    let notification = decode_server_notification(
        "connector/changed".into(),
        json!({
            "generation": 9,
        }),
    )
    .expect("registered Connector notification should decode");

    assert_eq!(
        notification,
        ServerNotification::ConnectorsChanged(ConnectorsChanged { generation: 9 })
    );
}

#[test]
fn registry_decodes_session_deleted_notification() {
    let notification = decode_server_notification(
        "session/deleted".into(),
        json!({
            "sessionId": "session_1",
        }),
    )
    .expect("registered Session deletion should decode");

    assert_eq!(
        notification,
        ServerNotification::SessionDeleted(SessionDeleted {
            session_id: ash_protocol::SessionId::new("session_1").unwrap(),
        })
    );
}

#[test]
fn registry_decodes_memory_change_without_content() {
    let notification = decode_server_notification(
        "memory/changed".into(),
        json!({
            "scope": { "type": "profile" },
            "catalogRevision": 4,
        }),
    )
    .expect("registered Memory notification should decode");

    assert_eq!(
        notification,
        ServerNotification::MemoryChanged(MemoryChanged {
            scope: memories::MemoryScope::Profile,
            catalog_revision: 4,
        })
    );
}

#[test]
fn registry_decodes_subscription_model_updates_with_account_identity() {
    let notification = decode_server_notification(
        "provider/models/updated".into(),
        json!({
            "connection": "xai-subscription",
            "accountId": "account-1",
            "organization": null,
            "plan": "SuperGrok Heavy",
            "result": {"type": "empty"},
        }),
    )
    .unwrap();
    assert_eq!(
        notification,
        ServerNotification::ProviderModelsUpdated(ProviderModelsUpdated {
            connection: "xai-subscription".into(),
            authority: super::super::provider::ProviderModelsAuthorityDto::Subscription {
                account_id: "account-1".into(),
                organization: None,
                plan: Some("SuperGrok Heavy".into())
            },
            result: ProviderModelsListResult::Empty,
        })
    );
    assert!(
        decode_server_notification(
            "provider/models/updated".into(),
            json!({"connection":"xai-subscription","result":{"type":"empty"}}),
        )
        .is_err()
    );
}

#[test]
fn registry_preserves_unknown_notifications_for_forward_compatibility() {
    let params = json!({ "generation": 12 });
    let notification = decode_server_notification("future/changed".into(), params.clone()).unwrap();

    assert_eq!(
        notification,
        ServerNotification::Unknown {
            method: "future/changed".into(),
            params,
        }
    );
}

#[test]
fn registry_rejects_invalid_payloads_for_known_notifications() {
    assert!(
        decode_server_notification("connector/changed".into(), json!({ "generation": "nine" }),)
            .is_err(),
        "known notifications must retain strict payload validation"
    );
}

#[test]
fn registry_decodes_external_catalog_scopes_without_inventing_login_accounts() {
    for identity in [serde_json::json!("fingerprint"), serde_json::Value::Null] {
        let wire = json!({ "connection": "kimi-cli", "catalogScope": { "connection": "kimi-cli", "identity": identity }, "result": { "type": "empty" } });
        let decoded =
            decode_server_notification("provider/models/updated".into(), wire.clone()).unwrap();
        let ServerNotification::ProviderModelsUpdated(update) = decoded else {
            panic!("expected catalog observation");
        };
        assert!(matches!(
            update.authority,
            super::super::provider::ProviderModelsAuthorityDto::External { .. }
        ));
        assert_eq!(serde_json::to_value(update).unwrap(), wire);
    }
}
