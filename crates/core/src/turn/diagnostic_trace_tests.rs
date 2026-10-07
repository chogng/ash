use super::*;
use ash_rollout_trace::DiagnosticEventKind;
use ash_rollout_trace::RecordingStatus;
use ash_rollout_trace::TraceRecorder;

fn recorded_turn(root: PathBuf) -> (Arc<ThreadController>, ThreadId, TurnId) {
    let (threads, thread, turn) = started_turn();
    let threads = Arc::try_unwrap(threads)
        .ok()
        .expect("unshared controller before execution")
        .with_trace_recorder(Arc::new(TraceRecorder::new(Some(root))));
    (Arc::new(threads), thread, turn)
}

#[test]
fn diagnostic_trace_records_each_failed_retry_and_actual_semantic_requests() {
    let root = tempfile::tempdir().unwrap();
    let (threads, thread, turn) = recorded_turn(root.path().into());
    let model = Arc::new(ScriptedModel::new([
        Err(CoreError::ModelTransient {
            failure: ash_protocol::StableTurnError::connection_failed(),
            retry_at: None,
        }),
        Err(CoreError::ModelInvalidResponse),
        Ok(text_response("recovered")),
    ]));
    TurnExecutor::without_tools(threads.clone(), model.clone())
        .execute(&thread, &turn, &CancellationSource::new().token())
        .unwrap();
    let session = threads.read_thread(&thread).unwrap().session_id;
    let page = threads.read_trace_diagnostics(&session, 0, 500).unwrap();
    let events = &page.diagnostics.events;
    assert_eq!(events.len(), 9);
    let capture = page.diagnostics.capture_id.as_ref().unwrap();
    for (index, request) in model.requests().iter().enumerate() {
        let group = &events[index * 3..index * 3 + 3];
        assert!(matches!(
            group[0].event,
            DiagnosticEventKind::ModelAttemptStarted { .. }
        ));
        assert!(matches!(
            group[1].event,
            DiagnosticEventKind::ModelRequestPrepared { .. }
        ));
        assert_eq!(group[0].event.attempt_id(), group[2].event.attempt_id());
        assert_eq!(
            threads
                .read_trace_payload(
                    &session,
                    capture,
                    &group[1].event.payload().unwrap().payload_id
                )
                .unwrap(),
            serde_json::to_value(request).unwrap()
        );
        if index < 2 {
            assert!(matches!(
                group[2].event,
                DiagnosticEventKind::ModelAttemptFailed { .. }
            ));
        } else {
            assert!(matches!(
                group[2].event,
                DiagnosticEventKind::ModelAttemptCompleted { .. }
            ));
        }
    }
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.event, DiagnosticEventKind::ModelAttemptStarted { .. }))
            .map(|event| event.event.attempt_id())
            .collect::<BTreeSet<_>>()
            .len(),
        3
    );
    assert_eq!(
        threads
            .read_thread(&thread)
            .unwrap()
            .turns
            .last()
            .unwrap()
            .status,
        TurnStatus::Completed
    );
}

struct CancelledPartialModel(CancellationSource);
impl ModelService for CancelledPartialModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        unreachable!("stream is implemented");
    }
    fn stream(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
        sink: &mut dyn ModelStreamSink,
    ) -> Result<ModelResponse, CoreError> {
        sink.emit(ModelStreamEvent::ReasoningDelta(
            "received reasoning".into(),
        ))?;
        sink.emit(ModelStreamEvent::TextDelta("received text".into()))?;
        self.0.cancel();
        sink.emit(ModelStreamEvent::TextDelta(
            " rejected by cancelled consumer".into(),
        ))?;
        panic!("cancelled consumer must reject output");
    }
}

#[test]
fn diagnostic_trace_retains_partial_output_before_cancellation_rejects_the_stream() {
    let root = tempfile::tempdir().unwrap();
    let (threads, thread, turn) = recorded_turn(root.path().into());
    let cancellation = CancellationSource::new();
    let result = TurnExecutor::without_tools(
        threads.clone(),
        Arc::new(CancelledPartialModel(cancellation.clone())),
    )
    .execute(&thread, &turn, &cancellation.token());
    assert!(matches!(result, Err(CoreError::Cancelled(_))));
    let snapshot = threads.read_thread(&thread).unwrap();
    assert_eq!(
        snapshot.turns.last().unwrap().status,
        TurnStatus::Interrupted
    );
    let page = threads
        .read_trace_diagnostics(&snapshot.session_id, 0, 500)
        .unwrap();
    let DiagnosticEventKind::ModelAttemptCancelled {
        partial_output: Some(reference),
        ..
    } = &page.diagnostics.events.last().unwrap().event
    else {
        panic!("expected cancelled attempt");
    };
    assert_eq!(
        threads
            .read_trace_payload(
                &snapshot.session_id,
                page.diagnostics.capture_id.as_ref().unwrap(),
                &reference.payload_id
            )
            .unwrap(),
        json!({ "text": "received text rejected by cancelled consumer", "reasoning": "received reasoning", "truncated": false })
    );
}

#[test]
fn diagnostic_trace_storage_failure_cannot_change_a_successful_turn() {
    let root = tempfile::tempdir().unwrap();
    let blocked = root.path().join("not-a-directory");
    std::fs::write(&blocked, "file").unwrap();
    let (threads, thread, turn) = recorded_turn(blocked);
    let result = TurnExecutor::without_tools(
        threads.clone(),
        Arc::new(ScriptedModel::new([Ok(text_response("answer"))])),
    )
    .execute(&thread, &turn, &CancellationSource::new().token());
    assert!(matches!(result, Ok(TurnExecutionOutcome::Completed(_))));
    let session = threads.read_thread(&thread).unwrap().session_id;
    assert_eq!(
        threads
            .read_trace_diagnostics(&session, 0, 500)
            .unwrap()
            .diagnostics
            .recording_status,
        RecordingStatus::Unavailable
    );
    assert!(
        !threads.read_session_trace(&session).unwrap().threads[0]
            .events
            .is_empty()
    );
}

struct ConsultationTool {
    threads: Arc<ThreadController>,
    model: ash_protocol::ModelRef,
}

impl ToolService for ConsultationTool {
    fn definitions(&self) -> Vec<ToolDefinition> {
        WeatherTool.definitions()
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        WeatherTool.prepare(call)
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        unreachable!("consultation requires the Core-supplied execution identity")
    }

    fn execute_streaming_with_facts(
        &self,
        call: &ToolCall,
        _: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        _: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let response = crate::ToolModel::new(self.threads.clone()).invoke(
            crate::ToolModelRequest {
                identity: facts.execution_identity().unwrap(),
                call_id: &call.id,
                model: &self.model,
                instructions: "Review the weather result.",
                question: "Does this answer the task?",
                max_output_tokens: 256,
                reasoning: None,
            },
            cancellation,
        )?;
        assert_eq!(response.response, text_response("consultation accepted"));
        Ok(ToolExecutionOutput::Success("reviewed".into()))
    }
}

#[test]
fn diagnostic_trace_records_tool_model_consultation_through_the_real_turn_mailbox() {
    let root = tempfile::tempdir().unwrap();
    let (threads, thread, initial) = recorded_turn(root.path().into());
    threads
        .complete_turn(&thread, &initial, "ready".into())
        .unwrap();
    let advisory_model = ash_protocol::ModelRef::new(
        ash_protocol::ProviderId::new("fixture").unwrap(),
        ash_protocol::ModelId::new("advisor").unwrap(),
    );
    let turn = threads
        .start_turn(
            &thread,
            StartTurnRequest {
                context_policy: Default::default(),
                command_id: CommandId::new("consultation").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                reasoning_effort: None,
                advisor: Some(ash_protocol::AdvisorConfig::new(advisory_model.clone())),
                kind: ash_protocol::TurnKind::Coding,
                mode: Default::default(),
                instructions: crate::test_turn_instructions(),
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "Review the task.".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    let model = Arc::new(ScriptedModel::new([
        Ok(ModelResponse {
            output: vec![ResponseItem::ToolCall(ToolCall {
                id: ToolCallId::new("consult").unwrap(),
                name: ToolName::new("weather").unwrap(),
                arguments: json!({ "city": "Paris" }),
            })],
            usage: None,
            billing: None,
            stop_reason: StopReason::ToolUse,
        }),
        Ok(text_response("consultation accepted")),
        Ok(text_response("task complete")),
    ]));
    let executor = TurnExecutor::new(
        threads.clone(),
        model.clone(),
        Arc::new(ConsultationTool {
            threads: threads.clone(),
            model: advisory_model,
        }),
        Arc::new(SandboxActionPolicyService),
    );
    executor.start(&thread, &turn).unwrap();
    wait_for_turn_status(&threads, &thread, &turn, TurnStatus::Completed);
    let snapshot = threads.read_thread(&thread).unwrap();
    assert_eq!(snapshot.usage.model_invocations, 3);
    assert!(snapshot.items.iter().any(|item| matches!(item, ThreadItem::ToolResult { text, is_error: false, .. } if text == "reviewed")));
    let requests = model.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests[1].tools.is_empty());
    assert!(request_contains(&requests[1], "Does this answer the task?"));
    let page = threads
        .read_trace_diagnostics(&snapshot.session_id, 0, 500)
        .unwrap();
    let purposes = page
        .diagnostics
        .events
        .iter()
        .filter_map(|event| match &event.event {
            DiagnosticEventKind::ModelAttemptStarted { purpose, .. } => Some(purpose.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        purposes,
        [
            ash_rollout_trace::InferencePurpose::Agent,
            ash_rollout_trace::InferencePurpose::Tool,
            ash_rollout_trace::InferencePurpose::Agent,
        ]
    );
    assert_eq!(page.diagnostics.events.len(), 9);
    assert_eq!(
        threads
            .read_trace_payload(
                &snapshot.session_id,
                page.diagnostics.capture_id.as_deref().unwrap(),
                &page.diagnostics.events[4]
                    .event
                    .payload()
                    .unwrap()
                    .payload_id,
            )
            .unwrap(),
        serde_json::to_value(&requests[1]).unwrap()
    );
}
