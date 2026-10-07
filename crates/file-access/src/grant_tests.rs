use super::*;

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
