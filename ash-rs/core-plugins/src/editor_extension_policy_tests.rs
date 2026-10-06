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
            enabled: false,
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
            enabled: false,
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
            "exact-capability": { "package": package, "contractVersion": 0, "enabled": true, "granted": true }
        }
    })).unwrap()).unwrap();
    let policy = EditorExtensionPolicy::open(path.clone()).unwrap();
    assert!(!policy.snapshot(&package, &capability).granted);
    assert!(!policy.snapshot(&package, &capability).enabled);
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
