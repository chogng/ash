use super::*;
use serde_json::json;

fn output() -> Turn {
    serde_json::from_value(json!({"turnId":"turn", "status":"completed", "items":[
        {"type":"userContext", "itemId":"context", "turnId":"turn", "name":"ash.creation.docs", "content":"Write"},
        {"type":"agentMessage", "itemId":"final", "turnId":"turn", "phase":"final_answer", "text":"# Retained\n\nOriginal"}
    ]})).unwrap()
}

#[test]
fn native_document_replay_keeps_user_edits_and_metadata_after_restart() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.sqlite");
    let catalog = Arc::new(SqliteArtifactCatalog::open(&path).unwrap());
    let directory = temp.path().canonicalize().unwrap().join("documents");
    let documents = Documents::new(catalog.clone(), directory.clone());
    let session = SessionId::new("session").unwrap();
    let thread = ThreadId::new("thread").unwrap();
    assert!(
        documents
            .accept_completed_turn(&session, &thread, &output())
            .unwrap()
    );
    let before = catalog
        .list(ash_artifact_catalog::NATIVE_ARTIFACT_CLIENT, &[])
        .unwrap();
    let file = documents.file_path(&before[0].file.id).unwrap();
    std::fs::write(&file, "# User edit").unwrap();
    drop(documents);
    let documents = Documents::new(catalog.clone(), directory);
    assert!(
        !documents
            .accept_completed_turn(&session, &thread, &output())
            .unwrap()
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "# User edit");
    assert_eq!(
        catalog
            .list(ash_artifact_catalog::NATIVE_ARTIFACT_CLIENT, &[])
            .unwrap(),
        before
    );
    assert_eq!(
        documents.resource_id(&file),
        Some(before[0].file.id.as_str())
    );
    assert!(documents.file_system(&"b".repeat(64)).is_err());
    assert!(documents.file_path("../outside").is_none());
}

#[test]
fn document_routes_exclude_other_native_artifact_kinds() {
    let temp = tempfile::tempdir().unwrap();
    let catalog = Arc::new(SqliteArtifactCatalog::open(&temp.path().join("state.sqlite")).unwrap());
    let id = "a".repeat(64);
    catalog
        .register_native(&ArtifactRegistration {
            id: id.clone(),
            resource: "file:///chart.svg".into(),
            title: "Chart".into(),
            content_type: "image/svg+xml".into(),
            source: ArtifactSource {
                provider_id: "local-agent-host".into(),
                account_id: None,
                session_id: "session".into(),
                thread_id: "thread".into(),
                item_id: "item".into(),
                part_id: "svg".into(),
            },
        })
        .unwrap();
    let documents = Documents::new(catalog, temp.path().to_owned());
    assert!(documents.file_path(&id).is_none());
}
