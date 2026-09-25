use super::Command;
use super::parse;
use crate::LifecycleCommand;

#[test]
fn lifecycle_and_connection_commands_preserve_explicit_product_services() {
    for (argument, expected) in [
        ("connect", Command::Connect),
        ("connect-selected", Command::ConnectSelected),
        ("start", Command::Lifecycle(LifecycleCommand::Start)),
        (
            "ensure-selected",
            Command::Lifecycle(LifecycleCommand::EnsureSelected),
        ),
        ("restart", Command::Lifecycle(LifecycleCommand::Restart)),
        ("stop", Command::Lifecycle(LifecycleCommand::Stop)),
        ("version", Command::Lifecycle(LifecycleCommand::Version)),
    ] {
        assert_eq!(
            parse(&[
                argument.into(),
                "--product-services".into(),
                "services.json".into()
            ])
            .unwrap(),
            (expected, Some("services.json".into()))
        );
    }
    for arguments in [
        vec![],
        vec!["unknown"],
        vec!["start", "extra"],
        vec!["start", "--product-services"],
    ] {
        assert!(parse(&arguments.into_iter().map(Into::into).collect::<Vec<_>>()).is_err());
    }
}

#[test]
fn packaged_backend_digest_rejects_a_changed_executable_before_launch() {
    use sha2::Digest;
    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("backend");
    std::fs::write(&executable, b"signed backend").unwrap();
    let expected = format!("{:x}", sha2::Sha256::digest(b"signed backend"));
    super::validate_backend_digest(&executable, &expected).unwrap();
    std::fs::write(&executable, b"changed backend").unwrap();
    assert!(super::validate_backend_digest(&executable, &expected).is_err());
    assert!(super::validate_backend_digest(&executable, "invalid").is_err());
}
