use super::ConnectionPrelude;
use super::decode_prelude;
use crate::ConnectionOptions;
use crate::ConnectionRole;
use crate::GrantSource;
use crate::SshConnectionOptions;

#[test]
fn execution_scope_requires_a_versioned_host_grant_and_identity() {
    let options = ConnectionOptions::new(
        "/profile",
        Some("/remote".into()),
        GrantSource::HostConfiguration,
        None,
    )
    .with_role(ConnectionRole::Execution {
        environment: "project".into(),
    });
    let mut value = serde_json::to_value(ConnectionPrelude::from_options(&options)).unwrap();
    assert_eq!(value["version"], 3);
    decode_prelude(format!("{value}\n").as_bytes()).unwrap();
    for (field, invalid) in [
        ("version", serde_json::json!(1)),
        ("version", serde_json::json!(2)),
        ("dirRoot", serde_json::Value::Null),
        ("dirRoot", serde_json::json!("relative")),
        ("dirGrantSource", serde_json::json!("userConfig")),
        (
            "role",
            serde_json::json!({"execution":{"environment":"../other"}}),
        ),
    ] {
        let mut invalid_scope = value.clone();
        invalid_scope[field] = invalid;
        assert!(decode_prelude(format!("{invalid_scope}\n").as_bytes()).is_err());
    }
    value["productServices"] = serde_json::json!("/manifest");
    assert!(decode_prelude(format!("{value}\n").as_bytes()).is_err());
    let mut response = super::ControlResponse::new(
        super::ControlState::Running,
        1,
        "instance".into(),
        "schema".into(),
    );
    response.version = 1;
    assert!(response.validate_connection(&options).is_err());
    response.version = 2;
    assert!(response.validate_connection(&options).is_err());
    response.version = 3;
    response.validate_connection(&options).unwrap();
}

#[test]
fn local_scope_keeps_its_original_wire_version() {
    let options = ConnectionOptions::new("/profile", None, GrantSource::HostConfiguration, None);
    let value = serde_json::to_value(ConnectionPrelude::from_options(&options)).unwrap();
    assert_eq!(value["version"], 1);
    assert!(value.get("ssh").is_none());
    assert_eq!(
        serde_json::to_value(super::ControlPrelude::new(super::ControlCommand::Status)).unwrap()["version"],
        1
    );
}

#[test]
fn older_backend_supports_local_connections_but_rejects_ssh_scope() {
    let local = ConnectionOptions::new("/profile", None, GrantSource::HostConfiguration, None);
    let remote = local
        .clone()
        .with_ssh(SshConnectionOptions::new("build", None, "/runtime/bin").unwrap())
        .unwrap();
    let mut response = super::ControlResponse::new(
        super::ControlState::Running,
        1,
        "instance".into(),
        "schema".into(),
    );
    response.version = 1;
    response.validate_connection(&local).unwrap();
    assert!(response.validate_connection(&remote).is_err());
    response.version = 2;
    response.validate_connection(&remote).unwrap();
}

#[test]
fn ssh_scope_round_trips_without_local_directory_authority() {
    let ssh = SshConnectionOptions::new(
        "BUILD",
        Some("/remote/project"),
        "/runtime/ash-remote-server",
    )
    .unwrap();
    let options = ConnectionOptions::new("/profile", None, GrantSource::HostConfiguration, None)
        .with_ssh(ssh.clone())
        .unwrap();
    let mut bytes = serde_json::to_vec(&ConnectionPrelude::from_options(&options)).unwrap();
    bytes.push(b'\n');
    let super::IncomingPrelude::Connection(prelude) = decode_prelude(&bytes).unwrap() else {
        panic!("expected connection");
    };
    assert_eq!(prelude.ssh.unwrap().options().unwrap(), ssh);
    assert_eq!(options.dir_root(), None);
    assert_eq!(ssh.host(), "build");
}

#[test]
fn ssh_scope_rejects_ambiguous_or_unvalidated_authority() {
    let valid = serde_json::json!({"version":2, "dirGrantSource":"hostConfiguration", "ssh":{"host":"build","root":"/remote","runtime":"/runtime/ash-remote-server"}});
    for (field, value) in [
        ("version", serde_json::json!(1)),
        ("dirRoot", serde_json::json!("/local")),
        ("role", serde_json::json!("agents")),
        ("web", serde_json::json!({})),
    ] {
        let mut prelude = valid.clone();
        prelude[field] = value;
        let mut bytes = serde_json::to_vec(&prelude).unwrap();
        bytes.push(b'\n');
        assert!(decode_prelude(&bytes).is_err());
    }
    for (host, root, runtime) in [
        ("-option", Some("/remote"), "/runtime/bin"),
        ("build", Some("relative"), "/runtime/bin"),
        ("build", None, "ash-remote-server"),
    ] {
        assert!(SshConnectionOptions::new(host, root, runtime).is_err());
    }
    let ssh = SshConnectionOptions::new("build", None, "/runtime/bin").unwrap();
    assert!(
        ConnectionOptions::new(
            "/profile",
            Some("/local".into()),
            GrantSource::HostConfiguration,
            None
        )
        .with_ssh(ssh.clone())
        .is_err()
    );
    assert!(
        ConnectionOptions::new("/profile", None, GrantSource::HostConfiguration, None)
            .with_role(ConnectionRole::Agents)
            .with_ssh(ssh)
            .is_err()
    );
}
