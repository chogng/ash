use crate::RoomOpenParams;
use crate::RoomPrincipal;
use crate::RoomReplay;
use crate::RoomRole;
use crate::RoomSubmitParams;
use crate::RoomSubmitResult;
use crate::SqliteRoomStore;
use tempfile::TempDir;

#[test]
fn sqlite_legacy_update_receipts_survive_checkpoint_migration() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("legacy.sqlite3");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(include_str!("../migrations/document-rooms/0001_rooms.sql"))
        .unwrap();
    let request = submit("legacy-room", "legacy-client", 1, 0, "saved");
    connection.execute("INSERT INTO document_collaboration_rooms(room_id,schema_id,document,version) VALUES (?1,'stanza-document-v1',?2,1)", rusqlite::params![request.room_id,request.document]).unwrap();
    connection
        .execute(
            "INSERT INTO document_collaboration_updates VALUES (?1,1,?2,1,0,?3,?4)",
            rusqlite::params![
                request.room_id,
                request.client_id,
                request.transaction,
                request.document
            ],
        )
        .unwrap();
    drop(connection);
    let rooms = SqliteRoomStore::open_at(&path).unwrap();
    assert_eq!(accepted_version(&rooms.submit(request.clone()).unwrap()), 1);
    let mut changed = request;
    changed.document = document("different");
    assert!(rooms.submit(changed).is_err());
    let joined = rooms
        .open(open_params(
            Some("legacy-room".into()),
            "new-client",
            document("ignored"),
        ))
        .unwrap();
    assert_eq!(joined.snapshot.document, document("saved"));
    assert_eq!(joined.snapshot.version, 1);
}

#[test]
fn concurrent_open_installs_empty_and_legacy_room_schemas() {
    let directory = TempDir::new().unwrap();
    for legacy in [false, true] {
        let path = directory
            .path()
            .join(format!("collaboration-{legacy}.sqlite3"));
        let room = legacy.then(|| {
            let rooms = SqliteRoomStore::open_at(&path).unwrap();
            let opened = rooms
                .open(open_params(None, "client-a", document("old")))
                .unwrap();
            let room = opened.snapshot.room_id;
            rooms
                .submit(submit(&room, "client-a", 1, 0, "saved"))
                .unwrap();
            drop(rooms);
            rusqlite::Connection::open(&path)
                .unwrap()
                .execute_batch(
                    "ALTER TABLE document_collaboration_rooms DROP COLUMN presence_generation;
                     DROP TABLE ash_schema_migrations;",
                )
                .unwrap();
            room
        });
        let barrier = std::sync::Barrier::new(4);
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| {
                    barrier.wait();
                    let rooms = SqliteRoomStore::open_at(&path).unwrap();
                    if let Some(room) = &room {
                        let snapshot = rooms
                            .open(open_params(
                                Some(room.clone()),
                                "client-b",
                                document("ignored"),
                            ))
                            .unwrap()
                            .snapshot;
                        assert_eq!(snapshot.document, document("saved"));
                        assert_eq!(snapshot.version, 1);
                    }
                });
            }
        });
        let connection = rusqlite::Connection::open(&path).unwrap();
        for component in ["document-rooms", "channel-resources"] {
            let version: u32 = connection
                .query_row(
                    "SELECT version FROM ash_schema_migrations WHERE component = ?1",
                    [component],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(version, if component == "document-rooms" { 2 } else { 1 });
        }
    }
}

#[test]
fn sqlite_rooms_recover_ordered_snapshots_after_reopening() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("collaboration.sqlite3");
    let room_id = {
        let rooms = SqliteRoomStore::open_at(&path).unwrap();
        let opened = rooms
            .open(open_params(None, "client-a", document("initial")))
            .unwrap();
        let room_id = opened.snapshot.room_id;
        let accepted = rooms
            .submit(submit(&room_id, "client-a", 1, 0, "first"))
            .unwrap();
        assert_eq!(accepted_version(&accepted), 1);
        room_id
    };
    let rooms = SqliteRoomStore::open_at(&path).unwrap();
    let joined = rooms
        .open(open_params(
            Some(room_id.clone()),
            "client-b",
            document("ignored"),
        ))
        .unwrap();
    assert_eq!(joined.snapshot.version, 1);
    assert_eq!(joined.snapshot.document, document("first"));
    let replay = rooms.replay(&room_id, 0).unwrap();
    assert!(
        matches!(replay, RoomReplay::Updates(updates) if updates.len() == 1 && updates[0].client_id == "client-a")
    );
}

#[test]
fn sqlite_rooms_upgrade_legacy_snapshots_to_typed_v2_without_recreating_the_room() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("collaboration.sqlite3");
    let mut envelope: serde_json::Value = serde_json::from_str(&document("updated")).unwrap();
    envelope["version"] = 2.into();
    envelope["documentType"] = "general".into();
    let encoded = envelope.to_string();
    let room_id = {
        let rooms = SqliteRoomStore::open_at(&path).unwrap();
        let opened = rooms
            .open(open_params(None, "client-a", document("legacy")))
            .unwrap();
        let room_id = opened.snapshot.room_id;
        let mut update = submit(&room_id, "client-a", 1, 0, "updated");
        update.document = encoded.clone();
        assert_eq!(accepted_version(&rooms.submit(update).unwrap()), 1);
        room_id
    };
    let rooms = SqliteRoomStore::open_at(&path).unwrap();
    let joined = rooms
        .open(open_params(Some(room_id), "client-b", document("ignored")))
        .unwrap();
    assert_eq!(joined.snapshot.document, encoded);
    assert_eq!(joined.snapshot.version, 1);
}

#[test]
fn persisted_channel_members_with_long_unicode_names_can_open_notes() {
    use crate::channels::ChannelChange;
    use crate::channels::ChannelCredential;
    use crate::channels::ChannelEditParams;
    use crate::channels::ChannelInvite;
    use crate::channels::ChannelInviteParams;
    use crate::channels::ChannelResourceKind;
    use crate::channels::ChannelResourceParams;
    use crate::channels::ChannelRole;
    use crate::channels::ChannelStore;

    for name in ["中".repeat(80), "😀".repeat(40)] {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("collaboration.sqlite3");
        let owner = ChannelCredential::generate().unwrap();
        let member = ChannelCredential::generate().unwrap();
        let access = {
            let channels = ChannelStore::open(&path).unwrap();
            let space = channels.create(&owner, "Workspace", &name).unwrap();
            let space = channels
                .invite(
                    &owner,
                    ChannelInvite {
                        params: ChannelInviteParams {
                            space_id: space.id.clone(),
                            revision: space.revision,
                            name: name.clone(),
                            role: ChannelRole::Editor,
                        },
                        credential: member.expose().into(),
                    },
                )
                .unwrap();
            let space = channels
                .edit(
                    &owner,
                    ChannelEditParams {
                        space_id: space.id,
                        revision: space.revision,
                        change: ChannelChange::Create {
                            name: "Notes".into(),
                            parent_id: None,
                        },
                    },
                )
                .unwrap();
            channels
                .resource(
                    &member,
                    ChannelResourceParams {
                        space_id: space.id,
                        channel_id: space.channels[0].id.clone(),
                    },
                    ChannelResourceKind::Notes,
                )
                .unwrap()
        };
        // Reopen from persisted channel membership rather than shortening an existing name.
        let rooms = SqliteRoomStore::open_at(&path).unwrap();
        let member_principal = rooms
            .principal_for_access_token(&access.resource_id, &access.credential)
            .unwrap()
            .unwrap();
        assert_eq!(member_principal.display_name, name);
        let opened = rooms
            .open_as(
                &member_principal,
                open_params(
                    Some(access.resource_id.clone()),
                    "client-unicode",
                    document("ignored"),
                ),
            )
            .unwrap();
        assert_eq!(opened.snapshot.room_id, access.resource_id);
        rooms
            .submit_as(
                &member_principal,
                submit(&access.resource_id, "client-unicode", 1, 0, "edited"),
            )
            .unwrap();
        assert!(
            rooms
                .open_as(
                    &principal("invalid", &"中".repeat(129)),
                    open_params(None, "client-invalid", document("initial"))
                )
                .is_err()
        );
    }
}

#[test]
fn sqlite_rooms_make_submit_retries_idempotent() {
    let directory = TempDir::new().unwrap();
    let rooms = SqliteRoomStore::open_at(directory.path().join("collaboration.sqlite3")).unwrap();
    let room_id = rooms
        .open(open_params(None, "client-a", document("initial")))
        .unwrap()
        .snapshot
        .room_id;
    let first = rooms
        .submit(submit(&room_id, "client-a", 1, 0, "first"))
        .unwrap();
    let retry = rooms
        .submit(submit(&room_id, "client-a", 1, 0, "first"))
        .unwrap();
    assert_eq!(first, retry);
    assert!(
        rooms
            .submit(submit(&room_id, "client-a", 1, 0, "different"))
            .is_err()
    );
}

#[test]
fn sqlite_rooms_persist_member_roles_credentials_and_audit_history() {
    let directory = TempDir::new().unwrap();
    let rooms = SqliteRoomStore::open_at(directory.path().join("collaboration.sqlite3")).unwrap();
    let owner = principal("owner", "Owner");
    let room_id = rooms
        .open_as(
            &owner,
            open_params(None, "client-owner", document("initial")),
        )
        .unwrap()
        .snapshot
        .room_id;

    let viewer_invite = rooms
        .create_invite(&room_id, &owner, "Viewer", RoomRole::Viewer)
        .unwrap();
    let viewer = rooms
        .principal_for_access_token(&room_id, &viewer_invite.access_token)
        .unwrap()
        .unwrap();
    assert_eq!(
        rooms
            .list_members(&room_id, &owner)
            .unwrap()
            .iter()
            .map(|member| member.display_name.as_str())
            .collect::<Vec<_>>(),
        vec!["Owner", "Viewer"]
    );
    assert!(
        rooms
            .list_members(&room_id, &viewer)
            .unwrap_err()
            .contains("owners")
    );
    let joined = rooms
        .open_as(
            &viewer,
            open_params(Some(room_id.clone()), "client-viewer", document("ignored")),
        )
        .unwrap();
    assert_eq!(joined.snapshot.version, 0);
    assert!(
        rooms
            .submit_as(
                &viewer,
                submit(&room_id, "client-viewer", 1, 0, "viewer-change")
            )
            .unwrap_err()
            .contains("read-only")
    );
    assert!(
        rooms
            .audit_events(&room_id, &viewer)
            .unwrap_err()
            .contains("owners")
    );
    assert_eq!(
        rooms
            .update_presence_as(&viewer, &room_id, "viewer-client", Some(selection()))
            .unwrap(),
        1
    );
    let presence = rooms.replay_presence_as(&owner, &room_id, 0).unwrap();
    assert_eq!(presence.generation, 1);
    assert_eq!(
        presence.presences.first().unwrap().client_id,
        "viewer-client"
    );
    assert_eq!(presence.presences.first().unwrap().selection, selection());

    let editor_invite = rooms
        .create_invite(&room_id, &owner, "Editor", RoomRole::Editor)
        .unwrap();
    let editor = rooms
        .principal_for_access_token(&room_id, &editor_invite.access_token)
        .unwrap()
        .unwrap();
    assert_eq!(
        accepted_version(
            &rooms
                .submit_as(
                    &editor,
                    submit(&room_id, "client-editor", 1, 0, "editor-change")
                )
                .unwrap()
        ),
        1
    );

    let rotated = rooms
        .rotate_member_access_token(&room_id, &owner, &editor_invite.principal_id)
        .unwrap();
    assert!(
        rooms
            .principal_for_access_token(&room_id, &editor_invite.access_token)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        rooms
            .principal_for_access_token(&room_id, &rotated.access_token)
            .unwrap(),
        Some(editor.clone())
    );
    rooms.revoke_member(&room_id, &owner, &editor.id).unwrap();
    assert!(
        rooms
            .revoke_member(&room_id, &owner, &owner.id)
            .unwrap_err()
            .contains("cannot revoke themselves")
    );
    assert_eq!(
        rooms
            .list_members(&room_id, &owner)
            .unwrap()
            .iter()
            .map(|member| member.display_name.as_str())
            .collect::<Vec<_>>(),
        vec!["Owner", "Viewer"]
    );
    assert!(
        rooms
            .open_as(
                &editor,
                open_params(Some(room_id.clone()), "client-editor", document("ignored"))
            )
            .unwrap_err()
            .contains("not a room member")
    );

    let events = rooms.audit_events(&room_id, &owner).unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec![
            "room.created",
            "member.invited",
            "member.invited",
            "document.submitted",
            "member.token_rotated",
            "member.revoked"
        ]
    );
    assert!(
        events
            .windows(2)
            .all(|events| events[0].event_id < events[1].event_id)
    );
}

#[test]
fn sqlite_rooms_initialize_only_pre_membership_rooms_for_a_bootstrap_owner() {
    let directory = TempDir::new().unwrap();
    let rooms = SqliteRoomStore::open_at(directory.path().join("collaboration.sqlite3")).unwrap();
    let room_id = rooms
        .open(open_params(None, "legacy-client", document("initial")))
        .unwrap()
        .snapshot
        .room_id;
    let owner = principal("server-admin", "Server administrator");
    rooms.initialize_owner_if_unowned(&room_id, &owner).unwrap();
    assert_eq!(
        rooms
            .open_as(
                &owner,
                open_params(Some(room_id.clone()), "owner-client", document("ignored"))
            )
            .unwrap()
            .snapshot
            .room_id,
        room_id
    );
    assert_eq!(
        rooms.audit_events(&room_id, &owner).unwrap()[0].event_type,
        "room.owner_initialized"
    );
}

fn open_params(room_id: Option<String>, client_id: &str, document: String) -> RoomOpenParams {
    RoomOpenParams {
        lease: None,
        room_id,
        client_id: client_id.into(),
        schema_id: "stanza-document-v1".into(),
        document,
    }
}

fn principal(id: &str, display_name: &str) -> RoomPrincipal {
    RoomPrincipal {
        id: id.into(),
        display_name: display_name.into(),
    }
}

fn submit(
    room_id: &str,
    client_id: &str,
    sequence: u64,
    base_version: u64,
    value: &str,
) -> RoomSubmitParams {
    RoomSubmitParams {
        epoch: None,
        room_id: room_id.into(),
        client_id: client_id.into(),
        sequence,
        base_version,
        transaction: transaction(),
        document: document(value),
    }
}

fn document(value: &str) -> String {
    format!(
        r#"{{"format":"ash.document","version":1,"document":{{"id":"document-1","type":"doc","attrs":{{}},"marks":[],"content":[{{"id":"text-1","type":"text","attrs":{{}},"marks":[],"content":[],"text":"{value}"}}]}}}}"#
    )
}

fn transaction() -> String {
    r#"{"format":"ash.document.transaction","version":1,"transaction":{"steps":[],"addToHistory":true,"selectionSet":false,"storedMarksSet":false,"metadata":[]}}"#.into()
}

fn selection() -> &'static str {
    r#"{"kind":"text","anchor":{"nodeId":"text-1","offset":0},"head":{"nodeId":"text-1","offset":1}}"#
}

fn accepted_version(result: &RoomSubmitResult) -> u64 {
    match result {
        RoomSubmitResult::Accepted { update } => update.version,
        _ => panic!("expected an accepted collaboration update"),
    }
}
