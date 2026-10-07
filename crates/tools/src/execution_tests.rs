use super::{
    ToolConcurrency, ToolExecutionContext, ToolExecutionFuture, ToolExecutionOutcome, ToolExecutor,
    ToolInvocation, ToolPayload, ToolRuntimeAuthority,
};
use crate::{
    EnvId, ToolBinding, ToolBindingId, ToolDefinition, ToolInputSchema, ToolLoading, ToolName,
    ToolOperationId, ToolOutput, ToolOutputSchema, ToolRegistryGeneration, ToolRuntimeKey,
    ToolSchemaMode,
};
use ash_async_utils::CancellationSource;
use ash_protocol::{ToolCallId, TurnId};
use serde_json::json;

#[test]
fn invocation_keeps_the_frozen_binding_and_environment() {
    let definition = definition();
    let binding = ToolBinding::new(
        ToolRegistryGeneration::new(7),
        ToolBindingId::new("binding_1").expect("valid binding"),
        ToolName::new("search").expect("valid name"),
        definition.digest(),
        ToolRuntimeKey::new("builtin:search").expect("valid runtime"),
    );
    let invocation = ToolInvocation::new(
        ToolOperationId::new("operation_1").expect("valid operation"),
        ToolCallId::new("call_1").expect("valid call"),
        TurnId::new("turn_1").expect("valid turn"),
        binding,
        ToolPayload::FunctionArguments(json!({"query": "ash"})),
        ToolExecutionContext::new(
            EnvId::new("env_1").expect("valid environment"),
            CancellationSource::new().token(),
            ToolRuntimeAuthority::Unrestricted,
        )
        .with_execution_dir("/host/selected"),
    );

    assert_eq!(
        invocation.binding().runtime_key().as_str(),
        "builtin:search"
    );
    assert_eq!(invocation.binding().registry_generation().get(), 7);
    assert_eq!(invocation.context().environment_id().as_str(), "env_1");
    assert_eq!(
        invocation.context().execution_dir(),
        Some(std::path::Path::new("/host/selected"))
    );
    assert_eq!(
        invocation.context().authority(),
        ToolRuntimeAuthority::Unrestricted
    );
}

#[test]
fn executor_defaults_to_exclusive_direct_exposure() {
    let executor = TestExecutor {
        definition: definition(),
    };

    assert_eq!(executor.concurrency(), ToolConcurrency::Exclusive);
    assert_eq!(executor.exposure(), crate::ToolExposure::Direct);
}

struct TestExecutor {
    definition: ToolDefinition,
}

impl ToolExecutor for TestExecutor {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn execute(&self, _invocation: ToolInvocation) -> ToolExecutionFuture<'_> {
        Box::pin(std::future::ready(ToolExecutionOutcome::Returned(
            ToolOutput::success(Vec::new()),
        )))
    }
}

fn definition() -> ToolDefinition {
    ToolDefinition::function(
        ToolName::new("search").expect("valid tool name"),
        "Search documents.",
        ToolInputSchema::parse(json!({"type": "object", "properties": {}})).expect("valid schema"),
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::ProviderDefault,
        ToolLoading::Eager,
    )
    .expect("valid definition")
}
