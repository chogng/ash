use super::*;
use crate::GrantSource;

#[test]
#[cfg(unix)]
fn aliases_share_one_entry_with_independent_sources_and_revision() {
    let directory = tempfile::tempdir().unwrap();
    let alias_parent = tempfile::tempdir().unwrap();
    let alias = alias_parent.path().join("dir-alias");
    std::os::unix::fs::symlink(directory.path(), &alias).unwrap();
    let canonical = Dir::open_local(directory.path()).unwrap();
    let aliased = Dir::open_local(&alias).unwrap();
    let mut access = Access::new(GrantSubject::Environment(EnvId::local()));

    assert_eq!(
        access
            .add(
                grant(canonical.clone(), file_permissions()),
                DirSource::PersistentConfiguration,
            )
            .unwrap(),
        Mutation::AddedDir
    );
    assert_eq!(
        access
            .add(
                grant(aliased, file_permissions()),
                DirSource::SessionRequest,
            )
            .unwrap(),
        Mutation::AddedSource
    );
    assert_eq!(access.revision().get(), 2);
    assert_eq!(access.dirs().len(), 1);
}

#[test]
fn snapshot_is_permission_bound_sorted_and_revoked_on_remove() {
    let ash_temp = tempfile::tempdir().unwrap();
    let ash = Dir::open_local(ash_temp.path()).unwrap();
    let alpha_temp = tempfile::tempdir().unwrap();
    let alpha = Dir::open_local(alpha_temp.path()).unwrap();
    let mut access = Access::new(GrantSubject::Environment(EnvId::local()));
    access
        .add(grant(ash, file_permissions()), DirSource::SessionRequest)
        .unwrap();
    access
        .add(
            grant(alpha.clone(), file_permissions()),
            DirSource::SessionRequest,
        )
        .unwrap();

    let snapshot = access.snapshot(Permission::WriteFiles).unwrap();

    assert_eq!(snapshot.revision().get(), 2);
    assert_eq!(snapshot.authorizations().len(), 2);
    assert!(
        snapshot.authorizations()[0].dir().canonical_path()
            < snapshot.authorizations()[1].dir().canonical_path()
    );
    let alpha_authorization = snapshot
        .authorizations()
        .iter()
        .find(|authorization| authorization.dir() == &alpha)
        .unwrap()
        .clone();
    assert_eq!(
        access.remove(&alpha, DirSource::SessionRequest),
        Mutation::RemovedDir
    );
    assert!(alpha_authorization.ensure_active().is_err());
}

#[test]
fn idempotent_mutations_do_not_advance_revision() {
    let dir_temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(dir_temp.path()).unwrap();
    let mut access = Access::new(GrantSubject::Environment(EnvId::local()));
    access
        .add(
            grant(dir.clone(), file_permissions()),
            DirSource::SessionRequest,
        )
        .unwrap();

    assert_eq!(
        access
            .add(
                grant(dir.clone(), file_permissions()),
                DirSource::SessionRequest,
            )
            .unwrap(),
        Mutation::AlreadyPresent
    );
    assert_eq!(
        access.remove(&dir, DirSource::LaunchArgument),
        Mutation::NotPresent
    );
    assert_eq!(access.revision().get(), 1);
}

#[test]
fn snapshots_include_only_dirs_granting_the_requested_permission() {
    let dir_temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(dir_temp.path()).unwrap();
    let mut access = Access::new(GrantSubject::Environment(EnvId::local()));
    access
        .add(
            grant(dir.clone(), file_permissions()),
            DirSource::SessionRequest,
        )
        .unwrap();

    assert_eq!(
        access
            .snapshot(Permission::ReadFiles)
            .unwrap()
            .authorizations()
            .len(),
        1
    );
    let write_authorization = access
        .snapshot(Permission::WriteFiles)
        .unwrap()
        .authorizations()[0]
        .clone();
    assert_eq!(
        access
            .set_permissions(
                &dir,
                DirSource::SessionRequest,
                1,
                Permissions::new([Permission::ReadFiles]),
            )
            .unwrap(),
        Mutation::UpdatedPermissions
    );
    assert_eq!(access.revision().get(), 2);
    assert!(write_authorization.ensure_active().is_err());
    assert!(
        access
            .snapshot(Permission::WriteFiles)
            .unwrap()
            .authorizations()
            .is_empty()
    );
}

#[test]
fn dropping_access_revokes_existing_snapshots() {
    let dir_temp = tempfile::tempdir().unwrap();
    let authorization = {
        let dir = Dir::open_local(dir_temp.path()).unwrap();
        let mut access = Access::new(GrantSubject::Environment(EnvId::local()));
        access
            .add(grant(dir, file_permissions()), DirSource::SessionRequest)
            .unwrap();
        access
            .snapshot(Permission::ReadFiles)
            .unwrap()
            .authorizations()[0]
            .clone()
    };

    assert!(authorization.ensure_active().is_err());
}

fn grant(dir: Dir, permissions: Permissions) -> Grant {
    Grant::for_environment(dir, GrantSource::ExplicitUser, permissions)
}

fn file_permissions() -> Permissions {
    Permissions::new([Permission::ReadFiles, Permission::WriteFiles])
}

#[test]
fn environment_identity_is_preserved_for_every_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let first = Dir::from_directory(
        ash_environment::LocalFileDriver::new(EnvId::new("first").unwrap())
            .open_directory(directory.path())
            .unwrap(),
    );
    let second = Dir::from_directory(
        ash_environment::LocalFileDriver::new(EnvId::new("second").unwrap())
            .open_directory(directory.path())
            .unwrap(),
    );
    let subject = GrantSubject::SessionTree(ash_protocol::SessionId::new("session").unwrap());
    let mut access = Access::new(subject.clone());
    let first_grant = Grant::new(
        subject.clone(),
        first.clone(),
        GrantSource::ExplicitUser,
        file_permissions(),
    );
    let second_grant = Grant::new(
        subject,
        second.clone(),
        GrantSource::ExplicitUser,
        file_permissions(),
    );
    access
        .add(first_grant.clone(), DirSource::SessionRequest)
        .unwrap();
    access
        .add(second_grant.clone(), DirSource::SessionRequest)
        .unwrap();
    let snapshot = access.snapshot(Permission::ReadFiles).unwrap();
    assert_eq!(snapshot.authorizations().len(), 2);
    assert!(
        snapshot
            .authorizations()
            .iter()
            .any(|authorization| authorization.dir() == &first)
    );
    assert!(
        snapshot
            .authorizations()
            .iter()
            .any(|authorization| authorization.dir() == &second)
    );
    assert_eq!(
        access.find(first.env(), directory.path()),
        Some(first.clone())
    );
    access
        .set_permissions(
            &first,
            DirSource::SessionRequest,
            2,
            Permissions::new([Permission::ReadFiles]),
        )
        .unwrap();
    assert!(!first_grant.is_active());
    assert!(access.authorize(&first, Permission::WriteFiles).is_err());
    assert!(access.authorize(&second, Permission::WriteFiles).is_ok());
    access.remove(&first, DirSource::SessionRequest);
    assert!(second_grant.is_active());
    assert!(access.authorize(&second, Permission::ReadFiles).is_ok());
}

#[test]
fn mismatched_subject_is_rejected_without_changing_access() {
    let directory = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(directory.path()).unwrap();
    let mut access = Access::new(GrantSubject::Thread(
        ash_protocol::ThreadId::new("thread").unwrap(),
    ));
    assert_eq!(
        access.add(grant(dir, file_permissions()), DirSource::SessionRequest),
        Err(AccessError::SubjectMismatch)
    );
    assert!(access.dirs().is_empty());
    assert_eq!(access.revision().get(), 0);
}

#[test]
fn direct_authorization_ignores_unrelated_revocation_and_accepts_explicit_configuration_grants() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let first = Dir::open_local(first.path()).unwrap();
    let second = Dir::open_local(second.path()).unwrap();
    let mut access = Access::new(GrantSubject::Environment(EnvId::local()));
    let revoked = grant(
        first.clone(),
        Permissions::new([Permission::DiscoverSkills]),
    );
    access
        .add(revoked.clone(), DirSource::SessionRequest)
        .unwrap();
    access
        .add(
            grant(
                second.clone(),
                Permissions::new([Permission::DiscoverSkills]),
            ),
            DirSource::PersistentConfiguration,
        )
        .unwrap();
    revoked.revoke();
    assert!(
        access
            .authorize(&first, Permission::DiscoverSkills)
            .is_err()
    );
    assert!(
        access
            .authorize(&second, Permission::DiscoverSkills)
            .is_ok()
    );
}

#[test]
fn duplicate_source_does_not_leave_an_unowned_active_lease() {
    let directory = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(directory.path()).unwrap();
    let first = grant(dir.clone(), file_permissions());
    let duplicate = grant(dir.clone(), file_permissions());
    let mut access = Access::new(first.subject().clone());
    access
        .add(first.clone(), DirSource::SessionRequest)
        .unwrap();
    access
        .add(first.clone(), DirSource::SessionRequest)
        .unwrap();
    assert!(first.is_active());
    access
        .add(duplicate.clone(), DirSource::SessionRequest)
        .unwrap();
    assert!(!duplicate.is_active());
    access.remove(&dir, DirSource::SessionRequest);
    assert!(!first.is_active());
}

#[test]
fn explicitly_granting_a_replacement_retires_the_previous_binding() {
    let parent = tempfile::tempdir().unwrap();
    let path = parent.path().join("root");
    std::fs::create_dir(&path).unwrap();
    let first = Dir::open_local(&path).unwrap();
    let previous = grant(first.clone(), file_permissions());
    let mut access = Access::new(previous.subject().clone());
    access
        .add(previous.clone(), DirSource::SessionRequest)
        .unwrap();
    std::fs::rename(&path, parent.path().join("old")).unwrap();
    std::fs::create_dir(&path).unwrap();
    let replacement = Dir::open_local(&path).unwrap();
    access
        .add(
            grant(replacement.clone(), file_permissions()),
            DirSource::SessionRequest,
        )
        .unwrap();
    assert!(!previous.is_active());
    assert_eq!(access.dirs().len(), 1);
    assert_eq!(
        access.find(replacement.env(), &path),
        Some(replacement.clone())
    );
    assert!(access.authorize(&first, Permission::ReadFiles).is_err());
    assert!(
        access
            .authorize(&replacement, Permission::ReadFiles)
            .is_ok()
    );
}
