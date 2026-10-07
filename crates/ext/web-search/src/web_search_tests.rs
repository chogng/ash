use std::sync::Arc;

use ash_async_utils::CancellationSource;
use ash_extension_api::ExtensionRegistryBuilder;
use ash_protocol::ToolSourceProvenance;
use ash_protocol::TurnId;
use ash_tools::EnvId;
use ash_tools::ToolBinding;
use ash_tools::ToolBindingId;
use ash_tools::ToolContent;
use ash_tools::ToolExecutionContext;
use ash_tools::ToolExecutionOutcome;
use ash_tools::ToolInvocation;
use ash_tools::ToolOperationId;
use ash_tools::ToolPayload;
use ash_tools::ToolRegistryGeneration;
use ash_tools::ToolRuntimeAuthority;
use ash_tools::ToolRuntimeKey;

use crate::WebSearchBackend;
use crate::WebSearchError;
use crate::WebSearchRequest;
use crate::WebSearchResponse;
use crate::WebSearchResult;
use crate::install;

struct FakeBackend;

impl WebSearchBackend for FakeBackend {
    fn service_name(&self) -> &str {
        "test search"
    }

    fn network_scopes(&self) -> Vec<String> {
        vec!["search.example.com".into()]
    }

    fn credential_reference(&self) -> Option<String> {
        Some("secret:test-search".into())
    }

    fn search(
        &self,
        request: &WebSearchRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<WebSearchResponse, WebSearchError> {
        Ok(WebSearchResponse {
            results: vec![WebSearchResult {
                title: request.search_query[0].q.clone(),
                url: "https://example.com/result".into(),
                snippet: "matched".into(),
                published_at: None,
            }],
        })
    }
}

#[test]
fn install_contributes_capability_tool_and_executes_backend() {
    let mut builder = ExtensionRegistryBuilder::new();
    install(&mut builder, Arc::new(FakeBackend));
    let registry = builder.build();
    let contribution = registry.contribute_capability_tools().unwrap().remove(0);
    let executor = contribution.executor().clone();
    let definition = executor.definition();
    let binding = ToolBinding::new(
        ToolRegistryGeneration::new(1),
        ToolBindingId::new("web-search@1").unwrap(),
        definition.name().clone(),
        definition.digest(),
        ToolRuntimeKey::new("web-search-runtime").unwrap(),
    )
    .with_source_chain(vec![ToolSourceProvenance::Extension {
        id: "web-search".into(),
    }]);
    let cancellation = CancellationSource::new();
    let invocation = ToolInvocation::new(
        ToolOperationId::new("operation-1").unwrap(),
        ash_protocol::ToolCallId::new("call-1").unwrap(),
        TurnId::new("turn-1").unwrap(),
        binding,
        ToolPayload::FunctionArguments(serde_json::json!({
            "search_query": [{"q": "rust extension design"}],
            "response_length": "short"
        })),
        ToolExecutionContext::new(
            EnvId::new("host-extension").unwrap(),
            cancellation.token(),
            ToolRuntimeAuthority::Unrestricted,
        )
        .with_session_id(ash_protocol::SessionId::new("session").unwrap())
        .with_thread_id(ash_protocol::ThreadId::new("thread").unwrap()),
    );

    let outcome = pollster::block_on(executor.execute(invocation));
    let items = ash_extension_api::ExtensionItemStore::new(registry.state().clone());
    let items = ash_extension_api::ItemContributor::contribute(
        &items,
        ash_extension_api::ThreadContext {
            session_id: &ash_protocol::SessionId::new("session").unwrap(),
            thread_id: &ash_protocol::ThreadId::new("thread").unwrap(),
            sequence: 1,
        },
    )
    .unwrap();
    assert!(
        matches!(&items[0].content,extension_items::ExtensionItemContent::WebSearch{sources,..} if sources[0].url=="https://example.com/result")
    );

    assert!(matches!(
        outcome,
        ToolExecutionOutcome::Returned(output)
            if matches!(&output.content()[0], ToolContent::Text(text) if text.contains("rust extension design"))
    ));
}
