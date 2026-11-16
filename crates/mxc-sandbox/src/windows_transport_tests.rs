use super::*;

#[test]
fn large_unicode_request_roundtrips_with_bounded_environment_items() {
    let payload = format!(
        "{}{}",
        "a".repeat(CHUNK_BYTES - 1),
        "🧊中文=\\\"".repeat(4000)
    );
    let mut environment = HashMap::from([
        ("SystemRoot".into(), "C:\\Windows".into()),
        (format!("{PREFIX}STALE"), "old request".into()),
    ]);
    encode(&payload, &mut environment).unwrap();
    assert_eq!(decode(environment.iter()).unwrap(), payload);
    assert!(environment.values().all(|value| value.len() <= CHUNK_BYTES));
    assert_eq!(environment["SystemRoot"], "C:\\Windows");
    assert!(!environment.contains_key(&format!("{PREFIX}STALE")));
    let lowercase = environment
        .iter()
        .map(|(key, value)| (key.to_ascii_lowercase(), value));
    assert_eq!(decode(lowercase).unwrap(), payload);
}

#[test]
fn malformed_transport_is_rejected_without_echoing_payload() {
    let mut original = HashMap::new();
    encode("secret-canary", &mut original).unwrap();
    for (key, value) in [
        (COUNT.to_owned(), "0"),
        (COUNT.to_owned(), "2"),
        (COUNT.to_owned(), "not-a-number"),
        (LENGTH.to_owned(), "1"),
        (LENGTH.to_owned(), "100"),
        (format!("{PREFIX}0"), ""),
        (format!("{PREFIX}1"), "extra"),
        (format!("{PREFIX}UNKNOWN"), "secret-canary"),
    ] {
        let mut environment = original.clone();
        environment.insert(key, value.into());
        let error = decode(environment.iter()).unwrap_err();
        assert!(!error.to_string().contains("secret-canary"));
    }
    let mut environment = original.clone();
    environment.remove(&format!("{PREFIX}0"));
    assert_eq!(decode(environment.iter()), Err(Error::Invalid));
    let duplicate = original
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .chain([(COUNT.to_ascii_lowercase(), "1".into())]);
    assert_eq!(decode(duplicate), Err(Error::Invalid));
    assert_eq!(
        decode(std::iter::empty::<(&str, &str)>()),
        Err(Error::Missing)
    );
}

#[test]
fn size_limits_apply_before_allocation_and_preserve_environment_on_encode_failure() {
    let mut environment = HashMap::from([("SystemRoot".into(), "C:\\Windows".into())]);
    let original = environment.clone();
    assert_eq!(
        encode(&"a".repeat(MAX_BYTES + 1), &mut environment),
        Err(Error::TooLarge)
    );
    assert_eq!(encode("", &mut environment), Err(Error::Invalid));
    assert_eq!(encode("a\0b", &mut environment), Err(Error::Invalid));
    assert_eq!(environment, original);
    encode(&"🧊".repeat(MAX_BYTES / 4), &mut environment).unwrap();
    assert_eq!(decode(environment.iter()).unwrap().len(), MAX_BYTES);
    environment.insert(LENGTH.into(), (MAX_BYTES + 1).to_string());
    assert_eq!(decode(environment.iter()), Err(Error::TooLarge));
    environment.insert(LENGTH.into(), "1".into());
    environment.insert(COUNT.into(), (MAX_CHUNKS + 1).to_string());
    assert_eq!(decode(environment.iter()), Err(Error::TooLarge));
}

#[cfg(unix)]
#[test]
fn unrelated_non_unicode_environment_is_ignored_and_transport_values_are_rejected() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;
    let mut environment = HashMap::new();
    encode("request", &mut environment).unwrap();
    let mut environment = environment
        .into_iter()
        .map(|(key, value)| (OsString::from(key), OsString::from(value)))
        .collect::<HashMap<_, _>>();
    environment.insert(OsString::from_vec(vec![255]), OsString::from_vec(vec![254]));
    assert_eq!(decode(environment.iter()).unwrap(), "request");
    environment.insert(
        OsString::from(format!("{PREFIX}0")),
        OsString::from_vec(vec![255]),
    );
    assert_eq!(decode(environment.iter()), Err(Error::Invalid));
}
