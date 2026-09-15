use std::future;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::CapabilitySet;
use ash_action_policy::GrantId;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationSource;
use core_api::CoreError;
use ash_core::ToolAuthorization;
use ash_core::ToolOutputSink;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallId;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use ash_protocol::ToolOutputStream;
use ash_protocol::TurnId;
use ash_tools::EnvId;
use ash_tools::ToolBinding;
use ash_tools::ToolBindingId;
use ash_tools::ToolContent;
use ash_tools::ToolDefinition;
use ash_tools::ToolExecutionFuture;
use ash_tools::ToolExecutionOutcome;
use ash_tools::ToolExecutor;
use ash_tools::ToolInputSchema;
use ash_tools::ToolLoading;
use ash_tools::ToolOutput;
use ash_tools::ToolOutputSchema;
use ash_tools::ToolPayload;
use ash_tools::ToolRegistryGeneration;
use ash_tools::ToolRuntimeKey;
use ash_tools::ToolSchemaMode;

use super::PreparedToolExecution;
use super::ToolExecutorReviewer;
use super::ToolExecutorRuntime;

struct RecordingExecutor {
    definition: ToolDefinition,
    saw_frozen_binding: Arc<AtomicBool>,
    content: Vec<ToolContent>,
}

impl ToolExecutor for RecordingExecutor {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn execute(&self, invocation: ash_tools::ToolInvocation) -> ToolExecutionFuture<'_> {
        self.saw_frozen_binding.store(
            invocation.binding().id().as_str() == "binding-7"
                && invocation.binding().registry_generation() == ToolRegistryGeneration::new(7)
                && invocation.context().environment_id().as_str() == "env-7"
                && invocation.context().session_id().map(|id| id.as_str()) == Some("session-7")
                && invocation.context().thread_id().map(|id| id.as_str()) == Some("thread-7"),
            Ordering::SeqCst,
        );
        Box::pin(future::ready(ToolExecutionOutcome::Returned(
            ToolOutput::success(self.content.clone()),
        )))
    }
}

struct UnusedReviewer;

impl ToolExecutorReviewer for UnusedReviewer {
    fn prepare(&self, call: &ToolCall) -> Result<PreparedToolExecution, CoreError> {
        Ok(PreparedToolExecution::new(
            ActionReviewRequest::new(
                ResolvedAction::new(
                    ActionDigest::from_canonical_bytes(b"executor-test"),
                    ActionKind::SystemOperation,
                    "executor test",
                    CapabilitySet::new([]),
                ),
                ActionProvenance::new(ActionSource::BuiltInTool, "executor-test"),
                SandboxCompatibility::NotApplicable {
                    reason: "test".into(),
                },
                ActionPolicyRevision::new("test"),
            ),
            ToolPayload::FunctionArguments(call.arguments.clone()),
        ))
    }
}

struct DirPermitReviewer(ash_file_access::Authorization);

impl ToolExecutorReviewer for DirPermitReviewer {
    fn prepare(&self, call: &ToolCall) -> Result<PreparedToolExecution, CoreError> {
        UnusedReviewer
            .prepare(call)
            .map(|prepared| prepared.with_dir_authorization(self.0.clone()))
    }
}

#[derive(Default)]
struct RecordingSink {
    values: Vec<(ToolOutputStream, String)>,
}

impl ToolOutputSink for RecordingSink {
    fn emit(&mut self, stream: ToolOutputStream, text: String) -> Result<(), CoreError> {
        self.values.push((stream, text));
        Ok(())
    }
}

#[test]
fn executor_runtime_preserves_registry_binding_environment_and_output() {
    let definition = ToolDefinition::function(
        ToolName::new("executor-tool").unwrap(),
        "executor tool",
        ToolInputSchema::parse(serde_json::json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }))
        .unwrap(),
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::ProviderDefault,
        ToolLoading::Eager,
    )
    .unwrap();
    let binding = ToolBinding::new(
        ToolRegistryGeneration::new(7),
        ToolBindingId::new("binding-7").unwrap(),
        definition.name().clone(),
        definition.digest(),
        ToolRuntimeKey::new("executor:7").unwrap(),
    );
    let observed = Arc::new(AtomicBool::new(false));
    let runtime = ToolExecutorRuntime::new(
        Arc::new(RecordingExecutor {
            definition,
            saw_frozen_binding: Arc::clone(&observed),
            content: vec![ToolContent::Text("executor-result".into())],
        }),
        EnvId::new("env-7").unwrap(),
        Arc::new(UnusedReviewer),
    );
    let call = ToolCall {
        id: ToolCallId::new("call-7").unwrap(),
        name: ToolName::new("executor-tool").unwrap(),
        arguments: serde_json::json!({}),
    };
    let mut sink = RecordingSink::default();
    runtime.prepare(&call).unwrap();

    let output = runtime
        .execute_for_turn(
            &binding,
            &call,
            &ToolAuthorization::UnsandboxedGrant {
                grant_id: GrantId::new("test"),
            },
            &CancellationSource::new().token(),
            &ash_protocol::SessionId::new("session-7").unwrap(),
            &ash_protocol::ThreadId::new("thread-7").unwrap(),
            &TurnId::new("turn-7").unwrap(),
            None,
            &mut sink,
        )
        .unwrap();

    assert!(observed.load(Ordering::SeqCst));
    assert!(matches!(
        output,
        ToolExecutionOutput::SuccessContent(content)
            if content == vec![ash_protocol::ContentPart::Text("executor-result".into())]
    ));
    assert_eq!(
        sink.values,
        vec![(ToolOutputStream::Stdout, "executor-result".into())]
    );
}

#[test]
fn executor_runtime_rechecks_and_retires_a_revoked_dir_authorization() {
    let definition = ToolDefinition::function(
        ToolName::new("guarded-executor").unwrap(),
        "guarded executor",
        ToolInputSchema::parse(serde_json::json!({"type": "object"})).unwrap(),
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::ProviderDefault,
        ToolLoading::Eager,
    )
    .unwrap();
    let binding = ToolBinding::new(
        ToolRegistryGeneration::new(7),
        ToolBindingId::new("binding-7").unwrap(),
        definition.name().clone(),
        definition.digest(),
        ToolRuntimeKey::new("executor:9").unwrap(),
    );
    let dir = tempfile::tempdir().unwrap();
    let authorization = Grant::for_environment(
        Dir::open_local(dir.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ExecuteCommands]),
    );
    let guard = authorization
        .authorize(Permission::ExecuteCommands)
        .unwrap();
    let executed = Arc::new(AtomicBool::new(false));
    let runtime = ToolExecutorRuntime::new(
        Arc::new(RecordingExecutor {
            definition,
            saw_frozen_binding: Arc::clone(&executed),
            content: Vec::new(),
        }),
        EnvId::new("env-7").unwrap(),
        Arc::new(DirPermitReviewer(guard)),
    );
    let call = ToolCall {
        id: ToolCallId::new("call-9").unwrap(),
        name: ToolName::new("guarded-executor").unwrap(),
        arguments: serde_json::json!({}),
    };
    runtime.prepare(&call).unwrap();
    authorization.revoke();

    let result = runtime.execute_for_turn(
        &binding,
        &call,
        &ToolAuthorization::UnsandboxedGrant {
            grant_id: GrantId::new("test"),
        },
        &CancellationSource::new().token(),
        &ash_protocol::SessionId::new("session-9").unwrap(),
        &ash_protocol::ThreadId::new("thread-9").unwrap(),
        &TurnId::new("turn-9").unwrap(),
        None,
        &mut RecordingSink::default(),
    );

    assert!(matches!(result, Err(CoreError::Execution(_))));
    assert!(!executed.load(Ordering::SeqCst));
    assert!(
        runtime
            .prepared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty()
    );
}

#[test]
fn executor_runtime_preserves_original_image_detail_until_model_capability_gate() {
    let definition = ToolDefinition::function(
        ToolName::new("image-tool").unwrap(),
        "image tool",
        ToolInputSchema::parse(serde_json::json!({"type": "object"})).unwrap(),
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::ProviderDefault,
        ToolLoading::Eager,
    )
    .unwrap();
    let binding = ToolBinding::new(
        ToolRegistryGeneration::new(8),
        ToolBindingId::new("binding-8").unwrap(),
        definition.name().clone(),
        definition.digest(),
        ToolRuntimeKey::new("executor:8").unwrap(),
    );
    let runtime = ToolExecutorRuntime::new(
        Arc::new(RecordingExecutor {
            definition,
            saw_frozen_binding: Arc::new(AtomicBool::new(false)),
            content: vec![ToolContent::Image {
                url: "data:image/png;base64,AA==".into(),
                detail: ash_tools::ImageDetail::Original,
            }],
        }),
        EnvId::new("env-7").unwrap(),
        Arc::new(UnusedReviewer),
    );
    let call = ToolCall {
        id: ToolCallId::new("call-8").unwrap(),
        name: ToolName::new("image-tool").unwrap(),
        arguments: serde_json::json!({}),
    };
    runtime.prepare(&call).unwrap();

    let output = runtime
        .execute_for_turn(
            &binding,
            &call,
            &ToolAuthorization::UnsandboxedGrant {
                grant_id: GrantId::new("test"),
            },
            &CancellationSource::new().token(),
            &ash_protocol::SessionId::new("session-8").unwrap(),
            &ash_protocol::ThreadId::new("thread-8").unwrap(),
            &TurnId::new("turn-8").unwrap(),
            None,
            &mut RecordingSink::default(),
        )
        .unwrap();

    assert!(matches!(
        output,
        ToolExecutionOutput::SuccessContent(content)
            if content == vec![ash_protocol::ContentPart::ImageUrl {
                url: "data:image/png;base64,AA==".into(),
                detail: ash_protocol::ImageDetail::Original,
            }]
    ));
}

#[test]
fn executor_output_adapter_truncates_text_before_protocol_and_streaming() {
    let mut sink = RecordingSink::default();
    let output = super::returned_output_with_policy(
        ToolOutput::success(vec![ToolContent::Text("executor output ".repeat(32))]),
        &mut sink,
        ash_tools::ToolOutputTruncationPolicy::Bytes(128),
    )
    .expect("tool output should adapt");

    let text = match output {
        ToolExecutionOutput::SuccessContent(content) => match &content[..] {
            [ash_protocol::ContentPart::Text(text)] => text.clone(),
            other => panic!("unexpected content: {other:?}"),
        },
        other => panic!("unexpected output: {other:?}"),
    };
    assert!(text.len() <= 128);
    assert!(text.contains("Warning: truncated output"));
    assert_eq!(sink.values, vec![(ToolOutputStream::Stdout, text.clone())]);
}
