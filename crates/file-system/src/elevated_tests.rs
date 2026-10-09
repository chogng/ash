use super::*;
use crate::LocalFileSystem;
use crate::file_revision;
use ash_async_utils::CancellationSource;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;

fn job(dir: &Dir, revision: Option<String>) -> WriteJob {
    WriteJob {
        root: dir.canonical_path().into(),
        directory_id: dir.id().to_string(),
        path: "notes.txt".into(),
        expected_revision: revision,
        #[cfg(unix)]
        creator: [
            rustix::process::geteuid().as_raw(),
            rustix::process::getegid().as_raw(),
        ],
    }
}

fn prepared<'a>(
    dir: &Dir,
    content: &'a [u8],
    revision: Option<&str>,
) -> Result<crate::local::PreparedElevatedWrite<'a>, FileSystemError> {
    crate::local::prepare_elevated_write(
        dir,
        Path::new("notes.txt"),
        content,
        revision,
        #[cfg(unix)]
        [
            rustix::process::geteuid().as_raw(),
            rustix::process::getegid().as_raw(),
        ],
    )
}

#[test]
fn saves_exact_bytes_and_preserves_unix_ownership_and_readonly_mode() {
    let temporary = tempfile::tempdir().unwrap();
    let target = temporary.path().join("notes.txt");
    std::fs::write(&target, b"old").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o444)).unwrap();
    }
    let before = std::fs::metadata(&target).unwrap();
    let dir = Dir::open_local(temporary.path()).unwrap();
    let content = b"\xef\xbb\xbfnew\r\n";
    let result = prepared(&dir, content, Some(&file_revision(b"old")))
        .unwrap()
        .publish()
        .unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), content);
    assert_eq!(result.size_bytes, content.len() as u64);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let after = std::fs::metadata(&target).unwrap();
        assert_eq!(
            (after.uid(), after.gid(), after.mode()),
            (before.uid(), before.gid(), before.mode())
        );
    }
    #[cfg(not(unix))]
    let _ = before;
    assert_eq!(std::fs::read_dir(temporary.path()).unwrap().count(), 1);
}

#[test]
fn external_change_during_authorization_rejects_publication_and_cleans_staging() {
    let temporary = tempfile::tempdir().unwrap();
    let target = temporary.path().join("notes.txt");
    std::fs::write(&target, b"old").unwrap();
    let dir = Dir::open_local(temporary.path()).unwrap();
    let write = prepared(&dir, b"editor", Some(&file_revision(b"old"))).unwrap();
    std::fs::write(&target, b"external").unwrap();
    assert!(matches!(
        write.publish(),
        Err(FileSystemError::RevisionConflict(_))
    ));
    assert_eq!(std::fs::read(&target).unwrap(), b"external");
    assert_eq!(std::fs::read_dir(temporary.path()).unwrap().count(), 1);
}

#[test]
fn swapping_the_target_with_identical_content_is_a_conflict() {
    let temporary = tempfile::tempdir().unwrap();
    let target = temporary.path().join("notes.txt");
    std::fs::write(&target, b"old").unwrap();
    let dir = Dir::open_local(temporary.path()).unwrap();
    let write = prepared(&dir, b"editor", Some(&file_revision(b"old"))).unwrap();
    std::fs::rename(&target, temporary.path().join("original.txt")).unwrap();
    std::fs::write(&target, b"old").unwrap();
    assert!(matches!(
        write.publish(),
        Err(FileSystemError::RevisionConflict(_))
    ));
    assert_eq!(std::fs::read(&target).unwrap(), b"old");
}

#[test]
fn no_revision_can_create_but_never_overwrite_an_existing_file() {
    let temporary = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temporary.path()).unwrap();
    prepared(&dir, b"first", None).unwrap().publish().unwrap();
    assert!(matches!(
        prepared(&dir, b"second", None),
        Err(FileSystemError::RevisionConflict(_))
    ));
    assert_eq!(
        std::fs::read(temporary.path().join("notes.txt")).unwrap(),
        b"first"
    );
}

#[test]
fn directory_grants_are_required_even_for_elevated_saves() {
    let temporary = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temporary.path()).unwrap();
    let files = LocalFileSystem::new(Grant::for_environment(
        dir,
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    ));
    let source = CancellationSource::new();
    assert!(matches!(
        files.write_file_elevated(Path::new("notes.txt"), b"content", None, &source.token()),
        Err(FileSystemError::PermissionDenied(_))
    ));
}

#[test]
fn cancellation_before_start_does_not_launch_a_privileged_process() {
    let temporary = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temporary.path()).unwrap();
    let source = CancellationSource::new();
    source.cancel();
    assert_eq!(
        exchange(
            &dir,
            &job(&dir, None),
            b"content",
            &source.token(),
            |_, _| panic!("must not launch")
        ),
        Err(FileSystemError::Cancelled)
    );
    assert_eq!(std::fs::read_dir(temporary.path()).unwrap().count(), 0);
}

#[test]
fn closing_the_control_connection_before_commit_discards_the_prepared_file() {
    let temporary = tempfile::tempdir().unwrap();
    let target = temporary.path().join("notes.txt");
    std::fs::write(&target, b"old").unwrap();
    let dir = Dir::open_local(temporary.path()).unwrap();
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let credential = credential(b'a');
    let credential_path = credential.path().as_os_str().to_os_string();
    let worker = std::thread::spawn(move || {
        run_elevated_file_helper([port.to_string().into(), credential_path])
    });
    let (mut socket, _) = listener.accept().unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut token = [0_u8; 64];
    socket.read_exact(&mut token).unwrap();
    assert_eq!(token, [b'a'; 64]);
    write_json(&mut socket, &job(&dir, Some(file_revision(b"old")))).unwrap();
    socket.write_all(&6_u32.to_be_bytes()).unwrap();
    socket.write_all(b"editor").unwrap();
    let mut ready = [0_u8; 1];
    socket.read_exact(&mut ready).unwrap();
    assert_eq!(ready, [1]);
    drop(socket);
    assert!(worker.join().unwrap().is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"old");
    assert_eq!(std::fs::read_dir(temporary.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_redirect_elevated_saves() {
    let temporary = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("outside.txt");
    std::fs::write(&target, b"outside").unwrap();
    std::os::unix::fs::symlink(&target, temporary.path().join("notes.txt")).unwrap();
    let dir = Dir::open_local(temporary.path()).unwrap();
    assert!(prepared(&dir, b"editor", Some(&file_revision(b"outside"))).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"outside");
}

#[test]
fn one_shot_helper_publishes_exact_bytes_only_after_the_commit_handshake() {
    let temporary = tempfile::tempdir().unwrap();
    let target = temporary.path().join("notes.txt");
    std::fs::write(&target, b"old").unwrap();
    let dir = Dir::open_local(temporary.path()).unwrap();
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let credential = credential(b'b');
    let credential_path = credential.path().as_os_str().to_os_string();
    let worker = std::thread::spawn(move || {
        run_elevated_file_helper([port.to_string().into(), credential_path])
    });
    let (mut socket, _) = listener.accept().unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut token = [0_u8; 64];
    socket.read_exact(&mut token).unwrap();
    assert_eq!(token, [b'b'; 64]);
    let bytes = b"\xef\xbb\xbfeditor\r\n";
    write_json(&mut socket, &job(&dir, Some(file_revision(b"old")))).unwrap();
    socket
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .unwrap();
    socket.write_all(bytes).unwrap();
    let mut ready = [0_u8; 1];
    socket.read_exact(&mut ready).unwrap();
    assert_eq!(ready, [1]);
    assert_eq!(std::fs::read(&target).unwrap(), b"old");
    socket.write_all(&[1]).unwrap();
    let result: Result<FileMetadata, FileSystemError> = read_json(&mut socket, 64 * 1024).unwrap();
    assert_eq!(result.unwrap().size_bytes, bytes.len() as u64);
    worker.join().unwrap().unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), bytes);
    assert_eq!(std::fs::read_dir(temporary.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn in_scope_symlinks_are_also_rejected_for_privileged_publication() {
    let temporary = tempfile::tempdir().unwrap();
    std::fs::write(temporary.path().join("original.txt"), b"original").unwrap();
    std::os::unix::fs::symlink("original.txt", temporary.path().join("notes.txt")).unwrap();
    let dir = Dir::open_local(temporary.path()).unwrap();
    assert!(matches!(
        prepared(&dir, b"editor", Some(&file_revision(b"original"))),
        Err(FileSystemError::NotFile(_))
    ));
    assert_eq!(
        std::fs::read(temporary.path().join("original.txt")).unwrap(),
        b"original"
    );
}

fn credential(byte: u8) -> tempfile::NamedTempFile {
    let mut file = tempfile::Builder::new()
        .prefix("ash-elevated-auth-")
        .tempfile()
        .unwrap();
    file.write_all(&[byte; 64]).unwrap();
    file.flush().unwrap();
    file
}

#[cfg(unix)]
#[test]
fn authentication_rejects_public_credentials_and_symlink_substitution() {
    use std::os::unix::fs::PermissionsExt;
    let credential = credential(b'a');
    assert_eq!(read_credential(credential.path()).unwrap(), "a".repeat(64));
    std::fs::set_permissions(credential.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        read_credential(credential.path()),
        Err(FileSystemError::ElevationDenied)
    );
    std::fs::set_permissions(credential.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let link = directory.path().join("ash-elevated-auth-link");
    std::os::unix::fs::symlink(credential.path(), &link).unwrap();
    assert_eq!(
        read_credential(&link),
        Err(FileSystemError::ElevationDenied)
    );
}

#[test]
fn launcher_results_distinguish_declined_unavailable_and_failed_authorization() {
    for platform in ["linux", "windows"] {
        assert_eq!(
            authorization_exit_error(platform, Some(126), ""),
            FileSystemError::ElevationDenied
        );
        assert_eq!(
            authorization_exit_error(platform, Some(127), ""),
            FileSystemError::ElevationUnavailable
        );
        assert_eq!(
            authorization_exit_error(platform, Some(1), "localized failure"),
            FileSystemError::ElevationFailed
        );
        assert_eq!(
            authorization_exit_error(platform, Some(0), ""),
            FileSystemError::ElevationFailed
        );
    }
    assert_eq!(
        authorization_exit_error("macos", Some(1), "ASH_ELEVATION_DENIED"),
        FileSystemError::ElevationDenied
    );
    assert_eq!(
        authorization_exit_error("macos", Some(1), "localized failure"),
        FileSystemError::ElevationFailed
    );
}

#[test]
fn linux_launchers_require_graphical_authorization_and_fall_back_when_missing() {
    let directory = tempfile::tempdir().unwrap();
    assert!(matches!(
        linux_launcher(directory.path()),
        Err(FileSystemError::ElevationUnavailable)
    ));
    let kde = directory.path().join("kdesudo");
    std::fs::write(&kde, b"").unwrap();
    let command = linux_launcher(directory.path()).unwrap();
    assert_eq!(command.get_program(), kde.as_os_str());
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        ["--comment", "Ash", "-d", "--"]
    );
    let polkit = directory.path().join("pkexec");
    std::fs::write(&polkit, b"").unwrap();
    let command = linux_launcher(directory.path()).unwrap();
    assert_eq!(command.get_program(), polkit.as_os_str());
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        ["--disable-internal-agent"]
    );
}

#[test]
fn mac_authorization_names_the_product_and_quotes_helper_paths() {
    let command = launch_command(
        "macos",
        "/Applications/Ash's App/helper",
        42,
        "/tmp/ash-elevated-auth-a'b",
    )
    .unwrap();
    let arguments = command
        .get_args()
        .map(|argument| argument.to_str().unwrap())
        .collect::<Vec<_>>();
    assert!(arguments[1].contains("with prompt (item 2 of arguments)"));
    assert!(arguments[1].contains("errorNumber is -128"));
    assert_eq!(
        arguments[3],
        r"exec '/Applications/Ash'\''s App/helper' --ash-elevated-file-write 42 '/tmp/ash-elevated-auth-a'\''b'"
    );
    assert_eq!(arguments[4], "Ash");
}

#[test]
fn a_launcher_exiting_without_connecting_is_a_failure_and_cleans_private_logs() {
    let directory = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(directory.path()).unwrap();
    let source = CancellationSource::new();
    let mut log_path = None;
    let result = exchange(
        &dir,
        &job(&dir, None),
        b"editor",
        &source.token(),
        |_, _| {
            let diagnostics = tempfile::NamedTempFile::new().unwrap();
            log_path = Some(diagnostics.path().to_path_buf());
            let child = Command::new(std::env::current_exe().unwrap())
                .arg("--list")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            Ok(HelperProcess {
                child,
                diagnostics,
                credential_path: "/tmp/ash-elevated-auth-test".into(),
            })
        },
    );
    assert_eq!(result, Err(FileSystemError::ElevationFailed));
    assert!(!log_path.unwrap().exists());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}
