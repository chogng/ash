use super::*;

fn fixture(root: &Path) -> Environment {
    Environment {
        address: "127.0.0.1:12345".parse().unwrap(),
        secret: "test-secret".into(),
        resources: root.into(),
        policy: Arc::new(Mutex::new(Policy {
            folders: vec![url::Url::from_directory_path(root).unwrap().to_string()],
            ..Policy::default()
        })),
        error: "invalid".into(),
        terminals: Arc::default(),
    }
}
fn request(root: &Path) -> Attach {
    Attach {
        token: "test-secret".into(),
        address: "127.0.0.1:12345".into(),
        inspector: "ws://127.0.0.1:9000/unique-target".into(),
        pid: 42,
        cwd: root.to_string_lossy().into(),
        script: root.join("main.js").to_string_lossy().into(),
        flagged: false,
    }
}
#[test]
fn disabled_is_empty_and_credentials_never_persist() {
    let root = tempfile::tempdir().unwrap();
    let environment = fixture(root.path());
    assert_eq!(
        environment.collection(&json!({})).unwrap(),
        json!({"persistent":false,"map":[],"descriptionMap":[]})
    );
    let collection = environment
        .collection(&json!({"autoAttachFilter":"always"}))
        .unwrap();
    assert_eq!(collection["persistent"], false);
    assert_eq!(collection["map"][0][1]["type"], 2);
    assert!(
        collection["map"][0][1]["value"]
            .as_str()
            .unwrap()
            .contains("--require=")
    );
    assert!(environment.admit(&request(root.path())).is_some());
}
#[test]
fn authority_workspace_and_inspector_are_checked_before_launch() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let environment = fixture(root.path());
    environment
        .collection(&json!({"autoAttachFilter":"always"}))
        .unwrap();
    let mut input = request(root.path());
    input.token = "retired".into();
    assert!(environment.admit(&input).is_none());
    input = request(other.path());
    assert!(environment.admit(&input).is_none());
    input = request(root.path());
    input.inspector = "ws://example.com:9000/target".into();
    assert!(environment.admit(&input).is_none());
    environment.workspace(vec![]).unwrap();
    assert!(environment.admit(&request(root.path())).is_none());
}
#[test]
fn smart_and_explicit_flag_policies_are_distinct() {
    let root = tempfile::tempdir().unwrap();
    let environment = fixture(root.path());
    let mut input = request(root.path());
    environment
        .collection(&json!({"autoAttachFilter":"smart"}))
        .unwrap();
    assert!(environment.admit(&input).is_some());
    input.script = root
        .path()
        .join("node_modules/npm/bin/npm-cli.js")
        .to_string_lossy()
        .into();
    assert!(environment.admit(&input).is_none());
    environment
        .collection(&json!({"autoAttachFilter":"onlyWithFlag"}))
        .unwrap();
    assert!(environment.admit(&input).is_none());
    input.flagged = true;
    assert!(environment.admit(&input).is_some());
    environment
        .collection(&json!({"autoAttachFilter":"disabled"}))
        .unwrap();
    assert!(environment.admit(&input).is_none());
}
#[test]
fn invalid_policy_does_not_silently_enable_auto_attach() {
    let root = tempfile::tempdir().unwrap();
    let environment = fixture(root.path());
    environment
        .collection(&json!({"autoAttachFilter":"always"}))
        .unwrap();
    assert!(environment.admit(&request(root.path())).is_some());
    assert!(
        environment
            .collection(&json!({"autoAttachFilter":"surprise"}))
            .is_err()
    );
    assert!(
        environment
            .collection(&json!({"autoAttachFilter":"smart","autoAttachSmartPattern":["["]}))
            .is_err()
    );
    assert!(environment.admit(&request(root.path())).is_none());
}

#[test]
fn temporary_pause_preserves_terminal_environment_and_survives_refresh() {
    let root = tempfile::tempdir().unwrap();
    let environment = fixture(root.path());
    let settings = json!({"autoAttachFilter":"always"});
    let active = environment.collection(&settings).unwrap();
    environment.suspend(Suspension::Paused).unwrap();
    assert!(environment.admit(&request(root.path())).is_none());
    // New terminals retain the preload while paused, so they can resume too.
    assert_eq!(environment.collection(&settings).unwrap(), active);
    assert!(environment.state().unwrap() == (Mode::Always, Suspension::Paused));
    assert!(environment.admit(&request(root.path())).is_none());
    environment.suspend(Suspension::Active).unwrap();
    assert!(environment.admit(&request(root.path())).is_some());
}

#[test]
fn auto_attach_configuration_changes_clear_temporary_pause() {
    let root = tempfile::tempdir().unwrap();
    let environment = fixture(root.path());
    environment
        .collection(&json!({"autoAttachFilter":"always"}))
        .unwrap();
    environment.suspend(Suspension::Paused).unwrap();
    environment
        .collection(&json!({"autoAttachFilter":"smart"}))
        .unwrap();
    assert!(environment.admit(&request(root.path())).is_some());
    environment.suspend(Suspension::Paused).unwrap();
    environment
        .collection(&json!({"autoAttachFilter":"smart", "autoAttachSmartPattern":[]}))
        .unwrap();
    assert!(environment.admit(&request(root.path())).is_some());
    // A new activation starts active without persisting a window's suspension.
    let fresh = fixture(root.path());
    fresh
        .collection(&json!({"autoAttachFilter":"smart"}))
        .unwrap();
    assert!(fresh.admit(&request(root.path())).is_some());
}

#[test]
fn terminal_leases_survive_disabled_global_policy_and_revoke_independently() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let environment = fixture(root.path());
    let folder = url::Url::from_directory_path(root.path())
        .unwrap()
        .to_string();
    let (secret, _) = environment
        .terminal_scope(
            "parent".into(),
            folder.clone(),
            BTreeMap::from([("sourceMaps".into(), json!(false))]),
        )
        .unwrap();
    let mut input = request(root.path());
    input.token = secret.clone();
    environment
        .collection(&json!({"autoAttachFilter":"disabled"}))
        .unwrap();
    environment.suspend(Suspension::Paused).unwrap();
    let admission = environment.admit(&input).unwrap();
    assert_eq!(admission.parent.as_deref(), Some("parent"));
    assert_eq!(admission.folder, folder);
    assert_eq!(admission.properties["sourceMaps"], false);
    input.cwd = other.path().to_string_lossy().into();
    assert!(environment.admit(&input).is_none());
    input.cwd = root.path().to_string_lossy().into();
    environment.retire_terminal(&secret);
    assert!(environment.admit(&input).is_none());
}
