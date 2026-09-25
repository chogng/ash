use super::*;
use crate::InMemoryThreadStore;
use crate::NoThreadWorktreeBinder;
use crate::SequenceExpectation;
use crate::StartThreadRequest;
use crate::StartTurnRequest;
use crate::thread_controller::CommitContextCheckpointRequest;
use ash_protocol::CommandId;
use ash_protocol::ContextSourceRange;
use ash_protocol::ItemId;
use ash_protocol::ThreadItem;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use ash_protocol::UserInput;
use ash_thread_store::ThreadStore;
use std::sync::Arc;

fn fixture() -> (Arc<InMemoryThreadStore>, ThreadController, ThreadSnapshot) {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = ThreadController::with_store(store.clone());
    let root = threads
        .start_thread(
            &NoThreadWorktreeBinder,
            StartThreadRequest {
                branch_name: None,
                agent_id: None,
                agent: None,
                command_id: CommandId::new("root").unwrap(),
                title: "Root".into(),
            },
        )
        .unwrap();
    (store, threads, root)
}

fn turn(threads: &ThreadController, thread: &ThreadId, text: &str) -> TurnId {
    threads
        .start_turn(
            thread,
            StartTurnRequest {
                advisor: None,
                command_id: CommandId::new(text).unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                kind: Default::default(),
                instructions: crate::test_turn_instructions(),
                policy_revision: "policy".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: vec![],
                input: vec![UserInput::Text { text: text.into() }],
            },
        )
        .unwrap()
        .turn_id
}

fn restore(
    threads: &ThreadController,
    source: &ThreadId,
    item: &ItemId,
    boundary: MessageBoundary,
    command: &str,
) -> ThreadSnapshot {
    threads
        .restore_message(
            &NoThreadWorktreeBinder,
            RestoreMessageRequest {
                command_id: CommandId::new(command).unwrap(),
                source_thread_id: source.clone(),
                item_id: item.clone(),
                boundary,
                title: command.into(),
            },
        )
        .unwrap()
}

#[test]
fn before_and_after_a_message_restore_exact_content_and_terminal_state() {
    let (store, threads, root) = fixture();
    let first = turn(&threads, &root.thread_id, "first request");
    threads
        .complete_turn(&root.thread_id, &first, "first answer".into())
        .unwrap();
    let point = threads
        .read_thread(&root.thread_id)
        .unwrap()
        .items
        .last()
        .unwrap()
        .item_id()
        .clone();
    let second = turn(&threads, &root.thread_id, "future request");
    threads
        .complete_turn(&root.thread_id, &second, "future answer".into())
        .unwrap();
    let before = restore(
        &threads,
        &root.thread_id,
        &point,
        MessageBoundary::Before,
        "before",
    );
    let after = restore(
        &threads,
        &root.thread_id,
        &point,
        MessageBoundary::After,
        "after",
    );
    assert_eq!(before.items.len(), 1);
    assert_eq!(after.items.len(), 2);
    assert_eq!(after.turns.len(), 1);
    assert_eq!(after.turns[0].status, TurnStatus::Completed);
    assert_eq!(after.agent_id, root.agent_id);
    assert_eq!(store.load(&after.thread_id).unwrap().len(), 2);
    assert_eq!(
        restore(
            &threads,
            &root.thread_id,
            &point,
            MessageBoundary::After,
            "after"
        ),
        after
    );
    let restarted = ThreadController::with_store(store);
    assert_eq!(restarted.read_thread(&after.thread_id).unwrap(), after);
}

#[test]
fn restoration_never_inherits_a_summary_containing_future_messages() {
    let (_, threads, root) = fixture();
    let first = turn(&threads, &root.thread_id, "public request");
    threads
        .complete_turn(&root.thread_id, &first, "public answer".into())
        .unwrap();
    let point = threads
        .read_thread(&root.thread_id)
        .unwrap()
        .items
        .last()
        .unwrap()
        .item_id()
        .clone();
    let second = turn(&threads, &root.thread_id, "future secret");
    threads
        .complete_turn(&root.thread_id, &second, "secret answer".into())
        .unwrap();
    let source = threads.read_thread(&root.thread_id).unwrap();
    threads
        .commit_context_checkpoint(
            &root.thread_id,
            CommitContextCheckpointRequest {
                source_thread_sequence: source.sequence,
                covered: ContextSourceRange {
                    start_sequence: 1,
                    end_sequence: source.sequence,
                },
                referenced_items: source
                    .items
                    .iter()
                    .map(|item| item.item_id().clone())
                    .collect(),
                summary: "Summary includes future secret".into(),
                schema_revision: "v1".into(),
                prompt_revision: "v1".into(),
                context_policy_revision: "v1".into(),
                generator_model: None,
            },
        )
        .unwrap();
    let restored = restore(
        &threads,
        &root.thread_id,
        &point,
        MessageBoundary::After,
        "past",
    );
    assert!(restored.context_checkpoints.is_empty());
    assert_eq!(restored.items.len(), 2);
    assert!(!format!("{:?}", restored.items).contains("secret"));
}

#[test]
fn inherited_messages_remain_restorable_without_the_original_thread_rows() {
    let (store, threads, root) = fixture();
    let first = turn(&threads, &root.thread_id, "source request");
    threads
        .complete_turn(&root.thread_id, &first, "source answer".into())
        .unwrap();
    let point = threads
        .read_thread(&root.thread_id)
        .unwrap()
        .items
        .last()
        .unwrap()
        .item_id()
        .clone();
    let branch = restore(
        &threads,
        &root.thread_id,
        &point,
        MessageBoundary::After,
        "branch",
    );
    let nested = threads
        .fork_thread(
            &NoThreadWorktreeBinder,
            crate::ForkThreadRequest {
                command_id: CommandId::new("nested").unwrap(),
                source_thread_id: branch.thread_id.clone(),
                title: "nested".into(),
            },
        )
        .unwrap();
    {
        let mut state = store.0.lock().unwrap();
        state.threads.remove(&root.thread_id);
        state.catalog.remove(&root.thread_id);
    }
    let restarted = ThreadController::with_store(store);
    let restored = restore(
        &restarted,
        &nested.thread_id,
        &point,
        MessageBoundary::After,
        "again",
    );
    assert_eq!(restored.items, branch.items);
    assert_eq!(restored.agent_id, branch.agent_id);
}

#[test]
fn a_tool_call_at_the_branch_point_is_closed_without_replaying_it() {
    let (_, threads, root) = fixture();
    let first = turn(&threads, &root.thread_id, "run a tool");
    let call = threads
        .record_tool_call(
            &root.thread_id,
            &first,
            crate::RecordToolCallRequest {
                tool_call_id: None,
                name: ash_protocol::ToolName::new("write_file").unwrap(),
                arguments_json: "{}".into(),
                binding: None,
            },
        )
        .unwrap();
    let restored = restore(
        &threads,
        &root.thread_id,
        call.item.item_id(),
        MessageBoundary::After,
        "tool-boundary",
    );
    assert!(
        matches!(restored.items.last(), Some(ThreadItem::ToolResult { tool_call_id, is_error: true, text, .. })
        if tool_call_id == &call.tool_call_id && text.contains("Interrupted"))
    );
    assert_eq!(restored.turns[0].status, TurnStatus::Interrupted);
    assert!(restored.started_tool_calls.is_empty());
    assert!(
        !threads
            .read_thread(&root.thread_id)
            .unwrap()
            .items
            .iter()
            .any(|item| matches!(item, ThreadItem::ToolResult { .. }))
    );
}

#[test]
fn one_shared_prefix_can_be_compacted_in_separate_message_ranges() {
    let (_, threads, root) = fixture();
    for text in ["first", "second"] {
        let id = turn(&threads, &root.thread_id, text);
        threads
            .complete_turn(&root.thread_id, &id, text.repeat(100))
            .unwrap();
    }
    let child = threads
        .fork_thread(
            &NoThreadWorktreeBinder,
            crate::ForkThreadRequest {
                command_id: CommandId::new("fork").unwrap(),
                source_thread_id: root.thread_id.clone(),
                title: "fork".into(),
            },
        )
        .unwrap();
    for count in [2, 4] {
        let current = threads.read_thread(&child.thread_id).unwrap();
        threads
            .commit_context_checkpoint(
                &child.thread_id,
                CommitContextCheckpointRequest {
                    source_thread_sequence: current.sequence,
                    covered: ContextSourceRange {
                        start_sequence: 1,
                        end_sequence: 2,
                    },
                    referenced_items: current
                        .items
                        .iter()
                        .take(count)
                        .map(|item| item.item_id().clone())
                        .collect(),
                    summary: format!("{count} items"),
                    schema_revision: "v1".into(),
                    prompt_revision: "v1".into(),
                    context_policy_revision: "v1".into(),
                    generator_model: None,
                },
            )
            .unwrap();
    }
    let child = threads.read_thread(&child.thread_id).unwrap();
    assert_eq!(child.context_checkpoints[0].referenced_items.len(), 2);
    assert_eq!(child.context_checkpoints[1].referenced_items.len(), 4);
    assert!(
        threads
            .read_thread(&root.thread_id)
            .unwrap()
            .context_checkpoints
            .is_empty()
    );
}

#[test]
fn fork_continuations_keep_identical_model_input_prefixes() {
    let (_, threads, root) = fixture();
    let first = turn(&threads, &root.thread_id, "shared request");
    threads
        .complete_turn(&root.thread_id, &first, "shared answer".into())
        .unwrap();
    let fork = threads
        .fork_thread(
            &NoThreadWorktreeBinder,
            crate::ForkThreadRequest {
                command_id: CommandId::new("fork").unwrap(),
                source_thread_id: root.thread_id.clone(),
                title: "fork".into(),
            },
        )
        .unwrap();
    let mut requests = Vec::new();
    for (thread, text) in [
        (&root.thread_id, "parent continuation"),
        (&fork.thread_id, "fork continuation"),
    ] {
        let current = turn(&threads, thread, text);
        let crate::context::ModelInvocationPreparation::Ready(invocation) = threads
            .prepare_model_invocation(
                thread,
                crate::thread_controller::PrepareModelInvocationRequest {
                    turn_id: &current,
                    harness_context: &crate::HarnessContext::default(),
                    extension_fragments: vec![],
                    evidence: vec![],
                    tools: vec![],
                    budget: crate::ContextBudget::provider_managed(),
                },
            )
            .unwrap()
        else {
            panic!("context must fit");
        };
        requests.push(crate::context::ContextAssembler::assemble(invocation.context()).unwrap());
    }
    let [parent, fork] = requests.as_slice() else {
        unreachable!()
    };
    let boundary = parent.prompt_cache_prefix_end.unwrap() as usize;
    assert_eq!(parent.prompt_cache_prefix_end, fork.prompt_cache_prefix_end);
    assert_eq!(parent.instructions, fork.instructions);
    assert_eq!(
        serde_json::to_vec(&parent.input[..=boundary]).unwrap(),
        serde_json::to_vec(&fork.input[..=boundary]).unwrap()
    );
    assert_ne!(parent.input[boundary + 1..], fork.input[boundary + 1..]);
}

#[test]
fn fork_session_copies_history_and_keeps_future_turns_independent() {
    let (store, threads, root) = fixture();
    let first = turn(&threads, &root.thread_id, "original request");
    threads
        .complete_turn(&root.thread_id, &first, "original answer".into())
        .unwrap();
    let source = threads.read_thread(&root.thread_id).unwrap();
    let request = || crate::ForkThreadRequest {
        command_id: CommandId::new("independent").unwrap(),
        source_thread_id: root.thread_id.clone(),
        title: "Independent".into(),
    };
    let copied = threads
        .fork_session(&NoThreadWorktreeBinder, request())
        .unwrap();
    assert_ne!(copied.session_id, source.session_id);
    assert_eq!(copied.thread_id.as_str(), copied.session_id.as_str());
    assert_eq!(copied.items, source.items);
    assert_eq!(copied.agent_id, source.agent_id);
    assert_eq!(copied.parent_thread_id, None);
    assert_eq!(copied.forked_from_id.as_ref(), Some(&source.thread_id));
    assert_eq!(
        threads
            .fork_session(&NoThreadWorktreeBinder, request())
            .unwrap()
            .thread_id,
        copied.thread_id
    );
    let background = turn(&threads, &copied.thread_id, "background request");
    threads
        .complete_turn(&copied.thread_id, &background, "background answer".into())
        .unwrap();
    assert_eq!(
        threads.read_thread(&root.thread_id).unwrap().items,
        source.items
    );
    threads.delete_session_threads(&source.session_id).unwrap();
    let restarted = ThreadController::with_store(store);
    assert_eq!(
        restarted
            .list_session_threads(&copied.session_id)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        restarted
            .read_thread(&copied.thread_id)
            .unwrap()
            .turns
            .len(),
        2
    );
}

#[test]
fn fork_cannot_import_into_an_unrelated_session_branch() {
    let (_, threads, root) = fixture();
    let result = threads.create_forked_thread(crate::CreateForkedThreadRequest {
        session_id: ash_protocol::SessionId::new("another-session").unwrap(),
        thread_id: ThreadId::new("unrelated-branch").unwrap(),
        title: "Invalid".into(),
        source_thread_id: root.thread_id,
        source_sequence: root.sequence,
    });
    assert!(matches!(result, Err(CoreError::InvalidInput(_))));
}
