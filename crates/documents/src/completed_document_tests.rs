use super::completed_document;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::Turn;
use serde_json::json;

fn turn(items: serde_json::Value) -> Turn {
    serde_json::from_value(json!({ "turnId": "turn", "status": "completed", "items": items }))
        .unwrap()
}

#[test]
fn docs_creation_uses_the_final_response_and_keeps_the_published_source_identity() {
    let output = turn(json!([
        {"type":"userContext", "itemId":"context", "turnId":"turn", "name":"ash.creation.docs", "content":"Create a document"},
        {"type":"agentMessage", "itemId":"first", "turnId":"turn", "text":"Draft", "phase":"commentary"},
        {"type":"agentMessage", "itemId":"final", "turnId":"turn", "text":"# Review 评审\n\nAccepted body", "phase":"final_answer"},
        {"type":"agentMessage", "itemId":"last", "turnId":"turn", "text":"Saved", "phase":"commentary"}
    ]));
    let session = SessionId::new("session").unwrap();
    let thread = ThreadId::new("thread").unwrap();
    let document = completed_document(&session, &thread, &output).unwrap();
    assert_eq!(document.title, "Review 评审");
    assert_eq!(document.markdown, "# Review 评审\n\nAccepted body");
    assert_eq!(document.item_id.as_str(), "final");
    assert_eq!(
        document.id,
        "81d18dc02113e11bae057cef0682d799886b8bcbf410049d15233169c4639354"
    );
    assert_ne!(
        completed_document(&SessionId::new("other").unwrap(), &thread, &output)
            .unwrap()
            .id,
        document.id
    );
}

#[test]
fn only_completed_docs_output_is_published_and_legacy_unphased_replies_remain_supported() {
    let session = SessionId::new("session").unwrap();
    let thread = ThreadId::new("thread").unwrap();
    let mut output = turn(json!([
        {"type":"userContext", "itemId":"context", "turnId":"turn", "name":"ash.creation.docs", "content":"Create a document"},
        {"type":"agentMessage", "itemId":"reply", "turnId":"turn", "text":"Legacy title\n\nBody"}
    ]));
    assert_eq!(
        completed_document(&session, &thread, &output)
            .unwrap()
            .title,
        "Legacy title"
    );
    output.status = ash_protocol::TurnStatus::Failed;
    assert!(completed_document(&session, &thread, &output).is_none());
    output.status = ash_protocol::TurnStatus::Completed;
    output.items.remove(0);
    assert!(completed_document(&session, &thread, &output).is_none());
}

#[test]
fn commentary_and_empty_final_answers_do_not_create_documents() {
    let session = SessionId::new("session").unwrap();
    let thread = ThreadId::new("thread").unwrap();
    for (phase, text) in [("commentary", "Working"), ("final_answer", " \n\t")] {
        let output = turn(json!([
            {"type":"userContext", "itemId":"context", "turnId":"turn", "name":"ash.creation.docs", "content":"Create a document"},
            {"type":"agentMessage", "itemId":"reply", "turnId":"turn", "text":text, "phase":phase}
        ]));
        assert!(completed_document(&session, &thread, &output).is_none());
    }
}
