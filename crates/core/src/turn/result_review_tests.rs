use super::*;
use ash_protocol::ContentPart;
use ash_protocol::RequestId;
use ash_protocol::ToolResultReview;
use ash_protocol::ToolResultReviewDecision;
use ash_protocol::ToolResultReviewRequest;
use ash_protocol::ToolResultReviewResponse;

struct ResultUpdates(std::sync::mpsc::Sender<()>);

impl ThreadUpdateSink for ResultUpdates {
    fn publish(&self, _: ash_protocol::ThreadUpdateEnvelope) {
        let _ = self.0.send(());
    }
}

fn review() -> ToolResultReview {
    ToolResultReview {
        reason: "Sensitive result chosen by the tool".into(),
        content: vec![ContentPart::Text("private result".into())],
        is_error: false,
    }
}

fn resolve_review(fixture: &Fixture, decision: ToolResultReviewDecision) {
    let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    let pending = snapshot
        .turns
        .last()
        .unwrap()
        .pending_interaction
        .as_ref()
        .unwrap();
    fixture
        .threads
        .resolve_turn_interaction(
            &fixture.thread_id,
            ResolveTurnInteractionRequest {
                command_id: CommandId::new("resolve-result").unwrap(),
                expected_sequence: SequenceExpectation::Exact(snapshot.sequence),
                turn_id: fixture.turn_id.clone(),
                request_id: pending.request_id.clone(),
                response: AgentResponse::ToolResultReview {
                    response: ToolResultReviewResponse { decision },
                },
            },
        )
        .unwrap();
}

#[test]
fn result_review_withholds_until_exact_reply_without_reexecuting_or_undoing() {
    for (decision, is_error) in [
        (ToolResultReviewDecision::Share, false),
        (ToolResultReviewDecision::Skip, false),
        (ToolResultReviewDecision::Share, true),
        (ToolResultReviewDecision::Skip, true),
    ] {
        let candidate = ToolResultReview {
            is_error,
            ..review()
        };
        let tool = Arc::new(ReviewTool {
            outputs: Mutex::new(VecDeque::from([
                ToolExecutionOutput::NeedsResultConfirmation(candidate.clone()),
            ])),
            ..Default::default()
        });
        let mut fixture = fixture_with(tool, Arc::new(ExecAllowPolicy::new()));
        let (sender, updates) = std::sync::mpsc::channel();
        fixture.scheduler = fixture
            .scheduler
            .with_thread_updates(Arc::new(ResultUpdates(sender)));
        std::thread::scope(|scope| {
            let running = scope.spawn(|| {
                fixture.scheduler.run_pending(
                    &fixture.thread_id,
                    &fixture.turn_id,
                    &CancellationSource::new().token(),
                )
            });
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
                if snapshot.turns.last().unwrap().pending_interaction.is_some() {
                    assert!(
                        !snapshot
                            .items
                            .iter()
                            .any(|item| matches!(item, ThreadItem::ToolResult { .. }))
                    );
                    assert_eq!(fixture.tools.authorizations.lock().unwrap().len(), 1);
                    break;
                }
                updates
                    .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                    .unwrap();
            }
            resolve_review(&fixture, decision);
            assert_eq!(
                running.join().unwrap().unwrap(),
                ToolSchedulingProgress::Complete
            );
        });
        let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
        let result = snapshot
            .items
            .iter()
            .find_map(|item| match item {
                ThreadItem::ToolResult { text, is_error, .. } => Some((text.as_str(), *is_error)),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            result.1,
            is_error && decision == ToolResultReviewDecision::Share
        );
        let result = result.0;
        match decision {
            ToolResultReviewDecision::Share => assert_eq!(result, "private result"),
            ToolResultReviewDecision::Skip => {
                assert!(!result.contains("private result"));
                assert!(result.contains("chose not to share"));
            }
        }
        assert_eq!(fixture.tools.authorizations.lock().unwrap().len(), 1);
        assert!(
            snapshot
                .resolved_interactions
                .iter()
                .any(|interaction| matches!(
                    &interaction.interaction.request,
                    AgentRequest::ToolResultReview { request } if request.review == candidate
                ))
        );
    }
}

#[test]
fn recovered_result_review_commits_retained_candidate_without_running_tool_again() {
    for (decision, answered_before_restart) in [
        (ToolResultReviewDecision::Share, true),
        (ToolResultReviewDecision::Skip, true),
        (ToolResultReviewDecision::Share, false),
        (ToolResultReviewDecision::Skip, false),
    ] {
        let mut fixture = fixture_with(
            Arc::new(ReviewTool::default()),
            Arc::new(ExecAllowPolicy::new()),
        );
        fixture
            .threads
            .record_tool_execution_started(
                &fixture.thread_id,
                &fixture.turn_id,
                crate::thread_controller::RecordToolExecutionStart {
                    tool_call_id: fixture.call_id.clone(),
                    action_digest: "a".repeat(64),
                    policy_revision: "test-policy-v1".into(),
                    authority: ToolExecutionAuthority::Sandboxed,
                    expected_review_sequence: None,
                },
            )
            .unwrap();
        fixture
            .threads
            .request_turn_interaction(
                &fixture.thread_id,
                &fixture.turn_id,
                RequestTurnInteraction {
                    request_id: RequestId::new("review-result").unwrap(),
                    item_id: fixture
                        .threads
                        .read_thread(&fixture.thread_id)
                        .unwrap()
                        .items
                        .iter()
                        .find_map(|item| match item {
                            ThreadItem::ToolCall { item_id, .. } => Some(item_id.clone()),
                            _ => None,
                        }),
                    request: AgentRequest::ToolResultReview {
                        request: ToolResultReviewRequest {
                            tool_call_id: fixture.call_id.clone(),
                            tool_name: ToolName::new("reviewed").unwrap(),
                            review: review(),
                        },
                    },
                    deadline: None,
                },
            )
            .unwrap();
        if answered_before_restart {
            resolve_review(&fixture, decision);
        }
        let recovered = Arc::new(ThreadController::with_store(fixture.store.clone()));
        recovered.recover_thread(&fixture.thread_id).unwrap();
        if !answered_before_restart {
            fixture.threads = recovered.clone();
            resolve_review(&fixture, decision);
        }
        ToolScheduler::new(
            recovered.clone(),
            fixture.tools.clone(),
            Arc::new(ExecAllowPolicy::new()),
        )
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();
        assert!(fixture.tools.authorizations.lock().unwrap().is_empty());
        assert!(
            recovered
                .read_thread(&fixture.thread_id)
                .unwrap()
                .items
                .iter()
                .any(|item| matches!(item, ThreadItem::ToolResult { .. }))
        );
    }
}

#[test]
fn result_review_rejects_unexecuted_and_completed_calls_and_oversized_evidence() {
    let fixture = fixture_with(
        Arc::new(ReviewTool::default()),
        Arc::new(ExecAllowPolicy::new()),
    );
    let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    let item_id = snapshot
        .items
        .iter()
        .find_map(|item| match item {
            ThreadItem::ToolCall { item_id, .. } => Some(item_id.clone()),
            _ => None,
        })
        .unwrap();
    let request = || RequestTurnInteraction {
        request_id: RequestId::new("invalid-review").unwrap(),
        item_id: Some(item_id.clone()),
        request: AgentRequest::ToolResultReview {
            request: ToolResultReviewRequest {
                tool_call_id: fixture.call_id.clone(),
                tool_name: ToolName::new("reviewed").unwrap(),
                review: review(),
            },
        },
        deadline: None,
    };
    assert!(
        fixture
            .threads
            .request_turn_interaction(&fixture.thread_id, &fixture.turn_id, request())
            .is_err()
    );
    fixture
        .scheduler
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();
    assert!(
        fixture
            .threads
            .request_turn_interaction(&fixture.thread_id, &fixture.turn_id, request())
            .is_err()
    );

    let mut oversized = review();
    oversized.content = vec![ContentPart::Text("x".repeat(4 * 1024 * 1024))];
    assert!(
        crate::thread_reducer::validate_agent_request(&AgentRequest::ToolResultReview {
            request: ToolResultReviewRequest {
                tool_call_id: fixture.call_id.clone(),
                tool_name: ToolName::new("reviewed").unwrap(),
                review: oversized,
            }
        })
        .is_err()
    );
}

#[test]
fn cancelled_result_review_does_not_disclose_or_reexecute() {
    let tool = Arc::new(ReviewTool {
        outputs: Mutex::new(VecDeque::from([
            ToolExecutionOutput::NeedsResultConfirmation(review()),
        ])),
        ..Default::default()
    });
    let mut fixture = fixture_with(tool, Arc::new(ExecAllowPolicy::new()));
    let (sender, updates) = std::sync::mpsc::channel();
    fixture.scheduler = fixture
        .scheduler
        .with_thread_updates(Arc::new(ResultUpdates(sender)));
    std::thread::scope(|scope| {
        let running = scope.spawn(|| {
            fixture.scheduler.run_pending(
                &fixture.thread_id,
                &fixture.turn_id,
                &CancellationSource::new().token(),
            )
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
            if let Some(pending) = &snapshot.turns.last().unwrap().pending_interaction {
                fixture
                    .threads
                    .cancel_turn_interaction(
                        &fixture.thread_id,
                        crate::CancelTurnInteractionRequest {
                            turn_id: fixture.turn_id.clone(),
                            request_id: pending.request_id.clone(),
                            reason: ash_protocol::InteractionCancelReason::OwnerDisconnected,
                        },
                    )
                    .unwrap();
                break;
            }
            updates
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .unwrap();
        }
        running.join().unwrap().unwrap();
    });
    let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    let text = snapshot
        .items
        .iter()
        .find_map(|item| match item {
            ThreadItem::ToolResult { text, .. } => Some(text),
            _ => None,
        })
        .unwrap();
    assert!(!text.contains("private result"));
    assert!(text.contains("not shared"));
    assert_eq!(fixture.tools.authorizations.lock().unwrap().len(), 1);
}
