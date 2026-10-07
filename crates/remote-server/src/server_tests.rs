use super::run_from_environment;

#[test]
fn remote_server_rejects_any_listener_other_than_stdio() {
    let result = run_from_environment([
        "app-server".to_owned(),
        "--listen".to_owned(),
        "tcp://127.0.0.1:0".to_owned(),
    ]);

    assert!(result.is_err());
}

#[test]
fn remote_server_requires_the_app_server_subcommand() {
    let result = run_from_environment(["version".to_owned()]);

    assert!(result.is_err());
}
