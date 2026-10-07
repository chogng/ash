use super::*;

#[test]
fn memory_store_round_trips_replaces_and_deletes() {
    let store = MemorySecretStore::default();
    let key = SecretKey::new("provider/openai/account/default/api-key").unwrap();

    assert_eq!(store.load(&key).unwrap(), None);

    store
        .store(&key, &SecretValue::new(b"first".to_vec()))
        .unwrap();
    assert_eq!(store.load(&key).unwrap().unwrap().expose(), b"first");

    store
        .store(&key, &SecretValue::new(b"replacement".to_vec()))
        .unwrap();
    assert_eq!(store.load(&key).unwrap().unwrap().expose(), b"replacement");

    assert_eq!(store.delete(&key).unwrap(), DeleteSecretOutcome::Deleted);
    assert_eq!(store.delete(&key).unwrap(), DeleteSecretOutcome::NotFound);
}

#[test]
fn secret_value_debug_is_redacted() {
    let secret = SecretValue::new(b"do-not-print".to_vec());

    let debug = format!("{secret:?}");

    assert_eq!(debug, "SecretValue([REDACTED])");
    assert!(!debug.contains("do-not-print"));
}

#[test]
fn secret_keys_reject_unsafe_shapes() {
    assert_eq!(SecretKey::new(""), Err(InvalidSecretKey::Empty));
    assert_eq!(
        SecretKey::new("provider\naccount"),
        Err(InvalidSecretKey::ContainsControlCharacter)
    );
    assert_eq!(
        SecretKey::new("x".repeat(513)),
        Err(InvalidSecretKey::TooLong)
    );
}

#[test]
fn unavailable_store_has_stable_failure_kind() {
    let store = UnavailableSecretStore;
    let key = SecretKey::new("provider/openai/default").unwrap();

    let error = store.load(&key).unwrap_err();

    assert_eq!(error.kind(), SecretStoreErrorKind::BackendUnavailable);
    assert_eq!(error.to_string(), "secret store unavailable");
}
