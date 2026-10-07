use super::MAX_BATCH_ENTRIES;
use super::MAX_BATCH_TEXT_BYTES;
use super::MAX_BATCH_UPDATES;
use super::TranscriptBatch;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptChange;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;
use ash_protocol::ItemId;
use ash_protocol::SessionId;
use ash_protocol::StreamCursor;
use ash_protocol::StreamInstanceId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::TurnId;

#[test]
fn repeated_entries_keep_the_latest_complete_value_and_cursor() {
    let mut batch = TranscriptBatch::start(update(1, vec![upsert("a", "hel")])).unwrap();

    batch.push(update(2, vec![upsert("a", "hello")])).unwrap();

    let update = batch.finish();
    assert_eq!(update.stream_cursor.as_ref().unwrap().sequence, 2);
    assert_eq!(entry_values(&update), vec![("item:a", "hello")]);
}

#[test]
fn distinct_entries_keep_first_appearance_order() {
    let mut batch =
        TranscriptBatch::start(update(1, vec![upsert("a", "a1"), upsert("b", "b1")])).unwrap();

    batch
        .push(update(2, vec![upsert("a", "a2"), upsert("c", "c1")]))
        .unwrap();

    assert_eq!(
        entry_values(&batch.finish()),
        vec![("item:a", "a2"), ("item:b", "b1"), ("item:c", "c1")]
    );
}

#[test]
fn committed_remove_and_clear_changes_are_barriers() {
    assert!(TranscriptBatch::start(update(1, vec![committed("a")])).is_err());
    assert!(TranscriptBatch::start(update(1, vec![remove("a")])).is_err());
    assert!(
        TranscriptBatch::start(update(1, vec![ThreadTranscriptChange::ClearTransient])).is_err()
    );
}

#[test]
fn scope_stream_and_sequence_boundaries_are_not_consumed() {
    let mut durable_boundary = scoped_update("session", "thread", "stream", 2);
    durable_boundary.durable_sequence += 1;
    let mut revision_boundary = scoped_update("session", "thread", "stream", 2);
    revision_boundary.revision += 1;
    let cases = vec![
        scoped_update("other", "thread", "stream", 2),
        scoped_update("session", "other", "stream", 2),
        scoped_update("session", "thread", "other", 2),
        scoped_update("session", "thread", "stream", 3),
        durable_boundary,
        revision_boundary,
    ];

    for next in cases {
        let mut batch = TranscriptBatch::start(update(1, vec![upsert("a", "a1")])).unwrap();
        let returned = batch.push(next).unwrap_err();
        assert_eq!(returned.changes.len(), 1);
        assert_eq!(entry_values(&batch.finish()), vec![("item:a", "a1")]);
    }
}

#[test]
fn oversized_first_update_is_returned_without_losing_changes() {
    let changes = (0..=MAX_BATCH_ENTRIES)
        .map(|index| upsert(&format!("entry-{index}"), "value"))
        .collect();

    let returned = match TranscriptBatch::start(update(1, changes)) {
        Ok(_) => panic!("oversized update should not start a transcript batch"),
        Err(update) => update,
    };

    assert_eq!(returned.changes.len(), MAX_BATCH_ENTRIES + 1);
}

#[test]
fn entry_limit_ends_the_batch_before_consuming_the_next_update() {
    let changes = (0..MAX_BATCH_ENTRIES)
        .map(|index| upsert(&format!("entry-{index}"), "value"))
        .collect();
    let mut batch = TranscriptBatch::start(update(1, changes)).unwrap();

    let returned = batch
        .push(update(2, vec![upsert("one-too-many", "value")]))
        .unwrap_err();

    assert_eq!(batch.finish().changes.len(), MAX_BATCH_ENTRIES);
    assert_eq!(
        entry_values(&returned),
        vec![("item:one-too-many", "value")]
    );
}

#[test]
fn text_limit_ends_the_batch_before_consuming_the_next_update() {
    let text = "x".repeat(MAX_BATCH_TEXT_BYTES / 8);
    let mut batch = TranscriptBatch::start(update(1, vec![upsert("entry-1", &text)])).unwrap();
    for sequence in 2..=8 {
        batch
            .push(update(
                sequence,
                vec![upsert(&format!("entry-{sequence}"), &text)],
            ))
            .unwrap();
    }

    let returned = batch
        .push(update(9, vec![upsert("one-too-large", "x")]))
        .unwrap_err();

    assert_eq!(batch.finish().changes.len(), 8);
    assert_eq!(entry_values(&returned), vec![("item:one-too-large", "x")]);
}

#[test]
fn update_limit_ends_a_single_identity_batch() {
    let mut batch = TranscriptBatch::start(update(1, vec![upsert("entry", "1")])).unwrap();
    for sequence in 2..=MAX_BATCH_UPDATES as u64 {
        batch
            .push(update(sequence, vec![upsert("entry", "next")]))
            .unwrap();
    }

    let returned = batch
        .push(update(
            MAX_BATCH_UPDATES as u64 + 1,
            vec![upsert("entry", "last")],
        ))
        .unwrap_err();

    assert_eq!(entry_values(&returned), vec![("item:entry", "last")]);
}

fn update(sequence: u64, changes: Vec<ThreadTranscriptChange>) -> ThreadTranscriptUpdateEnvelope {
    scoped_update_with_changes("session", "thread", "stream", sequence, changes)
}

fn scoped_update(
    session_id: &str,
    thread_id: &str,
    stream_id: &str,
    sequence: u64,
) -> ThreadTranscriptUpdateEnvelope {
    scoped_update_with_changes(
        session_id,
        thread_id,
        stream_id,
        sequence,
        vec![upsert("next", "value")],
    )
}

fn scoped_update_with_changes(
    session_id: &str,
    thread_id: &str,
    stream_id: &str,
    sequence: u64,
    changes: Vec<ThreadTranscriptChange>,
) -> ThreadTranscriptUpdateEnvelope {
    ThreadTranscriptUpdateEnvelope {
        session_id: SessionId::new(session_id).unwrap(),
        thread_id: ThreadId::new(thread_id).unwrap(),
        durable_sequence: 7,
        revision: sequence,
        stream_cursor: Some(StreamCursor {
            stream_instance_id: StreamInstanceId::new(stream_id).unwrap(),
            sequence,
        }),
        changes,
    }
}

fn upsert(id: &str, text: &str) -> ThreadTranscriptChange {
    ThreadTranscriptChange::Upsert {
        entry: item(id, text, true),
    }
}

fn committed(id: &str) -> ThreadTranscriptChange {
    ThreadTranscriptChange::Upsert {
        entry: item(id, "committed", false),
    }
}

fn remove(id: &str) -> ThreadTranscriptChange {
    ThreadTranscriptChange::Remove {
        entry_ids: vec![format!("item:{id}")],
    }
}

fn item(id: &str, text: &str, transient: bool) -> ThreadTranscriptEntry {
    let turn_id = TurnId::new("turn").unwrap();
    ThreadTranscriptEntry::Item {
        entry_id: format!("item:{id}"),
        turn_id: turn_id.clone(),
        item: ThreadItem::AgentMessage {
            item_id: ItemId::new(id).unwrap(),
            turn_id,
            text: text.to_owned(),
        },
        transient,
    }
}

fn entry_values(update: &ThreadTranscriptUpdateEnvelope) -> Vec<(&str, &str)> {
    update
        .changes
        .iter()
        .map(|change| {
            let ThreadTranscriptChange::Upsert {
                entry:
                    ThreadTranscriptEntry::Item {
                        entry_id,
                        item: ThreadItem::AgentMessage { text, .. },
                        ..
                    },
            } = change
            else {
                panic!("expected an Agent message upsert");
            };
            (entry_id.as_str(), text.as_str())
        })
        .collect()
}
