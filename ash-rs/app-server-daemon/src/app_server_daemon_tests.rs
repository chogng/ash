#[cfg(any(unix, windows))]
use super::ConnectionOptions;
#[cfg(any(unix, windows))]
use super::GrantSource;
use super::LifecycleOutput;
use super::LifecycleStatus;
#[cfg(any(unix, windows))]
use super::endpoint::endpoint_identity;

#[test]
#[cfg(any(unix, windows))]
fn endpoint_identity_is_shared_across_dirs() {
    let profile = tempfile::tempdir().unwrap();
    let first_dir = tempfile::tempdir().unwrap();
    let second_dir = tempfile::tempdir().unwrap();
    let first = ConnectionOptions::new(
        profile.path(),
        Some(first_dir.path().to_path_buf()),
        GrantSource::HostConfiguration,
        None,
    );
    let same = first.clone();
    let second = ConnectionOptions::new(
        profile.path(),
        Some(second_dir.path().to_path_buf()),
        GrantSource::HostConfiguration,
        None,
    );

    let first_identity = endpoint_identity(first.profile_root());
    let same_identity = endpoint_identity(same.profile_root());
    let second_identity = endpoint_identity(second.profile_root());

    assert_eq!(first_identity, same_identity);
    assert_eq!(first_identity, second_identity);
}

#[test]
#[cfg(any(unix, windows))]
fn endpoint_identity_is_shared_across_dir_grant_sources() {
    let profile = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let host = ConnectionOptions::new(
        profile.path(),
        Some(dir.path().to_path_buf()),
        GrantSource::HostConfiguration,
        None,
    );
    let user = ConnectionOptions::new(
        profile.path(),
        Some(dir.path().to_path_buf()),
        GrantSource::UserConfig,
        None,
    );

    assert_eq!(
        endpoint_identity(host.profile_root()),
        endpoint_identity(user.profile_root())
    );
}

#[test]
#[cfg(any(unix, windows))]
fn endpoint_identity_is_shared_across_product_service_adapters() {
    let profile = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let first_install = tempfile::tempdir().unwrap();
    let first_manifest = first_install.path().join("product-services.json");
    std::fs::write(&first_manifest, r#"{"schemaVersion":2,"marketplaces":[]}"#).unwrap();
    let first = ConnectionOptions::new(
        profile.path(),
        Some(dir.path().to_path_buf()),
        GrantSource::UserConfig,
        Some(first_manifest),
    );
    let second = ConnectionOptions::new(
        profile.path(),
        Some(dir.path().to_path_buf()),
        GrantSource::UserConfig,
        None,
    );

    assert_eq!(
        endpoint_identity(first.profile_root()),
        endpoint_identity(second.profile_root())
    );
}

#[test]
fn lifecycle_output_uses_one_stable_camel_case_json_contract() {
    let output = LifecycleOutput {
        status: LifecycleStatus::Running,
        pid: Some(42),
        instance_id: Some("instance".into()),
        daemon_version: "1.2.3".into(),
        installed_version: Some("1.2.4".into()),
        endpoint_path: "daemon.sock".into(),
        log_path: "daemon.log".into(),
        app_server_name: Some("ash-app-server".into()),
        schema_hash: Some("sha256:test".into()),
    };

    assert_eq!(
        serde_json::to_value(output).unwrap(),
        serde_json::json!({
            "status": "running",
            "pid": 42,
            "instanceId": "instance",
            "daemonVersion": "1.2.3",
            "installedVersion": "1.2.4",
            "endpointPath": "daemon.sock",
            "logPath": "daemon.log",
            "appServerName": "ash-app-server",
            "schemaHash": "sha256:test",
        })
    );
}
