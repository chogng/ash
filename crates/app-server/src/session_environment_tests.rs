use super::*;

#[test]
fn environment_snapshot_is_scoped_and_immutable() {
    let store = Arc::new(ash_secrets::MemorySecretStore::default());
    let first = SessionId::new("configured").unwrap();
    let second = SessionId::new("plain").unwrap();
    let values = BTreeMap::from([("MODE".into(), "first\nsecond".into())]);
    let environments = SessionEnvironments::default();
    environments.bind(store.clone());
    environments.validate(&values).unwrap();
    environments.install(&first, Some(values.clone())).unwrap();
    environments.install(&first, Some(values.clone())).unwrap();
    assert!(matches!(
        environments.install(
            &first,
            Some(BTreeMap::from([("MODE".into(), "other".into())]))
        ),
        Err(CoreError::CommandConflict)
    ));
    assert!(matches!(
        environments.install(&first, None),
        Err(CoreError::CommandConflict)
    ));

    let reopened = SessionEnvironments::default();
    reopened.bind(store);
    assert_eq!(reopened.load(Some(&first)).unwrap().0, values);
    assert!(reopened.load(Some(&second)).unwrap().0.is_empty());
    reopened.delete(&first).unwrap();
    assert!(reopened.load(Some(&first)).unwrap().0.is_empty());
}

#[test]
fn invalid_and_host_owned_variables_are_rejected_without_disclosing_values() {
    let environments = SessionEnvironments::default();
    for name in [
        "",
        "a=b",
        "DYLD_INSERT_LIBRARIES",
        "ash_home",
        "https_proxy",
    ] {
        let values = BTreeMap::from([(name.into(), "synthetic-secret".into())]);
        let error = environments.validate(&values).unwrap_err();
        assert!(matches!(error, CoreError::InvalidInput(_)));
        assert!(!error.to_string().contains("synthetic-secret"));
    }
}

#[test]
fn profile_configuration_survives_reopening_and_uses_a_separate_secret_namespace() {
    let store = Arc::new(ash_secrets::MemorySecretStore::default());
    let id = "sessions.environment.profile.12345678-1234-1234-1234-123456789abc";
    let values = BTreeMap::from([("MODE".into(), "test".into())]);
    let environments = SessionEnvironments::default();
    environments.bind(store.clone());
    environments.save_profile(id, &values).unwrap();
    let reopened = SessionEnvironments::default();
    reopened.bind(store);
    assert_eq!(reopened.read_profile(id).unwrap(), Some(values));
    assert!(
        reopened
            .load(Some(&SessionId::new(id).unwrap()))
            .unwrap()
            .0
            .is_empty()
    );
    assert!(reopened.read_profile("arbitrary-secret-key").is_err());
}
