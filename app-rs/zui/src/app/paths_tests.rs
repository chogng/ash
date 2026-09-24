use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use super::ApplicationPath;
use super::ApplicationPathConfig;
use super::ApplicationPathEnvironment;
use super::ApplicationPathError;
use super::ApplicationPathErrorCode;
use super::ApplicationPaths;

fn require_send_sync<T: Send + Sync>() {}

fn environment(root: &std::path::Path, logs_root: Option<PathBuf>) -> ApplicationPathEnvironment {
    let mut values = BTreeMap::new();
    values.insert(ApplicationPath::Executable, root.join("demo"));
    values.insert(ApplicationPath::Module, root.join("demo"));
    values.insert(ApplicationPath::Temporary, root.join("temporary"));
    values.insert(ApplicationPath::Home, root.join("home"));
    values.insert(ApplicationPath::AppData, root.join("app-data"));
    values.insert(ApplicationPath::Desktop, root.join("Desktop"));
    values.insert(ApplicationPath::Documents, root.join("Documents"));
    values.insert(ApplicationPath::Downloads, root.join("Downloads"));
    values.insert(ApplicationPath::Music, root.join("Music"));
    values.insert(ApplicationPath::Pictures, root.join("Pictures"));
    values.insert(ApplicationPath::Videos, root.join("Videos"));
    ApplicationPathEnvironment { values, logs_root }
}

#[test]
fn path_values_and_errors_cross_thread_boundaries() {
    require_send_sync::<ApplicationPath>();
    require_send_sync::<ApplicationPathError>();
    require_send_sync::<ApplicationPaths>();
}

#[test]
fn defaults_derive_product_owned_paths_without_creating_them() {
    let temporary = tempfile::tempdir().unwrap();
    let paths = ApplicationPaths::from_environment(
        ApplicationPathConfig::default(),
        environment(temporary.path(), None),
    )
    .unwrap();

    assert_eq!(paths.application_name(), "demo");
    assert_eq!(paths.application_version(), env!("CARGO_PKG_VERSION"));
    assert_eq!(paths.application_path(), temporary.path());
    let user_data = temporary.path().join("app-data").join("demo");
    assert_eq!(paths.path(ApplicationPath::UserData).unwrap(), user_data);
    assert_eq!(
        paths.path(ApplicationPath::SessionData).unwrap(),
        temporary.path().join("app-data").join("demo")
    );
    assert_eq!(
        paths.path(ApplicationPath::CrashDumps).unwrap(),
        temporary
            .path()
            .join("app-data")
            .join("demo")
            .join("Crashpad")
    );
    assert!(!temporary.path().join("app-data").exists());

    paths
        .set_application_name("Renamed Product".into())
        .unwrap();
    assert_eq!(paths.application_name(), "Renamed Product");
    assert_eq!(
        paths.path(ApplicationPath::UserData).unwrap(),
        temporary.path().join("app-data").join("demo")
    );
}

#[test]
fn app_data_override_is_applied_before_derived_paths() {
    let temporary = tempfile::tempdir().unwrap();
    let overridden = temporary.path().join("overridden-app-data");
    fs::create_dir(&overridden).unwrap();
    let mut config = ApplicationPathConfig::default();
    config.set_name("Product Name".into());
    config.set_override(ApplicationPath::AppData, overridden.clone());

    let paths =
        ApplicationPaths::from_environment(config, environment(temporary.path(), None)).unwrap();

    assert_eq!(
        paths.path(ApplicationPath::UserData).unwrap(),
        overridden.join("Product Name")
    );
    assert_eq!(
        paths.path(ApplicationPath::SessionData).unwrap(),
        overridden.join("Product Name")
    );
}

#[test]
fn log_queries_create_exact_platform_or_user_data_defaults() {
    let temporary = tempfile::tempdir().unwrap();
    let log_root = temporary.path().join("platform-logs");
    let platform_paths = ApplicationPaths::from_environment(
        ApplicationPathConfig::default(),
        environment(temporary.path(), Some(log_root.clone())),
    )
    .unwrap();
    let platform_logs = platform_paths.path(ApplicationPath::Logs).unwrap();
    assert_eq!(platform_logs, log_root.join("demo"));
    assert!(platform_logs.is_dir());

    let user_paths = ApplicationPaths::from_environment(
        ApplicationPathConfig::default(),
        environment(temporary.path(), None),
    )
    .unwrap();
    let user_logs = user_paths.path(ApplicationPath::Logs).unwrap();
    assert_eq!(
        user_logs,
        temporary.path().join("app-data").join("demo").join("logs")
    );
    assert!(user_logs.is_dir());
}

#[test]
fn set_path_requires_an_existing_absolute_location_of_the_right_type() {
    let temporary = tempfile::tempdir().unwrap();
    let paths = ApplicationPaths::from_environment(
        ApplicationPathConfig::default(),
        environment(temporary.path(), None),
    )
    .unwrap();
    let existing = temporary.path().join("existing");
    fs::create_dir(&existing).unwrap();
    paths
        .set_path(ApplicationPath::Downloads, existing.clone())
        .unwrap();
    assert_eq!(paths.path(ApplicationPath::Downloads).unwrap(), existing);

    let missing = paths
        .set_path(ApplicationPath::Downloads, temporary.path().join("missing"))
        .unwrap_err();
    assert_eq!(missing.code(), ApplicationPathErrorCode::InvalidOverride);
    assert_eq!(missing.path_name(), Some(ApplicationPath::Downloads));
    assert!(missing.source().is_some());

    let relative = paths
        .set_path(ApplicationPath::Downloads, "relative".into())
        .unwrap_err();
    assert_eq!(relative.code(), ApplicationPathErrorCode::InvalidOverride);
    let wrong_type = paths
        .set_path(ApplicationPath::Executable, temporary.path().to_path_buf())
        .unwrap_err();
    assert_eq!(wrong_type.code(), ApplicationPathErrorCode::InvalidOverride);
}

#[test]
fn app_logs_setter_creates_directories_while_generic_setter_does_not() {
    let temporary = tempfile::tempdir().unwrap();
    let paths = ApplicationPaths::from_environment(
        ApplicationPathConfig::default(),
        environment(temporary.path(), None),
    )
    .unwrap();
    let logs = temporary.path().join("custom").join("logs");

    assert!(paths.set_path(ApplicationPath::Logs, logs.clone()).is_err());
    paths.set_app_logs_path(logs.clone()).unwrap();
    assert!(logs.is_dir());
    assert_eq!(paths.path(ApplicationPath::Logs).unwrap(), logs);
}

#[test]
fn invalid_names_and_platform_only_paths_report_stable_categories() {
    let temporary = tempfile::tempdir().unwrap();
    let mut config = ApplicationPathConfig::default();
    config.set_name("parent/child".into());
    let invalid = ApplicationPaths::from_environment(config, environment(temporary.path(), None))
        .err()
        .unwrap();
    assert_eq!(invalid.code(), ApplicationPathErrorCode::Initialization);

    let paths = ApplicationPaths::from_environment(
        ApplicationPathConfig::default(),
        environment(temporary.path(), None),
    )
    .unwrap();
    if !ApplicationPath::Recent.is_supported() {
        let unsupported = paths.path(ApplicationPath::Recent).unwrap_err();
        assert_eq!(unsupported.code(), ApplicationPathErrorCode::Unsupported);
        assert_eq!(unsupported.path_name(), Some(ApplicationPath::Recent));
    }
}

#[test]
fn custom_versions_are_validated_and_retained_verbatim() {
    let temporary = tempfile::tempdir().unwrap();
    let mut config = ApplicationPathConfig::default();
    config.set_version("2.3.4-beta.1".into());
    let paths =
        ApplicationPaths::from_environment(config, environment(temporary.path(), None)).unwrap();
    assert_eq!(paths.application_version(), "2.3.4-beta.1");

    let mut invalid_config = ApplicationPathConfig::default();
    invalid_config.set_version("not a version".into());
    let invalid =
        ApplicationPaths::from_environment(invalid_config, environment(temporary.path(), None))
            .err()
            .unwrap();
    assert_eq!(invalid.code(), ApplicationPathErrorCode::Initialization);
    assert!(invalid.source().is_some());
}

#[test]
fn production_detection_captures_the_real_executable_and_application_directory() {
    let paths = ApplicationPaths::detect(ApplicationPathConfig::default()).unwrap();
    let executable = std::env::current_exe().unwrap();

    assert_eq!(paths.path(ApplicationPath::Executable).unwrap(), executable);
    assert_eq!(paths.application_path(), executable.parent().unwrap());
    assert!(
        paths
            .path(ApplicationPath::Temporary)
            .unwrap()
            .is_absolute()
    );
}
