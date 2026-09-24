use ash_remote_connections::RemoteConnectionCatalog;
use tempfile::TempDir;

use crate::launch::AppLaunch;
use crate::launch::RemoteRuntimeSource;
use crate::remote_connection_cli::AppInvocation;
use crate::remote_connection_cli::AppInvocationParseError;
use crate::remote_connection_cli::RemoteConnectionCommandParseError;

#[test]
fn non_remote_commands_preserve_the_existing_launch_surface() {
    let invocation = AppInvocation::parse([
        "--remote".into(),
        "build.example".into(),
        "--dir".into(),
        "/srv/project".into(),
    ])
    .unwrap();

    assert!(matches!(invocation, AppInvocation::Launch(_)));
}

#[test]
fn save_list_replace_remove_and_connect_form_one_credential_free_workflow() {
    let directory = TempDir::new().unwrap();
    let catalog = catalog(&directory);
    let mut output = Vec::new();

    let save = AppInvocation::parse([
        "remote".into(),
        "save".into(),
        "Build".into(),
        "--host".into(),
        "build.example".into(),
        "--dir".into(),
        "/srv/project".into(),
    ])
    .unwrap();
    assert!(
        save.resolve_with_catalog(&catalog, &mut output)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        String::from_utf8(output.clone()).unwrap(),
        "saved\tbuild\tbuild.example\t/srv/project\n"
    );

    output.clear();
    let list = AppInvocation::parse(["remote".into(), "list".into()]).unwrap();
    assert!(
        list.resolve_with_catalog(&catalog, &mut output)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        String::from_utf8(output.clone()).unwrap(),
        "build\tbuild.example\t/srv/project\n"
    );

    let duplicate = AppInvocation::parse([
        "remote".into(),
        "save".into(),
        "build".into(),
        "--host".into(),
        "other.example".into(),
        "--dir".into(),
        "/srv/other".into(),
    ])
    .unwrap();
    assert!(
        duplicate
            .resolve_with_catalog(&catalog, &mut output)
            .unwrap_err()
            .contains("already exists")
    );

    let replace = AppInvocation::parse([
        "remote".into(),
        "save".into(),
        "build".into(),
        "--host".into(),
        "other.example".into(),
        "--dir".into(),
        "/srv/other".into(),
        "--replace".into(),
    ])
    .unwrap();
    replace.resolve_with_catalog(&catalog, &mut output).unwrap();

    let connect = AppInvocation::parse([
        "remote".into(),
        "connect".into(),
        "build".into(),
        "--runtime".into(),
        "/opt/ash/bin/ash-remote-server".into(),
        "--ssh".into(),
        "/usr/bin/ssh".into(),
    ])
    .unwrap();
    let launch = connect
        .resolve_with_catalog(&catalog, &mut output)
        .unwrap()
        .unwrap();
    let AppLaunch::Remote {
        profile,
        ssh_executable,
        runtime_source,
    } = launch
    else {
        panic!("expected Remote launch");
    };
    assert_eq!(profile.target().host().as_str(), "other.example");
    assert_eq!(profile.target().dir().as_str(), "/srv/other");
    assert_eq!(
        profile.runtime().executable(),
        "/opt/ash/bin/ash-remote-server"
    );
    assert_eq!(ssh_executable.unwrap().to_string_lossy(), "/usr/bin/ssh");
    assert_eq!(runtime_source, RemoteRuntimeSource::ExplicitRuntime);

    let remove = AppInvocation::parse(["remote".into(), "remove".into(), "build".into()]).unwrap();
    remove.resolve_with_catalog(&catalog, &mut output).unwrap();
    assert!(catalog.connections().unwrap().is_empty());
}

#[test]
fn named_connections_cannot_be_overridden_by_raw_target_flags() {
    let error = AppInvocation::parse([
        "remote".into(),
        "connect".into(),
        "build".into(),
        "--remote".into(),
        "other".into(),
        "--dir".into(),
        "/srv/other".into(),
    ])
    .err()
    .unwrap();

    assert_eq!(
        error,
        AppInvocationParseError::Remote(RemoteConnectionCommandParseError::NamedTargetConflict)
    );
}

#[test]
fn save_requires_a_valid_name_host_and_absolute_dir() {
    let invalid_name = AppInvocation::parse([
        "remote".into(),
        "save".into(),
        "build server".into(),
        "--host".into(),
        "build".into(),
        "--dir".into(),
        "/srv/project".into(),
    ]);
    assert!(matches!(
        invalid_name,
        Err(AppInvocationParseError::Remote(
            RemoteConnectionCommandParseError::Name(_)
        ))
    ));

    let missing_host = AppInvocation::parse([
        "remote".into(),
        "save".into(),
        "build".into(),
        "--dir".into(),
        "/srv/project".into(),
    ]);
    assert!(matches!(
        missing_host,
        Err(AppInvocationParseError::Remote(
            RemoteConnectionCommandParseError::RequiredOption {
                command: "save",
                flag: "--host",
            }
        ))
    ));

    let relative_dir = AppInvocation::parse([
        "remote".into(),
        "save".into(),
        "build".into(),
        "--host".into(),
        "build".into(),
        "--dir".into(),
        "project".into(),
    ]);
    assert!(matches!(
        relative_dir,
        Err(AppInvocationParseError::Remote(
            RemoteConnectionCommandParseError::Address(_)
        ))
    ));
}

fn catalog(directory: &TempDir) -> RemoteConnectionCatalog {
    RemoteConnectionCatalog::new(directory.path().join("targets.json"))
}
