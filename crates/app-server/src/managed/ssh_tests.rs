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
        target.remote_command(),
        "'env' 'ASH_WORKSPACE_ROOT=/home/O'\\''Brien' '/opt/Ash'\\''s/ash-remote-server' 'connect'"
    );
    let empty = SshConnectionOptions::new("build", None, "/opt/ash/ash-remote-server").unwrap();
    assert_eq!(
        empty.remote_command(),
        "'env' '-u' 'ASH_WORKSPACE_ROOT' '/opt/ash/ash-remote-server' 'connect'"
    );
}

#[test]
fn windows_carrier_uses_the_shared_launch_contract_without_a_workspace() {
    use base64::Engine;
    let target =
        SshConnectionOptions::new("windows", None, "C:/Ash/bin/ash-remote-server.exe").unwrap();
    let command = target.remote_command();
    assert!(command.starts_with("powershell.exe "));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(command.split_whitespace().last().unwrap())
        .unwrap();
    let utf16 = bytes
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect::<Vec<_>>();
    let script = String::from_utf16(&utf16).unwrap();
    assert!(script.contains("$env:ASH_WORKSPACE_ROOT=$null"));
    assert!(script.contains("$s.FileName='C:/Ash/bin/ash-remote-server.exe'"));
}
