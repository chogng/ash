use super::*;
use crate::thread::transcript::TranscriptModel;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptChange;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptEntry;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;
use ash_protocol::ItemId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;

fn update(model: &mut TranscriptModel, id: &str, text: &str, lifecycle: CellLifecycle) {
    let turn_id = TurnId::new("turn").unwrap();
    model.apply(ThreadTranscriptUpdateEnvelope {
        session_id: SessionId::new("session").unwrap(),
        thread_id: ThreadId::new("thread").unwrap(),
        durable_sequence: 1,
        revision: 1,
        stream_cursor: None,
        changes: vec![ThreadTranscriptChange::Upsert {
            entry: ThreadTranscriptEntry::Item {
                entry_id: id.into(),
                turn_id: turn_id.clone(),
                transient: lifecycle == CellLifecycle::Live,
                item: ThreadItem::AgentMessage {
                    item_id: ItemId::new(id).unwrap(),
                    turn_id,
                    text: text.into(),
                },
            },
        }],
    });
}

fn visible(display: &StreamDisplay, model: &TranscriptModel) -> Vec<String> {
    display
        .visible(model.views(&BTreeSet::new(), None))
        .iter()
        .map(|view| view.text().into_owned())
        .collect()
}

#[test]
fn commits_follow_deadlines_without_mutating_canonical_text() {
    let now = Instant::now();
    let mut model = TranscriptModel::default();
    let mut display = StreamDisplay::default();
    update(&mut model, "a", "one\ntwo\nthree", CellLifecycle::Live);
    display.update(model.cells(), now);
    assert!(visible(&display, &model).is_empty());
    assert!(display.advance(now));
    assert_eq!(visible(&display, &model), ["one\n"]);
    for elapsed in 1..40 {
        assert!(!display.advance(now + Duration::from_millis(elapsed)));
    }
    assert!(display.advance(now + COMMIT_INTERVAL));
    assert_eq!(visible(&display, &model), ["one\ntwo\n"]);
    assert!(display.advance(now + COMMIT_INTERVAL * 2));
    assert_eq!(visible(&display, &model), ["one\ntwo\nthree"]);
    assert!(display.deadline().is_none());
    assert_eq!(
        model.views(&BTreeSet::new(), None)[0].text(),
        "one\ntwo\nthree"
    );
}

#[test]
fn token_updates_keep_the_commit_deadline_and_partial_line_arrival() {
    let now = Instant::now();
    let mut model = TranscriptModel::default();
    let mut display = StreamDisplay::default();
    update(&mut model, "a", "hello", CellLifecycle::Live);
    display.update(model.cells(), now);
    display.advance(now);
    for (elapsed, source) in [(1, "hello w"), (10, "hello wor"), (30, "hello world")] {
        update(&mut model, "a", source, CellLifecycle::Live);
        display.update(model.cells(), now + Duration::from_millis(elapsed));
        assert_eq!(display.deadline(), Some(now + COMMIT_INTERVAL));
        assert_eq!(display.queue[0].arrived, now + Duration::from_millis(1));
        assert_eq!(display.queue.len(), 1);
    }
    display.advance(now + COMMIT_INTERVAL);
    assert_eq!(visible(&display, &model), ["hello world"]);
}

#[test]
fn fifo_order_is_preserved_across_messages_and_catch_up_drains_the_backlog() {
    let now = Instant::now();
    let mut model = TranscriptModel::default();
    let mut display = StreamDisplay::default();
    update(&mut model, "a", "a1\na2\n", CellLifecycle::Live);
    display.update(model.cells(), now);
    update(&mut model, "b", "b1\nb2\n", CellLifecycle::Live);
    display.update(model.cells(), now);
    display.advance(now);
    assert_eq!(visible(&display, &model), ["a1\n"]);
    display.advance(now + COMMIT_INTERVAL);
    assert_eq!(visible(&display, &model), ["a1\na2\n"]);
    display.advance(now + Duration::from_millis(120));
    assert_eq!(visible(&display, &model), ["a1\na2\n", "b1\nb2\n"]);
    assert!(display.deadline().is_none());
    let now = now + Duration::from_millis(500);
    update(&mut model, "b", &"burst\n".repeat(8), CellLifecycle::Live);
    display.update(model.cells(), now);
    // Authoritative replacement appears immediately.
    assert!(display.deadline().is_none());
    update(&mut model, "c", &"burst\n".repeat(8), CellLifecycle::Live);
    display.update(model.cells(), now);
    display.advance(now);
    assert!(display.queue.is_empty());
    assert!(visible(&display, &model)[2].ends_with("burst\n"));
}

#[test]
fn replacement_completion_and_removal_never_leave_old_queue_entries() {
    let now = Instant::now();
    let mut model = TranscriptModel::default();
    let mut display = StreamDisplay::default();
    update(&mut model, "a", "old\nqueued\n", CellLifecycle::Live);
    display.update(model.cells(), now);
    display.advance(now);
    update(&mut model, "a", "new", CellLifecycle::Live);
    display.update(model.cells(), now);
    assert_eq!(visible(&display, &model), ["new"]);
    assert!(display.queue.is_empty());
    update(&mut model, "a", "new\ntail", CellLifecycle::Live);
    display.update(model.cells(), now);
    assert!(!display.queue.is_empty());
    update(&mut model, "a", "new\nfinal tail", CellLifecycle::Final);
    display.update(model.cells(), now);
    assert_eq!(visible(&display, &model), ["new\nfinal tail"]);
    assert!(display.deadline().is_none());
    update(&mut model, "b", "remove\nme", CellLifecycle::Live);
    display.update(model.cells(), now);
    display.update(&[], now);
    assert!(display.queue.is_empty());
    assert!(display.messages.is_empty());
}

#[test]
fn history_install_and_finished_turns_show_all_text_without_replaying() {
    let now = Instant::now();
    let mut model = TranscriptModel::default();
    let mut display = StreamDisplay::default();
    update(&mut model, "a", "history\ntext", CellLifecycle::Live);
    display.install(model.cells());
    assert_eq!(visible(&display, &model), ["history\ntext"]);
    assert!(display.deadline().is_none());
    update(&mut model, "a", "history\ntext\nnew", CellLifecycle::Live);
    display.update(model.cells(), now);
    display.finish_turn(&TurnId::new("turn").unwrap());
    assert_eq!(visible(&display, &model), ["history\ntext\nnew"]);
    assert!(display.deadline().is_none());
    update(
        &mut model,
        "a",
        "history\ntext\nnew\nlast update",
        CellLifecycle::Live,
    );
    display.update(model.cells(), now);
    assert!(display.deadline().is_none());
    assert!(visible(&display, &model)[0].ends_with("last update"));
}

#[test]
fn queue_capacity_forces_immediate_progress_instead_of_growing_without_bound() {
    let now = Instant::now();
    let mut model = TranscriptModel::default();
    let mut display = StreamDisplay::default();
    let source = "line\n".repeat(MAX_QUEUED_LINES + 1);
    update(&mut model, "a", &source, CellLifecycle::Live);
    display.update(model.cells(), now);
    assert!(display.queue.is_empty());
    assert!(display.deadline().is_none());
    assert_eq!(visible(&display, &model), [source]);
}

#[test]
fn source_boundaries_survive_table_reflow_and_resize_without_advancing_time() {
    let now = Instant::now();
    let source = "| Name | State |\n| --- | --- |\n| 中文 | pending |\n| next | complete |\n";
    let mut model = TranscriptModel::default();
    let mut display = StreamDisplay::default();
    update(&mut model, "a", source, CellLifecycle::Live);
    display.update(model.cells(), now);
    display.advance(now);
    display.advance(now + COMMIT_INTERVAL);
    let prefix = visible(&display, &model)[0].clone();
    let deadline = display.deadline();
    let mut render = StreamingRender::default();
    let mut highlight = |_: usize, _: &str, code: &str| {
        code.lines()
            .map(|line| ratatui::text::Line::raw(line.to_owned()))
            .collect()
    };
    for width in [36, 12, 36] {
        let lines = render.render(
            "a",
            &prefix,
            width,
            crate::render::test_context(),
            &mut highlight,
        );
        assert!(lines.iter().all(|line| line.line.width() <= width));
        assert_eq!(visible(&display, &model)[0], prefix);
        assert_eq!(display.deadline(), deadline);
    }
    display.finish_all();
    let completed = render.render(
        "a",
        &visible(&display, &model)[0],
        36,
        crate::render::test_context(),
        &mut highlight,
    );
    let fresh = StreamingRender::default().render(
        "a",
        source,
        36,
        crate::render::test_context(),
        &mut highlight,
    );
    assert_eq!(completed, fresh);
}
