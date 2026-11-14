use crate::*;
use ash_arkdown::Buffer;
use ash_arkdown::TextEdit;
use ash_arkdown::Transaction;
use ash_arkdown::Utf16Range;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

fn payload(bytes: &[u8]) -> String {
    serde_json::json!({"format":"ash.arkdown.crdt","version":1,"update":STANDARD.encode(bytes)})
        .to_string()
}
fn state(doc: &Buffer) -> String {
    payload(&doc.encode_update(&[]).unwrap())
}
fn read(value: &str) -> Buffer {
    let parsed: serde_json::Value = serde_json::from_str(value).unwrap();
    let bytes = STANDARD.decode(parsed["update"].as_str().unwrap()).unwrap();
    let mut doc = Buffer::new(77, "").unwrap();
    doc.apply_update(&bytes).unwrap();
    doc
}
fn insert(doc: &mut Buffer, text: &str) {
    doc.apply(Transaction {
        expected_revision: doc.revision(),
        edits: vec![TextEdit {
            range: Utf16Range { start: 2, end: 2 },
            text: text.into(),
        }],
    })
    .unwrap();
}
#[test]
fn markdown_room_rebases_concurrent_crdt_updates_and_derives_canonical_snapshot() {
    let mut rooms = MemoryRoomStore::default();
    let mut a = Buffer::new(11, "alpha🙂").unwrap();
    let opened = rooms
        .open(RoomOpenParams {
            lease: None,
            room_id: None,
            client_id: "alice".into(),
            schema_id: crate::markdown::SCHEMA.into(),
            document: state(&a),
        })
        .unwrap();
    let room = opened.snapshot.room_id;
    let mut b = read(&opened.snapshot.document);
    insert(&mut a, "甲");
    insert(&mut b, "乙");
    let first = RoomSubmitParams {
        epoch: None,
        room_id: room.clone(),
        client_id: "alice".into(),
        sequence: 1,
        base_version: 0,
        transaction: state(&a),
        document: state(&a),
    };
    assert!(matches!(
        rooms.submit(first.clone()).unwrap(),
        RoomSubmitResult::Accepted { .. }
    ));
    let mut second = RoomSubmitParams {
        epoch: None,
        room_id: room.clone(),
        client_id: "bob".into(),
        sequence: 1,
        base_version: 0,
        transaction: state(&b),
        document: state(&b),
    };
    let RoomSubmitResult::Conflict { updates } = rooms.submit(second.clone()).unwrap() else {
        panic!("expected rebase")
    };
    for update in updates {
        let value: serde_json::Value = serde_json::from_str(&update.transaction).unwrap();
        b.apply_update(&STANDARD.decode(value["update"].as_str().unwrap()).unwrap())
            .unwrap();
    }
    second.base_version = 1;
    second.transaction = state(&b);
    // Even a stale optimistic document cannot discard server-accepted CRDT IDs.
    second.document = opened.snapshot.document;
    assert!(matches!(
        rooms.submit(second.clone()).unwrap(),
        RoomSubmitResult::Accepted { .. }
    ));
    assert!(matches!(
        rooms.submit(second).unwrap(),
        RoomSubmitResult::Accepted { .. }
    ));
    let joined = rooms
        .open(RoomOpenParams {
            lease: None,
            room_id: Some(room),
            client_id: "third".into(),
            schema_id: crate::markdown::SCHEMA.into(),
            document: state(&a),
        })
        .unwrap();
    assert_eq!(read(&joined.snapshot.document).source(), b.source());
    assert_eq!(joined.snapshot.version, 2);
}

#[test]
fn sqlite_markdown_rooms_persist_canonical_updates_and_enforce_viewer_role() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rooms.db");
    let owner = RoomPrincipal {
        id: "owner".into(),
        display_name: "Owner".into(),
    };
    let mut doc = Buffer::new(12, "alpha").unwrap();
    let rooms = SqliteRoomStore::open_at(&path).unwrap();
    let opened = rooms
        .open_as(
            &owner,
            RoomOpenParams {
                lease: None,
                room_id: None,
                client_id: "owner-client".into(),
                schema_id: crate::markdown::SCHEMA.into(),
                document: state(&doc),
            },
        )
        .unwrap();
    let invite = rooms
        .create_invite(&opened.snapshot.room_id, &owner, "Viewer", RoomRole::Viewer)
        .unwrap();
    let viewer = rooms
        .principal_for_access_token(&opened.snapshot.room_id, &invite.access_token)
        .unwrap()
        .unwrap();
    insert(&mut doc, "甲");
    let submit = RoomSubmitParams {
        epoch: None,
        room_id: opened.snapshot.room_id.clone(),
        client_id: "client".into(),
        sequence: 1,
        base_version: 0,
        transaction: state(&doc),
        document: opened.snapshot.document,
    };
    assert!(rooms.submit_as(&viewer, submit.clone()).is_err());
    rooms.submit_as(&owner, submit).unwrap();
    drop(rooms);
    let reopened = SqliteRoomStore::open_at(&path).unwrap();
    let joined = reopened
        .open_as(
            &viewer,
            RoomOpenParams {
                lease: None,
                room_id: Some(opened.snapshot.room_id),
                client_id: "viewer-client".into(),
                schema_id: crate::markdown::SCHEMA.into(),
                document: state(&doc),
            },
        )
        .unwrap();
    assert_eq!(read(&joined.snapshot.document).source(), doc.source());
}

#[test]
fn malformed_markdown_payloads_do_not_create_or_mutate_rooms() {
    let mut rooms = MemoryRoomStore::default();
    let doc = Buffer::new(15, "unchanged").unwrap();
    for document in [
        r#"{"format":"ash.arkdown.crdt","version":2,"update":"AAA="}"#,
        r#"{"format":"ash.arkdown.crdt","version":1,"update":"not-base64"}"#,
        r#"{"format":"ash.arkdown.crdt","version":1,"update":"AAAA","extra":true}"#,
        r#"{"format":"ash.arkdown.crdt","version":1,"update":"/w=="}"#,
    ] {
        assert!(
            rooms
                .open(RoomOpenParams {
                    lease: None,
                    room_id: None,
                    client_id: "client".into(),
                    schema_id: crate::markdown::SCHEMA.into(),
                    document: document.into(),
                })
                .is_err()
        );
    }
    let opened = rooms
        .open(RoomOpenParams {
            lease: None,
            room_id: None,
            client_id: "client".into(),
            schema_id: crate::markdown::SCHEMA.into(),
            document: state(&doc),
        })
        .unwrap();
    assert!(
        rooms
            .submit(RoomSubmitParams {
                epoch: None,
                room_id: opened.snapshot.room_id.clone(),
                client_id: "client".into(),
                sequence: 1,
                base_version: 0,
                transaction: payload(&[255]),
                document: state(&doc),
            })
            .is_err()
    );
    let after = rooms
        .open(RoomOpenParams {
            lease: None,
            room_id: Some(opened.snapshot.room_id),
            client_id: "reader".into(),
            schema_id: crate::markdown::SCHEMA.into(),
            document: state(&doc),
        })
        .unwrap();
    assert_eq!(after.snapshot.version, 0);
    assert_eq!(read(&after.snapshot.document).source(), "unchanged");
}

#[test]
fn room_epoch_rejects_a_packet_from_another_incarnation() {
    let doc = Buffer::new(16, "seed").unwrap();
    let params = RoomOpenParams {
        lease: Some(true),
        room_id: Some("shared".into()),
        client_id: "a".into(),
        schema_id: crate::markdown::SCHEMA.into(),
        document: state(&doc),
    };
    let mut first = MemoryRoomStore::default();
    let old = first.open(params.clone()).unwrap();
    let mut restarted = MemoryRoomStore::default();
    let current = restarted.open(params).unwrap();
    assert_ne!(old.snapshot.epoch, current.snapshot.epoch);
    let result = restarted
        .submit(RoomSubmitParams {
            epoch: old.snapshot.epoch,
            room_id: "shared".into(),
            client_id: "a".into(),
            sequence: 1,
            base_version: 0,
            transaction: state(&doc),
            document: state(&doc),
        })
        .unwrap();
    assert!(matches!(result, RoomSubmitResult::Resync { .. }));
}

#[test]
fn sqlite_checkpoints_replay_deltas_and_bound_leased_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("checkpoint.sqlite");
    let rooms = SqliteRoomStore::open_at(&path).unwrap();
    let mut doc = Buffer::new(17, "seed").unwrap();
    let opened = rooms
        .open(RoomOpenParams {
            lease: Some(true),
            room_id: None,
            client_id: "a".into(),
            schema_id: crate::markdown::SCHEMA.into(),
            document: state(&doc),
        })
        .unwrap();
    let room = opened.snapshot.room_id;
    let epoch = opened.snapshot.epoch;
    for sequence in 1..=520 {
        let vector = doc.state_vector();
        insert(&mut doc, "x");
        rooms
            .submit(RoomSubmitParams {
                epoch: epoch.clone(),
                room_id: room.clone(),
                client_id: "a".into(),
                sequence,
                base_version: sequence - 1,
                transaction: payload(&doc.encode_update(&vector).unwrap()),
                document: state(&doc),
            })
            .unwrap();
    }
    drop(rooms);
    let db = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM collaboration_receipts", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        512
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM document_collaboration_updates",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        512
    );
    assert_eq!(
        db.query_row(
            "SELECT checkpoint_version FROM document_collaboration_rooms",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        512
    );
    let names = db
        .prepare("SELECT name FROM pragma_table_info('document_collaboration_updates')")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(!names.iter().any(|name| name == "document"));
    let rooms = SqliteRoomStore::open_at(&path).unwrap();
    let joined = rooms
        .open(RoomOpenParams {
            lease: Some(true),
            room_id: Some(room.clone()),
            client_id: "b".into(),
            schema_id: crate::markdown::SCHEMA.into(),
            document: state(&doc),
        })
        .unwrap();
    assert_eq!(read(&joined.snapshot.document).source(), doc.source());
    assert_eq!(joined.snapshot.epoch, epoch);
    db.execute(
        "UPDATE collaboration_clients SET expires=0 WHERE client_id='a'",
        [],
    )
    .unwrap();
    assert!(
        rooms
            .status_as(
                None,
                crate::RoomStatusParams {
                    room_id: room,
                    client_id: "a".into()
                }
            )
            .unwrap_err()
            .contains("leaseExpired")
    );
}
