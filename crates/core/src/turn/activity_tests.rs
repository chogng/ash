use super::*;

#[derive(Default)]
pub(super) struct Activity {
    entered: AtomicUsize,
    released: Arc<AtomicUsize>,
}

struct Scope(Arc<AtomicUsize>);

impl Drop for Scope {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

impl core_api::TurnExecutionActivity for Activity {
    fn enter(&self) -> Option<Box<dyn Send>> {
        self.entered.fetch_add(1, Ordering::SeqCst);
        Some(Box::new(Scope(Arc::clone(&self.released))))
    }
}

impl Activity {
    pub(super) fn assert_active(&self, count: usize) {
        assert_eq!(
            self.entered.load(Ordering::SeqCst) - self.released.load(Ordering::SeqCst),
            count
        );
    }

    pub(super) fn wait_released(&self, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.released.load(Ordering::SeqCst) < count {
            assert!(
                Instant::now() < deadline,
                "execution scope was not released"
            );
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(self.released.load(Ordering::SeqCst), count);
    }
}

struct ObservingModel {
    activity: Arc<Activity>,
    model: ScriptedModel,
}

impl ModelService for ObservingModel {
    fn invoke(
        &self,
        selection: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.activity.assert_active(1);
        self.model.invoke(selection, request, cancellation)
    }
}

#[test]
fn mailbox_execution_holds_activity_until_success_or_failure() {
    for (response, status) in [
        (Ok(text_response("done")), TurnStatus::Completed),
        (
            Err(CoreError::Execution("provider failed".into())),
            TurnStatus::Failed,
        ),
    ] {
        let (threads, thread_id, turn_id) = started_turn();
        let activity = Arc::new(Activity::default());
        let executor = TurnExecutor::without_tools(
            threads.clone(),
            Arc::new(ObservingModel {
                activity: activity.clone(),
                model: ScriptedModel::new([response]),
            }),
        )
        .with_execution_activity(activity.clone());
        executor.start(&thread_id, &turn_id).unwrap();
        activity.wait_released(1);
        activity.assert_active(0);
        assert_eq!(
            threads.read_thread(&thread_id).unwrap().turns[0].status,
            status
        );
    }
}

struct AskPolicy;

struct ApprovedWeatherTool;

impl ToolService for ApprovedWeatherTool {
    fn definitions(&self) -> Vec<ToolDefinition> {
        WeatherTool.definitions()
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        WeatherTool.prepare(call)
    }

    fn execute(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        assert!(matches!(authorization, ToolAuthorization::ApprovedOnce(_)));
        assert_eq!(call.arguments["city"], "Paris");
        Ok(ToolExecutionOutput::Success("sunny".into()))
    }
}

impl ActionPolicyService for AskPolicy {
    fn revision(&self) -> String {
        "test-policy-v1".into()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Ok(ExecutionDecision::AskUser(
            ash_action_policy::ApprovalRequest::new(
                request.action().digest().clone(),
                request.action().required_capabilities().clone(),
                "approval needed",
            ),
        ))
    }
}

#[test]
fn approval_wait_releases_activity_and_resume_reacquires_it() {
    let (threads, thread_id, turn_id) = started_turn();
    let activity = Arc::new(Activity::default());
    let executor = TurnExecutor::new(
        threads.clone(),
        Arc::new(ObservingModel {
            activity: activity.clone(),
            model: ScriptedModel::new([
                Ok(ModelResponse {
                    output: vec![ResponseItem::ToolCall(ToolCall {
                        id: ToolCallId::new("weather-call").unwrap(),
                        name: ToolName::new("weather").unwrap(),
                        arguments: json!({"city": "Paris"}),
                    })],
                    usage: None,
                    billing: None,
                    stop_reason: StopReason::ToolUse,
                }),
                Ok(text_response("done")),
            ]),
        }),
        Arc::new(ApprovedWeatherTool),
        Arc::new(AskPolicy),
    )
    .with_execution_activity(activity.clone());
    executor.start(&thread_id, &turn_id).unwrap();
    activity.wait_released(1);
    activity.assert_active(0);
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert_eq!(snapshot.turns[0].status, TurnStatus::WaitingForApproval);
    let pending = snapshot.turns[0].pending_interaction.as_ref().unwrap();
    threads
        .resolve_turn_interaction(
            &thread_id,
            crate::ResolveTurnInteractionRequest {
                command_id: CommandId::new("approve").unwrap(),
                expected_sequence: SequenceExpectation::Exact(snapshot.sequence),
                turn_id: turn_id.clone(),
                request_id: pending.request_id.clone(),
                response: AgentResponse::Approval {
                    response: ash_protocol::ActionApprovalResponse {
                        decision: ash_protocol::ActionApprovalDecision::ApproveOnce,
                    },
                },
            },
        )
        .unwrap();
    executor.resume(&thread_id, &turn_id).unwrap();
    activity.wait_released(2);
    activity.assert_active(0);
    assert_eq!(
        threads.read_thread(&thread_id).unwrap().turns[0].status,
        TurnStatus::Completed
    );
}

struct PanickingModel;

impl ModelService for PanickingModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        panic!("provider panicked");
    }
}

#[test]
fn provider_unwinding_releases_the_execution_scope() {
    let (threads, thread_id, turn_id) = started_turn();
    let activity = Arc::new(Activity::default());
    let executor = TurnExecutor::without_tools(threads, Arc::new(PanickingModel))
        .with_execution_activity(activity.clone());
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            executor.execute(&thread_id, &turn_id, &CancellationSource::new().token())
        }))
        .is_err()
    );
    activity.assert_active(0);
    assert_eq!(activity.released.load(Ordering::SeqCst), 1);
}
