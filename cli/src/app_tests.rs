use super::*;

#[test]
fn executable_launch_preserves_workspace_as_one_positional_argument() {
    let root = tempfile::tempdir().unwrap();
    let app = root.path().join("Ash executable");
    std::fs::write(&app, "fixture").unwrap();
    let workspace = root.path().join("-project with 'quotes' and {0}");
    let command = launch_command(&app, &workspace).unwrap();
    assert_eq!(command.get_program(), app);
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        [std::ffi::OsStr::new("--"), workspace.as_os_str()]
    );
}

#[test]
fn directory_is_not_an_application_executable() {
    let root = tempfile::tempdir().unwrap();
    assert!(launch_command(root.path(), root.path()).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn bundle_launch_uses_launch_services_and_forwards_to_existing_instances() {
    let root = tempfile::tempdir().unwrap();
    let app = root.path().join("Ash.app");
    std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    std::fs::write(app.join("Contents/MacOS/Ash"), "fixture").unwrap();
    let command = launch_command(&app, root.path()).unwrap();
    assert_eq!(command.get_program(), "/usr/bin/open");
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        [
            std::ffi::OsStr::new("-n"),
            std::ffi::OsStr::new("-a"),
            app.as_os_str(),
            std::ffi::OsStr::new("--args"),
            std::ffi::OsStr::new("--"),
            root.path().as_os_str(),
        ]
    );
}
