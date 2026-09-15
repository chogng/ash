use crate::launch::AppLaunch;
use crate::launch::LaunchParseError;
use crate::launch::RemoteRuntimeSource;
#[cfg(unix)]
use crate::launch_test_support::make_executable;
#[cfg(unix)]
use crate::launch_test_support::{incompatible_initialize_response, initialize_response};
#[cfg(unix)]
use ash_app_server_protocol::schema_hash;
use ash_remote::RemoteDirPath;
use ash_remote::RemoteProfile;
use ash_remote::RemoteRuntime;
use ash_remote::SshHost;
use ash_remote::SshTarget;

#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::num::NonZeroU64;
#[cfg(unix)]
use std::path::Path;

#[cfg(unix)]
use ash_remote_connections::RemoteConnectionProfileStore;
#[cfg(unix)]
use flate2::Compression;
#[cfg(unix)]
use flate2::write::GzEncoder;
#[cfg(unix)]
use serde_json::json;
#[cfg(unix)]
use sha2::Digest;
#[cfg(unix)]
use sha2::Sha256;
#[cfg(unix)]
use tar::Builder;
#[cfg(unix)]
use tar::EntryType;
#[cfg(unix)]
use tar::Header;

#[test]
fn no_arguments_select_the_local_target() {
    assert_eq!(AppLaunch::parse([]).unwrap(), AppLaunch::Local);
}

#[test]
fn remote_arguments_build_one_credential_free_profile() {
    let launch = AppLaunch::parse([
        "--remote".to_owned(),
        "build.example".to_owned(),
        "--dir".to_owned(),
        "/srv/project".to_owned(),
        "--runtime".to_owned(),
        "/opt/ash/bin/ash-remote-server".to_owned(),
        "--ssh".to_owned(),
        "/usr/local/bin/ssh".to_owned(),
    ])
    .unwrap();
    assert_eq!(
        launch,
        AppLaunch::Remote {
            profile: RemoteProfile::new(
                SshTarget::new(
                    SshHost::parse("build.example").unwrap(),
                    RemoteDirPath::parse("/srv/project").unwrap(),
                ),
                RemoteRuntime::new("/opt/ash/bin/ash-remote-server").unwrap(),
            ),
            ssh_executable: Some("/usr/local/bin/ssh".into()),
            runtime_source: RemoteRuntimeSource::ExplicitRuntime,
        }
    );
}

#[test]
fn remote_arguments_default_to_the_remote_runtime() {
    let launch = AppLaunch::parse([
        "--remote".to_owned(),
        "build.example".to_owned(),
        "--dir".to_owned(),
        "/srv/project".to_owned(),
    ])
    .unwrap();
    let AppLaunch::Remote {
        profile,
        runtime_source,
        ..
    } = launch
    else {
        panic!("expected Remote launch");
    };
    assert_eq!(profile.runtime().executable(), "ash-remote-server");
    assert_eq!(
        runtime_source,
        RemoteRuntimeSource::DefaultRuntime { catalog: None }
    );
}

#[test]
fn remote_dir_requires_a_remote_host() {
    assert_eq!(
        AppLaunch::parse(["--dir".to_owned(), "/srv/project".to_owned()]),
        Err(LaunchParseError::RemoteFlagRequired)
    );
}

#[test]
fn remote_launch_requires_an_absolute_path() {
    assert!(matches!(
        AppLaunch::parse([
            "--remote".to_owned(),
            "build".to_owned(),
            "--dir".to_owned(),
            "project".to_owned(),
        ]),
        Err(LaunchParseError::Address(_))
    ));
}

#[cfg(unix)]
#[test]
fn remote_launch_checks_runtime_readiness_before_starting_the_ui() {
    let directory = tempfile::tempdir().unwrap();
    let fake_ssh = directory.path().join("fake-ssh");
    let response = initialize_response(&schema_hash());
    fs::write(
        &fake_ssh,
        format!(
            "#!/bin/sh\ncommand=''\nfor argument in \"$@\"; do command=$argument; done\ncase \"$command\" in\n  *\"'connect'\"*) IFS= read -r request || exit 65; printf '%s\\n' '{response}' ;;\n  *missing*) printf '%s\\n' '__ASH_REMOTE_RUNTIME_MISSING__'; exit 127 ;;\n  *) printf '%s\\n' '__ASH_REMOTE_RUNTIME_FOUND__:/srv/ash/bin/ash-remote-server' ;;\nesac\n"
        ),
    )
    .unwrap();
    make_executable(&fake_ssh);

    let mut ready = AppLaunch::parse([
        "--remote".to_owned(),
        "build".to_owned(),
        "--dir".to_owned(),
        "/srv/project".to_owned(),
        "--ssh".to_owned(),
        fake_ssh.to_string_lossy().into_owned(),
    ])
    .unwrap();
    assert!(
        ready
            .prepare_remote_runtime_with_store(&profile_store(&directory))
            .is_ok()
    );

    let mut missing = AppLaunch::parse([
        "--remote".to_owned(),
        "build".to_owned(),
        "--dir".to_owned(),
        "/srv/project".to_owned(),
        "--runtime".to_owned(),
        "missing".to_owned(),
        "--ssh".to_owned(),
        fake_ssh.to_string_lossy().into_owned(),
    ])
    .unwrap();
    let error = missing
        .prepare_remote_runtime_with_store(&profile_store(&directory))
        .unwrap_err();
    assert!(error.contains("not executable"));
    assert!(error.contains("will not replace it automatically"));
}

#[cfg(unix)]
#[test]
fn explicit_incompatible_runtime_is_not_replaced_and_transport_failure_never_installs() {
    let directory = tempfile::tempdir().unwrap();
    let incompatible_ssh = directory.path().join("incompatible-ssh");
    let obsolete_response = incompatible_initialize_response("obsolete-schema");
    fs::write(
        &incompatible_ssh,
        format!(
            "#!/bin/sh\ncommand=''\nfor argument in \"$@\"; do command=$argument; done\ncase \"$command\" in\n  *\"'connect'\"*) IFS= read -r request || exit 65; printf '%s\\n' '{obsolete_response}' ;;\n  *__ASH_REMOTE_RUNTIME_FOUND__*) printf '%s\\n' '__ASH_REMOTE_RUNTIME_FOUND__:/opt/ash/bin/ash-remote-server' ;;\n  *) exit 64 ;;\nesac\n"
        ),
    )
    .unwrap();
    make_executable(&incompatible_ssh);
    let mut explicit = AppLaunch::parse([
        "--remote".into(),
        "build".into(),
        "--dir".into(),
        "/srv/project".into(),
        "--runtime".into(),
        "/opt/ash/bin/ash-remote-server".into(),
        "--ssh".into(),
        incompatible_ssh.to_string_lossy().into_owned(),
    ])
    .unwrap();
    let error = explicit
        .prepare_remote_runtime_with_store(&profile_store(&directory))
        .unwrap_err();
    assert!(error.contains("protocol major mismatch"));
    assert!(error.contains("will not replace it automatically"));

    let transport_ssh = directory.path().join("transport-ssh");
    fs::write(
        &transport_ssh,
        "#!/bin/sh\nprintf '%s\\n' 'transport-failed' >&2\nexit 255\n",
    )
    .unwrap();
    make_executable(&transport_ssh);
    let mut transport = AppLaunch::parse([
        "--remote".into(),
        "build".into(),
        "--dir".into(),
        "/srv/project".into(),
        "--ssh".into(),
        transport_ssh.to_string_lossy().into_owned(),
        "--runtime-catalog".into(),
        "/catalog/must-not-be-read.json".into(),
        "--runtime-catalog-sha256".into(),
        "0".repeat(64),
    ])
    .unwrap();
    let error = transport
        .prepare_remote_runtime_with_store(&profile_store(&directory))
        .unwrap_err();
    assert!(error.contains("transport-failed"));
    assert!(!error.contains("catalog"));
}

#[cfg(unix)]
#[test]
fn missing_default_runtime_is_installed_from_the_authenticated_catalog() {
    let directory = tempfile::tempdir().unwrap();
    let artifacts = directory.path().join("artifacts");
    fs::create_dir(&artifacts).unwrap();
    let artifact = create_runtime_archive(&artifacts);
    let catalog = json!({
        "formatVersion": 1,
        "artifacts": [{
            "version": "0.1.0",
            "target": "x86_64-unknown-linux-gnu",
            "archive": "artifacts/runtime.tar.gz",
            "archiveSize": artifact.archive_size,
            "unpackedSize": artifact.unpacked_size,
            "sha256": artifact.sha256,
        }],
    });
    let catalog_bytes = serde_json::to_vec(&catalog).unwrap();
    let catalog_path = directory.path().join("catalog.json");
    fs::write(&catalog_path, &catalog_bytes).unwrap();
    let catalog_sha256 = format!("{:x}", Sha256::digest(&catalog_bytes));
    let installed_runtime = format!(
        "/srv/ash/runtimes/x86_64-unknown-linux-gnu/0.1.0/{}/bin/ash-remote-server",
        artifact.sha256
    );
    let state = directory.path().join("installed");
    let fake_ssh = directory.path().join("fake-ssh");
    write_installing_fake_ssh(
        &fake_ssh,
        &state,
        &artifact.sha256,
        &installed_runtime,
        InitialRemoteRuntime::Missing,
    );

    let mut launch = AppLaunch::parse([
        "--remote".into(),
        "build".into(),
        "--dir".into(),
        "/srv/project".into(),
        "--ssh".into(),
        fake_ssh.to_string_lossy().into_owned(),
        "--runtime-catalog".into(),
        catalog_path.to_string_lossy().into_owned(),
        "--runtime-catalog-sha256".into(),
        catalog_sha256,
    ])
    .unwrap();

    let store = profile_store(&directory);
    launch.prepare_remote_runtime_with_store(&store).unwrap();

    let AppLaunch::Remote { profile, .. } = launch else {
        panic!("expected Remote launch");
    };
    assert_eq!(profile.runtime().executable(), installed_runtime);
    assert!(state.is_file());
    assert_eq!(fs::read_to_string(&state).unwrap(), "install\n");
    assert_eq!(
        store.connections().unwrap()[0]
            .active_runtime()
            .executable(),
        installed_runtime
    );

    let mut reconnect = AppLaunch::parse([
        "--remote".into(),
        "build".into(),
        "--dir".into(),
        "/srv/project".into(),
        "--ssh".into(),
        fake_ssh.to_string_lossy().into_owned(),
    ])
    .unwrap();
    reconnect.prepare_remote_runtime_with_store(&store).unwrap();
    let AppLaunch::Remote { profile, .. } = reconnect else {
        panic!("expected Remote launch");
    };
    assert_eq!(profile.runtime().executable(), installed_runtime);
    assert_eq!(fs::read_to_string(state).unwrap(), "install\n");
}

#[cfg(unix)]
#[test]
fn incompatible_default_runtime_is_replaced_from_the_authenticated_catalog() {
    let directory = tempfile::tempdir().unwrap();
    let artifacts = directory.path().join("artifacts");
    fs::create_dir(&artifacts).unwrap();
    let artifact = create_runtime_archive(&artifacts);
    let catalog = json!({
        "formatVersion": 1,
        "artifacts": [{
            "version": "0.1.0",
            "target": "x86_64-unknown-linux-gnu",
            "archive": "artifacts/runtime.tar.gz",
            "archiveSize": artifact.archive_size,
            "unpackedSize": artifact.unpacked_size,
            "sha256": artifact.sha256,
        }],
    });
    let catalog_bytes = serde_json::to_vec(&catalog).unwrap();
    let catalog_path = directory.path().join("catalog.json");
    fs::write(&catalog_path, &catalog_bytes).unwrap();
    let catalog_sha256 = format!("{:x}", Sha256::digest(&catalog_bytes));
    let installed_runtime = format!(
        "/srv/ash/runtimes/x86_64-unknown-linux-gnu/0.1.0/{}/bin/ash-remote-server",
        artifact.sha256
    );
    let state = directory.path().join("installed");
    let fake_ssh = directory.path().join("fake-ssh");
    write_installing_fake_ssh(
        &fake_ssh,
        &state,
        &artifact.sha256,
        &installed_runtime,
        InitialRemoteRuntime::Incompatible,
    );

    let mut launch = AppLaunch::parse([
        "--remote".into(),
        "build".into(),
        "--dir".into(),
        "/srv/project".into(),
        "--ssh".into(),
        fake_ssh.to_string_lossy().into_owned(),
        "--runtime-catalog".into(),
        catalog_path.to_string_lossy().into_owned(),
        "--runtime-catalog-sha256".into(),
        catalog_sha256,
    ])
    .unwrap();

    launch
        .prepare_remote_runtime_with_store(&profile_store(&directory))
        .unwrap();

    let AppLaunch::Remote { profile, .. } = launch else {
        panic!("expected Remote launch");
    };
    assert_eq!(profile.runtime().executable(), installed_runtime);
    assert!(state.is_file());
}

#[cfg(unix)]
#[derive(Clone, Copy)]
enum InitialRemoteRuntime {
    Missing,
    Incompatible,
}

#[cfg(unix)]
fn write_installing_fake_ssh(
    path: &Path,
    state: &Path,
    artifact_sha256: &str,
    installed_runtime: &str,
    initial_runtime: InitialRemoteRuntime,
) {
    let initial_probe = match initial_runtime {
        InitialRemoteRuntime::Missing => {
            "printf '%s\\n' '__ASH_REMOTE_RUNTIME_MISSING__'; exit 127"
        }
        InitialRemoteRuntime::Incompatible => {
            "printf '%s\\n' '__ASH_REMOTE_RUNTIME_FOUND__:/usr/bin/ash-remote-server'"
        }
    };
    let current_response = initialize_response(&schema_hash());
    let obsolete_response = incompatible_initialize_response("obsolete-schema");
    fs::write(
        path,
        format!(
            "#!/bin/sh\ncommand=''\nfor argument in \"$@\"; do command=$argument; done\ncase \"$command\" in\n  *\"'connect'\"*) IFS= read -r request || exit 65; if [ -f '{}' ]; then printf '%s\\n' '{}'; else printf '%s\\n' '{}'; fi ;;\n  *__ASH_REMOTE_PLATFORM__*) printf '%s\\n' '__ASH_REMOTE_PLATFORM__:linux:x86_64:gnu' ;;\n  *__ASH_REMOTE_RUNTIME_INSTALLED__*) cat >/dev/null; printf '%s\\n' install >> '{}'; printf '%s\\n' '__ASH_REMOTE_RUNTIME_INSTALLED__:{}:{}' ;;\n  *__ASH_REMOTE_RUNTIME_FOUND__*) if [ -f '{}' ]; then printf '%s\\n' '__ASH_REMOTE_RUNTIME_FOUND__:{}'; else {}; fi ;;\n  *) exit 64 ;;\nesac\n",
            state.display(),
            current_response,
            obsolete_response,
            state.display(),
            artifact_sha256,
            installed_runtime,
            state.display(),
            installed_runtime,
            initial_probe,
        ),
    )
    .unwrap();
    make_executable(path);
}

#[cfg(unix)]
struct TestRuntimeArtifact {
    archive_size: u64,
    unpacked_size: u64,
    sha256: String,
}

#[cfg(unix)]
fn create_runtime_archive(directory: &Path) -> TestRuntimeArtifact {
    let path = directory.join("runtime.tar.gz");
    let encoder = GzEncoder::new(File::create(&path).unwrap(), Compression::default());
    let mut builder = Builder::new(encoder);
    let metadata = serde_json::to_vec(&json!({
        "layoutVersion": 2,
        "version": "0.1.0",
        "target": "x86_64-unknown-linux-gnu",
        "entrypoint": "bin/ash-app-server",
        "pathDir": "ash-path",
        "resourcesDir": "ash-resources",
        "javascriptRuntime": { "kind": "packagedNode" },
        "components": {},
    }))
    .unwrap();
    let mut unpacked_size = append_archive_file(&mut builder, "ash-package.json", &metadata, 0o644);
    unpacked_size += append_archive_file(
        &mut builder,
        "bin/ash-remote-server",
        b"ash-remote-server",
        0o755,
    );
    unpacked_size +=
        append_archive_file(&mut builder, "bin/ash-app-server-daemon", b"daemon", 0o755);
    unpacked_size += append_archive_file(&mut builder, "bin/ash-app-server", b"app-server", 0o755);
    unpacked_size += append_archive_file(&mut builder, "ash-path/rg", b"rg", 0o755);
    unpacked_size +=
        append_archive_file(&mut builder, "ash-resources/node/bin/node", b"node", 0o755);
    builder.into_inner().unwrap().finish().unwrap();
    let bytes = fs::read(path).unwrap();
    TestRuntimeArtifact {
        archive_size: bytes.len() as u64,
        unpacked_size: NonZeroU64::new(unpacked_size).unwrap().get(),
        sha256: format!("{:x}", Sha256::digest(bytes)),
    }
}

#[cfg(unix)]
fn append_archive_file(
    builder: &mut Builder<GzEncoder<File>>,
    path: &str,
    bytes: &[u8],
    mode: u32,
) -> u64 {
    let mut header = Header::new_gnu();
    header.set_entry_type(EntryType::Regular);
    header.set_size(bytes.len() as u64);
    header.set_mode(mode);
    header.set_cksum();
    builder.append_data(&mut header, path, bytes).unwrap();
    bytes.len() as u64
}

#[cfg(unix)]
fn profile_store(directory: &tempfile::TempDir) -> RemoteConnectionProfileStore {
    RemoteConnectionProfileStore::new(directory.path().join("remote-connections.json"))
}
