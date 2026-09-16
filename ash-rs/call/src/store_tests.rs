use super::*;

#[test]
fn two_hosts_grant_one_microphone_and_switching_invalidates_old_tickets() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("calls.sqlite");
    let store = CallStore::open(&path).unwrap();
    let owner = MemberCredential::generate();
    let created = store.create(&owner, "create").unwrap();
    let ready = store
        .media_completed(&created.id, created.revision)
        .unwrap();
    let other = CallStore::open(&path).unwrap();
    let (first, second) = std::thread::scope(|scope| {
        let a = scope.spawn(|| store.join(&owner, "laptop").unwrap());
        let b = scope.spawn(|| other.join(&owner, "desktop").unwrap());
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_ne!(first.microphone, second.microphone);
    let changed = store
        .select_device(&owner, "device", ready.revision, "phone")
        .unwrap();
    assert!(matches!(
        other.join(&owner, "phone"),
        Err(CallError::NotReady)
    ));
    let ready = store
        .media_completed(&changed.id, changed.revision)
        .unwrap();
    assert!(other.join(&owner, "phone").unwrap().microphone);
    assert!(!other.join(&owner, "laptop").unwrap().microphone);
    assert!(!other.join(&owner, "desktop").unwrap().microphone);
    assert_ne!(ready.media_room, first.call.media_room);
}

#[test]
fn role_changes_rotate_media_and_require_current_owner_revision() {
    let directory = tempfile::tempdir().unwrap();
    let store = CallStore::open(&directory.path().join("calls.sqlite")).unwrap();
    let owner = MemberCredential::generate();
    let guest = MemberCredential::generate();
    let created = store.create(&owner, "create").unwrap();
    let ready = store
        .media_completed(&created.id, created.revision)
        .unwrap();
    let invited = store
        .invite(&owner, "invite", ready.revision, &guest, CallRole::Speaker)
        .unwrap();
    let old = store.join(&guest, "laptop").unwrap();
    assert!(matches!(
        store.set_role(
            &guest,
            "role",
            invited.revision,
            &old.member.id,
            CallRole::Listener
        ),
        Err(CallError::Denied)
    ));
    let rotating = store
        .set_role(
            &owner,
            "role",
            invited.revision,
            &old.member.id,
            CallRole::Listener,
        )
        .unwrap();
    assert!(matches!(
        store.join(&guest, "laptop"),
        Err(CallError::NotReady)
    ));
    store
        .media_completed(&rotating.id, rotating.revision)
        .unwrap();
    let new = store.join(&guest, "laptop").unwrap();
    assert_ne!(old.call.media_room, new.call.media_room);
    assert_ne!(old.participant_id, new.participant_id);
    assert!(!new.member.role.can_publish_audio());
}

#[test]
fn invitation_scope_revocation_and_recovery_survive_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("calls.sqlite");
    let owner = MemberCredential::generate();
    let guest = MemberCredential::generate();
    let store = CallStore::open(&path).unwrap();
    let created = store.create(&owner, "create").unwrap();
    assert!(matches!(
        store.join(&owner, "device"),
        Err(CallError::NotReady)
    ));
    let active = store
        .media_completed(&created.id, created.revision)
        .unwrap();
    let invited = store
        .invite(&owner, "invite", active.revision, &guest, CallRole::Speaker)
        .unwrap();
    let grant = store.join(&guest, "guest-device").unwrap();
    assert_eq!(grant.call.id, created.id);
    assert_eq!(grant.member.role, CallRole::Speaker);
    assert!(matches!(
        store.end(&guest, "end", invited.revision),
        Err(CallError::Denied)
    ));
    let pending = store
        .remove_member(&owner, "remove", invited.revision, &grant.member.id)
        .unwrap();
    assert_eq!(pending.media_epoch, 2);
    assert_ne!(pending.media_room, active.media_room);
    assert_eq!(
        pending.media_state,
        MediaState::Rotating {
            previous_room: active.media_room
        }
    );
    assert!(matches!(
        store.join(&guest, "guest-device"),
        Err(CallError::Denied)
    ));
    assert!(matches!(
        store.join(&owner, "device"),
        Err(CallError::NotReady)
    ));
    drop(store);
    let store = CallStore::open(&path).unwrap();
    assert_eq!(store.pending_media().unwrap(), vec![pending.clone()]);
    let ready = store
        .media_completed(&pending.id, pending.revision)
        .unwrap();
    assert_eq!(store.join(&owner, "device").unwrap().call, ready);
    assert!(store.pending_media().unwrap().is_empty());
    let closing = store.end(&owner, "end", ready.revision).unwrap();
    assert!(matches!(
        store.join(&owner, "device"),
        Err(CallError::NotReady)
    ));
    let closed = store
        .media_completed(&closing.id, closing.revision)
        .unwrap();
    assert_eq!(closed.media_state, MediaState::Closed);
    assert!(matches!(
        store.join(&owner, "device"),
        Err(CallError::NotReady)
    ));
}

#[test]
fn retries_do_not_duplicate_members_and_conflicting_operations_fail() {
    let directory = tempfile::tempdir().unwrap();
    let store = CallStore::open(&directory.path().join("calls.sqlite")).unwrap();
    let owner = MemberCredential::generate();
    let guest = MemberCredential::generate();
    let created = store.create(&owner, "create").unwrap();
    assert_eq!(store.create(&owner, "create").unwrap(), created);
    let ready = store
        .media_completed(&created.id, created.revision)
        .unwrap();
    let first = store
        .invite(&owner, "invite", ready.revision, &guest, CallRole::Listener)
        .unwrap();
    assert_eq!(
        store
            .invite(&owner, "invite", ready.revision, &guest, CallRole::Listener)
            .unwrap(),
        first
    );
    assert_eq!(first.members.len(), 2);
    assert!(matches!(
        store.invite(&owner, "invite", ready.revision, &guest, CallRole::Speaker),
        Err(CallError::Conflict)
    ));
    assert!(matches!(
        store.end(&owner, "end", ready.revision),
        Err(CallError::Conflict)
    ));
    assert!(matches!(
        store.remove_member(&owner, "self", first.revision, &first.members[0].id),
        Err(CallError::Invalid)
    ));
    assert!(matches!(
        store.read(&MemberCredential::generate()),
        Err(CallError::Denied)
    ));
    let connection = store.connection.lock().unwrap();
    let stored: String = connection
        .query_row(
            "SELECT credential FROM media_members WHERE member_id=?1",
            [&first.members[0].id],
            |row| row.get(0),
        )
        .unwrap();
    assert_ne!(stored, owner.expose());
}
