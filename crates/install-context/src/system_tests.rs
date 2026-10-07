use super::SystemExecutables;
use super::executable_name;
use crate::HostExecutableName;
use crate::tests::TestDirectory;
use std::fs;
use std::io;
use std::path::Path;

fn executable(directory: &Path, name: &HostExecutableName) -> std::path::PathBuf {
    let path = directory.join(executable_name(name));
    fs::write(&path, b"test executable").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    path
}

#[test]
fn installed_search_ignores_ambient_candidates_and_preserves_precedence() {
    let directory = TestDirectory::new();
    let first = directory.path().join("first");
    let second = directory.path().join("second");
    let workspace = directory.path().join("workspace");
    for path in [&first, &second, &workspace] {
        fs::create_dir(path).unwrap();
    }
    let name = HostExecutableName::new("helper").unwrap();
    executable(&workspace, &name);
    let system = SystemExecutables::from_directories(
        vec![first.clone(), second.clone()],
        vec![first.clone(), second.clone()],
    );
    assert_eq!(
        system.find(&name).unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
    let second_executable = executable(&second, &name);
    assert_eq!(
        system.find(&name).unwrap(),
        dunce::canonicalize(second_executable).unwrap()
    );
    let first_executable = executable(&first, &name);
    assert_eq!(
        system.find(&name).unwrap(),
        dunce::canonicalize(first_executable).unwrap()
    );
    assert_eq!(
        std::env::split_paths(&system.search_path().unwrap()).collect::<Vec<_>>(),
        vec![
            dunce::canonicalize(first).unwrap(),
            dunce::canonicalize(second).unwrap()
        ]
    );
}

#[test]
fn directories_and_empty_search_are_explicit_errors() {
    let directory = TestDirectory::new();
    let name = HostExecutableName::new("helper").unwrap();
    fs::create_dir(directory.path().join(executable_name(&name))).unwrap();
    let system = SystemExecutables::from_directories(
        vec![directory.path().to_path_buf()],
        vec![directory.path().to_path_buf()],
    );
    assert_eq!(
        system.find(&name).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    assert!(
        SystemExecutables::from_directories(vec![], vec![])
            .search_path()
            .is_err()
    );
    for name in ["../helper", "a/b", "a\\b", "", ".", "a\0b"] {
        assert!(HostExecutableName::new(name).is_err());
    }
}

#[cfg(unix)]
#[test]
fn links_outside_installation_roots_and_non_executable_files_are_rejected() {
    use std::os::unix::fs::PermissionsExt;
    let installed = TestDirectory::new();
    let outside = TestDirectory::new();
    let name = HostExecutableName::new("helper").unwrap();
    let target = executable(outside.path(), &name);
    let link = installed.path().join(executable_name(&name));
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let system = SystemExecutables::from_directories(
        vec![installed.path().into()],
        vec![installed.path().into()],
    );
    assert_eq!(
        system.find(&name).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    fs::remove_file(link).unwrap();
    let file = executable(installed.path(), &name);
    fs::set_permissions(file, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        system.find(&name).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
}

#[cfg(windows)]
#[test]
fn windows_names_cannot_address_drives_or_streams_and_keep_one_exe_suffix() {
    for name in ["C:helper", "helper:stream"] {
        assert!(HostExecutableName::new(name).is_err());
    }
    for name in ["helper", "helper.exe"] {
        assert_eq!(
            executable_name(&HostExecutableName::new(name).unwrap()),
            "helper.exe"
        );
    }
}
