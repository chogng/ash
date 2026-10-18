use super::*;

#[test]
fn observed_read_paths_require_existing_containment_policy_and_a_live_read_proof() {
    let directory = tempfile::tempdir().unwrap();
    let root = Dir::open_local(directory.path()).unwrap();
    let allowed = root.canonical_path().join("lib.rs");
    let denied = root.canonical_path().join(".env");
    std::fs::write(&allowed, "code").unwrap();
    std::fs::write(&denied, "private").unwrap();
    let grant = Grant::for_environment(
        root.clone(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles, Permission::WriteFiles]),
    )
    .with_path_policy(
        crate::PathAccessPolicy::new(
            crate::PathAccess::ReadOnly,
            vec![crate::PathAccessRule {
                pattern: ".env".into(),
                access: crate::PathAccess::Denied,
            }],
        )
        .unwrap(),
    );
    let read = grant.authorize(Permission::ReadFiles).unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    assert!(read.allows_read_path(&allowed));
    // On Windows std canonicalization supplies the verbatim spelling; both must work.
    assert!(read.allows_read_path(allowed.canonicalize().unwrap()));
    for path in [
        &denied,
        &denied.canonicalize().unwrap(),
        outside.path(),
        &root.canonical_path().join("missing.rs"),
    ] {
        assert!(!read.allows_read_path(path), "{path:?}");
    }
    assert!(!read.allows_read_path("lib.rs"));
    assert!(
        !grant
            .authorize(Permission::WriteFiles)
            .unwrap()
            .allows_read_path(&allowed)
    );
    grant.revoke();
    assert!(!read.allows_read_path(allowed));
}

#[test]
#[cfg(unix)]
fn observed_read_paths_check_symlink_names_and_targets() {
    let directory = tempfile::tempdir().unwrap();
    let root = Dir::open_local(directory.path()).unwrap();
    let allowed = root.canonical_path().join("lib.rs");
    let denied = root.canonical_path().join(".env");
    std::fs::write(&allowed, "code").unwrap();
    std::fs::write(&denied, "private").unwrap();
    let denied_name = root.canonical_path().join("secret");
    let denied_target = root.canonical_path().join("alias.rs");
    let escaped = root.canonical_path().join("outside.rs");
    let outside = tempfile::NamedTempFile::new().unwrap();
    std::os::unix::fs::symlink(&allowed, &denied_name).unwrap();
    std::os::unix::fs::symlink(&denied, &denied_target).unwrap();
    std::os::unix::fs::symlink(outside.path(), &escaped).unwrap();
    let grant = Grant::for_environment(
        root,
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    )
    .with_path_policy(
        crate::PathAccessPolicy::new(
            crate::PathAccess::ReadOnly,
            vec![crate::PathAccessRule {
                pattern: "{.env,secret}".into(),
                access: crate::PathAccess::Denied,
            }],
        )
        .unwrap(),
    );
    let read = grant.authorize(Permission::ReadFiles).unwrap();
    assert!(read.allows_read_path(allowed));
    for path in [denied_name, denied_target, escaped] {
        assert!(!read.allows_read_path(&path), "{path:?}");
    }
}

#[test]
fn grant_issues_only_explicit_permissions() {
    let directory = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(directory.path()).unwrap();
    let grant = Grant::for_environment(
        dir,
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    );

    assert!(grant.authorize(Permission::ReadFiles).is_ok());
    assert!(grant.authorize(Permission::ExecuteCommands).is_err());
}

#[test]
fn authorization_retains_the_checked_permission_and_source() {
    let directory = tempfile::tempdir().unwrap();
    let subject = GrantSubject::SessionTree(ash_protocol::SessionId::new("session-1").unwrap());
    let authorization = Authorization::evaluate(
        subject.clone(),
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ExecuteCommands]),
        Permission::ExecuteCommands,
    )
    .unwrap();

    assert_eq!(authorization.permission(), Permission::ExecuteCommands);
    assert_eq!(authorization.source(), GrantSource::ExplicitUser);
    assert_eq!(authorization.subject(), &subject);
}

#[test]
fn revocation_invalidates_existing_authorizations() {
    let directory = tempfile::tempdir().unwrap();
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::OrganizationPolicy,
        Permissions::new([Permission::WriteFiles]),
    );
    let authorization = grant.authorize(Permission::WriteFiles).unwrap();

    grant.revoke();

    assert!(!grant.is_active());
    assert!(authorization.ensure_active().is_err());
}

#[test]
fn operation_checks_subject_directory_and_exact_permission() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(first.path()).unwrap();
    let other = Dir::open_local(second.path()).unwrap();
    let grant = Grant::for_environment(
        dir.clone(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    );
    let authorization = grant.authorize(Permission::ReadFiles).unwrap();
    assert!(
        authorization
            .execute(grant.subject(), &dir, Permission::ReadFiles, || ())
            .is_ok()
    );
    assert!(
        authorization
            .execute(grant.subject(), &other, Permission::ReadFiles, || panic!(
                "wrong directory admitted"
            ))
            .is_err()
    );
    assert!(
        authorization
            .execute(grant.subject(), &dir, Permission::WriteFiles, || panic!(
                "wrong action admitted"
            ))
            .is_err()
    );
    let other_subject = GrantSubject::Thread(ThreadId::new("other").unwrap());
    assert!(
        authorization
            .execute(&other_subject, &dir, Permission::ReadFiles, || panic!(
                "wrong subject admitted"
            ))
            .is_err()
    );
}

#[test]
fn revocation_waits_for_admitted_operation_and_blocks_later_operations() {
    let directory = tempfile::tempdir().unwrap();
    let grant = Grant::for_environment(
        Dir::open_local(directory.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::WriteFiles]),
    );
    let authorization = grant.authorize(Permission::WriteFiles).unwrap();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel();
    let operation = std::thread::spawn(move || {
        authorization
            .execute(
                authorization.subject(),
                authorization.dir(),
                Permission::WriteFiles,
                || {
                    entered_tx.send(()).unwrap();
                    finish_rx.recv().unwrap();
                },
            )
            .unwrap()
    });
    entered_rx.recv().unwrap();
    let revoked = grant.clone();
    let (revoked_tx, revoked_rx) = std::sync::mpsc::channel();
    let revocation = std::thread::spawn(move || {
        revoked.revoke();
        revoked_tx.send(()).unwrap();
    });
    assert_eq!(
        revoked_rx.recv_timeout(std::time::Duration::from_millis(50)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout)
    );
    finish_tx.send(()).unwrap();
    operation.join().unwrap();
    revocation.join().unwrap();
    assert!(grant.authorize(Permission::WriteFiles).is_err());
}
