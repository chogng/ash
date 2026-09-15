use super::ExtensionHostInvocationRead;
use super::ExtensionHostRuntimeError;
use super::projection::ExtensionHostFailureKind;
use super::projection::runtime_failure;
use super::registration_allows_operation;
use super::sessions::InvocationSessionStore;
use super::source::stable_extension_id;
use ash_editor_extension_host::ExtensionHostError;
use ash_editor_extension_host::InvokeResult;
use ash_editor_extension_host::LanguageProviderOperation;
use ash_editor_extension_host::RegistrationKind;
use serde_json::json;
use std::time::Duration;
use std::time::Instant;

#[test]
fn stable_id_combines_plugin_and_manifest_local_identity() {
    assert_eq!(
        stable_extension_id("acme/review", "editor-runtime"),
        "acme/review:editor-runtime"
    );
}

#[test]
fn normalized_extension_source_does_not_require_legacy_plugin_authority() {
    let snapshot = super::source::combined_deployments(None, None, None).unwrap();

    assert_eq!(snapshot.revision, Default::default());
    assert!(snapshot.deployments.is_empty());
}

#[test]
fn session_reservations_enforce_global_and_connection_quotas() {
    let mut sessions = InvocationSessionStore::new(2, 1);

    sessions.reserve("one".into(), 7, 1).unwrap();
    assert!(matches!(
        sessions.reserve("same-owner".into(), 7, 1),
        Err(ExtensionHostRuntimeError::QuotaExceeded)
    ));
    sessions.reserve("two".into(), 8, 1).unwrap();
    assert!(matches!(
        sessions.reserve("global".into(), 9, 1),
        Err(ExtensionHostRuntimeError::QuotaExceeded)
    ));
}

#[test]
fn pending_invocation_identity_is_connection_owned() {
    let mut sessions = InvocationSessionStore::new(2, 2);
    sessions.reserve("one".into(), 7, 1).unwrap();

    assert!(matches!(
        sessions.read(7, "one"),
        Ok(ExtensionHostInvocationRead::Pending)
    ));
    assert!(matches!(
        sessions.read(8, "one"),
        Err(ExtensionHostRuntimeError::InvocationNotFound)
    ));
}

#[test]
fn detaching_an_owner_releases_terminal_sessions_immediately() {
    let mut sessions = InvocationSessionStore::new(1, 1);
    sessions.reserve("one".into(), 7, 1).unwrap();
    sessions.complete(
        "one",
        Ok(InvokeResult {
            payload: json!({ "ok": true }),
        }),
    );

    assert!(
        sessions
            .detach_owner(7, ash_editor_extension_host::CancelReason::Shutdown)
            .is_empty()
    );
    sessions.reserve("replacement".into(), 8, 1).unwrap();
}

#[test]
fn abandoned_terminal_sessions_are_reaped_before_reusing_quota() {
    let mut sessions = InvocationSessionStore::new(1, 1);
    sessions.reserve("one".into(), 7, 1).unwrap();
    sessions.complete(
        "one",
        Ok(InvokeResult {
            payload: json!(null),
        }),
    );
    sessions.sweep_expired(Instant::now() + Duration::from_secs(61));

    sessions.reserve("replacement".into(), 8, 1).unwrap();
}

#[test]
fn invocation_operations_are_brokered_by_registration_kind() {
    let command = RegistrationKind::Command {
        command: "acme.run".into(),
        title: "Run".into(),
    };
    let language = RegistrationKind::LanguageProvider {
        language_ids: vec!["rust".into()],
        operations: vec![LanguageProviderOperation::Hover],
    };
    let debug = RegistrationKind::DebugAdapter {
        debugger_type: "acme".into(),
    };

    assert!(registration_allows_operation(&command, "execute"));
    assert!(!registration_allows_operation(&command, "provideTasks"));
    assert!(registration_allows_operation(&language, "hover"));
    assert!(!registration_allows_operation(&language, "rename"));
    assert!(!registration_allows_operation(&debug, "execute"));
}

#[test]
fn host_failures_are_sanitized_before_projection() {
    let failure = runtime_failure(
        &ExtensionHostError::InvalidProtocol("host leaked /secret/path".into()),
        Some(3),
    );

    assert_eq!(failure.code, ExtensionHostFailureKind::InvalidProtocol);
    assert!(!failure.message.contains("/secret/path"));
    assert_eq!(failure.incarnation, Some(3));
}
