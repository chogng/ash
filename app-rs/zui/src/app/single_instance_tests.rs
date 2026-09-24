use std::ffi::OsString;
use std::path::Path;

use super::SecondInstance;
use super::SingleInstanceKey;
use super::SingleInstanceOptions;
use super::SingleInstanceRun;

#[test]
fn keys_are_normalized_and_reject_path_or_namespace_ambiguity() {
    let key = SingleInstanceKey::new("Com.Example_Sample-App").unwrap();

    assert_eq!(key.as_str(), "com.example_sample-app");
    assert!(SingleInstanceKey::new("").is_err());
    assert!(SingleInstanceKey::new(".hidden").is_err());
    assert!(SingleInstanceKey::new("example/app").is_err());
    assert!(SingleInstanceKey::new("x".repeat(129)).is_err());
}

#[test]
fn options_and_invocations_retain_opaque_data_and_native_arguments() {
    let key = SingleInstanceKey::new("com.example.zui").unwrap();
    let options = SingleInstanceOptions::new(key.clone()).with_additional_data([1, 2, 255]);
    let event = SecondInstance::new(["zui", "--new-window"], "/workspace")
        .with_additional_data(options.additional_data());

    assert_eq!(options.key(), &key);
    assert_eq!(
        event.arguments(),
        [OsString::from("zui"), OsString::from("--new-window")]
    );
    assert_eq!(event.working_directory(), Path::new("/workspace"));
    assert_eq!(event.additional_data(), [1, 2, 255]);
}

#[test]
fn forwarded_outcome_does_not_expose_a_primary_exit() {
    let outcome = SingleInstanceRun::<()>::Forwarded;

    assert!(!outcome.is_primary());
    assert!(outcome.is_forwarded());
    assert!(outcome.primary_exit().is_none());
    assert!(outcome.into_primary_exit().is_none());
}
