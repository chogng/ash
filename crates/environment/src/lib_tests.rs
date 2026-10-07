use super::*;

#[test]
fn rejects_empty_environment_id() {
    assert_eq!(EnvId::new("  "), Err(EnvIdError));
}

#[test]
fn local_environment_has_stable_identity() {
    assert_eq!(EnvId::local().as_str(), "local");
}
