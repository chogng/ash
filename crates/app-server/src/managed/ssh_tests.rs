use ash_app_server_daemon::SshConnectionOptions;

#[test]
fn command_quotes_remote_arguments_and_clears_an_empty_directory() {
    let target = SshConnectionOptions::new(
        "build",
        Some("/home/O'Brien"),
        "/opt/Ash's/ash-remote-server",
    )
    .unwrap();
    assert_eq!(
        super::remote_command(&target),
        "'env' 'ASH_WORKSPACE_ROOT=/home/O'\\''Brien' '/opt/Ash'\\''s/ash-remote-server' 'connect'"
    );
    let empty = SshConnectionOptions::new("build", None, "/opt/ash/ash-remote-server").unwrap();
    assert_eq!(
        super::remote_command(&empty),
        "'env' '-u' 'ASH_WORKSPACE_ROOT' '/opt/ash/ash-remote-server' 'connect'"
    );
}
