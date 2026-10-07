use crate::DocumentCollaborationOpenParams;
use crate::DocumentCollaborationPrincipal;
use crate::DocumentCollaborationReplay;
use crate::DocumentCollaborationRoomRole;
use crate::DocumentCollaborationSubmitParams;
use crate::DocumentCollaborationSubmitResult;
use crate::SqliteDocumentCollaborationRooms;
use tempfile::TempDir;

#[test]
fn sqlite_rooms_recover_ordered_snapshots_after_reopening() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("collaboration.sqlite3");
    let room_id = {
        let rooms = SqliteDocumentCollaborationRooms::open_at(&path).unwrap();
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
    let rooms = SqliteDocumentCollaborationRooms::open_at(&path).unwrap();
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
        matches!(replay, DocumentCollaborationReplay::Updates(updates) if updates.len() == 1 && updates[0].client_id == "client-a")
    );
}

#[test]
fn sqlite_rooms_make_submit_retries_idempotent() {
    let directory = TempDir::new().unwrap();
    let rooms =
        SqliteDocumentCollaborationRooms::open_at(directory.path().join("collaboration.sqlite3"))
            .unwrap();
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
    let rooms =
        SqliteDocumentCollaborationRooms::open_at(directory.path().join("collaboration.sqlite3"))
            .unwrap();
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
        .create_invite(
            &room_id,
            &owner,
            "Viewer",
            DocumentCollaborationRoomRole::Viewer,
        )
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
        .create_invite(
            &room_id,
            &owner,
            "Editor",
            DocumentCollaborationRoomRole::Editor,
        )
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
    let rooms =
        SqliteDocumentCollaborationRooms::open_at(directory.path().join("collaboration.sqlite3"))
            .unwrap();
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

fn open_params(
    room_id: Option<String>,
    client_id: &str,
    document: String,
) -> DocumentCollaborationOpenParams {
    DocumentCollaborationOpenParams {
        room_id,
        client_id: client_id.into(),
        schema_id: "stanza-document-v1".into(),
        document,
    }
}

fn principal(id: &str, display_name: &str) -> DocumentCollaborationPrincipal {
    DocumentCollaborationPrincipal {
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
) -> DocumentCollaborationSubmitParams {
    DocumentCollaborationSubmitParams {
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

fn accepted_version(result: &DocumentCollaborationSubmitResult) -> u64 {
    match result {
        DocumentCollaborationSubmitResult::Accepted { update } => update.version,
        _ => panic!("expected an accepted collaboration update"),
    }
}
