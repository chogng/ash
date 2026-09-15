use ash_remote_connections::RemoteConnectionCatalog;
use tempfile::TempDir;

use crate::remote_connection_cli::AppInvocation;
use crate::remote_connection_cli::AppInvocationParseError;
use crate::remote_connection_cli::RemoteConnectionCommandParseError;

#[test]
fn tunnel_requires_valid_ports_and_rejects_duplicate_options() {
    for value in ["0", "65536", "http"] {
        let result = AppInvocation::parse([
            "remote".into(),
            "tunnel".into(),
            "build".into(),
            "--remote-port".into(),
            value.into(),
        ]);
        assert!(matches!(
            result,
            Err(AppInvocationParseError::Remote(
                RemoteConnectionCommandParseError::InvalidPort {
                    flag: "--remote-port",
                    ..
                }
            ))
        ));
    }

    let duplicate = AppInvocation::parse([
        "remote".into(),
        "tunnel".into(),
        "build".into(),
        "--remote-port".into(),
        "3000".into(),
        "--remote-port".into(),
        "4000".into(),
    ]);
    assert!(matches!(
        duplicate,
        Err(AppInvocationParseError::Remote(
            RemoteConnectionCommandParseError::DuplicateOption("--remote-port")
        ))
    ));
}

#[test]
fn tunnel_requires_a_saved_connection_and_remote_port() {
    let missing_port = AppInvocation::parse(["remote".into(), "tunnel".into(), "build".into()]);
    assert!(matches!(
        missing_port,
        Err(AppInvocationParseError::Remote(
            RemoteConnectionCommandParseError::RequiredOption {
                command: "tunnel",
                flag: "--remote-port",
            }
        ))
    ));

    let directory = TempDir::new().unwrap();
    let catalog = RemoteConnectionCatalog::new(directory.path().join("targets.json"));
    let invocation = AppInvocation::parse([
        "remote".into(),
        "tunnel".into(),
        "missing".into(),
        "--remote-port".into(),
        "3000".into(),
    ])
    .unwrap();
    assert!(
        invocation
            .resolve_with_catalog(&catalog, &mut Vec::new())
            .unwrap_err()
            .contains("does not exist")
    );
}

#[cfg(unix)]
#[test]
fn tunnel_uses_named_host_and_fixed_loopback_forward_in_the_foreground() {
    use crate::launch_test_support::make_executable;
    use ash_remote_connections::select_available_loopback_port;

    let directory = TempDir::new().unwrap();
    let catalog = RemoteConnectionCatalog::new(directory.path().join("targets.json"));
    AppInvocation::parse([
        "remote".into(),
        "save".into(),
        "build".into(),
        "--host".into(),
        "build.example".into(),
        "--dir".into(),
        "/srv/project".into(),
    ])
    .unwrap()
    .resolve_with_catalog(&catalog, &mut Vec::new())
    .unwrap();
    let arguments_path = directory.path().join("arguments.txt");
    let fake_ssh = directory.path().join("fake-ssh");
    std::fs::write(
        &fake_ssh,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"${0%/*}/arguments.txt\"\nsleep 0.1\n",
    )
    .unwrap();
    make_executable(&fake_ssh);
    let local_port = select_available_loopback_port().unwrap();
    let _listener = std::net::TcpListener::bind(("127.0.0.1", local_port.get())).unwrap();
    let invocation = AppInvocation::parse([
        "remote".into(),
        "tunnel".into(),
        "build".into(),
        "--remote-port".into(),
        "3000".into(),
        "--local-port".into(),
        local_port.to_string(),
        "--ssh".into(),
        fake_ssh.to_string_lossy().into_owned(),
    ])
    .unwrap();
    let mut output = Vec::new();

    assert!(
        invocation
            .resolve_with_catalog(&catalog, &mut output)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        String::from_utf8(output).unwrap(),
        format!("forwarding\tbuild\t127.0.0.1:{local_port}\t127.0.0.1:3000\n")
    );
    assert_eq!(
        std::fs::read_to_string(arguments_path).unwrap(),
        format!(
            "-N\n-T\n-o\nBatchMode=yes\n-o\nExitOnForwardFailure=yes\n-o\nConnectTimeout=10\n-L\n127.0.0.1:{local_port}:127.0.0.1:3000\nbuild.example\n"
        )
    );
}

#[cfg(unix)]
#[test]
fn tunnel_does_not_advertise_an_endpoint_when_openssh_exits_during_startup() {
    let directory = TempDir::new().unwrap();
    let catalog = RemoteConnectionCatalog::new(directory.path().join("targets.json"));
    AppInvocation::parse([
        "remote".into(),
        "save".into(),
        "build".into(),
        "--host".into(),
        "build.example".into(),
        "--dir".into(),
        "/srv/project".into(),
    ])
    .unwrap()
    .resolve_with_catalog(&catalog, &mut Vec::new())
    .unwrap();
    let invocation = AppInvocation::parse([
        "remote".into(),
        "tunnel".into(),
        "build".into(),
        "--remote-port".into(),
        "3000".into(),
        "--local-port".into(),
        "49152".into(),
        "--ssh".into(),
        "/usr/bin/false".into(),
    ])
    .unwrap();
    let mut output = Vec::new();

    let error = invocation
        .resolve_with_catalog(&catalog, &mut output)
        .unwrap_err();
    assert!(error.contains("before it became ready"));
    assert!(output.is_empty());
}
