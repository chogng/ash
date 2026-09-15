use super::*;
use crate::local::ProviderModelService;
use ash_core::CreateThreadRequest;
use ash_core::InMemoryThreadStore;
use ash_core::StartTurnRequest;
use ash_core::ThreadController;
use ash_core::TurnExecutor;
use ash_model_provider::ModelInvoker;
use ash_protocol::ApprovalMode;
use ash_protocol::CommandId;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ResponseItem;
use ash_protocol::SessionId;
use ash_protocol::StableTurnErrorCode;
use ash_protocol::StopReason;
use ash_protocol::ThreadId;
use ash_protocol::TurnStatus;
use ash_protocol::UserInput;
use core_api::SequenceExpectation;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;
use std::time::Instant;

#[test]
fn unary_provider_services_return_final_results_without_requesting_a_stream() {
    struct UnaryInvoker;
    impl ModelInvoker for UnaryInvoker {
        fn output_transport(&self) -> ash_protocol::ModelOutputTransport {
            ash_protocol::ModelOutputTransport::Unary
        }

        fn invoke_with_cancellation(
            &self,
            _: &ModelRequest,
            _: &ash_async_utils::CancellationToken,
        ) -> Result<ModelResponse, ModelProviderError> {
            Ok(ModelResponse {
                output: vec![ResponseItem::Text("complete".into())],
                usage: None,
                billing: None,
                stop_reason: StopReason::Completed,
            })
        }

        fn stream_with_cancellation(
            &self,
            _: &ModelRequest,
            _: &ash_async_utils::CancellationToken,
            _: &mut dyn ash_model_provider::ModelEventSink,
        ) -> Result<ModelResponse, ModelProviderError> {
            panic!("a declared unary provider must use its complete operation")
        }
    }
    struct NoDeltas;
    impl core_api::ModelStreamSink for NoDeltas {
        fn emit(&mut self, _: ash_protocol::ModelStreamEvent) -> Result<(), core_api::CoreError> {
            panic!("a unary result must not be turned into an incremental event")
        }
    }
    let service = ProviderModelService::new(Arc::new(UnaryInvoker));
    let response = core_api::ModelService::stream(
        &service,
        core_api::ModelSelection::ConfiguredDefault,
        &ModelRequest::text("hello"),
        &ash_async_utils::CancellationSource::new().token(),
        &mut NoDeltas,
    )
    .unwrap();
    assert_eq!(response.text(), "complete");
}

#[test]
fn provider_failure_categories_cross_the_product_boundary_without_raw_details() {
    let cases = [
        (
            ModelProviderError::ContextOverflow("raw context detail".into()),
            CoreError::ModelContextOverflow,
            "raw context detail",
        ),
        (
            ModelProviderError::AuthFailed("raw auth detail".into()),
            CoreError::ModelAuthFailed,
            "raw auth detail",
        ),
        (
            ModelProviderError::Credential("raw credential detail".into()),
            CoreError::ModelFailure(StableTurnError::provider_credentials()),
            "raw credential detail",
        ),
        (
            ModelProviderError::InvalidRequest("raw request detail".into()),
            CoreError::ModelInvalidRequest,
            "raw request detail",
        ),
        (
            ModelProviderError::InvalidResponse("raw response detail".into()),
            CoreError::ModelInvalidResponse,
            "raw response detail",
        ),
    ];

    for (provider_error, expected, raw_detail) in cases {
        let mapped = map_model_provider_error(provider_error);
        assert_eq!(mapped, expected);
        assert!(!mapped.to_string().contains(raw_detail));
    }
}

#[test]
fn transient_retry_delay_crosses_the_product_boundary_as_typed_metadata() {
    assert_eq!(
        map_model_provider_error(ModelProviderError::Api(ApiError::RateLimited {
            retry_after_ms: Some(1_250),
        })),
        CoreError::ModelTransient {
            failure: StableTurnError::rate_limited(),
            retry_after_ms: Some(1_250),
        }
    );
}

#[test]
fn provider_usage_limit_maps_to_a_non_retryable_goal_failure_category() {
    assert_eq!(
        map_model_provider_error(ModelProviderError::Api(ApiError::UsageLimited)),
        CoreError::ModelUsageLimited
    );
}

#[test]
fn direct_provider_failures_keep_retry_policy_and_stable_codes_through_the_turn() {
    let auth = run_provider_failure(ProviderFailure::Auth);
    assert_eq!(auth, (StableTurnErrorCode::ProviderAuth, false, 1));

    let invalid_response = run_provider_failure(ProviderFailure::InvalidResponse);
    assert_eq!(
        invalid_response,
        (StableTurnErrorCode::InvalidResponse, true, 2)
    );
}

#[test]
fn provider_context_overflow_compacts_and_retries_through_the_product_boundary() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let thread_id = ThreadId::new("provider-overflow-thread").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("provider-overflow-session").unwrap(),
            thread_id: thread_id.clone(),
            title: "provider overflow".into(),
        })
        .unwrap();
    let history_turn = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("provider-overflow-history").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "provider-error-policy-v1".into(),
                approval_mode: ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "old history".repeat(500),
                }],
            },
        )
        .unwrap()
        .turn_id;
    threads
        .complete_turn(&thread_id, &history_turn, "old answer".repeat(500))
        .unwrap();
    let turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("provider-overflow-current").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "provider-error-policy-v1".into(),
                approval_mode: ApprovalMode::AskPermissions,
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
    let invoker = Arc::new(RecoveringOverflowProviderInvoker::default());
    let model = Arc::new(ProviderModelService::new(invoker.clone()));
    TurnExecutor::without_tools(threads.clone(), model)
        .start(&thread_id, &turn_id)
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let snapshot = threads.read_thread(&thread_id).unwrap();
        let turn = snapshot.turns.last().unwrap();
        if turn.status == TurnStatus::Completed {
            assert_eq!(invoker.invocations.load(Ordering::Relaxed), 3);
            assert_eq!(snapshot.context_checkpoints.len(), 1);
            assert_eq!(snapshot.context_overflow_recoveries.len(), 1);
            assert_eq!(
                snapshot.context_checkpoints[0].summary,
                "provider checkpoint"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "provider overflow recovery did not complete"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

#[derive(Clone, Copy)]
enum ProviderFailure {
    Auth,
    InvalidResponse,
}

struct FailingProviderInvoker {
    failure: ProviderFailure,
    invocations: AtomicUsize,
}

#[derive(Default)]
struct RecoveringOverflowProviderInvoker {
    invocations: AtomicUsize,
}

impl ModelInvoker for RecoveringOverflowProviderInvoker {
    fn output_transport(&self) -> ash_protocol::ModelOutputTransport {
        ash_protocol::ModelOutputTransport::Unary
    }

    fn stream_with_cancellation(
        &self,
        _: &ModelRequest,
        _: &ash_async_utils::CancellationToken,
        _: &mut dyn ash_model_provider::ModelEventSink,
    ) -> Result<ModelResponse, ModelProviderError> {
        match self.invocations.fetch_add(1, Ordering::Relaxed) {
            0 => Err(ApiError::ContextOverflow("raw overflow response".into()).into()),
            1 => Ok(ModelResponse {
                output: vec![ResponseItem::Text("provider checkpoint".into())],
                usage: None,
                billing: None,
                stop_reason: StopReason::Completed,
            }),
            2 => Ok(ModelResponse {
                output: vec![ResponseItem::Text("recovered answer".into())],
                usage: None,
                billing: None,
                stop_reason: StopReason::Completed,
            }),
            _ => panic!("provider overflow recovery invoked the model more than three times"),
        }
    }
}

impl ModelInvoker for FailingProviderInvoker {
    fn output_transport(&self) -> ash_protocol::ModelOutputTransport {
        ash_protocol::ModelOutputTransport::Unary
    }

    fn stream_with_cancellation(
        &self,
        _: &ModelRequest,
        _: &ash_async_utils::CancellationToken,
        _: &mut dyn ash_model_provider::ModelEventSink,
    ) -> Result<ModelResponse, ModelProviderError> {
        self.invocations.fetch_add(1, Ordering::Relaxed);
        Err(match self.failure {
            ProviderFailure::Auth => ApiError::AuthFailed("raw auth response".into()).into(),
            ProviderFailure::InvalidResponse => {
                ApiError::InvalidResponse("raw invalid response".into()).into()
            }
        })
    }
}

fn run_provider_failure(failure: ProviderFailure) -> (StableTurnErrorCode, bool, usize) {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let thread_id = ThreadId::new("provider-error-thread").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("provider-error-session").unwrap(),
            thread_id: thread_id.clone(),
            title: "provider error".into(),
        })
        .unwrap();
    let turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("provider-error-start").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "provider-error-policy-v1".into(),
                approval_mode: ApprovalMode::AskPermissions,
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
    let invoker = Arc::new(FailingProviderInvoker {
        failure,
        invocations: AtomicUsize::new(0),
    });
    let model = Arc::new(ProviderModelService::new(invoker.clone()));
    TurnExecutor::without_tools(threads.clone(), model)
        .start(&thread_id, &turn_id)
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let snapshot = threads.read_thread(&thread_id).unwrap();
        let turn = snapshot.turns.last().unwrap();
        if turn.status == TurnStatus::Failed {
            let error = turn.failure.as_ref().unwrap();
            return (
                error.code,
                error.retryable,
                invoker.invocations.load(Ordering::Relaxed),
            );
        }
        assert!(
            Instant::now() < deadline,
            "provider failure did not terminate"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn configuration_and_http_failures_keep_their_categories() {
    let cases = [
        (
            ModelProviderError::ConfigurationMissing,
            StableTurnError::model_configuration(),
        ),
        (
            ModelProviderError::Credential("secret detail".into()),
            StableTurnError::provider_credentials(),
        ),
        (
            ModelProviderError::Api(ApiError::HttpStatus(401)),
            StableTurnError::provider_http(401),
        ),
        (
            ModelProviderError::Api(ApiError::HttpStatus(403)),
            StableTurnError::provider_http(403),
        ),
        (
            ModelProviderError::Api(ApiError::HttpStatus(404)),
            StableTurnError::provider_http(404),
        ),
    ];
    for (error, stable) in cases {
        assert_eq!(
            map_model_provider_error(error),
            CoreError::ModelFailure(stable)
        );
    }
    for (error, stable) in [
        (
            ApiError::HttpStatus(503),
            StableTurnError::provider_http(503),
        ),
        (
            ApiError::Transport("private endpoint".into()),
            StableTurnError::connection_failed(),
        ),
        (
            ApiError::Overloaded,
            StableTurnError::provider_unavailable(),
        ),
    ] {
        assert_eq!(
            map_model_provider_error(error.into()),
            CoreError::ModelTransient {
                failure: stable,
                retry_after_ms: None
            }
        );
    }
}
