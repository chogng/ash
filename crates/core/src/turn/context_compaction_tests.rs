use super::*;

struct WindowModel {
    ordinary: AtomicUsize,
    requests: Mutex<Vec<ModelRequest>>,
    cancel_checkpoint: Option<Arc<CancellationSource>>,
    measured_checkpoint_tokens: Option<u32>,
}

impl ModelService for WindowModel {
    fn context_budget(&self, _: ModelSelection<'_>) -> Result<ContextBudget, CoreError> {
        Ok(ContextBudget::core_managed(
            ContextTokenCount::new(7_000),
            ContextTokenCount::new(500),
            ContextTokenCount::new(100),
            ContextCompactionLimit::Tokens(ContextTokenCount::new(3_200)),
        ))
    }

    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.requests.lock().unwrap().push(request.clone());
        let checkpoint = request
            .instructions
            .as_deref()
            .is_some_and(|body| body.contains("durable context checkpoint"))
            || request_contains(
                request,
                "Pause task execution and write a continuation record",
            );
        if checkpoint {
            if let Some(cancellation) = &self.cancel_checkpoint {
                cancellation.cancel();
            }
            return Ok(text_response(
                "Commands already completed. Keep the user correction. Continue the remaining work.",
            ));
        }
        let step = self.ordinary.fetch_add(1, Ordering::SeqCst);
        if step == 8 {
            return Ok(text_response("task complete"));
        }
        Ok(ModelResponse {
            output: vec![ResponseItem::ToolCall(ToolCall {
                id: ToolCallId::new(format!("work-{step}")).unwrap(),
                name: ToolName::new("weather").unwrap(),
                arguments: json!({"city":"Paris","source": "observed detail ".repeat(220)}),
            })],
            usage: None,
            billing: None,
            stop_reason: StopReason::ToolUse,
        })
    }

    fn measure_input(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ContextTokenMeasurementOutcome, CoreError> {
        if request_contains(request, "Pause task execution")
            && let Some(tokens) = self.measured_checkpoint_tokens
        {
            return Ok(ContextTokenMeasurementOutcome::Measured(
                ContextTokenMeasurement::exact(
                    ContextTokenCount::new(tokens),
                    ContextTokenMeasurementSource::provider_preflight("window-model-v1").unwrap(),
                ),
            ));
        }
        Ok(ContextTokenMeasurementOutcome::Unavailable)
    }
}

fn window_turn(
    policy: ash_protocol::ContextCompactionPolicy,
) -> (
    Arc<InMemoryThreadStore>,
    Arc<ThreadController>,
    ThreadId,
    TurnId,
) {
    let store = Arc::new(InMemoryThreadStore::default());
    let (threads, thread, first) =
        started_turn_with_store(ash_protocol::ToolMode::Direct, store.clone());
    threads
        .complete_turn(&thread, &first, "ready".into())
        .unwrap();
    let turn = threads
        .start_turn(
            &thread,
            StartTurnRequest {
                context_policy: policy,
                command_id: CommandId::new("window-task").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                reasoning_effort: None,
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                mode: Default::default(),
                instructions: crate::test_turn_instructions(),
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "Finish all steps. Preserve this user correction.".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    (store, threads, thread, turn)
}

#[test]
fn both_policies_cross_multiple_windows_in_one_turn_and_restore_without_repeating_tools() {
    for policy in [
        ash_protocol::ContextCompactionPolicy::Summary {
            summary_tokens: 200,
            recent_tokens: 900,
        },
        ash_protocol::ContextCompactionPolicy::Handoff {
            buffer_tokens: 4_000,
            state_tokens: 200,
        },
    ] {
        let (store, threads, thread, turn) = window_turn(policy.clone());
        let trace_root = tempfile::tempdir().unwrap();
        let threads = Arc::new(
            Arc::try_unwrap(threads)
                .ok()
                .expect("controller is unshared before execution")
                .with_trace_recorder(Arc::new(ash_rollout_trace::TraceRecorder::new(Some(
                    trace_root.path().into(),
                )))),
        );
        let model = Arc::new(WindowModel {
            ordinary: AtomicUsize::new(0),
            requests: Mutex::new(Vec::new()),
            cancel_checkpoint: None,
            measured_checkpoint_tokens: None,
        });
        let executor = TurnExecutor::new(
            threads.clone(),
            model.clone(),
            Arc::new(WeatherTool),
            Arc::new(SandboxActionPolicyService),
        );
        let result = executor
            .execute(&thread, &turn, &CancellationSource::new().token())
            .unwrap();
        assert!(matches!(result, TurnExecutionOutcome::Completed(_)));
        let state = threads.read_thread(&thread).unwrap();
        assert!(
            state.context_checkpoints.len() >= 2,
            "a long Turn should cross multiple windows"
        );
        assert_eq!(state.started_tool_calls.len(), 8);
        assert_eq!(
            state
                .items
                .iter()
                .filter(|item| matches!(item, ThreadItem::ToolResult { .. }))
                .count(),
            8
        );
        let requests = model.requests.lock().unwrap();
        let observed = threads
            .read_trace_diagnostics(&state.session_id, 0, 500)
            .unwrap();
        let attempts = observed
            .diagnostics
            .events
            .iter()
            .filter(|event| {
                matches!(
                    event.event,
                    ash_rollout_trace::DiagnosticEventKind::ModelAttemptStarted { .. }
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(attempts.len(), requests.len());
        assert!(attempts.iter().any(|event| matches!(
            event.event,
            ash_rollout_trace::DiagnosticEventKind::ModelAttemptStarted {
                purpose: ash_rollout_trace::InferencePurpose::Compaction,
                ..
            }
        )));
        assert_eq!(
            observed
                .diagnostics
                .events
                .iter()
                .filter(|event| matches!(
                    event.event,
                    ash_rollout_trace::DiagnosticEventKind::ModelAttemptCompleted { .. }
                ))
                .count(),
            requests.len()
        );
        for request in requests.iter().filter(|request| !request.tools.is_empty()) {
            assert!(request_contains(request, "Preserve this user correction"));
        }
        if matches!(
            policy,
            ash_protocol::ContextCompactionPolicy::Handoff { .. }
        ) {
            let handoffs = requests
                .iter()
                .filter(|request| request_contains(request, "Pause task execution"));
            for request in handoffs {
                assert!(request.tools.is_empty());
                assert_eq!(request.tool_choice, ash_protocol::ToolChoice::None);
                assert_eq!(request.max_output_tokens, Some(200));
                assert!(
                    request
                        .input
                        .iter()
                        .any(|item| matches!(item, InputItem::ToolResult(_)))
                );
            }
        }
        let restored = ThreadController::with_store(store);
        let reloaded = restored.read_thread(&thread).unwrap();
        assert_eq!(reloaded.context_policy(&turn), policy);
        assert_eq!(reloaded.context_checkpoints, state.context_checkpoints);
        assert_eq!(reloaded.started_tool_calls, state.started_tool_calls);
        assert_eq!(reloaded.items, state.items);
    }
}

#[test]
fn cancellation_after_handoff_response_keeps_source_history_without_a_checkpoint() {
    let (_, threads, thread, turn) = window_turn(ash_protocol::ContextCompactionPolicy::Handoff {
        buffer_tokens: 4_000,
        state_tokens: 200,
    });
    let cancellation = Arc::new(CancellationSource::new());
    let model = Arc::new(WindowModel {
        ordinary: AtomicUsize::new(0),
        requests: Mutex::new(Vec::new()),
        cancel_checkpoint: Some(cancellation.clone()),
        measured_checkpoint_tokens: None,
    });
    let executor = TurnExecutor::new(
        threads.clone(),
        model,
        Arc::new(WeatherTool),
        Arc::new(SandboxActionPolicyService),
    );
    assert!(matches!(
        executor.execute(&thread, &turn, &cancellation.token()),
        Err(CoreError::Cancelled(_))
    ));
    let state = threads.read_thread(&thread).unwrap();
    assert!(state.context_checkpoints.is_empty());
    assert!(!state.started_tool_calls.is_empty());
    assert!(
        state
            .items
            .iter()
            .any(|item| matches!(item, ThreadItem::ToolResult { .. }))
    );
    assert!(state.items.iter().any(|item| matches!(item, ThreadItem::UserMessage { text, .. } if text.contains("user correction"))));
}

#[test]
fn oversized_measured_handoff_is_rejected_before_model_invocation_and_keeps_history() {
    let (_, threads, thread, turn) = window_turn(ash_protocol::ContextCompactionPolicy::Handoff {
        buffer_tokens: 4_000,
        state_tokens: 200,
    });
    let model = Arc::new(WindowModel {
        ordinary: AtomicUsize::new(0),
        requests: Mutex::new(Vec::new()),
        cancel_checkpoint: None,
        measured_checkpoint_tokens: Some(7_000),
    });
    let executor = TurnExecutor::new(
        threads.clone(),
        model.clone(),
        Arc::new(WeatherTool),
        Arc::new(SandboxActionPolicyService),
    );
    let Err(error) = executor.execute(&thread, &turn, &CancellationSource::new().token()) else {
        panic!("an oversized handoff must fail before invocation");
    };
    assert!(
        error
            .to_string()
            .contains("checkpoint request exceeds the hard context window")
    );
    assert!(
        model
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| !request_contains(request, "Pause task execution"))
    );
    let state = threads.read_thread(&thread).unwrap();
    assert!(state.context_checkpoints.is_empty());
    assert!(!state.started_tool_calls.is_empty());
    assert!(
        state
            .items
            .iter()
            .any(|item| matches!(item, ThreadItem::ToolResult { .. }))
    );
}
