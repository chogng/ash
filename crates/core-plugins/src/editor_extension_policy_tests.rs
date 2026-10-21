use super::EditorExtensionPolicy;
use super::EditorExtensionPolicyAction;
use super::EditorExtensionPolicyError;
use super::EditorExtensionPolicySnapshot;
use crate::CapabilityRef;
use crate::PackageRef;

#[test]
fn consent_is_separate_persistent_and_bound_to_the_exact_artifact() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join("editor-policy.json");
    let policy = EditorExtensionPolicy::open(path.clone()).unwrap();
    let package = PackageRef {
        id: "publisher.hello@open-vsx".into(),
        version: "1.0.0".into(),
        digest: format!("sha256:{}", "a".repeat(64)),
    };
    let capability = CapabilityRef {
        id: "exact-capability".into(),
    };
    let events = policy.subscribe();
    assert_eq!(
        policy.snapshot(&package, &capability),
        EditorExtensionPolicySnapshot {
            revision: 1,
            enabled: true,
            granted: false
        }
    );
    assert_eq!(
        policy
            .set(
                &package,
                &capability,
                EditorExtensionPolicyAction::Enable,
                1
            )
            .unwrap(),
        EditorExtensionPolicySnapshot {
            revision: 2,
            enabled: true,
            granted: false
        }
    );
    assert_eq!(events.recv().unwrap(), 2);
    assert_eq!(
        policy.set(&package, &capability, EditorExtensionPolicyAction::Grant, 1),
        Err(EditorExtensionPolicyError::RevisionConflict)
    );
    policy
        .set(&package, &capability, EditorExtensionPolicyAction::Grant, 2)
        .unwrap();
    let reopened = EditorExtensionPolicy::open(path).unwrap();
    assert_eq!(
        reopened.snapshot(&package, &capability),
        EditorExtensionPolicySnapshot {
            revision: 3,
            enabled: true,
            granted: true
        }
    );
    let mut changed = package.clone();
    changed.digest = format!("sha256:{}", "b".repeat(64));
    assert_eq!(
        reopened.snapshot(&changed, &capability),
        EditorExtensionPolicySnapshot {
            revision: 3,
            enabled: true,
            granted: false
        }
    );
    assert_eq!(
        reopened.set(&changed, &capability, EditorExtensionPolicyAction::Grant, 3),
        Err(EditorExtensionPolicyError::InvalidBinding)
    );
    reopened
        .set(
            &package,
            &capability,
            EditorExtensionPolicyAction::Revoke,
            3,
        )
        .unwrap();
    assert!(!reopened.snapshot(&package, &capability).granted);
}

#[test]
fn an_old_api_contract_does_not_authorize_the_current_host() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join("editor-policy.json");
    let package = PackageRef {
        id: "publisher.hello@open-vsx".into(),
        version: "1.0.0".into(),
        digest: format!("sha256:{}", "a".repeat(64)),
    };
    let capability = CapabilityRef {
        id: "exact-capability".into(),
    };
    std::fs::write(&path, serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 1, "revision": 3, "records": {
            "exact-capability": { "package": package, "contractVersion": 4, "enabled": true, "granted": true }
        }
    })).unwrap()).unwrap();
    let policy = EditorExtensionPolicy::open(path.clone()).unwrap();
    assert!(!policy.snapshot(&package, &capability).granted);
    assert!(policy.snapshot(&package, &capability).enabled);
    let enabled = policy
        .set(
            &package,
            &capability,
            EditorExtensionPolicyAction::Enable,
            3,
        )
        .unwrap();
    assert!(enabled.enabled);
    assert!(!enabled.granted);
    let reopened = EditorExtensionPolicy::open(path).unwrap();
    assert_eq!(reopened.snapshot(&package, &capability), enabled);
}

#[test]
fn disablement_survives_updates_and_reopen_without_granting_the_new_artifact() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join("editor-policy.json");
    let policy = EditorExtensionPolicy::open(path.clone()).unwrap();
    let package = PackageRef {
        id: "publisher.hello@open-vsx".into(),
        version: "1.0.0".into(),
        digest: format!("sha256:{}", "a".repeat(64)),
    };
    let capability = CapabilityRef {
        id: "version-one".into(),
    };
    policy
        .set(&package, &capability, EditorExtensionPolicyAction::Grant, 1)
        .unwrap();
    let disabled = policy
        .set(
            &package,
            &capability,
            EditorExtensionPolicyAction::Disable,
            2,
        )
        .unwrap();
    assert!(!disabled.enabled);
    assert!(disabled.granted);
    let updated = PackageRef {
        version: "2.0.0".into(),
        digest: format!("sha256:{}", "b".repeat(64)),
        ..package.clone()
    };
    let updated_capability = CapabilityRef {
        id: "version-two".into(),
    };
    let reopened = EditorExtensionPolicy::open(path).unwrap();
    assert_eq!(
        reopened.snapshot(&updated, &updated_capability),
        EditorExtensionPolicySnapshot {
            revision: 3,
            enabled: false,
            granted: false
        }
    );
    let enabled = reopened
        .set(
            &updated,
            &updated_capability,
            EditorExtensionPolicyAction::Enable,
            3,
        )
        .unwrap();
    assert!(enabled.enabled);
    assert!(!enabled.granted);
    assert!(reopened.snapshot(&package, &capability).enabled);
    assert!(reopened.snapshot(&package, &capability).granted);
}

#[test]
fn legacy_disabled_policy_migrates_to_package_enablement_on_the_next_commit() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join("editor-policy.json");
    let package = PackageRef {
        id: "publisher.hello@open-vsx".into(),
        version: "1.0.0".into(),
        digest: format!("sha256:{}", "a".repeat(64)),
    };
    let capability = CapabilityRef {
        id: "version-one".into(),
    };
    std::fs::write(&path, serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 1, "revision": 4, "records": {
            "version-one": { "package": package, "contractVersion": 5, "enabled": false, "granted": true }
        }
    })).unwrap()).unwrap();
    let policy = EditorExtensionPolicy::open(path.clone()).unwrap();
    assert_eq!(
        policy.snapshot(&package, &capability),
        EditorExtensionPolicySnapshot {
            revision: 4,
            enabled: false,
            granted: false
        }
    );
    policy
        .set(
            &package,
            &capability,
            EditorExtensionPolicyAction::Enable,
            4,
        )
        .unwrap();
    let durable: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(durable["schemaVersion"], 2);
    assert!(durable["records"]["version-one"].get("enabled").is_none());
    assert_eq!(durable["disabledExtensions"], serde_json::json!([]));
    assert_eq!(durable["records"]["version-one"]["contractVersion"], 6);
    assert_eq!(durable["records"]["version-one"]["granted"], false);
}

#[test]
fn ash_capability_contract_retires_previous_grants_without_losing_enablement() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join("editor-policy.json");
    let package = PackageRef {
        id: "ash.inspector@team".into(),
        version: "1.0.0".into(),
        digest: format!("sha256:{}", "a".repeat(64)),
    };
    let capability = CapabilityRef {
        id: "exact-editor-capability".into(),
    };
    std::fs::write(&path, serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 2, "revision": 7, "disabledExtensions": [], "records": {
            "exact-editor-capability": { "package": package, "contractVersion": 5, "granted": true }
        }
    })).unwrap()).unwrap();
    let policy = EditorExtensionPolicy::open(path.clone()).unwrap();
    assert_eq!(
        policy.snapshot(&package, &capability),
        EditorExtensionPolicySnapshot {
            revision: 7,
            enabled: true,
            granted: false,
        }
    );
    let disabled = policy
        .set(
            &package,
            &capability,
            EditorExtensionPolicyAction::Disable,
            7,
        )
        .unwrap();
    assert!(!disabled.enabled);
    assert!(!disabled.granted);
    let enabled = policy
        .set(
            &package,
            &capability,
            EditorExtensionPolicyAction::Enable,
            8,
        )
        .unwrap();
    assert!(enabled.enabled);
    assert!(!enabled.granted);
    let reopened = EditorExtensionPolicy::open(path.clone()).unwrap();
    assert_eq!(reopened.snapshot(&package, &capability), enabled);
    let granted = reopened
        .set(&package, &capability, EditorExtensionPolicyAction::Grant, 9)
        .unwrap();
    assert!(granted.enabled);
    assert!(granted.granted);
    assert_eq!(
        EditorExtensionPolicy::open(path)
            .unwrap()
            .snapshot(&package, &capability),
        granted
    );
}

#[test]
fn built_in_disablement_is_persistent_and_does_not_grant_execution() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().join("editor-policy.json");
    let policy = EditorExtensionPolicy::open(path.clone()).unwrap();
    let id = "ash.github-authentication";
    assert!(policy.is_extension_enabled(id));
    let changed = policy.subscribe();
    let disabled = policy
        .set_built_in_enablement(id, EditorExtensionPolicyAction::Disable, 1)
        .unwrap();
    assert!(!disabled.enabled);
    assert!(!disabled.granted);
    assert_eq!(changed.recv().unwrap(), 2);
    assert_eq!(
        policy.set_built_in_enablement(id, EditorExtensionPolicyAction::Enable, 1),
        Err(EditorExtensionPolicyError::RevisionConflict)
    );
    assert_eq!(
        policy.set_built_in_enablement(id, EditorExtensionPolicyAction::Grant, 2),
        Err(EditorExtensionPolicyError::InvalidBinding)
    );
    assert_eq!(
        policy.set_built_in_enablement("../../provider", EditorExtensionPolicyAction::Disable, 2),
        Err(EditorExtensionPolicyError::InvalidBinding)
    );
    let reopened = EditorExtensionPolicy::open(path).unwrap();
    assert!(!reopened.is_extension_enabled(id));
    assert!(
        reopened
            .set_built_in_enablement(id, EditorExtensionPolicyAction::Enable, 2)
            .unwrap()
            .enabled
    );
}
