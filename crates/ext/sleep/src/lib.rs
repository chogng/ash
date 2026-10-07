//! Model-requested delays; clocks and scheduling stay in the runtime.
use extension_api::ExtensionError;
use extension_api::ExtensionItemStore;
use extension_api::ExtensionRegistryBuilder;
use extension_api::ReadOnlyToolContributor;
use serde_json::json;
use std::future::pending;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tools::ToolConcurrency;
use tools::ToolContent;
use tools::ToolDefinition;
use tools::ToolExecutionFuture;
use tools::ToolExecutionOutcome;
use tools::ToolExecutor;
use tools::ToolInputSchema;
use tools::ToolInvocation;
use tools::ToolLoading;
use tools::ToolName;
use tools::ToolOutput;
use tools::ToolOutputSchema;
use tools::ToolPayload;
use tools::ToolSchemaMode;

const MAX_WAIT_MS: u64 = 12 * 60 * 60 * 1000;
struct Sleep(Arc<ExtensionItemStore>);

/// Installs a cancellation-aware delay tool. Task conditions belong to their task tools.
pub fn install(builder: &mut ExtensionRegistryBuilder, items: Arc<ExtensionItemStore>) {
    builder.read_only_tool_contributor("sleep", Arc::new(Sleep(items)));
}

impl ReadOnlyToolContributor for Sleep {
    fn contribute(&self) -> Result<Vec<Arc<dyn ToolExecutor>>, ExtensionError> {
        Ok(vec![Arc::new(Sleep(Arc::clone(&self.0)))])
    }
}

impl ToolExecutor for Sleep {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function(
            ToolName::new("sleep").unwrap(),
            "Delay this execution for duration_ms, up to 12 hours, without model polling. Turn cancellation ends the wait. For a running command use shell-session action wait; for child Agents use wait_agent. Those tools return when their condition is met. This delay does not survive process restart; future scheduled runs belong to automation.",
            ToolInputSchema::parse(json!({
                "type": "object",
                "properties": {"duration_ms": {"type": "integer", "minimum": 0, "maximum": MAX_WAIT_MS}},
                "required": ["duration_ms"],
                "additionalProperties": false
            })).unwrap(),
            ToolOutputSchema::Unspecified,
            ToolSchemaMode::Strict,
            ToolLoading::Eager,
        ).expect("valid wait tool definition")
    }

    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::ParallelSafe
    }

    fn execute(&self, invocation: ToolInvocation) -> ToolExecutionFuture<'_> {
        Box::pin(async move {
            let output = match self.run(&invocation).await {
                Ok(output) => ToolOutput::success(vec![ToolContent::Text(output)]),
                Err(error) => ToolOutput::error(vec![ToolContent::Text(error)]),
            };
            ToolExecutionOutcome::Returned(output)
        })
    }
}

impl Sleep {
    async fn run(&self, invocation: &ToolInvocation) -> Result<String, String> {
        let (Some(session), Some(thread)) = (
            invocation.context().session_id(),
            invocation.context().thread_id(),
        ) else {
            return Err("Wait requires a bound Session and Thread".into());
        };
        let ToolPayload::FunctionArguments(args) = invocation.payload() else {
            return Err("Wait requires function arguments".into());
        };
        if args.as_object().is_none_or(|args| args.len() != 1) {
            return Err("Wait takes only duration_ms".into());
        }
        let ms = args["duration_ms"]
            .as_u64()
            .filter(|ms| *ms <= MAX_WAIT_MS)
            .ok_or("duration_ms must be between 0 and 43200000")?;
        let start = Instant::now();
        async_utils::wait_until(
            pending::<()>(),
            start + Duration::from_millis(ms),
            invocation.context().cancellation(),
        )
        .await
        .map_err(|signal| signal.reason().to_string())?;
        invocation
            .context()
            .cancellation()
            .check()
            .map_err(|signal| signal.reason().to_string())?;
        let elapsed = start.elapsed().as_millis();
        self.0
            .publish(
                session,
                thread,
                extension_items::ExtensionItem {
                    extension: "sleep".into(),
                    id: invocation.call_id().as_str().into(),
                    title: "Wait completed".into(),
                    body: format!("Waited {elapsed} ms"),
                    status: extension_items::ExtensionItemStatus::Completed,
                    content: extension_items::ExtensionItemContent::Sleep {
                        duration_ms: ms as u32,
                    },
                },
            )
            .map_err(|error| error.to_string())?;
        Ok(json!({"reason": "elapsed", "elapsed_ms": elapsed}).to_string())
    }
}

#[cfg(test)]
#[path = "wait_tests.rs"]
mod tests;
