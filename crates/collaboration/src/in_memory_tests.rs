use crate::DocumentCollaborationOpenParams;
use crate::DocumentCollaborationPresenceParams;
use crate::DocumentCollaborationPresenceReadParams;
use crate::DocumentCollaborationReplay;
use crate::DocumentCollaborationSubmitParams;
use crate::DocumentCollaborationSubmitResult;
use crate::InMemoryDocumentCollaborationRooms;

#[test]
fn in_memory_rooms_order_updates_and_replay_stale_clients() {
    let mut rooms = InMemoryDocumentCollaborationRooms::default();
    let document = document("initial");
    let opened = rooms
        .open(DocumentCollaborationOpenParams {
            room_id: None,
            client_id: "client-a".into(),
            schema_id: "stanza-document-v1".into(),
            document,
        })
        .unwrap();
    assert_room_id(&opened.snapshot.room_id);
    let accepted = rooms
        .submit(submit(&opened.snapshot.room_id, "client-a", 1, 0, "first"))
        .unwrap();
    assert_eq!(accepted_version(&accepted), 1);
    let replay = rooms.replay(&opened.snapshot.room_id, 0).unwrap();
    assert!(
        matches!(replay, DocumentCollaborationReplay::Updates(updates) if updates.len() == 1 && updates[0].version == 1)
    );
}

#[test]
fn in_memory_rooms_return_the_same_result_for_an_exact_retry() {
    let mut rooms = InMemoryDocumentCollaborationRooms::default();
    let room_id = open_room(&mut rooms);
    let first = rooms
        .submit(submit(&room_id, "client-a", 1, 0, "first"))
        .unwrap();
    let retried = rooms
        .submit(submit(&room_id, "client-a", 1, 0, "first"))
        .unwrap();
    assert_eq!(first, retried);
    let rejected = rooms.submit(submit(&room_id, "client-a", 1, 0, "changed"));
    assert!(rejected.is_err());
}

#[test]
fn collaboration_authorities_reject_invalid_document_and_transaction_envelopes() {
    let mut rooms = InMemoryDocumentCollaborationRooms::default();
    let invalid_document = rooms.open(DocumentCollaborationOpenParams {
        room_id: None,
        client_id: "client-a".into(),
        schema_id: "stanza-document-v1".into(),
        document: "{}".into(),
    });
    assert!(invalid_document.unwrap_err().contains("ash.document v1"));

    let room_id = open_room(&mut rooms);
    let invalid_transaction = DocumentCollaborationSubmitParams {
        room_id,
        client_id: "client-a".into(),
        sequence: 1,
        base_version: 0,
        transaction: r#"{"format":"ash.document.transaction","version":1,"transaction":{"steps":[{"kind":"unknown"}],"addToHistory":true,"selectionSet":false,"storedMarksSet":false,"metadata":[]}}"#.into(),
        document: document("first"),
    };
    assert!(
        rooms
            .submit(invalid_transaction)
            .unwrap_err()
            .contains("unknown Document Engine step kind")
    );
}

#[test]
fn in_memory_rooms_publish_and_clear_ephemeral_presence_without_advancing_document_version() {
    let mut rooms = InMemoryDocumentCollaborationRooms::default();
    let room_id = open_room(&mut rooms);
    let published = rooms
        .publish_presence(DocumentCollaborationPresenceParams {
            room_id: room_id.clone(),
            client_id: "client-a".into(),
            selection: Some(selection().into()),
        })
        .unwrap();
    assert_eq!(published.generation, 1);
    assert_eq!(published.presences.len(), 1);
    assert_eq!(
        rooms.replay(&room_id, 0).unwrap(),
        DocumentCollaborationReplay::Updates(Vec::new())
    );
    let cleared = rooms
        .publish_presence(DocumentCollaborationPresenceParams {
            room_id: room_id.clone(),
            client_id: "client-a".into(),
            selection: None,
        })
        .unwrap();
    assert_eq!(cleared.generation, 2);
    assert!(cleared.presences.is_empty());
    assert_eq!(
        rooms
            .read_presence(DocumentCollaborationPresenceReadParams { room_id })
            .unwrap(),
        cleared
    );
}

fn open_room(rooms: &mut InMemoryDocumentCollaborationRooms) -> String {
    rooms
        .open(DocumentCollaborationOpenParams {
            room_id: None,
            client_id: "client-a".into(),
            schema_id: "stanza-document-v1".into(),
            document: document("initial"),
        })
        .unwrap()
        .snapshot
        .room_id
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

fn transaction() -> String {
    r#"{"format":"ash.document.transaction","version":1,"transaction":{"steps":[],"addToHistory":true,"selectionSet":false,"storedMarksSet":false,"metadata":[]}}"#.into()
}

fn selection() -> &'static str {
    r#"{"kind":"text","anchor":{"nodeId":"text-1","offset":0},"head":{"nodeId":"text-1","offset":1}}"#
}

fn document(value: &str) -> String {
    format!(
        r#"{{"format":"ash.document","version":1,"document":{{"id":"document-1","type":"doc","attrs":{{}},"marks":[],"content":[{{"id":"text-1","type":"text","attrs":{{}},"marks":[],"content":[],"text":"{value}"}}]}}}}"#
    )
}

fn accepted_version(result: &DocumentCollaborationSubmitResult) -> u64 {
    match result {
        DocumentCollaborationSubmitResult::Accepted { update } => update.version,
        _ => panic!("expected an accepted collaboration update"),
    }
}

fn assert_room_id(room_id: &str) {
    assert_eq!(room_id.len(), "document-".len() + 32);
    assert!(room_id.starts_with("document-"));
    assert!(
        room_id["document-".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    );
}
