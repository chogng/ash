use super::RewindSelectionAction;
use super::rewind_choices;
use crate::widgets::list_selection::ListSelectionState;
use ash_protocol::ItemId;
use ash_protocol::SessionId;
use ash_protocol::Thread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadStatus;
use ash_protocol::Turn;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;

#[test]
fn rewind_picker_lists_user_message_checkpoints_and_selects_the_latest() {
    let thread = thread(&["first checkpoint", "second checkpoint"]);

    let view = rewind_choices(&thread, &[]);
    let state = ListSelectionState::new(view.model);

    assert_eq!(state.title(), "Rewind");
    assert!(state.search().is_some());
    assert_eq!(
        state
            .visible_items()
            .iter()
            .map(|item| item.label())
            .collect::<Vec<_>>(),
        vec!["1. first checkpoint", "2. second checkpoint"]
    );
    assert_eq!(state.selected_visible_index(), Some(1));
    assert_eq!(
        view.actions.values().last(),
        Some(&RewindSelectionAction::Rewind {
            before_turn_id: TurnId::new("turn-2").unwrap(),
            checkpoint_label: "second checkpoint".into(),
        })
    );
    crate::tui_assert_snapshot!("turn_checkpoints", render(&state));
}

fn thread(messages: &[&str]) -> Thread {
    Thread {
        agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
        origin: Default::default(),
        session_id: SessionId::new("session").unwrap(),
        thread_id: ThreadId::new("thread").unwrap(),
        parent_thread_id: None,
        forked_from_id: None,
        title: "thread".into(),
        status: ThreadStatus::Active,
        sequence: 1,
        usage: ash_protocol::ModelUsageSummary::default(),
        reference_cost: ash_protocol::ModelReferenceCostSummary::default(),
        goal: None,
        turns: messages
            .iter()
            .enumerate()
            .map(|(index, message)| {
                let ordinal = index + 1;
                let turn_id = TurnId::new(format!("turn-{ordinal}")).unwrap();
                Turn {
                    turn_id: turn_id.clone(),
                    status: TurnStatus::Completed,
                    kind: Default::default(),
                    instructions: None,
                    model: None,
                    tool_profile: None,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                    usage: ash_protocol::ModelUsageSummary::default(),
                    context_usage: None,
                    items: vec![ThreadItem::UserMessage {
                        item_id: ItemId::new(format!("item-{ordinal}")).unwrap(),
                        turn_id,
                        text: (*message).into(),
                    }],
                    plan: None,
                    pending_interaction: None,
                    error: None,
                }
            })
            .collect(),
    }
}

#[test]
fn message_checkpoints_offer_before_and_after_and_keep_unavailable_rows_read_only() {
    use crate::widgets::list_selection::ListSelection;
    use crate::widgets::list_selection::ListSelectionOutcome;
    use crossterm::event::KeyCode;
    use crossterm::event::KeyEvent;
    use crossterm::event::KeyModifiers;
    let mut thread = thread(&["Investigate the failure"]);
    let turn_id = thread.turns[0].turn_id.clone();
    thread.turns[0].items.extend([
        ThreadItem::AgentMessage {
            item_id: ItemId::new("answer").unwrap(),
            turn_id: turn_id.clone(),
            text: "I found the cause".into(),
        },
        ThreadItem::ToolCall {
            item_id: ItemId::new("call").unwrap(),
            turn_id: turn_id.clone(),
            tool_call_id: ash_protocol::ToolCallId::new("tool").unwrap(),
            name: ash_protocol::ToolName::new("read_file").unwrap(),
            arguments_json: "{}".into(),
            binding: None,
        },
        ThreadItem::UserMessage {
            item_id: ItemId::new("busy").unwrap(),
            turn_id: turn_id.clone(),
            text: "While a write is running".into(),
        },
    ]);
    let points = thread.turns[0]
        .items
        .iter()
        .enumerate()
        .map(|(index, item)| ash_protocol::MessageCheckpoint {
            item_id: item.item_id().clone(),
            turn_id: turn_id.clone(),
            source_thread_id: thread.thread_id.clone(),
            source_sequence: index as u64 + 2,
            after_sequence: index as u64 + 2,
            workspace: if item.item_id().as_str() == "busy" {
                ash_protocol::WorkspaceCheckpoint::Unavailable {
                    reason: "Write in progress".into(),
                }
            } else {
                ash_protocol::WorkspaceCheckpoint::NoFiles
            },
        })
        .collect::<Vec<_>>();
    let view = rewind_choices(&thread, &points);
    let state = ListSelectionState::new(view.model);
    assert_eq!(state.visible_items().len(), 7);
    assert_eq!(state.selected_visible_index(), Some(5));
    assert!(state.visible_items()[6].id().is_none());
    let view = rewind_choices(&thread, &points);
    let mut selection = ListSelection::new(view.model, view.actions);
    assert!(
        matches!(selection.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)), ListSelectionOutcome::Activate(RewindSelectionAction::RestoreMessage { item_id, boundary: ash_protocol::MessageBoundary::After, .. }) if item_id.as_str() == "call")
    );
    selection.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert!(matches!(
        selection.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        ListSelectionOutcome::Consumed
    ));
    crate::tui_assert_snapshot!("message_checkpoints", render(&state));
}

fn render(state: &ListSelectionState) -> String {
    let backend = ratatui::backend::TestBackend::new(80, 14);
    let mut terminal = ratatui::Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| {
            crate::widgets::list_selection::draw_body_with_pointer(
                frame,
                frame.area(),
                &state,
                None,
                None,
                crate::render::test_context(),
            )
        })
        .unwrap();
    terminal
        .backend()
        .buffer()
        .content
        .chunks(80)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}
