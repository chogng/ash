use super::*;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

#[test]
fn lists_metadata_and_bounded_file_content_inside_dir() {
    let dir = TestDir::new();
    fs::create_dir(dir.path.join("src")).unwrap();
    fs::write(dir.path.join("src/lib.rs"), "hello").unwrap();
    let file_system = dir.file_system();

    assert_eq!(
        file_system.read_directory(Path::new("src")).unwrap(),
        vec![DirectoryEntry {
            name: "lib.rs".into(),
            file_type: FileType::File,
        }],
    );
    assert_eq!(
        file_system.read_file(Path::new("src/lib.rs"), 5).unwrap(),
        b"hello",
    );
    let metadata = file_system.get_metadata(Path::new("src/lib.rs")).unwrap();
    assert_eq!(metadata.file_type, FileType::File);
    assert_eq!(metadata.size_bytes, 5);
}

#[test]
fn rejects_parent_traversal_and_read_overflow() {
    let dir = TestDir::new();
    fs::write(dir.path.join("large.txt"), "123456").unwrap();
    let file_system = dir.file_system();

    assert!(matches!(
        file_system.get_metadata(Path::new("../outside")),
        Err(FileSystemError::InvalidPath(_)),
    ));
    assert_eq!(
        file_system.read_file(Path::new("large.txt"), 5),
        Err(FileSystemError::ReadLimitExceeded { maximum_bytes: 5 }),
    );
}

#[test]
fn atomically_replaces_and_creates_bounded_files() {
    let dir = TestDir::new();
    fs::create_dir(dir.path.join("src")).unwrap();
    fs::write(dir.path.join("src/lib.rs"), "old").unwrap();
    let file_system = dir.file_system();

    let replaced = file_system
        .write_file(Path::new("src/lib.rs"), b"updated", 7)
        .unwrap();
    let created = file_system
        .write_file(Path::new("src/new.rs"), b"new", 7)
        .unwrap();

    assert_eq!(fs::read(dir.path.join("src/lib.rs")).unwrap(), b"updated");
    assert_eq!(fs::read(dir.path.join("src/new.rs")).unwrap(), b"new");
    assert_eq!(replaced.size_bytes, 7);
    assert_eq!(created.size_bytes, 3);
}

#[test]
fn conditionally_writes_only_the_revision_that_was_read() {
    let dir = TestDir::new();
    fs::write(dir.path.join("document.txt"), "first").unwrap();
    let file_system = dir.file_system();
    let read = file_system
        .read_file_with_revision(Path::new("document.txt"), 1024)
        .unwrap();

    file_system
        .write_file_with_condition(
            Path::new("document.txt"),
            b"second",
            1024,
            &FileWriteCondition::ExpectedRevision(read.revision.clone()),
        )
        .unwrap();
    assert_eq!(
        file_system.write_file_with_condition(
            Path::new("document.txt"),
            b"stale",
            1024,
            &FileWriteCondition::ExpectedRevision(read.revision),
        ),
        Err(FileSystemError::RevisionConflict(PathBuf::from(
            "document.txt"
        ))),
    );
    assert_eq!(
        fs::read_to_string(dir.path.join("document.txt")).unwrap(),
        "second"
    );
}

#[test]
fn rejects_unsafe_or_oversized_write_targets() {
    let dir = TestDir::new();
    fs::create_dir(dir.path.join("src")).unwrap();
    let file_system = dir.file_system();

    assert!(matches!(
        file_system.write_file(Path::new("../outside"), b"content", 7),
        Err(FileSystemError::InvalidPath(_)),
    ));
    assert_eq!(
        file_system.write_file(Path::new("src/large.txt"), b"123456", 5),
        Err(FileSystemError::WriteLimitExceeded { maximum_bytes: 5 }),
    );
    assert!(matches!(
        file_system.write_file(Path::new("missing/file.txt"), b"content", 7),
        Err(FileSystemError::Io(_)),
    ));
    assert!(matches!(
        file_system.write_file(Path::new("src"), b"content", 7),
        Err(FileSystemError::NotFile(_)),
    ));
}

#[test]
fn creates_renames_overwrites_and_deletes_dir_files() {
    let dir = TestDir::new();
    fs::write(dir.path.join("source.txt"), "source").unwrap();
    fs::write(dir.path.join("target.txt"), "target").unwrap();
    let file_system = dir.file_system();

    file_system
        .create_file(Path::new("created.txt"), ExistingTargetBehavior::Error)
        .unwrap();
    file_system
        .rename(
            Path::new("source.txt"),
            Path::new("target.txt"),
            ExistingTargetBehavior::Overwrite,
        )
        .unwrap();
    file_system
        .delete(
            Path::new("created.txt"),
            MissingTargetBehavior::Error,
            FileDeleteMode::FileOrEmptyDirectory,
        )
        .unwrap();
    file_system
        .delete(
            Path::new("created.txt"),
            MissingTargetBehavior::Ignore,
            FileDeleteMode::FileOrEmptyDirectory,
        )
        .unwrap();

    assert_eq!(
        fs::read_to_string(dir.path.join("target.txt")).unwrap(),
        "source"
    );
    assert!(!dir.path.join("source.txt").exists());
    assert!(!dir.path.join("created.txt").exists());
}

#[cfg(unix)]
#[test]
fn preserves_existing_file_permissions_during_replacement() {
    use std::os::unix::fs::PermissionsExt;

    let dir = TestDir::new();
    let path = dir.path.join("script.sh");
    fs::write(&path, "old").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    let file_system = dir.file_system();

    file_system
        .write_file(Path::new("script.sh"), b"new", 3)
        .unwrap();

    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new() -> Self {
        let sequence = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ash-file-system-tests-{}-{sequence}",
            std::process::id(),
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn file_system(&self) -> LocalFileSystem {
        LocalFileSystem::new(ash_file_access::Grant::for_environment(
            Dir::open_local(&self.path).unwrap(),
            ash_file_access::GrantSource::ExplicitUser,
            ash_file_access::Permissions::new([
                ash_file_access::Permission::ReadFiles,
                ash_file_access::Permission::WriteFiles,
                ash_file_access::Permission::BrowseFiles,
            ]),
        ))
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn a_read_authorization_cannot_mutate_or_browse() {
    let directory = TestDir::new();
    fs::write(directory.path.join("file"), "old").unwrap();
    let grant = ash_file_access::Grant::for_environment(
        Dir::open_local(&directory.path).unwrap(),
        ash_file_access::GrantSource::ExplicitUser,
        ash_file_access::Permissions::new([ash_file_access::Permission::ReadFiles]),
    );
    let files = LocalFileSystem::from_authorization(
        grant
            .authorize(ash_file_access::Permission::ReadFiles)
            .unwrap(),
    );
    assert_eq!(files.read_file(Path::new("file"), 10).unwrap(), b"old");
    assert!(files.write_file(Path::new("file"), b"new", 10).is_err());
    assert!(
        files
            .write_file_with_condition(
                Path::new("file"),
                b"new",
                10,
                &FileWriteCondition::Unconditional
            )
            .is_err()
    );
    assert!(
        files
            .create_file(Path::new("created"), ExistingTargetBehavior::Error)
            .is_err()
    );
    assert!(
        files
            .rename(
                Path::new("file"),
                Path::new("moved"),
                ExistingTargetBehavior::Error
            )
            .is_err()
    );
    assert!(
        files
            .delete(
                Path::new("file"),
                MissingTargetBehavior::Error,
                FileDeleteMode::FileOrEmptyDirectory
            )
            .is_err()
    );
    assert!(files.create_directory(Path::new("created-dir")).is_err());
    assert!(files.read_directory(Path::new("")).is_err());
    assert!(files.get_metadata(Path::new("file")).is_err());
    grant.revoke();
    assert!(files.read_file(Path::new("file"), 10).is_err());
    assert_eq!(fs::read(directory.path.join("file")).unwrap(), b"old");
}

#[test]
fn old_filesystem_cannot_access_a_replacement_root() {
    let parent = tempfile::tempdir().unwrap();
    let path = parent.path().join("root");
    fs::create_dir(&path).unwrap();
    let grant = ash_file_access::Grant::for_environment(
        Dir::open_local(&path).unwrap(),
        ash_file_access::GrantSource::ExplicitUser,
        ash_file_access::Permissions::new([
            ash_file_access::Permission::ReadFiles,
            ash_file_access::Permission::WriteFiles,
        ]),
    );
    let files = LocalFileSystem::new(grant);
    fs::rename(&path, parent.path().join("old")).unwrap();
    fs::create_dir(&path).unwrap();
    fs::write(path.join("file"), "replacement").unwrap();
    assert!(files.read_file(Path::new("file"), 100).is_err());
    assert!(
        files
            .write_file(Path::new("file"), b"changed", 100)
            .is_err()
    );
    assert_eq!(fs::read(path.join("file")).unwrap(), b"replacement");
}

#[test]
fn root_replacement_after_admission_keeps_io_on_the_opened_object() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("root");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("file"), "original").unwrap();
    let grant = ash_file_access::Grant::for_environment(
        Dir::open_local(&root).unwrap(),
        ash_file_access::GrantSource::ExplicitUser,
        ash_file_access::Permissions::new([ash_file_access::Permission::ReadFiles]),
    );
    let files = LocalFileSystem::new(grant);
    let bytes = files
        .execute(ash_file_access::Permission::ReadFiles, |scoped| {
            let relative = scoped.resolve_existing(Path::new("file"))?;
            fs::rename(&root, parent.path().join("old")).unwrap();
            fs::create_dir(&root).unwrap();
            fs::write(root.join("file"), "replacement").unwrap();
            scoped.handle().read(relative).map_err(io_error)
        })
        .unwrap();
    assert_eq!(bytes, b"original");
}

#[test]
#[cfg(unix)]
fn parent_symlink_replacement_after_resolution_cannot_escape() {
    let directory = TestDir::new();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path.join("nested")).unwrap();
    fs::write(directory.path.join("nested/file"), "inside").unwrap();
    fs::write(outside.path().join("file"), "outside").unwrap();
    let files = directory.file_system();
    let result = files.execute(ash_file_access::Permission::ReadFiles, |scoped| {
        let relative = scoped.resolve_existing(Path::new("nested/file"))?;
        fs::rename(directory.path.join("nested"), directory.path.join("old")).unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path.join("nested")).unwrap();
        scoped.handle().read(relative).map_err(io_error)
    });
    assert!(result.is_err());
}

#[test]
fn separate_services_serialize_conditional_writes() {
    let directory = TestDir::new();
    fs::write(directory.path.join("file"), "old").unwrap();
    let first = directory.file_system();
    let second = directory.file_system();
    let revision = first
        .read_file_with_revision(Path::new("file"), 100)
        .unwrap()
        .revision;
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers = [first, second]
        .into_iter()
        .enumerate()
        .map(|(index, files)| {
            let barrier = barrier.clone();
            let revision = revision.clone();
            std::thread::spawn(move || {
                barrier.wait();
                files.write_file_with_condition(
                    Path::new("file"),
                    format!("new {index}").as_bytes(),
                    100,
                    &FileWriteCondition::ExpectedRevision(revision),
                )
            })
        })
        .collect::<Vec<_>>();
    let results = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(FileSystemError::RevisionConflict(_))))
            .count(),
        1
    );
}
