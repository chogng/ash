use super::*;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

#[cfg(target_os = "linux")]
#[path = "local_x11_clipboard_tests.rs"]
mod x11_clipboard_tests;

#[test]
fn copies_binary_files_and_directories_between_granted_roots() {
    let source = TestDir::new();
    let target = TestDir::new();
    fs::create_dir(source.path.join("folder")).unwrap();
    let bytes = [0, 255, 1, 128];
    fs::write(source.path.join("folder/data.bin"), bytes).unwrap();
    let source_files = source.file_system();
    let target_files = target.file_system();

    source_files
        .copy_to(Path::new("folder"), &target_files, Path::new("copied"))
        .unwrap();
    assert_eq!(
        fs::read(target.path.join("copied/data.bin")).unwrap(),
        bytes
    );
    assert!(matches!(
        source_files.copy_to(Path::new("folder"), &target_files, Path::new("copied")),
        Err(FileSystemError::AlreadyExists(_))
    ));
    assert!(matches!(
        source_files.copy_to(
            Path::new("folder"),
            &source_files,
            Path::new("folder/child")
        ),
        Err(FileSystemError::InvalidPath(_))
    ));
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
#[test]
fn system_clipboard_transfer_copies_directories_and_moves_cut_files() {
    let source = TestDir::new();
    let target = TestDir::new();
    fs::create_dir(source.path.join("folder")).unwrap();
    fs::write(source.path.join("folder/data.bin"), [0, 255, 42]).unwrap();
    fs::write(source.path.join("cut.txt"), "move me").unwrap();
    let files = target.file_system();

    transfer_system_files(
        &files,
        Path::new("."),
        &[source.path.join("folder")],
        SystemFileTransferOperation::Copy,
    )
    .unwrap();
    assert_eq!(
        fs::read(target.path.join("folder/data.bin")).unwrap(),
        [0, 255, 42]
    );
    assert!(source.path.join("folder/data.bin").exists());

    transfer_system_files(
        &files,
        Path::new("."),
        &[source.path.join("cut.txt")],
        SystemFileTransferOperation::Move,
    )
    .unwrap();
    assert_eq!(fs::read(target.path.join("cut.txt")).unwrap(), b"move me");
    assert!(!source.path.join("cut.txt").exists());
}

#[test]
fn compound_copy_authorizations_preserve_action_scope_directory_and_revocation() {
    use ash_file_access::{GrantSource, Permission, Permissions};
    let source = TestDir::new();
    let target = TestDir::new();
    fs::write(source.path.join("source.txt"), "contents").unwrap();
    let grant = Grant::for_environment(
        Dir::open_local(&source.path).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles, Permission::BrowseFiles]),
    );
    let read = grant.authorize(Permission::ReadFiles).unwrap();
    let browse = grant.authorize(Permission::BrowseFiles).unwrap();
    let other = Grant::for_environment(
        Dir::open_local(&target.path).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::BrowseFiles]),
    );
    assert!(matches!(
        LocalFileSystem::from_authorizations(
            read.clone(),
            [other.authorize(Permission::BrowseFiles).unwrap()]
        ),
        Err(FileSystemError::PermissionDenied(_))
    ));
    let destination = target.file_system();
    let read_only = LocalFileSystem::from_authorization(read.clone());
    assert!(matches!(
        read_only.copy_to(
            Path::new("source.txt"),
            &destination,
            Path::new("denied.txt")
        ),
        Err(FileSystemError::PermissionDenied(_))
    ));
    let files = LocalFileSystem::from_authorizations(read, [browse]).unwrap();
    files
        .copy_to(
            Path::new("source.txt"),
            &destination,
            Path::new("copied.txt"),
        )
        .unwrap();
    assert_eq!(
        fs::read_to_string(target.path.join("copied.txt")).unwrap(),
        "contents"
    );
    grant.revoke();
    assert!(matches!(
        files.copy_to(
            Path::new("source.txt"),
            &destination,
            Path::new("revoked.txt")
        ),
        Err(FileSystemError::PermissionDenied(_))
    ));
    assert!(!target.path.join("revoked.txt").exists());
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
#[test]
fn system_clipboard_transfer_rejects_symlinks_and_renames_copy_conflicts() {
    let source = TestDir::new();
    let target = TestDir::new();
    fs::write(source.path.join("item.txt"), "original").unwrap();
    fs::write(target.path.join("item.txt"), "existing").unwrap();
    let files = target.file_system();
    transfer_system_files(
        &files,
        Path::new("."),
        &[source.path.join("item.txt")],
        SystemFileTransferOperation::Copy,
    )
    .unwrap();
    assert_eq!(
        fs::read(target.path.join("item copy.txt")).unwrap(),
        b"original"
    );
    assert_eq!(fs::read(target.path.join("item.txt")).unwrap(), b"existing");

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source.path.join("item.txt"), source.path.join("link")).unwrap();
        assert!(matches!(
            transfer_system_files(
                &files,
                Path::new("."),
                &[source.path.join("link")],
                SystemFileTransferOperation::Move,
            ),
            Err(FileSystemError::InvalidPath(_))
        ));
        assert!(source.path.join("item.txt").exists());
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn system_clipboard_transfer_preserves_private_and_read_only_directory_permissions() {
    use std::os::unix::fs::PermissionsExt;

    for (operation, mode) in [
        (SystemFileTransferOperation::Copy, 0o700),
        (SystemFileTransferOperation::Copy, 0o500),
        (SystemFileTransferOperation::Move, 0o700),
    ] {
        let source = TestDir::new();
        let target = TestDir::new();
        let directory = source.path.join("private");
        fs::create_dir_all(directory.join("nested")).unwrap();
        fs::write(directory.join("nested/data"), "private data").unwrap();
        fs::set_permissions(directory.join("nested"), fs::Permissions::from_mode(0o750)).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(mode)).unwrap();
        transfer_system_files(
            &target.file_system(),
            Path::new("."),
            &[directory.clone()],
            operation,
        )
        .unwrap();

        let copied = target.path.join("private");
        assert_eq!(
            fs::metadata(&copied).unwrap().permissions().mode() & 0o777,
            mode
        );
        assert_eq!(
            fs::metadata(copied.join("nested"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o750
        );
        assert_eq!(
            fs::read(copied.join("nested/data")).unwrap(),
            b"private data"
        );
        assert_eq!(
            directory.exists(),
            operation == SystemFileTransferOperation::Copy
        );
        if directory.exists() {
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::set_permissions(&copied, fs::Permissions::from_mode(0o700)).unwrap();
    }
}

#[cfg(target_os = "linux")]
#[test]
fn gnome_clipboard_marker_preserves_cut_and_copy() {
    let (copy, operation) = parse_gnome_copied_files(b"copy\nfile:///tmp/a%20b\n").unwrap();
    assert_eq!(copy, vec![PathBuf::from("/tmp/a b")]);
    assert_eq!(operation, SystemFileTransferOperation::Copy);
    let (cut, operation) = parse_gnome_copied_files(b"cut\nfile:///tmp/a%20b\n").unwrap();
    assert_eq!(cut, copy);
    assert_eq!(operation, SystemFileTransferOperation::Move);
    assert!(parse_gnome_copied_files(b"cut\nhttps://example.com/file\n").is_err());
    assert_eq!(
        parse_file_uri_list(b"# copied files\r\nfile:///tmp/first\r\nfile:///tmp/a%20b\r\n")
            .unwrap(),
        vec![PathBuf::from("/tmp/first"), PathBuf::from("/tmp/a b")],
    );
}

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
fn missing_or_empty_write_accepts_only_missing_or_empty_targets() {
    let dir = TestDir::new();
    fs::write(dir.path.join("empty.md"), "").unwrap();
    fs::write(dir.path.join("occupied.md"), "editor content").unwrap();
    let file_system = dir.file_system();

    for name in ["missing.md", "empty.md"] {
        file_system
            .write_file_with_condition(
                Path::new(name),
                b"imported content",
                100,
                &FileWriteCondition::MissingOrEmpty,
            )
            .unwrap();
        assert_eq!(fs::read(dir.path.join(name)).unwrap(), b"imported content");
    }
    assert_eq!(
        file_system.write_file_with_condition(
            Path::new("occupied.md"),
            b"imported content",
            100,
            &FileWriteCondition::MissingOrEmpty,
        ),
        Err(FileSystemError::RevisionConflict(PathBuf::from(
            "occupied.md"
        ))),
    );
    assert_eq!(
        fs::read(dir.path.join("occupied.md")).unwrap(),
        b"editor content"
    );
}

#[test]
fn byte_write_modes_preserve_existing_files_and_require_existing_replace_targets() {
    for mode in [
        FileWriteMode::Create,
        FileWriteMode::Replace,
        FileWriteMode::CreateOrReplace,
    ] {
        for initial in [None, Some(&b""[..]), Some(&b"saved"[..])] {
            let dir = TestDir::new();
            let path = Path::new("bytes.bin");
            if let Some(content) = initial {
                fs::write(dir.path.join(path), content).unwrap();
            }
            let file_system = dir.file_system();
            let bytes = [0, 255, 128];
            let written = file_system.write_file_with_condition(
                path,
                &bytes,
                1024,
                &FileWriteCondition::Options {
                    mode,
                    expected_revision: None,
                },
            );
            match (mode, initial) {
                (FileWriteMode::Create, Some(content)) => {
                    assert_eq!(
                        written,
                        Err(FileSystemError::AlreadyExists(path.to_path_buf()))
                    );
                    assert_eq!(fs::read(dir.path.join(path)).unwrap(), content);
                }
                (FileWriteMode::Replace, None) => {
                    assert_eq!(written, Err(FileSystemError::NotFound(path.to_path_buf())));
                    assert!(!dir.path.join(path).exists());
                }
                (FileWriteMode::Create, None)
                | (FileWriteMode::Replace, Some(_))
                | (FileWriteMode::CreateOrReplace, None | Some(_)) => {
                    assert_eq!(written.unwrap().size_bytes, bytes.len() as u64);
                    assert_eq!(fs::read(dir.path.join(path)).unwrap(), bytes);
                }
            }
        }
    }
}

#[test]
fn conditional_byte_writes_share_the_directory_publication_lock() {
    let dir = TestDir::new();
    let path = Path::new("bytes.bin");
    fs::write(dir.path.join(path), [0, 255]).unwrap();
    let file_system = dir.file_system();
    let revision = file_system
        .read_file_with_revision(path, 1024)
        .unwrap()
        .revision;
    let results = std::thread::scope(|scope| {
        let handles = [42, 43].map(|byte| {
            let revision = revision.clone();
            let files = &file_system;
            scope.spawn(move || {
                files.write_file_with_condition(
                    path,
                    &[0, 255, byte],
                    1024,
                    &FileWriteCondition::Options {
                        mode: FileWriteMode::Replace,
                        expected_revision: Some(revision),
                    },
                )
            })
        });
        handles.map(|handle| handle.join().unwrap())
    });
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(FileSystemError::RevisionConflict(_))))
            .count(),
        1
    );
    assert!(matches!(
        fs::read(dir.path.join(path)).unwrap().as_slice(),
        [0, 255, 42 | 43]
    ));
}

#[test]
fn missing_or_empty_publication_keeps_files_saved_after_preparation() {
    for initially_empty in [false, true] {
        let dir = TestDir::new();
        let target = dir.path.join("ASH.md");
        if initially_empty {
            fs::write(&target, "").unwrap();
        }
        let file_system = dir.file_system();
        let prepared = PreparedWrite::new(
            file_system.files.handle(),
            Path::new("ASH.md"),
            b"imported content",
            None,
        )
        .unwrap();

        fs::write(&target, "saved by editor").unwrap();
        assert_eq!(
            prepared
                .publish(WritePublication::MissingOrEmpty)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::AlreadyExists,
        );
        assert_eq!(fs::read(&target).unwrap(), b"saved by editor");
        assert_eq!(fs::read_dir(&dir.path).unwrap().count(), 1);
    }
}

#[cfg(unix)]
#[test]
fn missing_or_empty_write_rejects_an_empty_file_linked_outside_the_dir() {
    let dir = TestDir::new();
    let outside = tempfile::tempdir().unwrap();
    let external = outside.path().join("shared.md");
    fs::write(&external, "").unwrap();
    fs::hard_link(&external, dir.path.join("ASH.md")).unwrap();

    assert_eq!(
        dir.file_system().write_file_with_condition(
            Path::new("ASH.md"),
            b"imported content",
            100,
            &FileWriteCondition::MissingOrEmpty,
        ),
        Err(FileSystemError::RevisionConflict(PathBuf::from("ASH.md"))),
    );
    assert_eq!(fs::read(external).unwrap(), b"");
}

#[test]
fn create_publication_does_not_replace_a_file_created_after_preparation() {
    let dir = TestDir::new();
    let file_system = dir.file_system();
    let prepared =
        PreparedWrite::new(file_system.files.handle(), Path::new("new.md"), b"", None).unwrap();
    fs::write(dir.path.join("new.md"), "editor content").unwrap();

    assert_eq!(
        prepared
            .publish(WritePublication::Create)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::AlreadyExists,
    );
    assert_eq!(
        fs::read(dir.path.join("new.md")).unwrap(),
        b"editor content"
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

#[test]
fn file_creation_builds_missing_parents_without_overwriting_an_existing_target() {
    let dir = TestDir::new();
    let file_system = dir.file_system();
    let path = Path::new("missing/nested/created.txt");
    file_system
        .create_file(path, ExistingTargetBehavior::Error)
        .unwrap();
    assert_eq!(fs::read(dir.path.join(path)).unwrap(), b"");
    fs::write(dir.path.join(path), b"user content").unwrap();
    assert!(matches!(
        file_system.create_file(path, ExistingTargetBehavior::Error),
        Err(FileSystemError::AlreadyExists(_))
    ));
    assert_eq!(fs::read(dir.path.join(path)).unwrap(), b"user content");
    assert!(matches!(
        file_system.create_file(
            Path::new("../outside/new.txt"),
            ExistingTargetBehavior::Error
        ),
        Err(FileSystemError::InvalidPath(_))
    ));
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

#[cfg(unix)]
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

#[cfg(windows)]
#[test]
fn open_root_cannot_be_replaced_on_windows() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("root");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("file"), "original").unwrap();
    let grant = ash_file_access::Grant::for_environment(
        Dir::open_local(&root).unwrap(),
        ash_file_access::GrantSource::ExplicitUser,
        ash_file_access::Permissions::new([
            ash_file_access::Permission::ReadFiles,
            ash_file_access::Permission::WriteFiles,
        ]),
    );
    let files = LocalFileSystem::new(grant);

    // Windows keeps the authorized root open and rejects a rename that would rebind its path.
    let error = fs::rename(&root, parent.path().join("old")).unwrap_err();
    assert_eq!(error.raw_os_error(), Some(32));
    assert!(!parent.path().join("old").exists());
    assert_eq!(
        files.read_file(Path::new("file"), 100).unwrap(),
        b"original"
    );
    assert_eq!(fs::read(root.join("file")).unwrap(), b"original");
}

#[cfg(unix)]
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

#[cfg(windows)]
#[test]
fn root_replacement_attempt_after_admission_keeps_io_on_the_opened_object() {
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
            let error = fs::rename(&root, parent.path().join("old")).unwrap_err();
            assert_eq!(error.raw_os_error(), Some(32));
            scoped.handle().read(relative).map_err(io_error)
        })
        .unwrap();
    assert_eq!(bytes, b"original");
    assert_eq!(fs::read(root.join("file")).unwrap(), b"original");
    assert!(!parent.path().join("old").exists());
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

#[test]
fn mutation_batches_serialize_with_ordinary_conditional_writes() {
    let directory = TestDir::new();
    fs::write(directory.path.join("file"), "old").unwrap();
    let files = directory.file_system();
    let dir = Dir::open_local(&directory.path).unwrap();
    let revision = file_revision(b"old");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let first_barrier = barrier.clone();
    let first_revision = revision.clone();
    let first = std::thread::spawn(move || {
        first_barrier.wait();
        commit_file_mutations(
            &dir,
            &[FileMutation::Replace {
                path: PathBuf::from("file"),
                content: b"batch".to_vec(),
                expected_revision: first_revision,
            }],
        )
        .map_err(|error| error.source)
    });
    let second = std::thread::spawn(move || {
        barrier.wait();
        files
            .write_file_with_condition(
                Path::new("file"),
                b"ordinary",
                100,
                &FileWriteCondition::ExpectedRevision(revision),
            )
            .map(|_| ())
    });
    let results = [first.join().unwrap(), second.join().unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(FileSystemError::RevisionConflict(_))))
            .count(),
        1
    );
}

#[test]
fn explicit_unlock_saves_readonly_files_and_rejects_stale_revisions_before_chmod() {
    let dir = TestDir::new();
    let path = Path::new("readonly.txt");
    let target = dir.path.join(path);
    fs::write(&target, b"old").unwrap();
    let mut permissions = fs::metadata(&target).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&target, permissions).unwrap();
    let files = dir.file_system();
    assert_eq!(
        files.write_file_with_condition(
            path,
            b"new",
            1024,
            &FileWriteCondition::UnlockAndReplace {
                expected_revision: file_revision(b"stale")
            }
        ),
        Err(FileSystemError::RevisionConflict(path.into()))
    );
    assert!(fs::metadata(&target).unwrap().permissions().readonly());
    files
        .write_file_with_condition(
            path,
            b"new",
            1024,
            &FileWriteCondition::UnlockAndReplace {
                expected_revision: file_revision(b"old"),
            },
        )
        .unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"new");
    assert!(!fs::metadata(&target).unwrap().permissions().readonly());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o022,
            0
        );
    }
}

#[test]
fn explicit_unlock_cannot_change_permissions_through_a_hard_link() {
    let dir = TestDir::new();
    let outside = TestDir::new();
    let target = outside.path.join("outside.txt");
    fs::write(&target, b"old").unwrap();
    fs::hard_link(&target, dir.path.join("linked.txt")).unwrap();
    let permissions = fs::metadata(&target).unwrap().permissions();
    assert!(matches!(
        dir.file_system().write_file_with_condition(
            Path::new("linked.txt"),
            b"new",
            1024,
            &FileWriteCondition::UnlockAndReplace {
                expected_revision: file_revision(b"old")
            }
        ),
        Err(FileSystemError::InvalidPath(_))
    ));
    assert_eq!(fs::metadata(&target).unwrap().permissions(), permissions);
    assert_eq!(fs::read(&target).unwrap(), b"old");
}

#[cfg(unix)]
#[test]
fn explicit_unlock_restores_readonly_mode_when_publication_is_denied() {
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::fs::PermissionsExt;
    if rustix::process::geteuid().is_root() {
        return;
    }
    let dir = TestDir::new();
    let target = dir.path.join("readonly.txt");
    fs::write(&target, b"old").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o444)).unwrap();
    let files = dir.file_system();
    fs::set_permissions(&dir.path, fs::Permissions::from_mode(0o555)).unwrap();
    let result = files.write_file_with_condition(
        Path::new("readonly.txt"),
        b"new",
        1024,
        &FileWriteCondition::UnlockAndReplace {
            expected_revision: file_revision(b"old"),
        },
    );
    fs::set_permissions(&dir.path, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        result,
        Err(FileSystemError::OsPermissionDenied(_))
    ));
    assert_eq!(fs::metadata(&target).unwrap().mode() & 0o777, 0o444);
    assert_eq!(fs::read(&target).unwrap(), b"old");
}
