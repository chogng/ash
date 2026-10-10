use super::*;
use ash_protocol::AssistantMessage;
use ash_protocol::MessagePhase;
use ash_protocol::ThreadEvent;
use ash_protocol::TurnLoopAction;
use ash_protocol::TurnLoopDecision;
use ash_protocol::TurnLoopReason;

fn phased_response(phase: Option<MessagePhase>, text: &str) -> ModelResponse {
    ModelResponse {
        output: vec![ResponseItem::Message(AssistantMessage {
            id: "message".into(),
            text: text.into(),
            phase,
        })],
        usage: None,
        billing: None,
        stop_reason: StopReason::Completed,
    }
}

fn decisions(threads: &ThreadController, thread: &ThreadId) -> Vec<TurnLoopDecision> {
    threads
        .thread_updates_after(thread, 0)
        .unwrap()
        .into_iter()
        .filter_map(|update| match update.update {
            ThreadUpdate::Committed {
                event: ThreadEvent::ModelResponseEvaluated { decision, .. },
            } => Some(decision),
            _ => None,
        })
        .collect()
}

#[test]
fn nonterminal_phase_continues_once_and_preserves_phase_in_context_and_replay() {
    for phase in [MessagePhase::Commentary, MessagePhase::PartialAnswer] {
        let store = Arc::new(InMemoryThreadStore::default());
        let (threads, thread, turn) =
            started_turn_with_store(ash_protocol::ToolMode::Direct, store.clone());
        let model = Arc::new(ScriptedModel::new([
            Ok(phased_response(Some(phase.clone()), "working")),
            Ok(phased_response(Some(MessagePhase::FinalAnswer), "done")),
        ]));
        TurnExecutor::without_tools(threads.clone(), model.clone())
            .execute(&thread, &turn, &CancellationSource::new().token())
            .unwrap();
        let requests = model.requests();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].input.iter().any(|input| matches!(input, InputItem::Message(message)
            if message.phase.as_ref() == Some(&phase) && message.content == vec![ContentPart::Text("working".into())])));
        assert!(
            requests[1].instructions.as_deref().is_some_and(
                |instructions| instructions.contains("Do not repeat a progress-only response")
            )
        );
        assert_eq!(
            decisions(&threads, &thread)
                .iter()
                .map(|decision| (&decision.action, &decision.reason))
                .collect::<Vec<_>>(),
            [
                (
                    &TurnLoopAction::Continue,
                    &TurnLoopReason::NonterminalMessage
                ),
                (&TurnLoopAction::Complete, &TurnLoopReason::FinalAnswer)
            ]
        );
        let replay = ThreadController::with_store(store)
            .read_thread(&thread)
            .unwrap();
        assert_eq!(replay.turns[0].nonterminal_continuations, 1);
        assert_eq!(replay.turns[0].status, TurnStatus::Completed);
        assert!(
            matches!(&replay.items[1], ThreadItem::AgentMessage { phase: Some(saved), text, .. } if saved == &phase && text == "working")
        );
    }
}

#[test]
fn repeated_nonterminal_messages_fail_with_retained_content_and_a_durable_limit() {
    let store = Arc::new(InMemoryThreadStore::default());
    let (threads, thread, turn) =
        started_turn_with_store(ash_protocol::ToolMode::Direct, store.clone());
    let model = Arc::new(ScriptedModel::new([
        Ok(phased_response(Some(MessagePhase::Commentary), "working")),
        Ok(phased_response(
            Some(MessagePhase::PartialAnswer),
            "still working",
        )),
    ]));
    let result = TurnExecutor::without_tools(threads.clone(), model.clone()).execute(
        &thread,
        &turn,
        &CancellationSource::new().token(),
    );
    assert!(result.is_err());
    assert_eq!(model.requests().len(), 2);
    let replay = ThreadController::with_store(store)
        .read_thread(&thread)
        .unwrap();
    assert_eq!(replay.turns[0].nonterminal_continuations, 1);
    assert_eq!(replay.turns[0].status, TurnStatus::Failed);
    assert!(
        matches!(replay.items.last(), Some(ThreadItem::AgentMessage { text, .. }) if text == "still working")
    );
    let decisions = decisions(&threads, &thread);
    assert_eq!(
        decisions.last().unwrap().reason,
        TurnLoopReason::ContinuationLimit
    );
    let trace = ash_rollout_trace::capture_session_trace(threads.as_ref(), &replay.session_id).unwrap();
    let events = &trace.threads[0].events;
    assert!(matches!(
        events.last().unwrap().event,
        ThreadEvent::TurnFailed { .. }
    ));
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.event, ThreadEvent::TurnFailed { .. }))
            .count(),
        1
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event.event, ThreadEvent::TurnCompleted { .. }))
    );
}

#[test]
fn tools_take_precedence_over_a_final_answer_label() {
    let (threads, thread, turn) = started_turn();
    let mut response = phased_response(Some(MessagePhase::FinalAnswer), "tool result follows");
    response.output.push(ResponseItem::ToolCall(ToolCall {
        id: ToolCallId::new("weather-call").unwrap(),
        name: ToolName::new("weather").unwrap(),
        arguments: json!({"city":"Paris"}),
    }));
    let model = Arc::new(ScriptedModel::new([
        Ok(response),
        Ok(phased_response(Some(MessagePhase::FinalAnswer), "sunny")),
    ]));
    TurnExecutor::new(
        threads.clone(),
        model.clone(),
        Arc::new(WeatherTool),
        Arc::new(SandboxActionPolicyService),
    )
    .execute(&thread, &turn, &CancellationSource::new().token())
    .unwrap();
    let decisions = decisions(&threads, &thread);
    assert_eq!(decisions[0].action, TurnLoopAction::ExecuteTools);
    assert_eq!(
        decisions[0].message_phases,
        [Some(MessagePhase::FinalAnswer)]
    );
    assert_eq!(decisions[0].tool_call_count, 1);
    assert_eq!(decisions[1].action, TurnLoopAction::Complete);
    assert!(
        matches!(model.requests()[1].input.last(), Some(InputItem::ToolResult(result)) if result.call_id.as_str() == "weather-call")
    );
}

#[test]
fn missing_and_unknown_phases_complete_without_fabricating_a_final_answer() {
    for phase in [None, Some(MessagePhase::Other("future_phase".into()))] {
        let (threads, thread, turn) = started_turn();
        let model = Arc::new(ScriptedModel::new([Ok(phased_response(
            phase.clone(),
            "done",
        ))]));
        TurnExecutor::without_tools(threads.clone(), model.clone())
            .execute(&thread, &turn, &CancellationSource::new().token())
            .unwrap();
        assert_eq!(model.requests().len(), 1);
        assert_eq!(
            decisions(&threads, &thread)[0].reason,
            TurnLoopReason::CompatibleCompletion
        );
        assert!(
            matches!(threads.read_thread(&thread).unwrap().items.last(), Some(ThreadItem::AgentMessage { phase: saved, .. }) if saved == &phase)
        );
    }
}

#[test]
fn invalid_stops_retain_text_fail_and_never_execute_tools() {
    for (stop, reason) in [
        (StopReason::MaxOutputTokens, TurnLoopReason::TruncatedOutput),
        (
            StopReason::Other("pause_turn".into()),
            TurnLoopReason::UnknownStopReason,
        ),
        (StopReason::Refusal, TurnLoopReason::InvalidToolRequest),
    ] {
        for include_tool in [false, true] {
            if stop == StopReason::Refusal && !include_tool {
                continue;
            }
            let (threads, thread, turn) = started_turn();
            let mut response = phased_response(Some(MessagePhase::FinalAnswer), "incomplete");
            response.stop_reason = stop.clone();
            if include_tool {
                response.output.push(ResponseItem::ToolCall(ToolCall {
                    id: ToolCallId::new("incomplete-call").unwrap(),
                    name: ToolName::new("weather").unwrap(),
                    arguments: json!({}),
                }));
            }
            let model = Arc::new(ScriptedModel::new([Ok(response)]));
            let result = TurnExecutor::new(
                threads.clone(),
                model.clone(),
                Arc::new(WeatherTool),
                Arc::new(SandboxActionPolicyService),
            )
            .execute(&thread, &turn, &CancellationSource::new().token());
            assert!(result.is_err());
            assert_eq!(model.requests().len(), 1);
            let snapshot = threads.read_thread(&thread).unwrap();
            assert_eq!(snapshot.turns[0].status, TurnStatus::Failed);
            assert!(!snapshot.items.iter().any(|item| matches!(
                item,
                ThreadItem::ToolCall { .. } | ThreadItem::ToolResult { .. }
            )));
            assert_eq!(decisions(&threads, &thread)[0].reason, reason);
        }
    }
}

#[test]
fn tool_stop_without_a_call_fails_and_explicit_refusal_completes() {
    for (stop, action, reason) in [
        (
            StopReason::ToolUse,
            TurnLoopAction::Fail,
            TurnLoopReason::InvalidToolRequest,
        ),
        (
            StopReason::Refusal,
            TurnLoopAction::Complete,
            TurnLoopReason::Refusal,
        ),
    ] {
        let (threads, thread, turn) = started_turn();
        let mut response = text_response("cannot comply");
        response.stop_reason = stop;
        let result = TurnExecutor::without_tools(
            threads.clone(),
            Arc::new(ScriptedModel::new([Ok(response)])),
        )
        .execute(&thread, &turn, &CancellationSource::new().token());
        assert_eq!(result.is_ok(), action == TurnLoopAction::Complete);
        assert_eq!(
            (
                &decisions(&threads, &thread)[0].action,
                &decisions(&threads, &thread)[0].reason
            ),
            (&action, &reason)
        );
    }
}

struct MessageStreamModel(ModelResponse);

struct CancelBeforeCommitModel {
    threads: Arc<ThreadController>,
    thread: ThreadId,
    turn: TurnId,
}

impl ModelService for CancelBeforeCommitModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.threads.interrupt_turn(
            &self.thread,
            crate::InterruptTurnRequest {
                command_id: CommandId::new("cancel-before-commit").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                turn_id: self.turn.clone(),
            },
        )?;
        Ok(phased_response(
            Some(MessagePhase::FinalAnswer),
            "stale answer",
        ))
    }
}

#[test]
fn cancellation_accepted_before_response_commit_cannot_complete_or_fail_the_turn() {
    let (threads, thread, turn) = started_turn();
    let result = TurnExecutor::without_tools(
        threads.clone(),
        Arc::new(CancelBeforeCommitModel {
            threads: threads.clone(),
            thread: thread.clone(),
            turn: turn.clone(),
        }),
    )
    .execute(&thread, &turn, &CancellationSource::new().token());
    assert!(
        matches!(&result, Err(CoreError::Cancelled(_))),
        "{:?}",
        result.as_ref().err()
    );
    let snapshot = threads.read_thread(&thread).unwrap();
    assert_eq!(snapshot.turns[0].status, TurnStatus::Interrupted);
    assert!(
        !snapshot
            .items
            .iter()
            .any(|item| matches!(item, ThreadItem::AgentMessage { .. }))
    );
    assert!(decisions(&threads, &thread).is_empty());
}

impl ModelService for MessageStreamModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        unreachable!("stream is implemented")
    }

    fn stream(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
        sink: &mut dyn ModelStreamSink,
    ) -> Result<ModelResponse, CoreError> {
        for item in &self.0.output {
            if let ResponseItem::Message(message) = item {
                sink.emit(ModelStreamEvent::MessageStarted {
                    id: message.id.clone(),
                    phase: None,
                })?;
                sink.emit(ModelStreamEvent::MessageDelta {
                    id: message.id.clone(),
                    text: message.text.clone(),
                })?;
                sink.emit(ModelStreamEvent::MessageCompleted(message.clone()))?;
            }
        }
        Ok(self.0.clone())
    }
}

#[test]
fn streamed_messages_keep_separate_ids_order_and_late_phase_in_history_and_trace() {
    let (threads, thread, turn) = started_turn();
    let response = ModelResponse {
        output: vec![
            ResponseItem::Message(AssistantMessage {
                id: "progress".into(),
                text: "working".into(),
                phase: Some(MessagePhase::Commentary),
            }),
            ResponseItem::Message(AssistantMessage {
                id: "answer".into(),
                text: "done".into(),
                phase: Some(MessagePhase::FinalAnswer),
            }),
        ],
        usage: None,
        billing: None,
        stop_reason: StopReason::Completed,
    };
    let updates = Arc::new(RecordingUpdates::default());
    TurnExecutor::without_tools(threads.clone(), Arc::new(MessageStreamModel(response)))
        .with_thread_updates(updates.clone())
        .execute(&thread, &turn, &CancellationSource::new().token())
        .unwrap();
    let snapshot = threads.read_thread(&thread).unwrap();
    let messages = snapshot
        .items
        .iter()
        .filter_map(|item| match item {
            ThreadItem::AgentMessage {
                item_id,
                text,
                phase,
                ..
            } => Some((item_id.clone(), text.clone(), phase.clone())),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 2);
    assert_ne!(messages[0].0, messages[1].0);
    assert_eq!(
        (&messages[0].1, &messages[0].2),
        (&"working".into(), &Some(MessagePhase::Commentary))
    );
    assert_eq!(
        (&messages[1].1, &messages[1].2),
        (&"done".into(), &Some(MessagePhase::FinalAnswer))
    );
    let streamed = updates
        .updates()
        .into_iter()
        .filter_map(|update| match update.update {
            ThreadUpdate::ItemDelta {
                item_id,
                delta: ash_protocol::ItemDelta::AgentMessagePhase { phase: Some(phase) },
                ..
            } => Some((item_id, phase)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        streamed,
        [
            (messages[0].0.clone(), MessagePhase::Commentary),
            (messages[1].0.clone(), MessagePhase::FinalAnswer)
        ]
    );
    assert_eq!(
        decisions(&threads, &thread)[0].message_phases,
        [
            Some(MessagePhase::Commentary),
            Some(MessagePhase::FinalAnswer)
        ]
    );
}
