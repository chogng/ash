use super::SshEndpoint;

#[test]
fn execution_command_quotes_host_selected_paths_and_has_no_bearer_secret() {
    let endpoint = SshEndpoint::new(
        "BUILD",
        "/remote/it's here",
        "/package/it's/bin/ash-remote-server",
        "project",
    )
    .unwrap();
    assert_eq!(
        endpoint.command(),
        "'env' 'ASH_WORKSPACE_ROOT=/remote/it'\\''s here' '/package/it'\\''s/bin/ash-remote-server' 'execution-connect' 'project'"
    );
}

#[test]
fn execution_endpoint_rejects_option_hosts_relative_paths_and_invalid_ids() {
    for (host, root, runtime, environment) in [
        ("-option", "/remote", "/package/runtime", "project"),
        ("build", "relative", "/package/runtime", "project"),
        ("build", "/remote", "runtime", "project"),
        ("build", "/remote", "/package/runtime", "../project"),
    ] {
        assert!(SshEndpoint::new(host, root, runtime, environment).is_err());
    }
}
