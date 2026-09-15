use std::sync::Arc;

use ash_tools::ToolConcurrency;
use ash_tools::ToolContent;
use ash_tools::ToolDefinition;
use ash_tools::ToolExecutionFuture;
use ash_tools::ToolExecutionOutcome;
use ash_tools::ToolExecutor;
use ash_tools::ToolInputSchema;
use ash_tools::ToolInvocation;
use ash_tools::ToolLoading;
use ash_tools::ToolName;
use ash_tools::ToolOutput;
use ash_tools::ToolOutputSchema;
use ash_tools::ToolPayload;
use ash_tools::ToolSchemaMode;
use ash_tools::ToolStartFailure;
use serde_json::json;

use crate::WebSearchBackend;
use crate::WebSearchRequest;

pub const WEB_SEARCH_TOOL_NAME: &str = "web_search";

pub(crate) struct WebSearchTool {
    backend: Arc<dyn WebSearchBackend>,
    items: Arc<ash_extension_api::ExtensionItemStore>,
    definition: ToolDefinition,
}

impl WebSearchTool {
    pub(crate) fn new(
        backend: Arc<dyn WebSearchBackend>,
        items: Arc<ash_extension_api::ExtensionItemStore>,
    ) -> Self {
        Self {
            backend,
            items,
            definition: definition(),
        }
    }
}

impl ToolExecutor for WebSearchTool {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::ParallelSafe
    }

    fn execute(&self, invocation: ToolInvocation) -> ToolExecutionFuture<'_> {
        Box::pin(async move {
            let ToolPayload::FunctionArguments(arguments) = invocation.payload() else {
                return ToolExecutionOutcome::NotStarted(ToolStartFailure::new(
                    "Web Search requires function arguments",
                ));
            };
            let request = match serde_json::from_value::<WebSearchRequest>(arguments.clone()) {
                Ok(request) => request,
                Err(error) => {
                    return ToolExecutionOutcome::NotStarted(ToolStartFailure::new(format!(
                        "invalid Web Search arguments: {error}"
                    )));
                }
            };
            if let Err(error) = request.validate() {
                return ToolExecutionOutcome::NotStarted(ToolStartFailure::new(error.to_string()));
            }
            let (Some(session), Some(thread)) = (
                invocation.context().session_id(),
                invocation.context().thread_id(),
            ) else {
                return ToolExecutionOutcome::NotStarted(ToolStartFailure::new(
                    "Search requires a bound Session and Thread",
                ));
            };
            match self
                .backend
                .search(&request, invocation.context().cancellation())
            {
                Ok(response) => {
                    let item = extension_items::ExtensionItem {
                        extension: "web-search".into(),
                        id: invocation.call_id().as_str().into(),
                        title: "Web search".into(),
                        body: request
                            .search_query
                            .iter()
                            .map(|q| q.q.as_str())
                            .collect::<Vec<_>>()
                            .join("\n"),
                        status: extension_items::ExtensionItemStatus::Completed,
                        content: extension_items::ExtensionItemContent::WebSearch {
                            queries: request.search_query.iter().map(|q| q.q.clone()).collect(),
                            sources: response
                                .results
                                .iter()
                                .map(|result| extension_items::SearchSource {
                                    title: result.title.clone(),
                                    url: result.url.clone(),
                                })
                                .collect(),
                        },
                    };
                    if let Err(error) = self.items.publish(session, thread, item) {
                        return ToolExecutionOutcome::Returned(ToolOutput::error(vec![
                            ToolContent::Text(error.to_string()),
                        ]));
                    }
                    match serde_json::to_string(&response) {
                        Ok(response) => ToolExecutionOutcome::Returned(ToolOutput::success(vec![
                            ToolContent::Text(response),
                        ])),
                        Err(error) => ToolExecutionOutcome::NotStarted(ToolStartFailure::new(
                            error.to_string(),
                        )),
                    }
                }
                Err(error) => {
                    ToolExecutionOutcome::Returned(ToolOutput::error(vec![ToolContent::Text(
                        error.to_string(),
                    )]))
                }
            }
        })
    }
}

fn definition() -> ToolDefinition {
    ToolDefinition::function(
        ToolName::new(WEB_SEARCH_TOOL_NAME).expect("Web Search tool name is valid"),
        "Search the public web through the host-configured provider. Supports up to four exact queries with optional domain and recency filters.",
        ToolInputSchema::parse(json!({
            "type": "object",
            "properties": {
                "search_query": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 4,
                    "items": {
                        "type": "object",
                        "properties": {
                            "q": {"type": "string"},
                            "domains": {
                                "type": "array",
                                "items": {"type": "string"}
                            },
                            "recency_days": {"type": "integer", "minimum": 1}
                        },
                        "required": ["q"],
                        "additionalProperties": false
                    }
                },
                "response_length": {
                    "type": "string",
                    "enum": ["short", "medium", "long"]
                }
            },
            "required": ["search_query"],
            "additionalProperties": false
        }))
        .expect("Web Search schema is valid"),
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::Strict,
        ToolLoading::Eager,
    )
    .expect("Web Search definition is valid")
}
