use super::*;
use crate::ActionPolicyService;
use crate::ContextBudget;
use crate::ContextCompactionLimit;
use crate::ContextTokenCount;
use crate::ContextTokenMeasurementCapability;
use crate::ContextTokenMeasurementOutcome;
use crate::CreateThreadRequest;
use crate::InMemoryThreadStore;
use crate::ModelSelection;
use crate::ModelService;
use crate::ModelStreamSink;
use crate::SequenceExpectation;
use crate::StartContextCompactionRequest;
use crate::StartTurnRequest;
use crate::SteerTurnRequest;
use crate::ThreadUpdateSink;
use crate::ToolAuthorization;
use crate::ToolExecutionFacts;
use crate::ToolExecutionOutput;
use crate::ToolInteractionService;
use crate::ToolOutputSink;
use crate::ToolService;
use crate::ToolUserInputOutcome;
use crate::TurnExecutionOutcome;
use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::Capability;
use ash_action_policy::CapabilityKind;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_agent_environment::AgentEnvironmentSnapshot;
use ash_agent_environment::Dirs;
use ash_agent_environment::HostEnvironment;
use ash_agent_environment::RepositoryEnvironment;
use ash_async_utils::CancellationSource;
use ash_context_engine::ContextTokenMeasurement;
use ash_context_engine::ContextTokenMeasurementSource;
use ash_protocol::AgentResponse;
use ash_protocol::CommandId;
use ash_protocol::ContentDigest;
use ash_protocol::ContentPart;
use ash_protocol::FrozenSkillActivation;
use ash_protocol::InputItem;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ModelStreamEvent;
use ash_protocol::ModelUsage;
use ash_protocol::ProviderId;
use ash_protocol::ReasoningConfig;
use ash_protocol::ReasoningEffort;
use ash_protocol::RequestUserInput;
use ash_protocol::RequestUserInputResponse;
use ash_protocol::ResponseItem;
use ash_protocol::SessionId;
use ash_protocol::SkillActivationReason;
use ash_protocol::SkillId;
use ash_protocol::SkillName;
use ash_protocol::SkillRef;
use ash_protocol::SkillSourceId;
use ash_protocol::StableTurnErrorCode;
use ash_protocol::StopReason;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadUpdate;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::ToolCallId;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolName;
use ash_protocol::TurnStatus;
use ash_protocol::UserInput;
use ash_protocol::UserInputAnswer;
use ash_protocol::UserInputQuestion;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxPolicy;
use serde_json::json;
use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;
use std::time::Instant;

#[test]
fn completes_a_text_turn_from_durable_context() {
    let (threads, thread_id, turn_id) = started_turn();
    let model = Arc::new(ScriptedModel::new([Ok(text_response("answer"))]));
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone());

    let completion = executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    assert!(matches!(
        completion,
        TurnExecutionOutcome::Completed(crate::CompletedTurn {
            item: ThreadItem::AgentMessage { ref text, .. },
            ..
        }) if text == "answer"
    ));
    assert_eq!(model.requests().len(), 1);
    let InputItem::Message(message) = &model.requests()[0].input[0] else {
        panic!("first input must be a message");
    };
    assert_eq!(message.content, vec![ContentPart::Text("hello".into())]);
    assert_eq!(
        threads
            .read_thread(&thread_id)
            .unwrap()
            .turns
            .last()
            .unwrap()
            .status,
        TurnStatus::Completed
    );
}

#[test]
fn populates_configured_reasoning_on_model_request() {
    let (threads, thread_id, turn_id) = started_turn();
    let reasoning = ReasoningConfig {
        effort: ReasoningEffort::High,
        summary: false,
    };
    let model = Arc::new(
        ScriptedModel::new([Ok(text_response("answer"))]).with_reasoning(reasoning.clone()),
    );
    let executor = TurnExecutor::without_tools(threads, model.clone());

    let completion = executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    assert!(matches!(
        completion,
        TurnExecutionOutcome::Completed(crate::CompletedTurn {
            item: ThreadItem::AgentMessage { ref text, .. },
            ..
        }) if text == "answer"
    ));
    assert_eq!(model.requests().len(), 1);
    assert_eq!(model.requests()[0].reasoning, Some(reasoning));
}

#[cfg(feature = "code-mode")]
#[test]
fn tool_mode_controls_the_model_facing_catalog() {
    for (mode, expected) in [
        (
            ash_protocol::ToolMode::CodeMode,
            vec!["weather", "exec", "wait"],
        ),
        (ash_protocol::ToolMode::CodeModeOnly, vec!["exec", "wait"]),
    ] {
        let (threads, thread_id, turn_id) = started_turn_with_tool_mode(mode);
        let model = Arc::new(ScriptedModel::new([Ok(text_response("done"))]));
        let executor = TurnExecutor::new(
            threads,
            model.clone(),
            Arc::new(WeatherTool),
            Arc::new(SandboxActionPolicyService),
        );

        executor
            .execute(&thread_id, &turn_id, &CancellationSource::new().token())
            .unwrap();

        assert_eq!(
            model.requests()[0]
                .tools
                .iter()
                .map(|definition| definition.name.as_str())
                .collect::<Vec<_>>(),
            expected
        );
    }
}

#[cfg(feature = "code-mode")]
#[test]
fn code_mode_exec_runs_javascript_through_the_durable_tool_path() {
    let (threads, thread_id, turn_id) =
        started_turn_with_tool_mode(ash_protocol::ToolMode::CodeModeOnly);
    let model = Arc::new(ScriptedModel::new([
        Ok(ModelResponse {
            output: vec![ResponseItem::ToolCall(ToolCall {
                id: ToolCallId::new("code-mode-exec").unwrap(),
                name: ToolName::new("exec").unwrap(),
                arguments: json!({"source": "text('hello from JavaScript');"}),
            })],
            usage: None,
            billing: None,
            stop_reason: StopReason::ToolUse,
        }),
        Ok(text_response("done")),
    ]));
    let executor = TurnExecutor::new(
        threads.clone(),
        model,
        Arc::new(crate::NoTools),
        Arc::new(CodeModeControlPolicy),
    );

    executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    assert!(threads.read_thread(&thread_id).unwrap().items.iter().any(|item| {
        matches!(
            item,
            ThreadItem::ToolResult {
                tool_call_id,
                text,
                is_error: false,
                ..
            } if tool_call_id.as_str() == "code-mode-exec" && text.contains("hello from JavaScript")
        )
    }));
}

#[cfg(feature = "code-mode")]
#[test]
fn code_mode_only_runs_concurrent_nested_tools_through_the_durable_scheduler() {
    let (threads, thread_id, turn_id) =
        started_turn_with_tool_mode(ash_protocol::ToolMode::CodeModeOnly);
    let model = Arc::new(ScriptedModel::new([
        Ok(ModelResponse {
            output: vec![ResponseItem::ToolCall(ToolCall {
                id: ToolCallId::new("code-mode-concurrent-exec").unwrap(),
                name: ToolName::new("exec").unwrap(),
                arguments: json!({
                    "source": "const values = await Promise.all([tools.weather({city: 'Paris'}), tools.weather({city: 'Paris'})]); text(values);"
                }),
            })],
            usage: None,
            billing: None,
            stop_reason: StopReason::ToolUse,
        }),
        Ok(text_response("done")),
    ]));
    let executor = TurnExecutor::new(
        threads.clone(),
        model,
        Arc::new(WeatherTool),
        Arc::new(CodeModeControlPolicy),
    );

    executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    let snapshot = threads.read_thread(&thread_id).unwrap();
    let nested_calls = snapshot
        .items
        .iter()
        .filter(|item| {
            matches!(
                item,
                ThreadItem::ToolCall {
                    binding: Some(ash_protocol::ToolCallBinding {
                        caller: ash_protocol::ToolCallCaller::CodeMode { .. },
                        ..
                    }),
                    ..
                }
            )
        })
        .count();
    let nested_results = snapshot
        .items
        .iter()
        .filter(|item| {
            matches!(
                item,
                ThreadItem::ToolResult {
                    tool_call_id,
                    text,
                    is_error: false,
                    ..
                } if tool_call_id.as_str().starts_with("code-code-mode-concurrent-exec-")
                    && text == "sunny"
            )
        })
        .count();
    assert_eq!(nested_calls, 2);
    assert_eq!(nested_results, 2);
    assert!(snapshot.items.iter().any(|item| {
        matches!(
            item,
            ThreadItem::ToolResult {
                tool_call_id,
                text,
                is_error: false,
                ..
            } if tool_call_id.as_str() == "code-mode-concurrent-exec"
                && text.contains("sunny")
        )
    }));
}

#[cfg(not(feature = "code-mode"))]
#[test]
fn explicit_code_mode_fails_closed_when_the_runtime_feature_is_absent() {
    let (threads, thread_id, turn_id) =
        started_turn_with_tool_mode(ash_protocol::ToolMode::CodeModeOnly);
    let model = Arc::new(ScriptedModel::new([Ok(text_response("must not run"))]));
    let executor = TurnExecutor::without_tools(threads, model.clone());

    let error = match executor.execute(&thread_id, &turn_id, &CancellationSource::new().token()) {
        Ok(_) => panic!("Code Mode must fail when the runtime feature is absent"),
        Err(error) => error,
    };

    assert!(
        error
            .to_string()
            .contains("does not include the V8 runtime")
    );
    assert!(model.requests().is_empty());
}

#[test]
fn frozen_tool_profile_rejects_definition_drift_before_model_invocation() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let thread_id = ThreadId::new("profile-thread").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("profile-session").unwrap(),
            thread_id: thread_id.clone(),
            title: "profile".into(),
        })
        .unwrap();
    let model = Arc::new(ScriptedModel::new([
        Ok(text_response("first complete")),
        Ok(text_response("unused")),
    ]));
    let tools = Arc::new(MutableDefinitionsTool {
        description: Mutex::new("stable definition".into()),
    });
    let executor = TurnExecutor::new(
        threads.clone(),
        model.clone(),
        tools.clone(),
        Arc::new(SandboxActionPolicyService),
    );
    let profile = executor.tool_profile_snapshot().unwrap();
    assert_eq!(profile.id, "coding");
    assert_eq!(profile.revision, "coding-v1");
    assert_eq!(profile.tool_names, vec![ToolName::new("weather").unwrap()]);
    assert!(profile.parallel_tool_calls);
    let turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("profile-start").unwrap(),
                expected_sequence: SequenceExpectation::Exact(1),
                model: Some(ModelRef::new(
                    ProviderId::new("any-provider").unwrap(),
                    ModelId::new("any-model").unwrap(),
                )),
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: Some(profile.clone()),
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "hello".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    assert_eq!(
        threads.read_thread(&thread_id).unwrap().turns[0]
            .tool_profile
            .as_ref(),
        Some(&profile)
    );

    executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();
    let requests = model.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0]
            .tools
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        vec!["weather"]
    );
    assert!(requests[0].parallel_tool_calls);

    let drift_turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("profile-drift-start").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: Some(ModelRef::new(
                    ProviderId::new("another-provider").unwrap(),
                    ModelId::new("another-model").unwrap(),
                )),
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: Some(profile),
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "continue".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;

    *tools.description.lock().unwrap() = "drifted definition".into();
    let error = match executor.execute(
        &thread_id,
        &drift_turn_id,
        &CancellationSource::new().token(),
    ) {
        Ok(_) => panic!("definition drift must fail before model invocation"),
        Err(error) => error,
    };

    assert!(
        matches!(error, CoreError::Context(message) if message.contains("frozen tool profile"))
    );
    assert_eq!(model.requests().len(), 1);
}

#[test]
fn manual_context_compaction_commits_a_checkpoint_and_usage_before_completing() {
    let (threads, thread_id, history_turn_id) = started_turn();
    let model_ref = ModelRef::new(
        ProviderId::new("provider").unwrap(),
        ModelId::new("compaction-model").unwrap(),
    );
    threads
        .complete_turn(
            &thread_id,
            &history_turn_id,
            "durable history that must remain available ".repeat(40),
        )
        .unwrap();
    let compact_turn_id = threads
        .start_context_compaction(
            &thread_id,
            StartContextCompactionRequest {
                command_id: CommandId::new("manual-compact").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: Some(model_ref.clone()),
                policy_revision: "test-policy-v1".into(),
                retention_prompt: Some("preserve the deployment decision".into()),
            },
        )
        .unwrap()
        .turn_id;
    let model = Arc::new(ScriptedModel::new([Ok(ModelResponse {
        output: vec![ResponseItem::Text("manual checkpoint".into())],
        usage: Some(ModelUsage {
            input_tokens: Some(100),
            output_tokens: Some(8),
            cached_input_tokens: Some(0),
            cache_write_input_tokens: Some(0),
            reasoning_tokens: Some(0),
        }),
        billing: None,
        stop_reason: StopReason::Completed,
    })]));
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone());

    let outcome = executor
        .execute(
            &thread_id,
            &compact_turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();
    let snapshot = threads.read_thread(&thread_id).unwrap();

    assert!(matches!(
        outcome,
        TurnExecutionOutcome::ContextCompacted { .. }
    ));
    assert_eq!(snapshot.context_checkpoints.len(), 1);
    assert_eq!(snapshot.context_checkpoints[0].summary, "manual checkpoint");
    assert_eq!(snapshot.usage.model_invocations, 1);
    assert!(
        snapshot
            .context_calibration(&model_ref, crate::context::CONTEXT_ESTIMATOR_REVISION)
            .is_some()
    );
    assert_eq!(
        snapshot
            .turns
            .iter()
            .find(|turn| turn.turn_id == compact_turn_id)
            .unwrap()
            .usage
            .model_invocations,
        1
    );
    assert_eq!(
        snapshot
            .turns
            .iter()
            .find(|turn| turn.turn_id == compact_turn_id)
            .unwrap()
            .status,
        TurnStatus::Completed
    );
    let requests = model.requests();
    assert_eq!(requests.len(), 1);
    assert!(request_contains(
        &requests[0],
        "preserve the deployment decision"
    ));
    assert!(requests[0].tools.is_empty());
}

#[test]
fn manual_context_compaction_batches_a_prefix_that_exceeds_the_model_window() {
    let (threads, thread_id, first_turn_id) = started_turn();
    threads
        .complete_turn(
            &thread_id,
            &first_turn_id,
            "first durable history segment ".repeat(180),
        )
        .unwrap();
    let second_turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("second-history-turn").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "continue the durable history".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    threads
        .complete_turn(
            &thread_id,
            &second_turn_id,
            "second durable history segment ".repeat(180),
        )
        .unwrap();
    let compact_turn_id = threads
        .start_context_compaction(
            &thread_id,
            StartContextCompactionRequest {
                command_id: CommandId::new("batched-manual-compact").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                retention_prompt: None,
            },
        )
        .unwrap()
        .turn_id;
    let model = Arc::new(BatchedCompactionModel::default());
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone());

    let outcome = executor
        .execute(
            &thread_id,
            &compact_turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();
    let snapshot = threads.read_thread(&thread_id).unwrap();

    assert!(matches!(
        outcome,
        TurnExecutionOutcome::ContextCompacted { .. }
    ));
    assert_eq!(model.requests.lock().unwrap().len(), 2);
    assert_eq!(snapshot.context_checkpoints.len(), 2);
    assert!(
        snapshot.context_checkpoints[0].covered.end_sequence
            < snapshot.context_checkpoints[1].covered.end_sequence
    );
    assert_eq!(snapshot.usage.model_invocations, 2);
}

#[test]
fn failed_manual_context_compaction_does_not_commit_a_checkpoint() {
    let (threads, thread_id, history_turn_id) = started_turn();
    threads
        .complete_turn(
            &thread_id,
            &history_turn_id,
            "history large enough to compact ".repeat(40),
        )
        .unwrap();
    let compact_turn_id = threads
        .start_context_compaction(
            &thread_id,
            StartContextCompactionRequest {
                command_id: CommandId::new("failed-compact").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                retention_prompt: None,
            },
        )
        .unwrap()
        .turn_id;
    let empty_response = || ModelResponse {
        output: Vec::new(),
        usage: Some(ModelUsage {
            input_tokens: Some(10),
            output_tokens: Some(0),
            cached_input_tokens: None,
            cache_write_input_tokens: None,
            reasoning_tokens: None,
        }),
        billing: None,
        stop_reason: StopReason::Completed,
    };
    let model = Arc::new(ScriptedModel::new([Ok(empty_response())]));
    let executor = TurnExecutor::without_tools(threads.clone(), model);

    assert!(
        executor
            .execute(
                &thread_id,
                &compact_turn_id,
                &CancellationSource::new().token(),
            )
            .is_err()
    );
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert!(snapshot.context_checkpoints.is_empty());
    assert_eq!(snapshot.usage.model_invocations, 1);
    assert_eq!(snapshot.turns.last().unwrap().status, TurnStatus::Failed);
}

#[test]
fn manual_context_compaction_does_not_absorb_an_unfinished_tool_group() {
    let (threads, thread_id, history_turn_id) = started_turn();
    threads
        .record_tool_call(
            &thread_id,
            &history_turn_id,
            crate::RecordToolCallRequest {
                tool_call_id: Some(ToolCallId::new("unfinished").unwrap()),
                name: ToolName::new("weather").unwrap(),
                arguments_json: "{}".into(),
                binding: None,
            },
        )
        .unwrap();
    threads
        .fail_turn(
            &thread_id,
            &history_turn_id,
            ash_protocol::StableTurnError::model_invocation_failed(),
        )
        .unwrap();
    let compact_turn_id = threads
        .start_context_compaction(
            &thread_id,
            StartContextCompactionRequest {
                command_id: CommandId::new("safe-compact").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                retention_prompt: None,
            },
        )
        .unwrap()
        .turn_id;
    let model = Arc::new(ScriptedModel::new([]));
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone());

    let outcome = executor
        .execute(
            &thread_id,
            &compact_turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();
    let snapshot = threads.read_thread(&thread_id).unwrap();

    assert!(matches!(
        outcome,
        TurnExecutionOutcome::ContextCompacted { .. }
    ));
    assert!(model.requests().is_empty());
    assert!(snapshot.context_checkpoints.is_empty());
}

#[test]
fn steering_during_a_model_call_discards_its_stale_completion_and_replans() {
    let (threads, thread_id, turn_id) = started_turn();
    let updates = Arc::new(RecordingUpdates::default());
    let model = Arc::new(SteeringModel {
        threads: threads.clone(),
        thread_id: thread_id.clone(),
        turn_id: turn_id.clone(),
        requests: Mutex::new(Vec::new()),
    });
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone())
        .with_thread_updates(updates.clone());

    let outcome = executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    assert!(matches!(outcome, TurnExecutionOutcome::Completed(_)));
    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(!request_contains(&requests[0], "steer toward tests"));
    assert!(request_contains(&requests[1], "steer toward tests"));
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert_eq!(snapshot.usage.model_invocations, 2);
    assert!(!snapshot.items.iter().any(
        |item| matches!(item, ThreadItem::AgentMessage { text, .. } if text == "stale answer")
    ));
    assert!(!snapshot.items.iter().any(
        |item| matches!(item, ThreadItem::Reasoning { text, .. } if text == "stale reasoning")
    ));
    assert!(!snapshot.items.iter().any(
        |item| matches!(item, ThreadItem::ToolCall { tool_call_id, .. } if tool_call_id.as_str() == "stale-call")
    ));
    assert!(snapshot.items.iter().any(
        |item| matches!(item, ThreadItem::AgentMessage { text, .. } if text == "steered answer")
    ));
    let mut first_sequence_by_instance = BTreeMap::new();
    for cursor in updates
        .updates()
        .into_iter()
        .filter_map(|update| update.stream_cursor)
    {
        first_sequence_by_instance
            .entry(cursor.stream_instance_id.to_string())
            .or_insert(cursor.sequence);
    }
    assert_eq!(first_sequence_by_instance.len(), 2);
    assert!(
        first_sequence_by_instance
            .values()
            .all(|sequence| *sequence == 1)
    );
}

#[test]
fn code_mode_nested_call_is_durable_and_reenters_the_ordinary_scheduler() {
    let (threads, thread_id, turn_id) = started_turn();
    let model = Arc::new(ScriptedModel::new([]));
    let executor = TurnExecutor::new(
        threads.clone(),
        model,
        Arc::new(WeatherTool),
        Arc::new(SandboxActionPolicyService),
    );

    let nested_id = executor
        .record_code_mode_nested_call(
            &thread_id,
            &turn_id,
            &ToolCallId::new("outer").unwrap(),
            "cell-1",
            "runtime-1",
            ToolName::new("weather").unwrap(),
            json!({"city": "Paris"}),
        )
        .unwrap();
    let call = threads
        .read_thread(&thread_id)
        .unwrap()
        .items
        .into_iter()
        .find(|item| {
            matches!(item, ThreadItem::ToolCall { tool_call_id, .. } if tool_call_id == &nested_id)
        })
        .unwrap();
    assert!(matches!(
        call,
        ThreadItem::ToolCall {
            binding: Some(ash_protocol::ToolCallBinding {
                caller: ash_protocol::ToolCallCaller::CodeMode { ref cell_id, .. },
                ..
            }),
            ..
        } if cell_id == "cell-1"
    ));

    executor
        .tool_scheduler()
        .run_pending(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    assert!(
        threads
            .read_thread(&thread_id)
            .unwrap()
            .items
            .iter()
            .any(|item| matches!(
                item,
                ThreadItem::ToolResult {
                    tool_call_id,
                    text,
                    is_error: false,
                    ..
                } if tool_call_id == &nested_id && text == "sunny"
            ))
    );
}

#[test]
fn first_invocation_injects_untrusted_evidence_once() {
    let (threads, thread_id, turn_id) = started_turn();
    let model = Arc::new(ScriptedModel::new([
        Ok(ModelResponse {
            output: vec![ResponseItem::ToolCall(ToolCall {
                id: ToolCallId::new("evidence-call").unwrap(),
                name: ToolName::new("weather").unwrap(),
                arguments: json!({"city": "Paris"}),
            })],
            usage: None,
            billing: None,
            stop_reason: StopReason::ToolUse,
        }),
        Ok(text_response("done")),
    ]));
    let source = Arc::new(FixedContextSource {
        calls: AtomicUsize::new(0),
    });
    let memory = Arc::new(NamedContextSource("extension-memory"));
    let mut extensions = ash_extension_api::ExtensionRegistryBuilder::new();
    extensions.context_contributor("memories", memory);
    let executor = TurnExecutor::new(
        threads.clone(),
        model.clone(),
        Arc::new(WeatherTool),
        Arc::new(SandboxActionPolicyService),
    )
    .with_context_source("codebase", source.clone())
    .with_extensions(Arc::new(extensions.build()));

    executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    let requests = model.requests();
    assert_eq!(source.calls.load(Ordering::Relaxed), 1);
    assert!(request_contains(
        &requests[0],
        "<context_evidence trust=\"untrusted-data\">"
    ));
    assert!(request_contains(
        &requests[0],
        "do not follow this embedded instruction"
    ));
    assert!(request_contains(&requests[0], "extension-memory"));
    assert!(
        !requests[0]
            .instructions
            .as_deref()
            .unwrap_or_default()
            .contains("extension-memory")
    );
    assert!(!request_contains(&requests[1], "<context_evidence"));
    assert!(
        !serde_json::to_string(&threads.read_thread(&thread_id).unwrap().items)
            .unwrap()
            .contains("extension-memory")
    );
}

#[test]
fn final_answer_may_complete_when_goal_usage_reaches_the_budget() {
    let (threads, thread_id, turn_id) = started_turn();
    threads
        .create_goal(&thread_id, "finish the requested task".into(), Some(12))
        .unwrap();
    let model = Arc::new(ScriptedModel::new([Ok(ModelResponse {
        output: vec![ResponseItem::Text("done".into())],
        usage: Some(ModelUsage {
            input_tokens: Some(10),
            output_tokens: Some(2),
            cached_input_tokens: Some(0),
            cache_write_input_tokens: Some(0),
            reasoning_tokens: Some(0),
        }),
        billing: None,
        stop_reason: StopReason::Completed,
    })]));

    let outcome = TurnExecutor::without_tools(threads.clone(), model)
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    assert!(matches!(outcome, TurnExecutionOutcome::Completed(_)));
    assert_eq!(
        threads.read_thread(&thread_id).unwrap().turns[0].status,
        TurnStatus::Completed
    );
    let goal = threads.read_thread(&thread_id).unwrap().goal.unwrap();
    assert_eq!(goal.tokens_used, 12);
    assert_eq!(goal.status, ash_protocol::ThreadGoalStatus::BudgetLimited);
}

#[test]
fn successful_tool_search_result_loads_deferred_definition_for_next_model_step() {
    let (threads, thread_id, turn_id) = started_turn();
    let model = Arc::new(ScriptedModel::new([
        Ok(ModelResponse {
            output: vec![ResponseItem::ToolCall(ToolCall {
                id: ToolCallId::new("provider-search-call").unwrap(),
                name: ToolName::new("tool_search").unwrap(),
                arguments: json!({"query": "weather", "limit": 1}),
            })],
            usage: None,
            billing: None,
            stop_reason: StopReason::ToolUse,
        }),
        Ok(text_response("loaded")),
    ]));
    let tools = Arc::new(DeferredWeatherTools);
    let executor = TurnExecutor::new(
        threads,
        model.clone(),
        tools,
        Arc::new(SandboxActionPolicyService),
    );

    let outcome = executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    assert!(matches!(outcome, TurnExecutionOutcome::Completed(_)));
    let requests = model.requests();
    assert_eq!(
        requests[0]
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["tool_search"]
    );
    assert_eq!(
        requests[1]
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["tool_search", "weather"]
    );
}

#[test]
fn compacts_durable_history_then_replans_with_the_verified_checkpoint() {
    let (threads, thread_id, first_turn_id) = started_turn();
    threads
        .complete_turn(&thread_id, &first_turn_id, "a".repeat(2_000))
        .unwrap();
    for index in 0..3 {
        let turn_id = threads
            .start_turn(
                &thread_id,
                StartTurnRequest {
                    kind: ash_protocol::TurnKind::Coding,
                    instructions: crate::test_turn_instructions(),
                    command_id: CommandId::new(format!("history-{index}")).unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    model: None,
                    policy_revision: "test-policy-v1".into(),
                    approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: None,
                    activated_skills: Vec::new(),
                    input: vec![UserInput::Text {
                        text: format!("history input {index}"),
                    }],
                },
            )
            .unwrap()
            .turn_id;
        threads
            .complete_turn(&thread_id, &turn_id, "history".repeat(286))
            .unwrap();
    }
    let current_turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("start-after-history").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "current input".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    let model = Arc::new(CompactingModel::default());
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone());

    let outcome = executor
        .execute(
            &thread_id,
            &current_turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();

    assert!(matches!(outcome, TurnExecutionOutcome::Completed(_)));
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert_eq!(snapshot.context_checkpoints.len(), 1);
    assert_eq!(
        snapshot.context_checkpoints[0].summary,
        "bounded checkpoint"
    );
    assert_eq!(snapshot.usage.model_invocations, 2);
    assert_eq!(snapshot.usage.input_tokens.reported, 150);
    assert!(snapshot.usage.input_tokens.complete);
    assert_eq!(snapshot.usage.output_tokens.reported, 15);
    assert!(snapshot.usage.output_tokens.complete);
    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[0]
            .instructions
            .as_deref()
            .is_some_and(|body| body.contains("durable context checkpoint"))
    );
    assert!(request_contains(&requests[1], "bounded checkpoint"));
    assert!(!request_contains(&requests[1], &"a".repeat(600)));
    assert_eq!(requests[1].max_output_tokens, Some(200));
}

#[test]
fn provider_preflight_tightens_the_budget_and_rechecks_after_compaction() {
    let (threads, thread_id, first_turn_id) = started_turn();
    threads
        .complete_turn(&thread_id, &first_turn_id, "a".repeat(32_000))
        .unwrap();
    let current_turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("start-measured-turn").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "current input".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    let model = Arc::new(PreflightCompactingModel::default());
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone());

    let outcome = executor
        .execute(
            &thread_id,
            &current_turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();

    assert!(matches!(outcome, TurnExecutionOutcome::Completed(_)));
    assert_eq!(model.measurements.load(Ordering::Relaxed), 2);
    assert_eq!(
        threads
            .read_thread(&thread_id)
            .unwrap()
            .context_checkpoints
            .len(),
        1
    );
    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[0]
            .instructions
            .as_deref()
            .is_some_and(|body| body.contains("durable context checkpoint"))
    );
    assert!(request_contains(&requests[1], "measured checkpoint"));
}

#[test]
fn explicit_skill_selection_uses_frozen_digest_and_layered_body() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let thread_id = ThreadId::new("skill-thread").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("session").unwrap(),
            thread_id: thread_id.clone(),
            title: "skill".into(),
        })
        .unwrap();
    let skill_id = SkillId::new(
        SkillSourceId::new("user:skill-source:test").unwrap(),
        SkillName::new("review").unwrap(),
    );
    let digest = ContentDigest::sha256(b"skill body");
    let activation = FrozenSkillActivation {
        id: skill_id.clone(),
        content_digest: digest.clone(),
        catalog_generation: 7,
        reason: SkillActivationReason::Explicit,
    };
    let turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("skill-start").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: vec![activation.clone()],
                input: vec![
                    UserInput::Skill {
                        skill: SkillRef::pinned(skill_id, digest.clone()),
                    },
                    UserInput::Text {
                        text: "review this".into(),
                    },
                ],
            },
        )
        .unwrap()
        .turn_id;
    let model = Arc::new(ScriptedModel::new([Ok(text_response("done"))]));
    let mut extensions = ash_extension_api::ExtensionRegistryBuilder::new();
    extensions.turn_input_contributor(
        "skills",
        Arc::new(FixedSkillContributor {
            expected: activation.clone(),
            body: "# Review workflow\nInspect correctness first.".into(),
        }),
    );
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone())
        .with_extensions(Arc::new(extensions.build()));

    executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    let request = &model.requests()[0];
    assert!(request_contains(request, "Inspect correctness first."));
    assert!(request_contains(request, digest.as_str()));
    assert!(request_contains(request, "<skill-instructions"));
    assert!(!request_contains(request, "reason=\"explicit\""));
    assert!(!request_contains(request, "catalog-generation"));
    assert_eq!(
        threads.read_thread(&thread_id).unwrap().turns[0].activated_skills,
        vec![activation]
    );
}

#[test]
fn executes_a_durable_tool_loop_before_the_next_model_invocation() {
    let (threads, thread_id, turn_id) = started_turn();
    let call = ToolCall {
        id: ToolCallId::new("call_1").unwrap(),
        name: ToolName::new("weather").unwrap(),
        arguments: json!({"city": "Paris"}),
    };
    let model = Arc::new(ScriptedModel::new([
        Ok(ModelResponse {
            output: vec![ResponseItem::ToolCall(call.clone())],
            usage: None,
            billing: None,
            stop_reason: StopReason::ToolUse,
        }),
        Ok(text_response("sunny")),
    ]));
    let log = Arc::new(ToolLifecycleLog::default());
    let mut builder = ash_extension_api::ExtensionRegistryBuilder::new();
    builder.tool_lifecycle_contributor("test", log.clone());
    threads
        .install_extensions(Arc::new(builder.build()))
        .unwrap();
    let tools = Arc::new(WeatherTool);
    let executor = TurnExecutor::new(
        threads.clone(),
        model.clone(),
        tools,
        Arc::new(SandboxActionPolicyService),
    );

    executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert!(snapshot.items.iter().any(
        |item| matches!(item, ThreadItem::ToolCall { tool_call_id, .. } if tool_call_id == &call.id)
    ));
    assert!(snapshot.items.iter().any(
        |item| matches!(item, ThreadItem::ToolResult { tool_call_id, text, .. } if tool_call_id == &call.id && text == "sunny")
    ));
    let events = log.0.lock().unwrap();
    assert_eq!(
        events.as_slice(),
        ["started:call_1", "completed:call_1:false"]
    );
    let requests = model.requests();
    assert_eq!(requests.len(), 2);
    assert!(matches!(
        requests[1].input.last(),
        Some(InputItem::ToolResult(result)) if result.call_id == call.id
    ));
}

#[test]
fn repeated_identical_tool_failures_stop_at_five_with_a_stable_turn_error() {
    let (threads, thread_id, turn_id) = started_turn();
    let mut responses = (1..=5)
        .map(|index| {
            Ok(ModelResponse {
                output: vec![ResponseItem::ToolCall(ToolCall {
                    id: ToolCallId::new(format!("repeat-{index}")).unwrap(),
                    name: ToolName::new("weather").unwrap(),
                    arguments: if index % 2 == 0 {
                        json!({"unit": "c", "city": "Paris"})
                    } else {
                        json!({"city": "Paris", "unit": "c"})
                    },
                })],
                usage: None,
                billing: None,
                stop_reason: StopReason::ToolUse,
            })
        })
        .collect::<Vec<_>>();
    responses.push(Ok(text_response("must not be invoked")));
    let model = Arc::new(ScriptedModel::new(responses));
    let executor = TurnExecutor::new(
        threads.clone(),
        model.clone(),
        Arc::new(FailingWeatherTool),
        Arc::new(SandboxActionPolicyService),
    );

    let error = match executor.execute(&thread_id, &turn_id, &CancellationSource::new().token()) {
        Ok(_) => panic!("the fifth repeated failure must stop the Turn"),
        Err(error) => error,
    };

    assert!(matches!(error, CoreError::ToolRepetition(_)));
    let requests = model.requests();
    assert_eq!(requests.len(), 5);
    assert!(requests[3].input.iter().any(|input| matches!(
        input,
        InputItem::ToolResult(result)
            if result.content.iter().any(|content| matches!(
                content,
                ContentPart::Text(text)
                    if text.contains(crate::tool_repetition::TOOL_REPETITION_REMINDER)
            ))
    )));
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert_eq!(snapshot.turns[0].status, TurnStatus::Failed);
    assert_eq!(
        snapshot.turns[0].failure.as_ref().map(|error| error.code),
        Some(StableTurnErrorCode::ToolRepetition)
    );
    assert_eq!(
        snapshot
            .items
            .iter()
            .filter(|item| matches!(item, ThreadItem::ToolResult { is_error: true, .. }))
            .count(),
        5
    );
}

#[test]
fn rejects_a_model_tool_call_outside_the_invocation_capability_scope() {
    let (threads, thread_id, turn_id) = started_turn();
    let model = Arc::new(ScriptedModel::new([Ok(ModelResponse {
        output: vec![ResponseItem::ToolCall(ToolCall {
            id: ToolCallId::new("invented-call").unwrap(),
            name: ToolName::new("invented_tool").unwrap(),
            arguments: json!({}),
        })],
        usage: None,
        billing: None,
        stop_reason: StopReason::ToolUse,
    })]));
    let executor = TurnExecutor::without_tools(threads.clone(), model);

    assert!(
        executor
            .execute(&thread_id, &turn_id, &CancellationSource::new().token())
            .is_err()
    );

    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert_eq!(snapshot.turns[0].status, TurnStatus::Failed);
    assert!(
        snapshot
            .items
            .iter()
            .all(|item| !matches!(item, ThreadItem::ToolCall { .. }))
    );
}

#[test]
fn durable_turn_instructions_stay_frozen_while_harness_context_refreshes() {
    let (threads, thread_id, turn_id) = started_turn();
    let instructions = Arc::new(MutableInstructions::new("first instructions"));
    let model = Arc::new(InstructionRefreshingModel {
        instructions: Arc::clone(&instructions),
        requests: Mutex::new(Vec::new()),
    });
    let executor = TurnExecutor::new(
        threads,
        model.clone(),
        Arc::new(ReadInstructionTargetTool),
        Arc::new(SandboxActionPolicyService),
    )
    .with_harness_context_provider(instructions.clone());

    executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(request_contains(&requests[0], "first instructions"));
    assert!(!request_contains(&requests[0], "second instructions"));
    assert!(request_contains(&requests[1], "second instructions"));
    assert!(request_contains(&requests[0], "first environment"));
    assert!(!request_contains(&requests[0], "second environment"));
    assert!(request_contains(&requests[1], "second environment"));
    assert!(
        requests[0]
            .instructions
            .as_deref()
            .is_some_and(|body| body.contains("test instructions"))
    );
    assert!(
        requests[1]
            .instructions
            .as_deref()
            .is_some_and(|body| body.contains("test instructions"))
    );
    assert_eq!(
        instructions.request_identities(),
        vec![
            ("session".into(), "thread".into(), turn_id.to_string()),
            ("session".into(), "thread".into(), turn_id.to_string()),
        ]
    );
    assert_eq!(
        instructions.read_paths.lock().unwrap().as_slice(),
        [Vec::<PathBuf>::new(), vec![PathBuf::from("src/lib.rs")]]
    );
}

#[test]
fn continues_beyond_two_hundred_model_invocations() {
    const TOOL_ROUNDS: usize = 200;

    let (threads, thread_id, turn_id) = started_turn();
    let model = Arc::new(LongRunningToolModel::new(TOOL_ROUNDS));
    let executor = TurnExecutor::new(
        threads.clone(),
        model.clone(),
        Arc::new(WeatherTool),
        Arc::new(SandboxActionPolicyService),
    );

    let outcome = executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    assert!(matches!(outcome, TurnExecutionOutcome::Completed(_)));
    assert_eq!(model.invocations(), TOOL_ROUNDS + 1);
    assert_eq!(
        threads
            .read_thread(&thread_id)
            .unwrap()
            .turns
            .last()
            .unwrap()
            .status,
        TurnStatus::Completed
    );
}

#[test]
fn cancellation_interrupts_the_turn_before_invoking_the_model() {
    let (threads, thread_id, turn_id) = started_turn();
    let model = Arc::new(ScriptedModel::new([Ok(text_response("unused"))]));
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone());
    let cancellation = CancellationSource::new();
    cancellation.cancel();

    assert!(matches!(
        executor.execute(&thread_id, &turn_id, &cancellation.token()),
        Err(CoreError::Cancelled(_))
    ));
    assert!(model.requests().is_empty());
    assert_eq!(
        threads
            .read_thread(&thread_id)
            .unwrap()
            .turns
            .last()
            .unwrap()
            .status,
        TurnStatus::Interrupted
    );
}

#[test]
fn cancellation_after_a_model_response_preserves_its_usage() {
    let (threads, thread_id, turn_id) = started_turn();
    let cancellation = CancellationSource::new();
    let model = Arc::new(CancellingResponseModel {
        cancellation: cancellation.clone(),
    });
    let executor = TurnExecutor::without_tools(threads.clone(), model);

    assert!(matches!(
        executor.execute(&thread_id, &turn_id, &cancellation.token()),
        Err(CoreError::Cancelled(_))
    ));
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert_eq!(snapshot.turns[0].status, TurnStatus::Interrupted);
    assert_eq!(snapshot.usage.model_invocations, 1);
    assert_eq!(snapshot.usage.input_tokens.reported, 9);
    assert!(snapshot.usage.input_tokens.complete);
    assert!(
        !snapshot
            .items
            .iter()
            .any(|item| matches!(item, ThreadItem::AgentMessage { .. }))
    );
}

#[test]
fn model_failure_durably_fails_the_turn() {
    let (threads, thread_id, turn_id) = started_turn();
    let model = Arc::new(ScriptedModel::new([Err(CoreError::Model(
        "offline".into(),
    ))]));
    let executor = TurnExecutor::without_tools(threads.clone(), model);

    assert!(matches!(
        executor.execute(
            &thread_id,
            &turn_id,
            &CancellationSource::new().token()
        ),
        Err(CoreError::Model(message)) if message == "offline"
    ));
    assert_eq!(
        threads
            .read_thread(&thread_id)
            .unwrap()
            .turns
            .last()
            .unwrap()
            .status,
        TurnStatus::Failed
    );
}

#[test]
fn retries_transient_model_failures_before_completing() {
    let (threads, thread_id, turn_id) = started_turn();
    let model = Arc::new(ScriptedModel::new([
        Err(CoreError::ModelTransient {
            failure: ash_protocol::StableTurnError::connection_failed(),
            retry_after_ms: None,
        }),
        Err(CoreError::ModelTransient {
            failure: ash_protocol::StableTurnError::connection_failed(),
            retry_after_ms: None,
        }),
        Ok(text_response("recovered")),
    ]));
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone());

    let outcome = executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    assert!(matches!(outcome, TurnExecutionOutcome::Completed(_)));
    assert_eq!(model.requests().len(), 3);
}

#[test]
fn retries_an_invalid_model_response_once_before_failing_stably() {
    let (threads, thread_id, turn_id) = started_turn();
    let model = Arc::new(ScriptedModel::new([
        Err(CoreError::ModelInvalidResponse),
        Err(CoreError::ModelInvalidResponse),
        Ok(text_response("must not be reached")),
    ]));
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone());

    assert!(matches!(
        executor.execute(&thread_id, &turn_id, &CancellationSource::new().token()),
        Err(CoreError::ModelInvalidResponse)
    ));
    assert_eq!(model.requests().len(), 2);
    let snapshot = threads.read_thread(&thread_id).unwrap();
    let failure = snapshot.turns.last().unwrap().failure.as_ref().unwrap();
    assert_eq!(failure.code, StableTurnErrorCode::InvalidResponse);
    assert!(failure.retryable);
}

#[test]
fn semantic_model_failures_do_not_retry_and_keep_stable_turn_codes() {
    let cases = [
        (
            CoreError::ModelContextOverflow,
            StableTurnErrorCode::ContextOverflow,
            true,
        ),
        (
            CoreError::ModelAuthFailed,
            StableTurnErrorCode::ProviderAuth,
            false,
        ),
        (
            CoreError::ModelInvalidRequest,
            StableTurnErrorCode::InvalidRequest,
            false,
        ),
    ];

    for (error, code, retryable) in cases {
        let (threads, thread_id, turn_id) = started_turn();
        let model = Arc::new(ScriptedModel::new([
            Err(error.clone()),
            Ok(text_response("must not be reached")),
        ]));
        let executor = TurnExecutor::without_tools(threads.clone(), model.clone());

        assert_eq!(
            executor
                .execute(&thread_id, &turn_id, &CancellationSource::new().token())
                .err(),
            Some(error)
        );
        assert_eq!(model.requests().len(), 1);
        let snapshot = threads.read_thread(&thread_id).unwrap();
        let failure = snapshot.turns.last().unwrap().failure.as_ref().unwrap();
        assert_eq!(failure.code, code);
        assert_eq!(failure.retryable, retryable);
    }
}

#[test]
fn context_overflow_commits_one_checkpoint_before_retrying_with_the_new_snapshot() {
    let (threads, thread_id, turn_id) = started_turn_with_history();
    let model = Arc::new(CheckpointObservingModel::new(
        threads.clone(),
        thread_id.clone(),
        turn_id.clone(),
        Ok(text_response("recovered")),
    ));
    let compaction = Arc::new(FixedOverflowCompaction::default());
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone())
        .with_context_compaction_service(compaction.clone());

    let outcome = executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    assert!(matches!(outcome, TurnExecutionOutcome::Completed(_)));
    assert_eq!(model.requests().len(), 2);
    assert_eq!(compaction.calls.load(Ordering::Relaxed), 1);
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert_eq!(snapshot.context_checkpoints.len(), 1);
    assert_eq!(snapshot.context_overflow_recoveries.len(), 1);
    assert_eq!(
        snapshot.context_overflow_recoveries.get(&turn_id),
        Some(&snapshot.context_checkpoints[0].checkpoint_id)
    );
}

#[test]
fn a_second_context_overflow_fails_stably_without_another_compaction() {
    let (threads, thread_id, turn_id) = started_turn_with_history();
    let model = Arc::new(CheckpointObservingModel::new(
        threads.clone(),
        thread_id.clone(),
        turn_id.clone(),
        Err(CoreError::ModelContextOverflow),
    ));
    let compaction = Arc::new(FixedOverflowCompaction::default());
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone())
        .with_context_compaction_service(compaction.clone());

    assert_eq!(
        executor
            .execute(&thread_id, &turn_id, &CancellationSource::new().token())
            .err(),
        Some(CoreError::ModelContextOverflow)
    );

    assert_eq!(model.requests().len(), 2);
    assert_eq!(compaction.calls.load(Ordering::Relaxed), 1);
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert_eq!(snapshot.context_checkpoints.len(), 1);
    let failure = snapshot.turns.last().unwrap().failure.as_ref().unwrap();
    assert_eq!(failure.code, StableTurnErrorCode::ContextOverflow);
}

#[test]
fn cancellation_during_overflow_compaction_prevents_the_checkpoint_and_retry() {
    let (threads, thread_id, turn_id) = started_turn_with_history();
    let model = Arc::new(CheckpointObservingModel::new(
        threads.clone(),
        thread_id.clone(),
        turn_id.clone(),
        Ok(text_response("must not be reached")),
    ));
    let compaction = Arc::new(BlockingOverflowCompaction::default());
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone())
        .with_context_compaction_service(compaction.clone());

    executor.start(&thread_id, &turn_id).unwrap();
    compaction.wait_until_entered();
    threads
        .interrupt_turn(
            &thread_id,
            crate::InterruptTurnRequest {
                command_id: CommandId::new("cancel-overflow-compaction").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                turn_id: turn_id.clone(),
            },
        )
        .unwrap();
    wait_for_turn_status(&threads, &thread_id, &turn_id, TurnStatus::Interrupted);
    wait_for_flag(
        &compaction.was_cancelled,
        "overflow compaction was not cancelled",
    );

    assert_eq!(model.requests().len(), 1);
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert!(snapshot.context_checkpoints.is_empty());
    assert!(snapshot.context_overflow_recoveries.is_empty());
}

#[test]
fn restart_after_overflow_checkpoint_commit_does_not_replay_the_model_call() {
    let store = Arc::new(InMemoryThreadStore::default());
    let original = Arc::new(ThreadController::with_store(store.clone()));
    let thread_id = ThreadId::new("overflow-restart-thread").unwrap();
    original
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("overflow-restart-session").unwrap(),
            thread_id: thread_id.clone(),
            title: "overflow restart".into(),
        })
        .unwrap();
    let history_turn = original
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("overflow-restart-history").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "history".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    original
        .complete_turn(&thread_id, &history_turn, "answer".repeat(100))
        .unwrap();
    let current_turn = original
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("overflow-restart-current").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "continue".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    let source = original.read_thread(&thread_id).unwrap();
    let covered_end_sequence = source
        .items
        .iter()
        .filter(|item| item.turn_id() == &history_turn)
        .filter_map(|item| source.item_sequences.get(item.item_id()))
        .copied()
        .max()
        .unwrap();
    original
        .commit_context_overflow_recovery(
            &thread_id,
            &current_turn,
            CommitContextCheckpointRequest {
                referenced_items: source
                    .items
                    .iter()
                    .filter(|item| {
                        source
                            .item_sequences
                            .get(item.item_id())
                            .is_some_and(|sequence| *sequence <= covered_end_sequence)
                    })
                    .map(|item| item.item_id().clone())
                    .collect(),
                source_thread_sequence: source.sequence,
                covered: ash_protocol::ContextSourceRange {
                    start_sequence: 1,
                    end_sequence: covered_end_sequence,
                },
                summary: "overflow checkpoint".into(),
                schema_revision: "context-checkpoint-v1".into(),
                prompt_revision: "compaction-test-v1".into(),
                context_policy_revision: "context-policy-v1".into(),
                generator_model: None,
            },
        )
        .unwrap();

    let recovered = Arc::new(ThreadController::with_store(store));
    let snapshot = recovered.recover_thread(&thread_id).unwrap();
    let model = Arc::new(ScriptedModel::new([Ok(text_response(
        "must not be invoked",
    ))]));
    let executor = TurnExecutor::without_tools(recovered, model.clone());

    assert_eq!(executor.resume_recovered_tool_continuations().unwrap(), 0);
    assert!(model.requests().is_empty());
    assert_eq!(
        snapshot
            .turns
            .iter()
            .find(|turn| turn.turn_id == current_turn)
            .unwrap()
            .status,
        TurnStatus::Interrupted
    );
    assert_eq!(snapshot.context_checkpoints.len(), 1);
    assert_eq!(snapshot.context_overflow_recoveries.len(), 1);
}

#[test]
fn retries_one_empty_response_and_completes_refusal_as_agent_message() {
    let (threads, thread_id, turn_id) = started_turn();
    let model = Arc::new(ScriptedModel::new([
        Ok(ModelResponse {
            output: Vec::new(),
            usage: Some(ModelUsage {
                input_tokens: Some(10),
                output_tokens: Some(1),
                cached_input_tokens: Some(2),
                cache_write_input_tokens: Some(0),
                reasoning_tokens: None,
            }),
            billing: None,
            stop_reason: StopReason::Completed,
        }),
        Ok(ModelResponse {
            output: vec![ResponseItem::Refusal("cannot comply".into())],
            usage: Some(ModelUsage {
                input_tokens: Some(12),
                output_tokens: Some(3),
                cached_input_tokens: None,
                cache_write_input_tokens: None,
                reasoning_tokens: Some(1),
            }),
            billing: None,
            stop_reason: StopReason::Completed,
        }),
    ]));
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone());

    let outcome = executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    assert!(matches!(
        outcome,
        TurnExecutionOutcome::Completed(crate::CompletedTurn {
            item: ThreadItem::AgentMessage { ref text, .. },
            ..
        }) if text == "cannot comply"
    ));
    assert_eq!(model.requests().len(), 2);
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert_eq!(snapshot.usage.model_invocations, 2);
    assert_eq!(snapshot.usage.input_tokens.reported, 22);
    assert!(snapshot.usage.input_tokens.complete);
    assert_eq!(snapshot.usage.output_tokens.reported, 4);
    assert!(snapshot.usage.output_tokens.complete);
    assert_eq!(snapshot.usage.cached_input_tokens.reported, 2);
    assert!(!snapshot.usage.cached_input_tokens.complete);
    assert_eq!(snapshot.usage.reasoning_tokens.reported, 1);
    assert!(!snapshot.usage.reasoning_tokens.complete);
    assert_eq!(snapshot.turns[0].usage, snapshot.usage);
}

#[test]
fn model_usage_and_goal_projection_are_identical_after_recovery() {
    let store = Arc::new(InMemoryThreadStore::default());
    let original = Arc::new(ThreadController::with_store(store.clone()));
    let thread_id = ThreadId::new("usage-recovery-thread").unwrap();
    original
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("usage-recovery-session").unwrap(),
            thread_id: thread_id.clone(),
            title: "usage recovery".into(),
        })
        .unwrap();
    let model_ref = ModelRef::new(
        ProviderId::new("provider").unwrap(),
        ModelId::new("priced-model").unwrap(),
    );
    original
        .create_goal(&thread_id, "finish the task".into(), Some(2))
        .unwrap();
    let turn_id = original
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("usage-recovery-start").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: Some(model_ref.clone()),
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "hello".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    let model = Arc::new(ScriptedModel::new([Ok(ModelResponse {
        output: vec![ResponseItem::Text("answer".into())],
        usage: Some(ModelUsage {
            input_tokens: Some(11),
            output_tokens: Some(2),
            cached_input_tokens: None,
            cache_write_input_tokens: None,
            reasoning_tokens: None,
        }),
        billing: None,
        stop_reason: StopReason::Completed,
    })]));
    TurnExecutor::without_tools(original.clone(), model)
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();
    let before_restart = original.read_thread(&thread_id).unwrap();
    let before_calibration = before_restart
        .context_calibration(&model_ref, crate::context::CONTEXT_ESTIMATOR_REVISION)
        .cloned()
        .expect("selected-model invocation must derive a calibration sample");
    let invocation = store
        .events()
        .into_iter()
        .find_map(|event| match event.event {
            ash_protocol::ThreadEvent::ModelInvocationRecorded { record, .. } => Some(record),
            _ => None,
        })
        .expect("model response must commit an invocation fact");
    assert_eq!(invocation.requested_model, Some(model_ref.clone()));
    assert_eq!(
        invocation
            .usage
            .as_ref()
            .and_then(|usage| usage.input_tokens),
        Some(11)
    );
    assert!(matches!(
        invocation.reference_cost,
        ash_protocol::ModelReferenceCostRecord::Unpriced {
            reason: ash_protocol::ModelReferenceCostReason::MissingBillingContext
        }
    ));

    let recovered = ThreadController::with_store(store);
    let after_restart = recovered.recover_thread(&thread_id).unwrap();

    assert_eq!(after_restart.usage, before_restart.usage);
    assert_eq!(after_restart.usage.model_invocations, 1);
    assert_eq!(after_restart.usage.input_tokens.reported, 11);
    assert!(after_restart.usage.input_tokens.complete);
    assert!(!after_restart.usage.cached_input_tokens.complete);
    assert_eq!(
        after_restart.context_calibration(&model_ref, crate::context::CONTEXT_ESTIMATOR_REVISION),
        Some(&before_calibration)
    );
    assert_eq!(before_calibration.samples(), 1);
    assert_eq!(after_restart.goal, before_restart.goal);
}

#[test]
fn unary_turns_commit_the_final_message_without_incremental_updates() {
    let (threads, thread_id, turn_id) = started_turn();
    let updates = Arc::new(RecordingUpdates::default());
    let model = Arc::new(ScriptedModel::new([Ok(text_response("complete answer"))]));
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone())
        .with_thread_updates(updates.clone());

    let result = executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();

    assert!(
        matches!(result, TurnExecutionOutcome::Completed(crate::CompletedTurn {
        item: ThreadItem::AgentMessage { ref text, .. }, ..
    }) if text == "complete answer")
    );
    assert_eq!(model.requests().len(), 1);
    assert!(
        !updates
            .updates()
            .iter()
            .any(|update| matches!(update.update, ThreadUpdate::ItemDelta { .. }))
    );
    assert!(threads.read_thread(&thread_id).unwrap().items.iter().any(
        |item| matches!(item, ThreadItem::AgentMessage { text, .. } if text == "complete answer")
    ));
}

#[test]
fn streaming_delta_and_final_item_share_one_identity() {
    let (threads, thread_id, turn_id) = started_turn();
    let updates = Arc::new(RecordingUpdates::default());
    let executor = TurnExecutor::without_tools(threads.clone(), Arc::new(ChunkedModel))
        .with_thread_updates(updates.clone());

    executor.start(&thread_id, &turn_id).unwrap();
    wait_for_turn_status(&threads, &thread_id, &turn_id, TurnStatus::Completed);

    let updates = updates.updates();
    let started_item_id = updates.iter().find_map(|update| match &update.update {
        ThreadUpdate::ItemStarted {
            item: ThreadItem::AgentMessage { item_id, .. },
            ..
        } => Some(item_id.clone()),
        _ => None,
    });
    let delta_item_id = updates.iter().find_map(|update| match &update.update {
        ThreadUpdate::ItemDelta { item_id, .. } => Some(item_id.clone()),
        _ => None,
    });
    let snapshot = threads.read_thread(&thread_id).unwrap();
    let completed_item_id = snapshot.items.iter().find_map(|item| match item {
        ThreadItem::AgentMessage { item_id, .. } => Some(item_id.clone()),
        _ => None,
    });

    assert_eq!(started_item_id, delta_item_id);
    assert_eq!(delta_item_id, completed_item_id);
    let text = updates
        .iter()
        .filter_map(|update| match &update.update {
            ThreadUpdate::ItemDelta {
                delta: ash_protocol::ItemDelta::AgentMessage { text },
                ..
            } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert_eq!(text, "hello");
    let cursors = updates
        .iter()
        .filter_map(|update| update.stream_cursor.as_ref())
        .collect::<Vec<_>>();
    assert!(!cursors.is_empty());
    assert!(
        cursors
            .iter()
            .all(|cursor| cursor.stream_instance_id == cursors[0].stream_instance_id)
    );
    assert_eq!(
        cursors
            .iter()
            .map(|cursor| cursor.sequence)
            .collect::<Vec<_>>(),
        (1..=u64::try_from(cursors.len()).unwrap()).collect::<Vec<_>>()
    );
}

#[test]
fn streaming_hidden_markup_is_filtered_across_chunk_boundaries() {
    let (threads, thread_id, turn_id) = started_turn();
    let updates = Arc::new(RecordingUpdates::default());
    let executor = TurnExecutor::without_tools(threads.clone(), Arc::new(HiddenMarkupChunkedModel))
        .with_thread_updates(updates.clone());

    executor.start(&thread_id, &turn_id).unwrap();
    wait_for_turn_status(&threads, &thread_id, &turn_id, TurnStatus::Completed);

    let streamed_text = updates
        .updates()
        .into_iter()
        .filter_map(|update| match update.update {
            ThreadUpdate::ItemDelta {
                delta: ash_protocol::ItemDelta::AgentMessage { text },
                ..
            } => Some(text),
            _ => None,
        })
        .collect::<String>();
    let snapshot = threads.read_thread(&thread_id).unwrap();
    let final_text = snapshot.items.iter().find_map(|item| match item {
        ThreadItem::AgentMessage { text, .. } => Some(text.as_str()),
        _ => None,
    });

    assert_eq!(streamed_text, "hello<");
    assert_eq!(final_text, Some("hello<"));
    assert!(!streamed_text.contains("oai-mem-citation"));
    assert!(!streamed_text.contains("private-source"));
}

#[test]
fn per_thread_mailboxes_run_independently_and_interrupt_the_active_turn() {
    let (threads, slow_thread_id, slow_turn_id) = started_turn();
    let fast_thread_id = ThreadId::new("fast-thread").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("session").unwrap(),
            thread_id: fast_thread_id.clone(),
            title: "fast".into(),
        })
        .unwrap();
    let fast_turn_id = threads
        .start_turn(
            &fast_thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("fast-start").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "fast".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    let model = Arc::new(BlockingFirstModel::default());
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone());

    executor.start(&slow_thread_id, &slow_turn_id).unwrap();
    model.wait_until_slow_invocation_enters();
    executor.start(&fast_thread_id, &fast_turn_id).unwrap();
    wait_for_turn_status(
        &threads,
        &fast_thread_id,
        &fast_turn_id,
        TurnStatus::Completed,
    );

    threads
        .interrupt_turn(
            &slow_thread_id,
            crate::InterruptTurnRequest {
                command_id: CommandId::new("slow-interrupt").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                turn_id: slow_turn_id.clone(),
            },
        )
        .unwrap();
    wait_for_turn_status(
        &threads,
        &slow_thread_id,
        &slow_turn_id,
        TurnStatus::Interrupted,
    );

    wait_for_flag(&model.slow_was_cancelled, "slow model was not cancelled");
}

#[test]
fn interrupt_propagates_to_the_active_tool_call() {
    let (threads, thread_id, turn_id) = started_turn();
    let call = ToolCall {
        id: ToolCallId::new("blocking_call").unwrap(),
        name: ToolName::new("blocking").unwrap(),
        arguments: json!({}),
    };
    let model = Arc::new(ScriptedModel::new([Ok(ModelResponse {
        output: vec![ResponseItem::ToolCall(call)],
        usage: None,
        billing: None,
        stop_reason: StopReason::ToolUse,
    })]));
    let tool = Arc::new(BlockingTool::default());
    let executor = TurnExecutor::new(
        threads.clone(),
        model,
        tool.clone(),
        Arc::new(SandboxActionPolicyService),
    );

    executor.start(&thread_id, &turn_id).unwrap();
    tool.wait_until_entered();
    threads
        .interrupt_turn(
            &thread_id,
            crate::InterruptTurnRequest {
                command_id: CommandId::new("tool-interrupt").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                turn_id: turn_id.clone(),
            },
        )
        .unwrap();

    wait_for_turn_status(&threads, &thread_id, &turn_id, TurnStatus::Interrupted);
    wait_for_flag(
        &tool.was_cancelled,
        "active tool did not observe cancellation",
    );
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert!(
        snapshot
            .started_tool_calls
            .contains(&ToolCallId::new("blocking_call").unwrap())
    );
    assert!(!snapshot.items.iter().any(
        |item| matches!(item, ThreadItem::ToolResult { tool_call_id, .. } if tool_call_id.as_str() == "blocking_call")
    ));
}

#[test]
fn running_tool_user_input_is_durable_and_resumes_the_same_execution() {
    let (threads, thread_id, turn_id) = started_turn();
    let call = ToolCall {
        id: ToolCallId::new("interactive_call").unwrap(),
        name: ToolName::new("interactive").unwrap(),
        arguments: json!({}),
    };
    let model = Arc::new(ScriptedModel::new([
        Ok(ModelResponse {
            output: vec![ResponseItem::ToolCall(call)],
            usage: None,
            billing: None,
            stop_reason: StopReason::ToolUse,
        }),
        Ok(text_response("done")),
    ]));
    let executor = TurnExecutor::new(
        threads.clone(),
        model,
        Arc::new(InteractiveTool),
        Arc::new(SandboxActionPolicyService),
    );

    executor.start(&thread_id, &turn_id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    let pending = loop {
        let snapshot = threads.read_thread(&thread_id).unwrap();
        if let Some(interaction) = snapshot.turns[0].pending_interaction.clone() {
            break (snapshot.sequence, interaction);
        }
        assert!(
            Instant::now() < deadline,
            "interactive tool did not request input"
        );
        thread::sleep(Duration::from_millis(2));
    };
    assert!(matches!(
        pending.1.request,
        ash_protocol::AgentRequest::UserInput { .. }
    ));
    let resolved = threads
        .resolve_turn_interaction(
            &thread_id,
            crate::ResolveTurnInteractionRequest {
                command_id: CommandId::new("resolve-interactive").unwrap(),
                expected_sequence: SequenceExpectation::Exact(pending.0),
                turn_id: turn_id.clone(),
                request_id: pending.1.request_id,
                response: AgentResponse::UserInput {
                    response: RequestUserInputResponse {
                        answers: BTreeMap::from([(
                            "city".into(),
                            UserInputAnswer {
                                value: "Paris".into(),
                            },
                        )]),
                    },
                },
            },
        )
        .unwrap();
    assert!(resolved.live_execution_woken);

    wait_for_turn_status(&threads, &thread_id, &turn_id, TurnStatus::Completed);
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert!(snapshot.items.iter().any(|item| matches!(
        item,
        ThreadItem::ToolResult { text, is_error: false, .. } if text == "Paris"
    )));
}

struct ScriptedModel {
    responses: Mutex<VecDeque<Result<ModelResponse, CoreError>>>,
    requests: Mutex<Vec<ModelRequest>>,
    reasoning: Option<ReasoningConfig>,
}

#[test]
fn abandoned_network_request_cancels_approval_without_restarting_the_tool() {
    let (threads, thread_id, turn_id) = started_turn();
    let request_lifetime = CancellationSource::new();
    let tools = Arc::new(NetworkApprovalTool {
        request_lifetime: request_lifetime.clone(),
        executions: AtomicUsize::new(0),
    });
    let model = Arc::new(ScriptedModel::new([
        Ok(ModelResponse {
            output: vec![ResponseItem::ToolCall(ToolCall {
                id: ToolCallId::new("network-call").unwrap(),
                name: ToolName::new("network-tool").unwrap(),
                arguments: json!({}),
            })],
            usage: None,
            billing: None,
            stop_reason: StopReason::ToolUse,
        }),
        Ok(text_response("done")),
    ]));
    let executor = TurnExecutor::new(
        threads.clone(),
        model,
        tools.clone(),
        Arc::new(NetworkPromptPolicy),
    );
    executor.start(&thread_id, &turn_id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = threads.read_thread(&thread_id).unwrap();
        if matches!(
            snapshot.turns[0]
                .pending_interaction
                .as_ref()
                .map(|pending| &pending.request),
            Some(ash_protocol::AgentRequest::Approval { .. })
        ) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "network request did not ask for approval: {snapshot:#?}"
        );
        thread::sleep(Duration::from_millis(2));
    }
    request_lifetime.cancel();
    wait_for_turn_status(&threads, &thread_id, &turn_id, TurnStatus::Completed);
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert!(snapshot.turns[0].pending_interaction.is_none());
    assert_eq!(tools.executions.load(Ordering::Relaxed), 1);
    assert!(
        threads
            .thread_updates_after(&thread_id, 0)
            .unwrap()
            .iter()
            .any(|update| matches!(
                &update.update,
                ThreadUpdate::Committed {
                    event: ash_protocol::ThreadEvent::InteractionCancelled {
                        reason: ash_protocol::InteractionCancelReason::OwnerDisconnected,
                        ..
                    },
                    ..
                }
            ))
    );
}

struct NetworkPromptPolicy;

impl ActionPolicyService for NetworkPromptPolicy {
    fn revision(&self) -> String {
        "test-policy-v1".into()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        if request.action().kind() == &ActionKind::NetworkRequest {
            Ok(ExecutionDecision::AskUser(
                ash_action_policy::ApprovalRequest::new(
                    request.action().digest().clone(),
                    request.action().required_capabilities().clone(),
                    "approve this destination",
                ),
            ))
        } else {
            Ok(ExecutionDecision::RunSandboxed(SandboxPolicy::new(
                FileSystemAccess::ReadOnly,
                NetworkAccess::Managed,
            )))
        }
    }
}

struct NetworkApprovalTool {
    request_lifetime: CancellationSource,
    executions: AtomicUsize,
}

impl ToolService for NetworkApprovalTool {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![tool_definition("network-tool")]
    }

    fn prepare(&self, _: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(b"network-parent"),
                ActionKind::LocalProcess(ash_action_policy::ProcessInvocationKind::Direct),
                "run a network command",
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "network-tool"),
            SandboxCompatibility::Supported(SandboxPolicy::new(
                FileSystemAccess::ReadOnly,
                NetworkAccess::Managed,
            )),
            ActionPolicyRevision::new("test-policy-v1"),
        ))
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        panic!("network tool requires its live interaction context")
    }

    fn execute_streaming_with_facts_and_interactions(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
        _: &ToolExecutionFacts,
        interactions: Arc<dyn ToolInteractionService>,
        _: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.executions.fetch_add(1, Ordering::Relaxed);
        let review = ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(b"network-request"),
                ActionKind::NetworkRequest,
                "connect to example.com:443",
                CapabilitySet::new([Capability::new(
                    CapabilityKind::Network,
                    "https://example.com:443",
                )]),
            )
            .with_network_target("https", "example.com", Some(443)),
            ActionProvenance::new(ActionSource::BuiltInTool, "network-tool"),
            SandboxCompatibility::NotApplicable {
                reason: "the proxy controls the network request".into(),
            },
            ActionPolicyRevision::new("test-policy-v1"),
        );
        assert!(
            interactions
                .approve_network(&review, &self.request_lifetime.token())
                .is_err()
        );
        Ok(ToolExecutionOutput::Failure(
            "network request abandoned".into(),
        ))
    }
}

#[derive(Default)]
struct BatchedCompactionModel {
    requests: Mutex<Vec<ModelRequest>>,
}

impl ModelService for BatchedCompactionModel {
    fn context_budget(&self, _: ModelSelection<'_>) -> Result<ContextBudget, CoreError> {
        Ok(ContextBudget::core_managed(
            ContextTokenCount::new(2_400),
            ContextTokenCount::new(200),
            ContextTokenCount::new(100),
            ContextCompactionLimit::ContextWindow,
        ))
    }

    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.requests.lock().unwrap().push(request.clone());
        let mut response = text_response("batch checkpoint");
        response.usage = Some(ModelUsage {
            input_tokens: Some(100),
            output_tokens: Some(8),
            cached_input_tokens: None,
            cache_write_input_tokens: None,
            reasoning_tokens: None,
        });
        Ok(response)
    }
}

struct CancellingResponseModel {
    cancellation: CancellationSource,
}

impl ModelService for CancellingResponseModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.cancellation.cancel();
        Ok(ModelResponse {
            output: vec![ResponseItem::Text("discarded after cancellation".into())],
            usage: Some(ModelUsage {
                input_tokens: Some(9),
                output_tokens: Some(2),
                cached_input_tokens: None,
                cache_write_input_tokens: None,
                reasoning_tokens: None,
            }),
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }

    fn stream(
        &self,
        selection: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        _: &mut dyn ModelStreamSink,
    ) -> Result<ModelResponse, CoreError> {
        self.invoke(selection, request, cancellation)
    }
}

struct SteeringModel {
    threads: Arc<ThreadController>,
    thread_id: ThreadId,
    turn_id: ash_protocol::TurnId,
    requests: Mutex<Vec<ModelRequest>>,
}

impl ModelService for SteeringModel {
    fn stream(
        &self,
        selection: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn ModelStreamSink,
    ) -> Result<ModelResponse, CoreError> {
        let first = self.requests.lock().unwrap().is_empty();
        sink.emit(if first {
            ModelStreamEvent::ReasoningDelta("stale reasoning".into())
        } else {
            ModelStreamEvent::TextDelta("steered answer".into())
        })?;
        self.invoke(selection, request, cancellation)
    }

    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let invocation = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request.clone());
            requests.len()
        };
        if invocation == 1 {
            let sequence = self.threads.read_thread(&self.thread_id)?.sequence;
            self.threads.steer_turn(
                &self.thread_id,
                SteerTurnRequest {
                    command_id: CommandId::new("steer-during-model").unwrap(),
                    expected_sequence: SequenceExpectation::Exact(sequence),
                    turn_id: self.turn_id.clone(),
                    input: vec![UserInput::Text {
                        text: "steer toward tests".into(),
                    }],
                },
            )?;
            Ok(ModelResponse {
                output: vec![
                    ResponseItem::Reasoning("stale reasoning".into()),
                    ResponseItem::ToolCall(ToolCall {
                        id: ToolCallId::new("stale-call").unwrap(),
                        name: ToolName::new("stale-tool").unwrap(),
                        arguments: json!({}),
                    }),
                ],
                usage: None,
                billing: None,
                stop_reason: StopReason::ToolUse,
            })
        } else {
            Ok(text_response("steered answer"))
        }
    }
}

struct CheckpointObservingModel {
    threads: Arc<ThreadController>,
    thread_id: ThreadId,
    turn_id: TurnId,
    second_response: Mutex<Option<Result<ModelResponse, CoreError>>>,
    requests: Mutex<Vec<ModelRequest>>,
}

impl CheckpointObservingModel {
    fn new(
        threads: Arc<ThreadController>,
        thread_id: ThreadId,
        turn_id: TurnId,
        second_response: Result<ModelResponse, CoreError>,
    ) -> Self {
        Self {
            threads,
            thread_id,
            turn_id,
            second_response: Mutex::new(Some(second_response)),
            requests: Mutex::new(Vec::new()),
        }
    }

    fn requests(&self) -> Vec<ModelRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl ModelService for CheckpointObservingModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let invocation = {
            let mut requests = self.requests.lock().unwrap();
            let invocation = requests.len();
            requests.push(request.clone());
            invocation
        };
        if invocation == 0 {
            return Err(CoreError::ModelContextOverflow);
        }
        assert_eq!(invocation, 1, "overflow recovery may retry only once");
        let snapshot = self.threads.read_thread(&self.thread_id).unwrap();
        let checkpoint_id = snapshot
            .context_overflow_recoveries
            .get(&self.turn_id)
            .expect("recovery marker must be durable before the retry");
        assert_eq!(
            Some(checkpoint_id),
            snapshot
                .context_checkpoints
                .last()
                .map(|checkpoint| &checkpoint.checkpoint_id)
        );
        assert!(request_contains(request, "overflow checkpoint"));
        self.second_response
            .lock()
            .unwrap()
            .take()
            .expect("second response is configured")
    }
}

#[derive(Default)]
struct FixedOverflowCompaction {
    calls: AtomicUsize,
}

impl ContextCompactionService for FixedOverflowCompaction {
    fn compact(
        &self,
        request: &ContextCompactionRequest,
        _: &CancellationToken,
        _: &mut dyn FnMut(Option<ModelUsage>) -> Result<(), CoreError>,
    ) -> Result<crate::ContextCompactionResult, CoreError> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        assert!(!request.source_items().is_empty());
        Ok(crate::ContextCompactionResult::new(
            "overflow checkpoint",
            "context-checkpoint-v1",
            "compaction-test-v1",
            "context-policy-v1",
        ))
    }
}

#[derive(Default)]
struct BlockingOverflowCompaction {
    entered: AtomicBool,
    was_cancelled: AtomicBool,
    entered_lock: Mutex<()>,
    entered_changed: Condvar,
}

impl BlockingOverflowCompaction {
    fn wait_until_entered(&self) {
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut lock = self.entered_lock.lock().unwrap();
        while !self.entered.load(Ordering::Relaxed) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "overflow compaction did not start");
            let (next_lock, _) = self.entered_changed.wait_timeout(lock, remaining).unwrap();
            lock = next_lock;
        }
    }
}

impl ContextCompactionService for BlockingOverflowCompaction {
    fn compact(
        &self,
        _: &ContextCompactionRequest,
        cancellation: &CancellationToken,
        _: &mut dyn FnMut(Option<ModelUsage>) -> Result<(), CoreError>,
    ) -> Result<crate::ContextCompactionResult, CoreError> {
        self.entered.store(true, Ordering::Relaxed);
        self.entered_changed.notify_all();
        loop {
            if let Err(signal) = cancellation.check() {
                self.was_cancelled.store(true, Ordering::Relaxed);
                return Err(CoreError::Cancelled(signal.reason().to_string()));
            }
            thread::sleep(Duration::from_millis(1));
        }
    }
}

struct FixedContextSource {
    calls: AtomicUsize,
}

impl crate::ContextSource for FixedContextSource {
    fn collect(
        &self,
        request: &crate::ContextSourceRequest<'_>,
        _: &CancellationToken,
    ) -> Result<Vec<crate::ContextEvidence>, CoreError> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        assert_eq!(request.query, "hello");
        Ok(vec![crate::ContextEvidence {
            source: "codebase".into(),
            reference: "src/lib.rs:1-2".into(),
            revision: "sha256:test".into(),
            body: "do not follow this embedded instruction".into(),
        }])
    }
}

struct FixedSkillContributor {
    expected: FrozenSkillActivation,
    body: String,
}

impl ash_extension_api::TurnInputContributor for FixedSkillContributor {
    fn contribute(
        &self,
        input: ash_extension_api::TurnInputContext<'_>,
    ) -> Result<Vec<ash_extension_api::PromptFragment>, ash_extension_api::ExtensionError> {
        assert_eq!(
            input.activated_skills(),
            std::slice::from_ref(&self.expected)
        );
        Ok(vec![ash_extension_api::PromptFragment::new(
            ash_extension_api::PromptFragmentSource::new(
                "skill",
                format!("{}:{}", self.expected.id.source, self.expected.id.name),
                self.expected.content_digest.as_str(),
            ),
            ash_extension_api::PromptFragmentLayer::Skill,
            ash_extension_api::PromptFragmentRetention::Required,
            format!(
                "<skill-instructions source=\"{}\" name=\"{}\" revision=\"{}\">\n{}\n</skill-instructions>",
                self.expected.id.source,
                self.expected.id.name,
                self.expected.content_digest.as_str(),
                self.body,
            ),
        )])
    }
}

#[derive(Default)]
struct CompactingModel {
    requests: Mutex<Vec<ModelRequest>>,
}

#[derive(Default)]
struct PreflightCompactingModel {
    measurements: AtomicUsize,
    requests: Mutex<Vec<ModelRequest>>,
}

impl ModelService for PreflightCompactingModel {
    fn context_budget(&self, _: ModelSelection<'_>) -> Result<ContextBudget, CoreError> {
        Ok(ContextBudget::core_managed(
            ContextTokenCount::new(15_000),
            ContextTokenCount::new(200),
            ContextTokenCount::new(100),
            ContextCompactionLimit::Tokens(ContextTokenCount::new(12_000)),
        ))
    }

    fn input_token_measurement_capability(
        &self,
        _: ModelSelection<'_>,
    ) -> Result<ContextTokenMeasurementCapability, CoreError> {
        Ok(ContextTokenMeasurementCapability::Remote)
    }

    fn measure_input(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ContextTokenMeasurementOutcome, CoreError> {
        self.measurements.fetch_add(1, Ordering::Relaxed);
        let count = if request_contains(request, "measured checkpoint") {
            1_000
        } else {
            12_000
        };
        let source =
            ContextTokenMeasurementSource::provider_preflight("test-provider-count-v1").unwrap();
        Ok(ContextTokenMeasurementOutcome::Measured(
            ContextTokenMeasurement::exact(ContextTokenCount::new(count), source),
        ))
    }

    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.requests.lock().unwrap().push(request.clone());
        if request
            .instructions
            .as_deref()
            .is_some_and(|body| body.contains("durable context checkpoint"))
        {
            Ok(text_response("measured checkpoint"))
        } else {
            Ok(text_response("done"))
        }
    }
}

impl ModelService for CompactingModel {
    fn context_budget(&self, _: ModelSelection<'_>) -> Result<ContextBudget, CoreError> {
        Ok(ContextBudget::core_managed(
            ContextTokenCount::new(2_100),
            ContextTokenCount::new(200),
            ContextTokenCount::new(100),
            ContextCompactionLimit::ContextWindow,
        ))
    }

    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.requests.lock().unwrap().push(request.clone());
        let is_compaction = request
            .instructions
            .as_deref()
            .is_some_and(|body| body.contains("durable context checkpoint"));
        let mut response = if is_compaction {
            text_response("bounded checkpoint")
        } else {
            text_response("done")
        };
        response.usage = Some(ModelUsage {
            input_tokens: Some(if is_compaction { 100 } else { 50 }),
            output_tokens: Some(if is_compaction { 10 } else { 5 }),
            cached_input_tokens: None,
            cache_write_input_tokens: None,
            reasoning_tokens: None,
        });
        Ok(response)
    }
}

struct LongRunningToolModel {
    tool_rounds: usize,
    invocations: AtomicUsize,
}

struct MutableInstructions {
    current: Mutex<Arc<HarnessContext>>,
    requests: Mutex<Vec<(String, String, String)>>,
    read_paths: Mutex<Vec<Vec<PathBuf>>>,
}

impl MutableInstructions {
    fn new(content: &str) -> Self {
        Self {
            current: Mutex::new(Arc::new(test_harness_context(content, "first environment"))),
            requests: Mutex::new(Vec::new()),
            read_paths: Mutex::new(Vec::new()),
        }
    }

    fn replace(&self, content: &str) {
        *self.current.lock().unwrap() =
            Arc::new(test_harness_context(content, "second environment"));
    }

    fn request_identities(&self) -> Vec<(String, String, String)> {
        self.requests.lock().unwrap().clone()
    }
}

impl HarnessContextProvider for MutableInstructions {
    fn snapshot(
        &self,
        request: &crate::HarnessContextRequest<'_>,
    ) -> Result<Arc<HarnessContext>, CoreError> {
        self.requests.lock().unwrap().push((
            request.session_id.to_string(),
            request.thread_id.to_string(),
            request.turn_id.to_string(),
        ));
        self.read_paths
            .lock()
            .unwrap()
            .push(request.read_paths.to_vec());
        Ok(Arc::clone(&self.current.lock().unwrap()))
    }
}

fn test_harness_context(content: &str, environment_marker: &str) -> HarnessContext {
    let primary_root = std::env::current_dir().unwrap().join("dir");
    let environment = AgentEnvironmentSnapshot::new(
        HostEnvironment::new(
            primary_root.clone(),
            "test".into(),
            environment_marker.into(),
            "/bin/sh".into(),
        )
        .unwrap(),
        RepositoryEnvironment::NotDetected,
        Dirs::new([primary_root]).unwrap(),
    );
    HarnessContext::new(HarnessInstructions::new("system", Some(content.into())))
        .with_environment(environment)
}

struct InstructionRefreshingModel {
    instructions: Arc<MutableInstructions>,
    requests: Mutex<Vec<ModelRequest>>,
}

impl ModelService for InstructionRefreshingModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(request.clone());
        if requests.len() == 1 {
            self.instructions.replace("second instructions");
            return Ok(ModelResponse {
                output: vec![ResponseItem::ToolCall(ToolCall {
                    id: ToolCallId::new("refresh_instructions").unwrap(),
                    name: ToolName::new("read_file").unwrap(),
                    arguments: json!({"path": "src/lib.rs"}),
                })],
                usage: None,
                billing: None,
                stop_reason: StopReason::ToolUse,
            });
        }
        Ok(text_response("done"))
    }
}

impl LongRunningToolModel {
    fn new(tool_rounds: usize) -> Self {
        Self {
            tool_rounds,
            invocations: AtomicUsize::new(0),
        }
    }

    fn invocations(&self) -> usize {
        self.invocations.load(Ordering::Relaxed)
    }
}

impl ModelService for LongRunningToolModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let invocation = self.invocations.fetch_add(1, Ordering::Relaxed);
        if invocation == self.tool_rounds {
            return Ok(text_response("done"));
        }
        Ok(ModelResponse {
            output: vec![ResponseItem::ToolCall(ToolCall {
                id: ToolCallId::new(format!("call_{invocation}")).unwrap(),
                name: ToolName::new("weather").unwrap(),
                arguments: json!({"city": "Paris"}),
            })],
            usage: None,
            billing: None,
            stop_reason: StopReason::ToolUse,
        })
    }
}

#[derive(Default)]
struct RecordingUpdates(Mutex<Vec<ThreadUpdateEnvelope>>);

impl RecordingUpdates {
    fn updates(&self) -> Vec<ThreadUpdateEnvelope> {
        self.0.lock().unwrap().clone()
    }
}

impl ThreadUpdateSink for RecordingUpdates {
    fn publish(&self, update: ThreadUpdateEnvelope) {
        self.0.lock().unwrap().push(update);
    }
}

struct ChunkedModel;

impl ModelService for ChunkedModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        unreachable!("stream is overridden")
    }

    fn stream(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
        sink: &mut dyn ModelStreamSink,
    ) -> Result<ModelResponse, CoreError> {
        sink.emit(ModelStreamEvent::TextDelta("hel".into()))?;
        sink.emit(ModelStreamEvent::TextDelta("lo".into()))?;
        Ok(text_response("hello"))
    }
}

struct HiddenMarkupChunkedModel;

impl ModelService for HiddenMarkupChunkedModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        unreachable!("stream is overridden")
    }

    fn stream(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
        sink: &mut dyn ModelStreamSink,
    ) -> Result<ModelResponse, CoreError> {
        sink.emit(ModelStreamEvent::TextDelta("hel<oai-mem-".into()))?;
        sink.emit(ModelStreamEvent::TextDelta(
            "citation>private-source</oai-mem-cit".into(),
        ))?;
        sink.emit(ModelStreamEvent::TextDelta("ation>lo<".into()))?;
        Ok(text_response(
            "hel<oai-mem-citation>private-source</oai-mem-citation>lo<",
        ))
    }
}

#[derive(Default)]
struct BlockingFirstModel {
    slow_has_entered: AtomicBool,
    slow_was_cancelled: AtomicBool,
    entered_lock: Mutex<()>,
    entered: Condvar,
}

impl BlockingFirstModel {
    fn wait_until_slow_invocation_enters(&self) {
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut lock = self.entered_lock.lock().unwrap();
        while !self.slow_has_entered.load(Ordering::Relaxed) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "slow model invocation did not start");
            let (next_lock, _) = self.entered.wait_timeout(lock, remaining).unwrap();
            lock = next_lock;
        }
    }
}

impl ModelService for BlockingFirstModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        unreachable!("stream is overridden")
    }

    fn stream(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn ModelStreamSink,
    ) -> Result<ModelResponse, CoreError> {
        let prompt = request
            .input
            .iter()
            .find_map(|input| match input {
                InputItem::Message(message) => {
                    message.content.iter().find_map(|content| match content {
                        ContentPart::Text(text) => Some(text.as_str()),
                        ContentPart::ImageAttachment { .. } => None,
                        ContentPart::ImageUrl { .. } => None,
                    })
                }
                InputItem::ToolResult(_) => None,
            })
            .unwrap_or_default();
        if prompt == "fast" {
            sink.emit(ModelStreamEvent::TextDelta("fast result".into()))?;
            return Ok(text_response("fast result"));
        }
        sink.emit(ModelStreamEvent::TextDelta("partial".into()))?;
        self.slow_has_entered.store(true, Ordering::Relaxed);
        self.entered.notify_all();
        while !cancellation.is_cancelled() {
            thread::sleep(Duration::from_millis(1));
        }
        self.slow_was_cancelled.store(true, Ordering::Relaxed);
        Err(CoreError::Cancelled("cancelled during stream".into()))
    }
}

impl ScriptedModel {
    fn new(responses: impl IntoIterator<Item = Result<ModelResponse, CoreError>>) -> Self {
        Self {
            responses: Mutex::new(responses.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
            reasoning: None,
        }
    }

    fn with_reasoning(mut self, reasoning: ReasoningConfig) -> Self {
        self.reasoning = Some(reasoning);
        self
    }

    fn requests(&self) -> Vec<ModelRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl ModelService for ScriptedModel {
    fn reasoning_config(
        &self,
        _: ModelSelection<'_>,
    ) -> Result<Option<ReasoningConfig>, CoreError> {
        Ok(self.reasoning.clone())
    }

    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.requests.lock().unwrap().push(request.clone());
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("script contains a response")
    }
}

struct WeatherTool;

struct ReadInstructionTargetTool;

struct FailingWeatherTool;

struct DeferredWeatherTools;

struct MutableDefinitionsTool {
    description: Mutex<String>,
}

impl ToolService for MutableDefinitionsTool {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: ToolName::new("weather").unwrap(),
            description: self.description.lock().unwrap().clone(),
            parameters: json!({"type": "object"}),
            strict: true,
        }]
    }

    fn prepare(&self, _: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Err(CoreError::Execution("not used".into()))
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Err(CoreError::Execution("not used".into()))
    }
}

impl ToolService for DeferredWeatherTools {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![tool_definition("tool_search"), tool_definition("weather")]
    }

    fn model_definitions(
        &self,
        activated: &std::collections::BTreeSet<ToolName>,
    ) -> Result<Vec<ToolDefinition>, CoreError> {
        let mut definitions = vec![tool_definition("tool_search")];
        if activated.contains(&ToolName::new("weather").unwrap()) {
            definitions.push(tool_definition("weather"));
        }
        Ok(definitions)
    }

    fn activated_tool_names(
        &self,
        call: &ToolCall,
        result: &str,
    ) -> Result<Vec<ToolName>, CoreError> {
        if call.name.as_str() == "tool_search" && result == "weather loaded" {
            Ok(vec![ToolName::new("weather").unwrap()])
        } else {
            Ok(Vec::new())
        }
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(serde_json::to_vec(call).unwrap()),
                ActionKind::LocalProcess(ash_action_policy::ProcessInvocationKind::Direct),
                "search tools",
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "tool-search"),
            SandboxCompatibility::Supported(SandboxPolicy::new(
                FileSystemAccess::ReadOnly,
                NetworkAccess::Denied,
            )),
            ActionPolicyRevision::new("test-policy"),
        ))
    }

    fn execute(
        &self,
        call: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        assert_eq!(call.name.as_str(), "tool_search");
        Ok(ToolExecutionOutput::Success("weather loaded".into()))
    }
}

fn tool_definition(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: ToolName::new(name).unwrap(),
        description: name.into(),
        parameters: json!({"type": "object"}),
        strict: true,
    }
}

#[derive(Default)]
struct BlockingTool {
    entered: AtomicBool,
    was_cancelled: AtomicBool,
    entered_lock: Mutex<()>,
    entered_changed: Condvar,
}

struct InteractiveTool;

impl ToolService for InteractiveTool {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![tool_definition("interactive")]
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(serde_json::to_vec(call).unwrap()),
                ActionKind::SystemOperation,
                "request user input",
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "interactive"),
            SandboxCompatibility::Supported(SandboxPolicy::new(
                FileSystemAccess::ReadOnly,
                NetworkAccess::Denied,
            )),
            ActionPolicyRevision::new("test-policy"),
        ))
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Err(CoreError::Execution(
            "interactive execution context is required".into(),
        ))
    }

    fn execute_streaming_with_facts_and_interactions(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
        _: &ToolExecutionFacts,
        interactions: Arc<dyn ToolInteractionService>,
        _: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let outcome = interactions.request_user_input(RequestUserInput {
            questions: vec![UserInputQuestion {
                id: "city".into(),
                header: "City".into(),
                question: "Which city?".into(),
                options: Vec::new(),
                allow_free_form: true,
            }],
        })?;
        match outcome {
            ToolUserInputOutcome::Answered(response) => Ok(ToolExecutionOutput::Success(
                response.answers["city"].value.clone(),
            )),
            ToolUserInputOutcome::Cancelled(reason) => Ok(ToolExecutionOutput::Failure(format!(
                "interaction cancelled: {reason:?}"
            ))),
        }
    }
}

impl BlockingTool {
    fn wait_until_entered(&self) {
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut lock = self.entered_lock.lock().unwrap();
        while !self.entered.load(Ordering::Relaxed) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "blocking tool did not start");
            let (next_lock, _) = self.entered_changed.wait_timeout(lock, remaining).unwrap();
            lock = next_lock;
        }
    }
}

impl ToolService for BlockingTool {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: ToolName::new("blocking").unwrap(),
            description: "Wait for cancellation".into(),
            parameters: json!({"type": "object"}),
            strict: true,
        }]
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(serde_json::to_vec(call).unwrap()),
                ActionKind::LocalProcess(ash_action_policy::ProcessInvocationKind::Direct),
                "wait for cancellation",
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "blocking"),
            SandboxCompatibility::Supported(SandboxPolicy::new(
                FileSystemAccess::ReadOnly,
                NetworkAccess::Denied,
            )),
            ActionPolicyRevision::new("test-policy"),
        ))
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.entered.store(true, Ordering::Relaxed);
        self.entered_changed.notify_all();
        while !cancellation.is_cancelled() {
            thread::sleep(Duration::from_millis(1));
        }
        self.was_cancelled.store(true, Ordering::Relaxed);
        Err(CoreError::Cancelled(
            "cancelled during tool execution".into(),
        ))
    }
}

impl ToolService for WeatherTool {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: ToolName::new("weather").unwrap(),
            description: "Get weather".into(),
            parameters: json!({"type": "object"}),
            strict: true,
        }]
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        let capabilities =
            CapabilitySet::new([Capability::new(CapabilityKind::Network, "weather.example")]);
        let sandbox = SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Allowed);
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(serde_json::to_vec(call).unwrap()),
                ActionKind::NetworkRequest,
                "read weather",
                capabilities,
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "weather"),
            SandboxCompatibility::Supported(sandbox),
            ActionPolicyRevision::new("test-policy"),
        ))
    }

    fn execute(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        assert!(matches!(authorization, ToolAuthorization::Sandboxed(_)));
        assert_eq!(call.arguments["city"], "Paris");
        Ok(ToolExecutionOutput::Success("sunny".into()))
    }
}

impl ToolService for ReadInstructionTargetTool {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: ToolName::new("read_file").unwrap(),
            description: "Read a file for instruction matching".into(),
            parameters: json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
            strict: true,
        }]
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(serde_json::to_vec(call).unwrap()),
                ActionKind::NetworkRequest,
                "read a test file",
                CapabilitySet::new([Capability::new(CapabilityKind::Network, "weather.example")]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "read_file"),
            SandboxCompatibility::Supported(SandboxPolicy::new(
                FileSystemAccess::ReadOnly,
                NetworkAccess::Allowed,
            )),
            ActionPolicyRevision::new("test-policy"),
        ))
    }

    fn execute(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        assert!(matches!(authorization, ToolAuthorization::Sandboxed(_)));
        assert_eq!(call.arguments["path"], "src/lib.rs");
        Ok(ToolExecutionOutput::Success("source".into()))
    }
}

impl ToolService for FailingWeatherTool {
    fn definitions(&self) -> Vec<ToolDefinition> {
        WeatherTool.definitions()
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        WeatherTool.prepare(call)
    }

    fn execute(
        &self,
        _: &ToolCall,
        authorization: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        assert!(matches!(authorization, ToolAuthorization::Sandboxed(_)));
        Ok(ToolExecutionOutput::Failure("weather unavailable".into()))
    }
}

struct SandboxActionPolicyService;

impl ActionPolicyService for SandboxActionPolicyService {
    fn revision(&self) -> String {
        "test-policy-v1".into()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        let SandboxCompatibility::Supported(policy) = request.sandbox() else {
            return Err(CoreError::Policy("test action has no sandbox".into()));
        };
        Ok(ExecutionDecision::RunSandboxed(*policy))
    }
}

#[cfg(feature = "code-mode")]
struct CodeModeControlPolicy;

#[cfg(feature = "code-mode")]
impl ActionPolicyService for CodeModeControlPolicy {
    fn revision(&self) -> String {
        "test-policy-v1".into()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        match request.sandbox() {
            SandboxCompatibility::Supported(policy) => Ok(ExecutionDecision::RunSandboxed(*policy)),
            SandboxCompatibility::NotApplicable { .. } => Ok(ExecutionDecision::RunUnsandboxed {
                grant_id: ash_action_policy::GrantId::new("code-mode-test-grant"),
            }),
            SandboxCompatibility::Unsupported { reason } => Err(CoreError::Policy(reason.clone())),
        }
    }
}

fn started_turn() -> (Arc<ThreadController>, ThreadId, TurnId) {
    started_turn_with_tool_mode(ash_protocol::ToolMode::Direct)
}

fn started_turn_with_tool_mode(
    tool_mode: ash_protocol::ToolMode,
) -> (Arc<ThreadController>, ThreadId, TurnId) {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let thread_id = ThreadId::new("thread").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("session").unwrap(),
            thread_id: thread_id.clone(),
            title: "test".into(),
        })
        .unwrap();
    let turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("start").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "hello".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    (threads, thread_id, turn_id)
}

fn started_turn_with_history() -> (Arc<ThreadController>, ThreadId, TurnId) {
    let (threads, thread_id, history_turn_id) = started_turn();
    threads
        .complete_turn(&thread_id, &history_turn_id, "durable history ".repeat(400))
        .unwrap();
    let turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("start-overflow-turn").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "continue after durable history".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    (threads, thread_id, turn_id)
}

fn text_response(text: &str) -> ModelResponse {
    ModelResponse {
        output: vec![ResponseItem::Text(text.into())],
        usage: None,
        billing: None,
        stop_reason: StopReason::Completed,
    }
}

fn request_contains(request: &ModelRequest, expected: &str) -> bool {
    request.input.iter().any(|input| match input {
        InputItem::Message(message) => message
            .content
            .iter()
            .any(|content| matches!(content, ContentPart::Text(text) if text.contains(expected))),
        InputItem::ToolResult(_) => false,
    })
}

fn wait_for_turn_status(
    threads: &ThreadController,
    thread_id: &ThreadId,
    turn_id: &ash_protocol::TurnId,
    expected: TurnStatus,
) {
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let snapshot = threads.read_thread(thread_id).unwrap();
        if snapshot
            .turns
            .iter()
            .find(|turn| &turn.turn_id == turn_id)
            .is_some_and(|turn| turn.status == expected)
        {
            return;
        }
        assert!(Instant::now() < deadline, "Turn did not reach {expected:?}");
        thread::sleep(Duration::from_millis(1));
    }
}

fn wait_for_flag(flag: &AtomicBool, message: &str) {
    let deadline = Instant::now() + Duration::from_secs(1);
    while !flag.load(Ordering::Relaxed) {
        assert!(Instant::now() < deadline, "{message}");
        thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn model_failure_details_survive_retry_exhaustion() {
    for stable in [
        ash_protocol::StableTurnError::rate_limited(),
        ash_protocol::StableTurnError::provider_http(500),
        ash_protocol::StableTurnError::connection_failed(),
    ] {
        let (threads, thread_id, turn_id) = started_turn();
        let error = CoreError::ModelTransient {
            failure: stable.clone(),
            retry_after_ms: None,
        };
        let model = Arc::new(ScriptedModel::new(vec![Err(error.clone()); 4]));
        let executor = TurnExecutor::without_tools(threads.clone(), model.clone());
        assert_eq!(
            executor
                .execute(&thread_id, &turn_id, &CancellationSource::new().token())
                .err(),
            Some(error)
        );
        assert_eq!(model.requests().len(), 4);
        let snapshot = threads.read_thread(&thread_id).unwrap();
        assert_eq!(
            snapshot.turns.last().unwrap().failure.as_ref(),
            Some(&stable)
        );
    }
}

struct NamedContextSource(&'static str);

impl crate::ContextSource for NamedContextSource {
    fn collect(
        &self,
        _: &crate::ContextSourceRequest<'_>,
        _: &CancellationToken,
    ) -> Result<Vec<crate::ContextEvidence>, CoreError> {
        if self.0 == "cancel" {
            return Err(CoreError::Cancelled("context stopped".into()));
        }
        if self.0 == "fail" {
            return Err(CoreError::Context("context unavailable".into()));
        }
        Ok(vec![crate::ContextEvidence {
            source: self.0.into(),
            reference: format!("{}:ref", self.0),
            revision: "1".into(),
            body: format!("{} evidence", self.0),
        }])
    }
}

impl ash_extension_api::ContextContributor for NamedContextSource {
    fn collect(
        &self,
        request: &crate::ContextSourceRequest<'_>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<crate::ContextEvidence>, ash_extension_api::ExtensionError> {
        crate::ContextSource::collect(self, request, cancellation)
            .map_err(|error| ash_extension_api::ExtensionError::new(error.to_string()))
    }
}

#[test]
fn independent_context_sources_survive_rebinding_and_removal() {
    let (threads, thread_id, turn_id) = started_turn();
    let model = Arc::new(ScriptedModel::new([Ok(text_response("done"))]));
    let executor = TurnExecutor::without_tools(threads, model.clone())
        .with_context_source("codebase", Arc::new(NamedContextSource("old")))
        .with_context_source("memories", Arc::new(NamedContextSource("memory")))
        .with_context_source("retired", Arc::new(NamedContextSource("retired")))
        .with_context_source("codebase", Arc::new(NamedContextSource("new")))
        .without_context_source("retired")
        .with_tool_service(Arc::new(WeatherTool), Arc::new(SandboxActionPolicyService));
    executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();
    let request = &model.requests()[0];
    assert!(request_contains(request, "new evidence"));
    assert!(request_contains(request, "memory evidence"));
    assert!(!request_contains(request, "old evidence"));
    assert!(!request_contains(request, "retired evidence"));
    assert!(
        !request
            .instructions
            .as_deref()
            .unwrap_or_default()
            .contains("memory evidence")
    );
    for item in &request.input {
        if let ash_protocol::InputItem::Message(message) = item
            && message.content.iter().any(|part| matches!(part, ash_protocol::ContentPart::Text(text) if text.contains("memory evidence"))) {
            assert_eq!(message.role, ash_protocol::MessageRole::User);
        }
    }
}

#[test]
fn context_cancellation_and_failure_never_invoke_the_model_with_partial_evidence() {
    for name in ["cancel", "fail"] {
        let (threads, thread_id, turn_id) = started_turn();
        let model = Arc::new(ScriptedModel::new([Ok(text_response("unexpected"))]));
        let executor = TurnExecutor::without_tools(threads.clone(), model.clone())
            .with_context_source("a", Arc::new(NamedContextSource("first")))
            .with_context_source("b", Arc::new(NamedContextSource(name)));
        let result = executor.execute(&thread_id, &turn_id, &CancellationSource::new().token());
        assert!(result.is_err());
        assert!(model.requests().is_empty());
        let snapshot = threads.read_thread(&thread_id).unwrap();
        assert_eq!(
            snapshot.turns[0].status,
            if name == "cancel" {
                ash_protocol::TurnStatus::Interrupted
            } else {
                ash_protocol::TurnStatus::Failed
            }
        );
    }
}

#[derive(Default)]
struct ToolLifecycleLog(Mutex<Vec<String>>);
impl ash_extension_api::ToolLifecycleContributor for ToolLifecycleLog {
    fn tool_changed(
        &self,
        _: ash_extension_api::ThreadContext<'_>,
        _: &TurnId,
        event: &ash_extension_api::ToolLifecycle,
    ) {
        self.0.lock().unwrap().push(match event {
            ash_extension_api::ToolLifecycle::Started { call_id, .. } => {
                format!("started:{call_id}")
            }
            ash_extension_api::ToolLifecycle::Completed { call_id, is_error } => {
                format!("completed:{call_id}:{is_error}")
            }
        });
    }
}

struct MissingToolInstructions;

impl HarnessContextProvider for MissingToolInstructions {
    fn snapshot(
        &self,
        _: &crate::HarnessContextRequest<'_>,
    ) -> Result<Arc<HarnessContext>, CoreError> {
        Ok(Arc::new(HarnessContext::default()))
    }
    fn validate_tool_context(
        &self,
        _: &crate::HarnessContextRequest<'_>,
        _: &ToolCall,
    ) -> Result<(), CoreError> {
        Err(CoreError::InvalidInput(
            "Read the applicable instruction file before retrying".into(),
        ))
    }
}

#[test]
fn missing_instructions_return_to_model_without_starting_tool_or_requesting_approval() {
    let (threads, thread_id, turn_id) = started_turn();
    let call_id = ToolCallId::new("requires-instructions").unwrap();
    let model = Arc::new(ScriptedModel::new([
        Ok(ModelResponse {
            output: vec![ResponseItem::ToolCall(ToolCall {
                id: call_id.clone(),
                name: ToolName::new("weather").unwrap(),
                arguments: json!({"city":"Paris"}),
            })],
            usage: None,
            billing: None,
            stop_reason: StopReason::ToolUse,
        }),
        Ok(text_response("Read the rules first")),
    ]));
    let executor = TurnExecutor::new(
        threads.clone(),
        model.clone(),
        Arc::new(WeatherTool),
        Arc::new(SandboxActionPolicyService),
    )
    .with_harness_context_provider(Arc::new(MissingToolInstructions));
    executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert!(!snapshot.started_tool_calls.contains(&call_id));
    assert!(snapshot.items.iter().any(|item| matches!(item, ThreadItem::ToolResult { tool_call_id, is_error: true, text, .. } if tool_call_id == &call_id && text.contains("instruction file"))));
    assert!(model.requests()[1].input.iter().any(|item| matches!(item, InputItem::ToolResult(result) if result.is_error && result.content.iter().any(|part| matches!(part, ContentPart::Text(text) if text.contains("Read the applicable instruction file before retrying"))))));
    assert!(snapshot.turns[0].pending_interaction.is_none());
}

struct InstructionReadBarrier;

impl HarnessContextProvider for InstructionReadBarrier {
    fn snapshot(
        &self,
        _: &crate::HarnessContextRequest<'_>,
    ) -> Result<Arc<HarnessContext>, CoreError> {
        Ok(Arc::new(HarnessContext::default()))
    }
    fn validate_tool_context(
        &self,
        request: &crate::HarnessContextRequest<'_>,
        call: &ToolCall,
    ) -> Result<(), CoreError> {
        if call.name.as_str() == "weather" && request.read_paths.is_empty() {
            return Err(CoreError::InvalidInput(
                "Read rules and submit a new call".into(),
            ));
        }
        Ok(())
    }
}

struct InstructionBarrierTools(AtomicUsize);

impl ToolService for InstructionBarrierTools {
    fn definitions(&self) -> Vec<ToolDefinition> {
        let mut definitions = WeatherTool.definitions();
        definitions.extend(ReadInstructionTargetTool.definitions());
        definitions
    }
    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        WeatherTool.prepare(call)
    }
    fn execute(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        if call.name.as_str() == "read_file" {
            return Ok(ToolExecutionOutput::Success("Rules".into()));
        }
        self.0.fetch_add(1, Ordering::SeqCst);
        WeatherTool.execute(call, authorization, cancellation)
    }
}

#[test]
fn a_read_in_the_same_model_batch_does_not_satisfy_instruction_preflight() {
    let (threads, thread_id, turn_id) = started_turn();
    let tools = Arc::new(InstructionBarrierTools(AtomicUsize::new(0)));
    let model = Arc::new(ScriptedModel::new([
        Ok(ModelResponse {
            output: vec![
                ResponseItem::ToolCall(ToolCall {
                    id: ToolCallId::new("read").unwrap(),
                    name: ToolName::new("read_file").unwrap(),
                    arguments: json!({"path":"rules.md"}),
                }),
                ResponseItem::ToolCall(ToolCall {
                    id: ToolCallId::new("early").unwrap(),
                    name: ToolName::new("weather").unwrap(),
                    arguments: json!({"city":"Paris"}),
                }),
            ],
            usage: None,
            billing: None,
            stop_reason: StopReason::ToolUse,
        }),
        Ok(ModelResponse {
            output: vec![ResponseItem::ToolCall(ToolCall {
                id: ToolCallId::new("retry").unwrap(),
                name: ToolName::new("weather").unwrap(),
                arguments: json!({"city":"Paris"}),
            })],
            usage: None,
            billing: None,
            stop_reason: StopReason::ToolUse,
        }),
        Ok(text_response("done")),
    ]));
    let executor = TurnExecutor::new(
        threads.clone(),
        model,
        tools.clone(),
        Arc::new(SandboxActionPolicyService),
    )
    .with_harness_context_provider(Arc::new(InstructionReadBarrier));
    executor
        .execute(&thread_id, &turn_id, &CancellationSource::new().token())
        .unwrap();
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert!(
        !snapshot
            .started_tool_calls
            .contains(&ToolCallId::new("early").unwrap())
    );
    assert!(
        snapshot
            .started_tool_calls
            .contains(&ToolCallId::new("retry").unwrap())
    );
    assert_eq!(tools.0.load(Ordering::SeqCst), 1);
}
