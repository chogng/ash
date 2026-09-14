use super::*;
use serde_json::json;

#[test]
fn stable_turn_error_categories_serialize_as_public_camel_case_codes() {
    let errors = [
        StableTurnError::context_overflow(),
        StableTurnError::provider_auth(),
        StableTurnError::invalid_request(),
        StableTurnError::invalid_response(),
        StableTurnError::tool_repetition(),
        StableTurnError::usage_limited(),
    ];

    assert_eq!(
        errors
            .iter()
            .map(|error| serde_json::to_value(error).unwrap()["code"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!("contextOverflow"),
            json!("providerAuth"),
            json!("invalidRequest"),
            json!("invalidResponse"),
            json!("toolRepetition"),
            json!("usageLimited"),
        ]
    );
}

#[test]
fn durable_thread_event_serializes_without_a_runtime_message_wrapper() {
    let event = ThreadEvent::TurnStarted {
        thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
        turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
    };

    assert_eq!(
        serde_json::to_value(event).unwrap(),
        json!({
            "type": "turnStarted",
            "threadId": "thread_1",
            "turnId": "turn_1"
        })
    );
    assert_eq!(
        serde_json::to_value(ThreadEvent::TurnSteerDelivered {
            thread_id: ThreadId::new("thread_1").unwrap(),
            turn_id: TurnId::new("turn_1").unwrap(),
            command_id: CommandId::new("steer_1").unwrap(),
        })
        .unwrap(),
        json!({
            "type": "turnSteerDelivered",
            "threadId": "thread_1",
            "turnId": "turn_1",
            "commandId": "steer_1"
        })
    );
}

#[test]
fn historical_agent_capability_scope_cannot_pass_tools_to_descendants() {
    let scope: AgentCapabilityScope = serde_json::from_value(json!({
        "tools": ["read_file"],
        "skills": []
    }))
    .unwrap();

    assert_eq!(scope.tools, [ToolName::new("read_file").unwrap()]);
    assert!(scope.delegation_tools.is_empty());
    assert_eq!(
        serde_json::to_value(scope).unwrap(),
        json!({
            "tools": ["read_file"],
            "skills": []
        })
    );
}

#[test]
fn model_usage_preserves_partial_reports_and_aggregate_completeness() {
    let legacy_usage: ModelUsage = serde_json::from_value(json!({
        "inputTokens": 5,
        "outputTokens": 2,
        "cachedInputTokens": 1,
        "reasoningTokens": null
    }))
    .unwrap();
    assert_eq!(legacy_usage.cache_write_input_tokens, None);
    let legacy_total = json!({"reported": 0, "complete": true});
    let legacy_summary: ModelUsageSummary = serde_json::from_value(json!({
        "modelInvocations": 0,
        "inputTokens": legacy_total,
        "outputTokens": legacy_total,
        "cachedInputTokens": legacy_total,
        "reasoningTokens": legacy_total
    }))
    .unwrap();
    assert_eq!(
        legacy_summary.cache_write_input_tokens,
        ModelUsageTotal::default()
    );

    let first = ModelUsage {
        input_tokens: Some(10),
        output_tokens: Some(3),
        cached_input_tokens: Some(2),
        cache_write_input_tokens: Some(1),
        reasoning_tokens: None,
    };
    let second = ModelUsage {
        input_tokens: Some(7),
        output_tokens: None,
        cached_input_tokens: None,
        cache_write_input_tokens: None,
        reasoning_tokens: Some(1),
    };
    let summary = ModelUsageSummary::default()
        .checked_record(Some(&first))
        .unwrap()
        .checked_record(Some(&second))
        .unwrap()
        .checked_record(None)
        .unwrap();

    assert_eq!(summary.model_invocations, 3);
    assert_eq!(summary.input_tokens.reported, 17);
    assert!(!summary.input_tokens.complete);
    assert_eq!(summary.output_tokens.reported, 3);
    assert!(!summary.output_tokens.complete);
    assert_eq!(summary.cached_input_tokens.reported, 2);
    assert!(!summary.cached_input_tokens.complete);
    assert_eq!(summary.cache_write_input_tokens.reported, 1);
    assert!(!summary.cache_write_input_tokens.complete);
    assert_eq!(summary.reasoning_tokens.reported, 1);
    assert!(!summary.reasoning_tokens.complete);

    assert_eq!(
        serde_json::to_value(ThreadEvent::ModelUsageRecorded {
            thread_id: ThreadId::new("thread_1").unwrap(),
            turn_id: TurnId::new("turn_1").unwrap(),
            usage: Some(first),
            input_estimate: None,
        })
        .unwrap(),
        json!({
            "type": "modelUsageRecorded",
            "threadId": "thread_1",
            "turnId": "turn_1",
            "usage": {
                "inputTokens": 10,
                "outputTokens": 3,
                "cachedInputTokens": 2,
                "cacheWriteInputTokens": 1,
                "reasoningTokens": null
            }
        })
    );
    assert_eq!(
        serde_json::to_value(ThreadEvent::ModelUsageRecorded {
            thread_id: ThreadId::new("thread_1").unwrap(),
            turn_id: TurnId::new("turn_1").unwrap(),
            usage: Some(second),
            input_estimate: Some(ModelInputEstimate {
                estimated_input_tokens: 9,
                estimator_revision: "deterministic-bytes-v1".into(),
                calibration_revision: "usage-underestimate-asymmetric-ema-v1".into(),
            }),
        })
        .unwrap(),
        json!({
            "type": "modelUsageRecorded",
            "threadId": "thread_1",
            "turnId": "turn_1",
            "usage": {
                "inputTokens": 7,
                "outputTokens": null,
                "cachedInputTokens": null,
                "cacheWriteInputTokens": null,
                "reasoningTokens": 1
            },
            "inputEstimate": {
                "estimatedInputTokens": 9,
                "estimatorRevision": "deterministic-bytes-v1",
                "calibrationRevision": "usage-underestimate-asymmetric-ema-v1"
            }
        })
    );
}

#[test]
fn model_invocation_fact_keeps_exact_cost_strings() {
    let thread_id = ThreadId::new("thread_1").unwrap();
    let turn_id = TurnId::new("turn_1").unwrap();
    let event = ThreadEvent::ModelInvocationRecorded {
        thread_id: thread_id.clone(),
        turn_id: turn_id.clone(),
        record: ModelInvocationRecord {
            time_context: None,
            invocation_id: ModelInvocationId::new("model-invocation_1").unwrap(),
            thread_id,
            turn_id,
            requested_model: Some(ModelRef::new(
                ProviderId::new("kimi").unwrap(),
                ModelId::new("kimi-k2.7-code-highspeed").unwrap(),
            )),
            resolved_model: Some(ModelId::new("kimi-k2.7-code-highspeed").unwrap()),
            billing: Some(ModelBillingRecord {
                billing_platform: "kimi_api".into(),
                operation: "text_generation".into(),
                requested_service_tier: None,
                applied_service_tier: "standard".into(),
                service_tier_evidence: ModelBillingEvidence::FixedModelIdentity,
                region: "global".into(),
                pricing_variant: "default".into(),
                rate_card_revision: "accelerated-public-2026-09-04".into(),
            }),
            started_at_unix_ms: 100,
            completed_at_unix_ms: 120,
            outcome: ModelInvocationOutcome::Completed,
            usage: None,
            input_estimate: None,
            reference_cost: ModelReferenceCostRecord::Complete {
                cost: RatedModelCost {
                    amount: ModelMoneyAmount {
                        currency: "USD".into(),
                        pico_units: "2548000000".into(),
                    },
                    revision: "accelerated-public-2026-09-04".into(),
                    line_items: Vec::new(),
                },
            },
        },
    };

    let json = serde_json::to_value(event).unwrap();
    assert_eq!(json["type"], "modelInvocationRecorded");
    assert_eq!(
        json["record"]["referenceCost"]["cost"]["amount"]["picoUnits"],
        "2548000000"
    );
}

#[test]
fn reference_cost_summary_adds_exact_amounts_and_preserves_unknown_work() {
    let complete = ModelReferenceCostRecord::Complete {
        cost: RatedModelCost {
            amount: ModelMoneyAmount {
                currency: "USD".into(),
                pico_units: "10080000000".into(),
            },
            revision: "rates-v1".into(),
            line_items: Vec::new(),
        },
    };
    let partial = ModelReferenceCostRecord::Partial {
        known_minimum: RatedModelCost {
            amount: ModelMoneyAmount {
                currency: "USD".into(),
                pico_units: "250000000".into(),
            },
            revision: "rates-v1".into(),
            line_items: Vec::new(),
        },
        reason: ModelReferenceCostReason::MissingTokenRates {
            dimensions: vec!["cache_write_input".into()],
        },
    };

    let summary = ModelReferenceCostSummary::default()
        .checked_record(&complete)
        .unwrap()
        .checked_record(&partial)
        .unwrap();

    assert_eq!(
        summary,
        ModelReferenceCostSummary {
            known_amounts: vec![ModelMoneyAmount {
                currency: "USD".into(),
                pico_units: "10330000000".into(),
            }],
            complete: false,
        }
    );
}

#[test]
fn thread_goal_serializes_as_a_durable_cumulative_budget() {
    let goal = ThreadGoal {
        thread_id: ThreadId::new("thread_1").unwrap(),
        goal_id: "goal_1".into(),
        objective: "finish the migration".into(),
        status: ThreadGoalStatus::Active,
        token_budget: Some(50_000),
        tokens_used: 12,
    };

    assert_eq!(
        serde_json::to_value(goal).unwrap(),
        json!({
            "threadId": "thread_1",
            "goalId": "goal_1",
            "objective": "finish the migration",
            "status": "active",
            "tokenBudget": 50_000,
            "tokensUsed": 12,
        })
    );
}

#[test]
fn legacy_start_turn_without_host_skill_activations_remains_distinguishable() {
    let command: ThreadCommand = serde_json::from_value(json!({
        "type": "startTurn",
        "activatedSkills": [],
        "approvalMode": "askPermissions",
        "input": [{ "type": "text", "text": "hello" }]
    }))
    .unwrap();

    assert!(matches!(
        command,
        ThreadCommand::StartTurn {
            kind: TurnKind::Coding,
            host_activated_skills: None,
            instructions: None,
            ..
        }
    ));
}

#[test]
fn turn_instructions_and_review_target_have_stable_public_shapes() {
    let instructions =
        TurnInstructions::new("prompts", "review/code", "review-v3", "review instructions")
            .unwrap();
    assert_eq!(
        serde_json::to_value(instructions).unwrap(),
        json!({
            "owner": "prompts",
            "id": "review/code",
            "revision": "review-v3",
            "body": "review instructions"
        })
    );
    assert_eq!(
        serde_json::to_value(ReviewTarget::BaseBranch {
            branch: "main".into(),
        })
        .unwrap(),
        json!({"type": "baseBranch", "branch": "main"})
    );
    assert_eq!(
        serde_json::to_value(TurnKind::Review).unwrap(),
        json!("review")
    );
}

#[test]
fn empty_turn_instruction_fields_are_rejected() {
    assert!(TurnInstructions::new("", "review/code", "review-v3", "body").is_err());
    let decoded: TurnInstructions = serde_json::from_value(json!({
        "owner": "prompts",
        "id": "review/code",
        "revision": "review-v3",
        "body": ""
    }))
    .unwrap();
    assert!(decoded.validate().is_err());
}

#[test]
fn turn_steering_serializes_as_a_typed_command_and_durable_item_binding() {
    let turn_id = TurnId::new("turn_1").unwrap();
    let command = ThreadCommand::SteerTurn {
        turn_id: turn_id.clone(),
        input: vec![UserInput::Text {
            text: "focus on the failing test".into(),
        }],
    };
    let event = ThreadEvent::TurnSteered {
        thread_id: ThreadId::new("thread_1").unwrap(),
        turn_id,
        item_ids: vec![ItemId::new("item_2").unwrap()],
    };

    assert_eq!(
        serde_json::to_value(command).unwrap(),
        json!({
            "type": "steerTurn",
            "turnId": "turn_1",
            "input": [{"type": "text", "text": "focus on the failing test"}]
        })
    );
    assert_eq!(
        serde_json::to_value(event).unwrap(),
        json!({
            "type": "turnSteered",
            "threadId": "thread_1",
            "turnId": "turn_1",
            "itemIds": ["item_2"]
        })
    );
}

#[test]
fn context_overflow_recovery_event_binds_the_checkpoint_to_one_turn() {
    let thread_id = ThreadId::new("thread_1").unwrap();
    let event = ThreadEvent::ContextOverflowRecoveryCommitted {
        thread_id: thread_id.clone(),
        turn_id: TurnId::new("turn_1").unwrap(),
        checkpoint: ContextCheckpoint {
            checkpoint_id: ContextCheckpointId::new("checkpoint_1").unwrap(),
            source_thread_id: thread_id,
            covered: ContextSourceRange {
                start_sequence: 1,
                end_sequence: 4,
            },
            referenced_items: vec![ItemId::new("item_1").unwrap()],
            source_digest: ContextSourceDigest::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
            summary: "earlier history".into(),
            schema_revision: "context-checkpoint-v1".into(),
            prompt_revision: "compaction-v1".into(),
            context_policy_revision: "context-policy-v1".into(),
            generator_model: None,
            created_at_unix_ms: 42,
            verification: ContextCheckpointVerification::Verified,
        },
    };

    let encoded = serde_json::to_value(event).unwrap();
    assert_eq!(encoded["type"], json!("contextOverflowRecoveryCommitted"));
    assert_eq!(encoded["threadId"], json!("thread_1"));
    assert_eq!(encoded["turnId"], json!("turn_1"));
    assert_eq!(encoded["checkpoint"]["checkpointId"], json!("checkpoint_1"));
}

#[test]
fn sandbox_escalation_retains_the_structured_denied_process_result() {
    let event = ThreadEvent::ToolExecutionEscalated {
        thread_id: ThreadId::new("thread_1").unwrap(),
        turn_id: TurnId::new("turn_1").unwrap(),
        tool_call_id: ToolCallId::new("call_1").unwrap(),
        action_digest: "a".repeat(64),
        policy_revision: "policy-1".into(),
        denial: SandboxDenialOutput::safe_to_retry(
            "network access denied",
            ProcessExecutionOutput::from_captured_streams(
                ProcessExitStatus::Code(1),
                "",
                "operation not permitted",
            ),
        ),
        authority: ToolExecutionAuthority::AutoReviewed {
            assessment_id: "assessment-1".into(),
        },
    };

    assert_eq!(
        serde_json::to_value(event).unwrap(),
        json!({
            "type": "toolExecutionEscalated",
            "threadId": "thread_1",
            "turnId": "turn_1",
            "toolCallId": "call_1",
            "actionDigest": "a".repeat(64),
            "policyRevision": "policy-1",
            "denial": {
                "reason": "network access denied",
                "output": {
                    "exitStatus": {"type": "code", "code": 1},
                    "stdout": "",
                    "stderr": "operation not permitted",
                    "aggregatedOutput": "operation not permitted"
                },
                "replaySafety": "safeToRetry"
            },
            "authority": {
                "type": "autoReviewed",
                "assessmentId": "assessment-1"
            }
        })
    );
}

#[test]
fn exec_policy_authority_serializes_exact_rule_and_revision() {
    let authority = ToolExecutionAuthority::ExecPolicyGranted {
        layer_id: "user".into(),
        rule_id: "user-safe-status".into(),
        exec_policy_revision: "exec-policy-7".into(),
    };

    assert_eq!(
        serde_json::to_value(authority).unwrap(),
        json!({
            "type": "execPolicyGranted",
            "layerId": "user",
            "ruleId": "user-safe-status",
            "execPolicyRevision": "exec-policy-7"
        })
    );
}

#[test]
fn canonical_session_contains_thread_identity_presentation_and_lineage_without_history() {
    let session = Session {
        session_id: SessionId::new("session_1").expect("test ID is non-empty"),
        title: "task".into(),
        status: SessionStatus::Active,
        manager: Default::default(),
        threads: vec![
            SessionThread {
                thread_id: ThreadId::new("thread_root").expect("test ID is non-empty"),
                title: "task".into(),
                created_at_unix_ms: 1,
                completed_turn_duration_ms: 0,
                active_turn_started_at_unix_ms: None,
                usage: Default::default(),
                parent_thread_id: None,
                forked_from_id: None,
                status: ThreadStatus::Active,
            },
            SessionThread {
                thread_id: ThreadId::new("thread_child").expect("test ID is non-empty"),
                title: "review".into(),
                created_at_unix_ms: 2,
                completed_turn_duration_ms: 0,
                active_turn_started_at_unix_ms: None,
                usage: Default::default(),
                parent_thread_id: Some(ThreadId::new("thread_root").expect("test ID is non-empty")),
                forked_from_id: Some(ThreadId::new("thread_root").expect("test ID is non-empty")),
                status: ThreadStatus::Active,
            },
        ],
    };

    assert_eq!(session.threads.len(), 2);
    assert_eq!(session.threads[1].title, "review");
    assert_eq!(session.threads[1].created_at_unix_ms, 2);
    assert_eq!(
        session.threads[1].forked_from_id.as_ref(),
        Some(&session.threads[0].thread_id)
    );
}

#[test]
fn session_manager_info_has_a_stable_status_activity_and_time_shape() {
    let manager = SessionManagerInfo {
        status: SessionManagerStatus::NeedsInput,
        status_changed_at_unix_ms: 42,
        activity: Some(SessionManagerActivity::Question {
            text: "Which API should I use?".into(),
        }),
        summary: None,
    };

    assert_eq!(
        serde_json::to_value(manager).unwrap(),
        json!({
            "status": "needsInput",
            "statusChangedAtUnixMs": 42,
            "activity": {
                "type": "question",
                "text": "Which API should I use?"
            }
        })
    );
}

#[test]
fn legacy_thread_archive_defaults_to_completed() {
    let event = serde_json::from_value::<ThreadEvent>(json!({
        "type": "threadArchived",
        "threadId": "thread_1"
    }))
    .unwrap();

    assert_eq!(
        event,
        ThreadEvent::ThreadArchived {
            thread_id: ThreadId::new("thread_1").unwrap(),
            reason: ThreadArchiveReason::Completed,
        }
    );
}

#[test]
fn live_update_uses_a_separate_stream_cursor_from_durable_sequence() {
    let update = ThreadUpdateEnvelope {
        session_id: SessionId::new("session_1").expect("test ID is non-empty"),
        thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
        durable_sequence: 4,
        stream_cursor: Some(StreamCursor {
            stream_instance_id: StreamInstanceId::new("stream_1").expect("test ID is non-empty"),
            sequence: 9,
        }),
        update: ThreadUpdate::ItemDelta {
            turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
            item_id: ItemId::new("item_1").expect("test ID is non-empty"),
            delta: ItemDelta::AgentMessage {
                text: "delta".into(),
            },
        },
    };

    assert_eq!(update.durable_sequence, 4);
    assert_eq!(update.stream_cursor.unwrap().sequence, 9);
}

#[test]
fn interaction_request_is_durable_without_connection_ownership() {
    let event = ThreadEvent::InteractionRequested {
        thread_id: ThreadId::new("thread_1").expect("test ID is non-empty"),
        turn_id: TurnId::new("turn_1").expect("test ID is non-empty"),
        interaction: TurnInteraction {
            request_id: RequestId::new("request_1").expect("test ID is non-empty"),
            item_id: None,
            request: AgentRequest::UserInput {
                request: RequestUserInput {
                    questions: Vec::new(),
                },
            },
            deadline: Some(InteractionDeadline {
                expires_at_unix_ms: 1_234,
            }),
        },
    };

    assert_eq!(
        serde_json::to_value(event).unwrap(),
        json!({
            "type": "interactionRequested",
            "threadId": "thread_1",
            "turnId": "turn_1",
            "interaction": {
                "requestId": "request_1",
                "request": {"type": "userInput", "request": {"questions": []}},
                "deadline": {"expiresAtUnixMs": 1234}
            }
        })
    );
}

#[test]
fn readable_wait_state_excludes_the_owner_directed_request_payload() {
    let interaction = TurnInteraction {
        request_id: RequestId::new("request_1").expect("test ID is non-empty"),
        item_id: None,
        request: AgentRequest::UserInput {
            request: RequestUserInput {
                questions: vec![UserInputQuestion {
                    id: "secret-question".into(),
                    header: "Secret".into(),
                    question: "Do not broadcast this payload".into(),
                    options: Vec::new(),
                    allow_free_form: true,
                }],
            },
        },
        deadline: None,
    };

    assert_eq!(
        serde_json::to_value(interaction.pending_state()).unwrap(),
        json!({
            "requestId": "request_1",
            "kind": "userInput"
        })
    );
}

#[test]
fn approval_interaction_serializes_its_exact_policy_binding() {
    let interaction = TurnInteraction {
        request_id: RequestId::new("approval_1").unwrap(),
        item_id: None,
        request: AgentRequest::Approval {
            request: ActionApprovalRequest {
                action_digest: "a".repeat(64),
                policy_revision: "policy-7".into(),
                capabilities: vec![ActionApprovalCapability {
                    kind: ActionApprovalCapabilityKind::Network,
                    scope: "api.example.com".into(),
                }],
                reason: "network requires unsandboxed execution".into(),
                sandbox_denial: Some(SandboxDenialOutput::safe_to_retry(
                    "network access denied",
                    ProcessExecutionOutput::from_captured_streams(
                        ProcessExitStatus::Code(1),
                        "",
                        "operation not permitted",
                    ),
                )),
            },
        },
        deadline: None,
    };

    assert_eq!(
        serde_json::to_value(&interaction).unwrap(),
        json!({
            "requestId": "approval_1",
            "request": {
                "type": "approval",
                "request": {
                    "actionDigest": "a".repeat(64),
                    "policyRevision": "policy-7",
                    "capabilities": [{
                        "kind": "network",
                        "scope": "api.example.com"
                    }],
                    "reason": "network requires unsandboxed execution",
                    "sandboxDenial": {
                        "reason": "network access denied",
                        "output": {
                            "exitStatus": {
                                "type": "code",
                                "code": 1
                            },
                            "stdout": "",
                            "stderr": "operation not permitted",
                            "aggregatedOutput": "operation not permitted"
                        },
                        "replaySafety": "safeToRetry"
                    }
                }
            }
        })
    );
    assert_eq!(
        serde_json::to_value(interaction.pending_state()).unwrap(),
        json!({
            "requestId": "approval_1",
            "kind": "approval"
        })
    );
    assert_eq!(
        serde_json::to_value(AgentResponse::Approval {
            response: ActionApprovalResponse {
                decision: ActionApprovalDecision::ApproveOnce,
            },
        })
        .unwrap(),
        json!({
            "type": "approval",
            "response": {"decision": "approveOnce"}
        })
    );
}

#[test]
fn ordinary_approval_omits_the_sandbox_escalation_payload() {
    let request = ActionApprovalRequest {
        action_digest: "a".repeat(64),
        policy_revision: "policy-7".into(),
        capabilities: vec![ActionApprovalCapability {
            kind: ActionApprovalCapabilityKind::Network,
            scope: "api.example.com".into(),
        }],
        reason: "network requires unsandboxed execution".into(),
        sandbox_denial: None,
    };

    assert!(
        serde_json::to_value(request)
            .unwrap()
            .get("sandboxDenial")
            .is_none()
    );
}

#[test]
fn user_input_supports_text_images_skills_instructions_and_mentions() {
    let input = [
        UserInput::Text {
            text: "hello".into(),
        },
        UserInput::Image {
            url: "https://example.test/image.png".into(),
        },
        UserInput::Skill {
            skill: crate::SkillRef::follow_latest(crate::SkillId::new(
                crate::SkillSourceId::new("user:skill-source:personal").unwrap(),
                crate::SkillName::new("review").unwrap(),
            )),
        },
        UserInput::Instruction {
            reference: crate::InstructionRef {
                source: crate::InstructionSource::User,
                relative_path: "manual.md".into(),
                digest: crate::ContentDigest::sha256(b"manual"),
            },
        },
        UserInput::Mention {
            name: "issues".into(),
            path: "app://issues".into(),
        },
    ];

    assert_eq!(input.len(), 5);
    let encoded = serde_json::to_value(&input[3]).unwrap();
    assert_eq!(encoded["type"], "instruction");
    assert_eq!(encoded["reference"]["source"]["type"], "user");
    assert_eq!(encoded["reference"]["relativePath"], "manual.md");
    assert_eq!(
        serde_json::from_value::<UserInput>(encoded).unwrap(),
        input[3]
    );
}

#[test]
fn legacy_raw_path_skill_input_is_rejected() {
    assert!(
        serde_json::from_value::<UserInput>(serde_json::json!({
            "type": "skill",
            "name": "review",
            "path": "/tmp/outside/SKILL.md"
        }))
        .is_err()
    );
}

#[test]
fn tool_names_reject_ambiguous_or_provider_specific_syntax() {
    assert!(ToolName::new("request_user_input").is_ok());
    assert!(ToolName::new("namespace/tool").is_err());
    assert!(ToolName::new("").is_err());
}

#[test]
fn canonical_identifiers_reject_empty_construction_and_deserialization() {
    assert!(SessionId::new("").is_err());
    assert!(ThreadId::new("   ").is_err());
    assert!(CommandId::new("").is_err());
    assert!(DelegationId::new("").is_err());
    assert!(AgentJoinId::new(" ").is_err());
    assert!(AgentMessageId::new(" ").is_err());
    assert!(ToolCallId::new("\n").is_err());
    assert!(serde_json::from_str::<SessionId>("\"\"").is_err());
    assert!(serde_json::from_str::<StreamInstanceId>("\"  \"").is_err());
}

#[test]
fn agent_join_and_cancellation_facts_have_stable_wire_shapes() {
    let join = AgentJoin {
        join_id: AgentJoinId::new("join-1").unwrap(),
        parent_thread_id: ThreadId::new("parent").unwrap(),
        policy: AgentJoinPolicy::Quorum { count: 2 },
        delegations: vec![
            DelegationId::new("one").unwrap(),
            DelegationId::new("two").unwrap(),
        ],
        status: AgentJoinStatus::Waiting,
        satisfied_by: Vec::new(),
    };
    assert_eq!(
        serde_json::to_value(join).unwrap(),
        json!({
            "joinId": "join-1",
            "parentThreadId": "parent",
            "policy": { "type": "quorum", "count": 2 },
            "delegations": ["one", "two"],
            "status": "waiting",
            "satisfiedBy": []
        })
    );
    assert_eq!(
        serde_json::to_value(ThreadEvent::DelegationCancellationRequested {
            thread_id: ThreadId::new("parent").unwrap(),
            delegation_id: DelegationId::new("one").unwrap(),
        })
        .unwrap(),
        json!({
            "type": "delegationCancellationRequested",
            "threadId": "parent",
            "delegationId": "one"
        })
    );
}

#[test]
fn agent_spawn_lineage_and_digests_have_a_stable_wire_shape() {
    let origin = ThreadOrigin::AgentSpawn {
        parent_thread_id: ThreadId::new("thread_parent").unwrap(),
        parent_sequence: 17,
        delegation_id: DelegationId::new("delegation_review").unwrap(),
    };

    assert_eq!(
        serde_json::to_value(origin).unwrap(),
        json!({
            "type": "agentSpawn",
            "parentThreadId": "thread_parent",
            "parentSequence": 17,
            "delegationId": "delegation_review"
        })
    );
    assert!(ContextSeedDigest::new(format!("sha256:{}", "a".repeat(64))).is_ok());
    assert!(ContextSeedDigest::new(format!("sha256:{}", "A".repeat(64))).is_err());
    assert!(DelegationResultDigest::new("sha256:short").is_err());
}

#[test]
fn tool_contract_uses_validated_names_and_call_identifiers() {
    let name = ToolName::new("search").unwrap();
    let call_id = ToolCallId::new("tool_1").unwrap();
    let call = ToolCall {
        id: call_id,
        name,
        arguments: json!({"query": "ash"}),
    };

    assert_eq!(serde_json::to_value(call).unwrap()["name"], "search");
}

#[test]
fn durable_tool_call_binding_preserves_source_generation_and_caller() {
    let item = ThreadItem::ToolCall {
        item_id: ItemId::new("item_1").unwrap(),
        turn_id: TurnId::new("turn_1").unwrap(),
        tool_call_id: ToolCallId::new("tool_1").unwrap(),
        name: ToolName::new("search").unwrap(),
        arguments_json: "{}".into(),
        binding: Some(crate::ToolCallBinding {
            registry_incarnation: Some("process-1".into()),
            registry_generation: 9,
            definition_digest: "sha256:definition".into(),
            source_chain: vec![crate::ToolSourceProvenance::Mcp {
                server_id: "github".into(),
                remote_name: "search".into(),
                catalog_generation: 4,
                connection_generation: 2,
            }],
            caller: crate::ToolCallCaller::CodeMode {
                parent_tool_call_id: ToolCallId::new("outer_1").unwrap(),
                cell_id: "cell_1".into(),
                runtime_call_id: "nested_1".into(),
            },
        }),
    };
    let value = serde_json::to_value(item).unwrap();

    assert_eq!(value["binding"]["registryGeneration"], 9);
    assert_eq!(value["binding"]["sourceChain"][0]["type"], "mcp");
    assert_eq!(value["binding"]["caller"]["type"], "codeMode");
}

#[test]
fn durable_tool_result_preserves_structured_image_content_and_reads_legacy_text() {
    let item = ThreadItem::ToolResult {
        item_id: ItemId::new("item_1").unwrap(),
        turn_id: TurnId::new("turn_1").unwrap(),
        tool_call_id: ToolCallId::new("tool_1").unwrap(),
        text: "[image]".into(),
        content: Some(vec![ContentPart::ImageUrl {
            url: "data:image/png;base64,AA==".into(),
            detail: ImageDetail::High,
        }]),
        is_error: false,
    };
    let value = serde_json::to_value(&item).unwrap();
    assert_eq!(value["content"][0]["type"], "imageUrl");
    assert_eq!(value["content"][0]["detail"], "high");

    let text = serde_json::to_value(ContentPart::Text("result".into())).unwrap();
    assert_eq!(
        text,
        json!({
            "type": "text",
            "text": "result"
        })
    );
    assert_eq!(
        serde_json::from_value::<ContentPart>(text).unwrap(),
        ContentPart::Text("result".into())
    );

    let legacy = json!({
        "type": "toolResult",
        "itemId": "item_2",
        "turnId": "turn_1",
        "toolCallId": "tool_1",
        "text": "legacy",
        "isError": false
    });
    assert!(matches!(
        serde_json::from_value::<ThreadItem>(legacy).unwrap(),
        ThreadItem::ToolResult { content: None, text, .. } if text == "legacy"
    ));
}

#[test]
fn model_request_final_gate_sanitizes_message_and_tool_result_images() {
    let mut request = ModelRequest {
        instructions: None,
        input: vec![
            InputItem::Message(Message {
                role: MessageRole::User,
                content: vec![ContentPart::ImageUrl {
                    url: "data:image/png;base64,AA==".into(),
                    detail: ImageDetail::Original,
                }],
                tool_calls: Vec::new(),
            }),
            InputItem::ToolResult(ToolResult {
                call_id: ToolCallId::new("tool_1").unwrap(),
                name: ToolName::new("image").unwrap(),
                content: vec![ContentPart::ImageUrl {
                    url: "data:image/png;base64,AA==".into(),
                    detail: ImageDetail::Original,
                }],
                is_error: false,
            }),
        ],
        tools: Vec::new(),
        tool_choice: ToolChoice::Auto,
        parallel_tool_calls: false,
        reasoning: None,
        max_output_tokens: None,
        temperature: None,
        prompt_cache_key: None,
        prompt_cache_prefix_end: Some(0),
    };

    let decisions = request.sanitize_image_details(false);

    assert_eq!(decisions.len(), 2);
    assert!(decisions.iter().all(|decision| {
        decision.effective == ImageDetail::Auto
            && decision.reason == ImageDetailDecisionReason::OriginalUnsupportedDowngraded
    }));
}

#[test]
fn root_and_child_agent_configurations_share_the_same_role_size_bound() {
    let mut agent = AgentConfiguration {
        role: Some(AgentRoleSnapshot {
            name: "reviewer".into(),
            instructions: "x".repeat(64 * 1024),
            model: None,
            definition: None,
        }),
        capability_scope: AgentCapabilityScope {
            tools: Vec::new(),
            delegation_tools: Vec::new(),
            skills: Vec::new(),
        },
        base_instructions: None,
    };
    agent.validate().unwrap();
    agent.role.as_mut().unwrap().instructions.push('x');
    assert_eq!(
        agent.validate(),
        Err("Agent role instructions exceed 64 KiB")
    );
}
