use super::*;
use ash_file_access::Dir;
use ash_file_access::GrantSource;
use ash_file_access::Permissions;

#[test]
fn exact_file_system_keeps_original_permissions_and_denies_directories_and_transfers() {
    let directory = tempfile::tempdir().unwrap();
    let relative = Path::new("current.ash-workspace");
    let path = directory.path().join(relative);
    std::fs::write(&path, "{}").unwrap();
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::ReadFiles, Permission::BrowseFiles]),
    );
    let files = ExactFileSystem::new(grant.clone(), relative).unwrap();
    assert_eq!(files.read_file(relative, 1024).unwrap(), b"{}");
    assert!(files.write_file(relative, b"updated", 1024).is_err());
    assert!(files.read_directory(Path::new(".")).is_err());
    assert!(files.create_directory(relative).is_err());
    assert!(
        files
            .rename(relative, Path::new("other"), ExistingTargetBehavior::Error)
            .is_err()
    );
    assert!(
        files
            .delete(
                relative,
                MissingTargetBehavior::Error,
                FileDeleteMode::Recursive
            )
            .is_err()
    );
    grant.revoke();
    assert!(files.read_file(relative, 1024).is_err());
}

#[test]
fn exact_file_system_rejects_directory_registration_and_file_replacement_by_a_directory() {
    let directory = tempfile::tempdir().unwrap();
    let relative = Path::new("current.ash-workspace");
    let path = directory.path().join(relative);
    std::fs::create_dir(&path).unwrap();
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([
            Permission::ReadFiles,
            Permission::BrowseFiles,
            Permission::WriteFiles,
        ]),
    );
    assert!(ExactFileSystem::new(grant.clone(), relative).is_err());
    std::fs::remove_dir(&path).unwrap();
    std::fs::write(&path, "{}").unwrap();
    let files = ExactFileSystem::new(grant, relative).unwrap();
    files.write_file(relative, b"atomic update", 1024).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"atomic update");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("protected.txt"), "keep").unwrap();
    assert!(files.get_metadata(relative).is_err());
    assert!(files.read_directory(relative).is_err());
    assert!(
        files
            .write_file(relative, b"replace directory", 1024)
            .is_err()
    );
    assert!(
        files
            .delete(
                relative,
                MissingTargetBehavior::Error,
                FileDeleteMode::Recursive
            )
            .is_err()
    );
    assert_eq!(std::fs::read(path.join("protected.txt")).unwrap(), b"keep");
}
