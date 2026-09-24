use super::*;
use crate::thread::composer::ChatInputItem;
use crossterm::event::KeyCode;
use crossterm::event::KeyModifiers;

fn pending(queue: &mut Queue, text: &str) -> (QueueId, ::queue::QueuedMessage) {
    let id = queue.push(QueuedChatInput::from_submission(ChatSubmission {
        display_text: text.into(),
        input: vec![ChatInputItem::Text(text.into())],
    }));
    let command = queue.submit(id).unwrap();
    (id, crate::test_support::queued_message(command.into()))
}

#[test]
fn queue_preserves_backend_identity_and_reconciles_terminal_delivery() {
    let mut queue = Queue::default();
    let navigation = QueueNavigation::default();
    let (first_id, mut first) = pending(&mut queue, "first");
    let (second_id, second) = pending(&mut queue, "second");
    queue.apply(vec![first.clone(), second.clone()]).unwrap();
    assert_eq!(
        queue
            .view(&navigation)
            .items
            .iter()
            .map(|item| (item.id, item.text, item.sending))
            .collect::<Vec<_>>(),
        [(first_id, "first", false), (second_id, "second", false)]
    );
    let target = queue.target(first_id).unwrap();
    assert_eq!(target.command_id, first.request.command_id);
    assert!(queue.view(&navigation).items[0].sending);
    first.status = ::queue::QueueStatus::Started;
    first.revision = 2;
    queue.apply(vec![first, second]).unwrap();
    assert_eq!(queue.view(&navigation).items.len(), 1);
    assert_eq!(queue.view(&navigation).items[0].id, second_id);
}

#[test]
fn restore_and_replace_keep_identity_and_do_not_start_a_turn() {
    let mut queue = Queue::default();
    let (id, mut message) = pending(&mut queue, "first");
    message.status = ::queue::QueueStatus::Paused;
    queue.apply(vec![message.clone()]).unwrap();
    let mut input = ChatInput::new();
    queue.restore(id, &mut input).unwrap();
    assert_eq!(input.text(), "first");
    input.insert_text(" updated");
    let crate::thread::composer::ChatInputQueueOutcome::Queued(updated) = input.queue_current()
    else {
        panic!("queued draft")
    };
    assert_eq!(queue.push(updated), id);
    let crate::thread::Command::EditQueue {
        target,
        action: QueueAction::Replace(submission),
    } = queue.submit(id).unwrap()
    else {
        panic!("expected replacement")
    };
    assert_eq!(target.command_id, message.request.command_id);
    assert_eq!(submission.display_text, "first updated");
}

#[test]
fn focus_emits_backend_actions_without_reordering_or_deleting_locally() {
    let mut queue = Queue::default();
    let mut navigation = QueueNavigation::default();
    let (one, first) = pending(&mut queue, "first");
    let (two, second) = pending(&mut queue, "second");
    queue.apply(vec![first, second]).unwrap();
    assert!(navigation.focus_latest(&queue));
    assert_eq!(queue.view(&navigation).selected, Some(two));
    assert_eq!(
        navigation.handle_key(&queue, KeyEvent::new(KeyCode::Up, KeyModifiers::CONTROL)),
        QueueKeyOutcome::Move(two, ::queue::QueueMove::Up)
    );
    assert_eq!(queue.view(&navigation).items[0].id, one);
    assert_eq!(
        navigation.handle_key(&queue, KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE)),
        QueueKeyOutcome::Delete(two)
    );
    assert_eq!(queue.view(&navigation).items.len(), 2);
    navigation.handle_key(&queue, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(!navigation.focused(&queue));
}

#[test]
fn reconnect_rebuilds_queue_and_preserves_unsent_local_drafts() {
    let mut original = Queue::default();
    let (_, message) = pending(&mut original, "persisted");
    let mut restored = Queue::default();
    let navigation = QueueNavigation::default();
    restored.push(QueuedChatInput::from_submission(ChatSubmission {
        display_text: "not accepted".into(),
        input: vec![ChatInputItem::Text("not accepted".into())],
    }));
    restored.apply(vec![message]).unwrap();
    assert_eq!(
        restored
            .view(&navigation)
            .items
            .iter()
            .map(|item| item.text)
            .collect::<Vec<_>>(),
        ["persisted", "not accepted"]
    );
}

#[test]
fn queue_navigation_is_independent_while_backend_messages_are_shared() {
    let mut queue = Queue::default();
    let (first_id, first) = pending(&mut queue, "first");
    let (second_id, second) = pending(&mut queue, "second");
    queue.apply(vec![first, second]).unwrap();
    let mut fullscreen = QueueNavigation::default();
    let mut inline = QueueNavigation::default();
    fullscreen.focus_latest(&queue);
    inline.focus_latest(&queue);
    inline.handle_key(&queue, KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert_eq!(queue.view(&fullscreen).selected, Some(second_id));
    assert_eq!(queue.view(&inline).selected, Some(first_id));
    fullscreen.blur();
    assert!(!fullscreen.focused(&queue));
    assert!(inline.focused(&queue));
    assert_eq!(queue.view(&inline).items.len(), 2);
}

#[test]
fn pending_backend_edit_keeps_the_selected_identity_until_its_reply() {
    let mut queue = Queue::default();
    let (id, mut message) = pending(&mut queue, "selected");
    queue.apply(vec![message.clone()]).unwrap();
    let mut navigation = QueueNavigation::default();
    navigation.focus_latest(&queue);
    queue.target(id).unwrap();
    navigation.reconcile(&queue);
    assert!(!navigation.focused(&queue));
    assert_eq!(queue.view(&navigation).selected, Some(id));
    message.revision += 1;
    queue.apply(vec![message]).unwrap();
    navigation.reconcile(&queue);
    assert!(navigation.focused(&queue));
    assert_eq!(queue.view(&navigation).selected, Some(id));
}

#[test]
fn down_after_the_last_message_stays_in_the_queue_until_escape() {
    let mut queue = Queue::default();
    let (_, message) = pending(&mut queue, "only");
    queue.apply(vec![message]).unwrap();
    let mut navigation = QueueNavigation::default();
    navigation.focus_latest(&queue);
    assert_eq!(
        navigation.handle_key(&queue, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)),
        QueueKeyOutcome::Consumed
    );
    assert!(navigation.focused(&queue));
    navigation.handle_key(&queue, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(!navigation.focused(&queue));
}

#[test]
fn deleting_a_selected_message_keeps_the_nearest_message_selected_after_the_reply() {
    let mut queue = Queue::default();
    let (first_id, first) = pending(&mut queue, "first");
    let (second_id, mut second) = pending(&mut queue, "second");
    let (third_id, third) = pending(&mut queue, "third");
    queue
        .apply(vec![first.clone(), second.clone(), third.clone()])
        .unwrap();
    let mut navigation = QueueNavigation::default();
    navigation.focus_latest(&queue);
    navigation.handle_key(&queue, KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert_eq!(queue.view(&navigation).selected, Some(second_id));
    assert_eq!(
        navigation.handle_key(&queue, KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE)),
        QueueKeyOutcome::Delete(second_id)
    );
    assert_eq!(queue.view(&navigation).items.len(), 3);
    second.status = ::queue::QueueStatus::Cancelled;
    second.revision += 1;
    queue.apply(vec![first, second, third]).unwrap();
    navigation.reconcile(&queue);
    assert_eq!(
        queue
            .view(&navigation)
            .items
            .iter()
            .map(|item| item.id)
            .collect::<Vec<_>>(),
        [first_id, third_id]
    );
    assert_eq!(queue.view(&navigation).selected, Some(third_id));
}

#[test]
fn pointer_target_uses_the_visible_queue_row_and_focuses_its_identity() {
    let mut queue = Queue::default();
    let (first_id, first) = pending(&mut queue, "first");
    let (second_id, second) = pending(&mut queue, "second");
    queue.apply(vec![first, second]).unwrap();
    let mut navigation = QueueNavigation::default();
    let area = ratatui::layout::Rect::new(0, 0, 40, 2);
    let target = pointer_target_at(
        area,
        &queue.view(&navigation),
        DEFAULT_MAX_VISIBLE_ITEMS,
        ratatui::layout::Position::new(area.right() - 1, 1),
    )
    .unwrap();

    assert_eq!(target, second_id);
    let mut terminal =
        ratatui::Terminal::new(ratatui::backend::TestBackend::new(area.width, area.height))
            .unwrap();
    terminal
        .draw(|frame| {
            draw(
                frame,
                area,
                &queue.view(&navigation),
                DEFAULT_MAX_VISIBLE_ITEMS,
                Some(target),
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    for column in area.x..area.right() {
        assert_eq!(
            terminal.backend().buffer()[(column, 1)].bg,
            crate::render::test_context().hover_background()
        );
    }
    assert!(navigation.focus(&queue, target));
    assert_eq!(queue.view(&navigation).selected, Some(second_id));
    assert_ne!(first_id, second_id);
}

#[test]
fn restored_audio_queue_keeps_its_attachment_when_the_draft_is_resubmitted() {
    let mut queue = Queue::default();
    let (id, mut message) = pending(&mut queue, "listen");
    let attachment = ash_protocol::AudioAttachmentRef {
        content_digest: ash_protocol::ContentDigest::sha256(b"recording"),
        media_type: ash_protocol::AudioMediaType::Wav,
        encoded_bytes: 32044,
        duration_ms: 1000,
    };
    message.request.input = vec![ash_protocol::UserInput::AudioAttachment {
        attachment: attachment.clone(),
    }];
    message.status = ::queue::QueueStatus::Paused;
    queue.apply(vec![message]).unwrap();
    let mut input = ChatInput::new();
    queue.restore(id, &mut input).unwrap();
    insta::assert_snapshot!(input.text(), @"[Audio #1] ");
    let crate::thread::composer::ChatInputQueueOutcome::Queued(updated) = input.queue_current()
    else {
        panic!("expected queued audio")
    };
    assert_eq!(queue.push(updated), id);
    let crate::thread::Command::EditQueue {
        action: QueueAction::Replace(submission),
        ..
    } = queue.submit(id).unwrap()
    else {
        panic!("expected replacement")
    };
    assert!(
        submission
            .input
            .contains(&ChatInputItem::AudioAttachment(attachment))
    );
}
