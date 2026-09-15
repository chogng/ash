use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;

use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::GrantId;
use ash_action_policy::ResolvedAction;
use ash_action_policy::ReviewEvidence;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolInteractionService;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use ash_protocol::AgentRequest;
use ash_protocol::AgentResponse;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use ash_protocol::ToolSourceProvenance;
use core_api::CoreError;
use sha2::Digest;
use sha2::Sha256;

pub(super) const MCP_SEARCH_TOOLS_NAME: &str = "search_tools";
const MCP_CALL_TOOL_NAME: &str = "call_mcp_tool";
const MCP_DIRECT_TOOL_LIMIT: usize = 15;
const MCP_DIRECT_TOKEN_LIMIT: usize = 5_000;
const MCP_SEARCH_RESULT_LIMIT: usize = 5;
const MCP_SEARCH_QUERY_BYTE_LIMIT: usize = 1_000;
const MCP_CATALOG_POLICY_REVISION: &str = "mcp-catalog-search-v1";

pub(super) fn project_mcp_service(tools: Arc<dyn ToolService>) -> Arc<dyn ToolService> {
    let definitions = tools.definitions();
    let estimate = estimate_definition_tokens(&definitions);
    if definitions.len() <= MCP_DIRECT_TOOL_LIMIT && estimate <= MCP_DIRECT_TOKEN_LIMIT {
        tools
    } else {
        Arc::new(McpMetaToolService::new(tools, definitions))
    }
}

pub(super) fn decide_mcp_catalog_search(
    request: &ActionReviewRequest,
    cancellation: &CancellationToken,
) -> Result<ExecutionDecision, CoreError> {
    cancellation
        .check()
        .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
    if request.action_policy_revision().as_str() != MCP_CATALOG_POLICY_REVISION
        || request.provenance().source() != &ActionSource::BuiltInTool
        || request.provenance().source_id() != MCP_SEARCH_TOOLS_NAME
        || request.action().kind() != &ActionKind::SystemOperation
        || !request.action().required_capabilities().is_empty()
    {
        return Err(CoreError::Policy(
            "MCP catalog search policy rejected an action outside its read-only contract".into(),
        ));
    }
    Ok(ExecutionDecision::RunUnsandboxed {
        grant_id: GrantId::new("mcp-catalog-search-read-only"),
    })
}

fn estimate_definition_tokens(definitions: &[ToolDefinition]) -> usize {
    // Stable, local v1 estimate: canonical JSON bytes divided by four, rounded up.
    let bytes = serde_json::to_vec(definitions).map_or(usize::MAX, |value| value.len());
    bytes.saturating_add(3) / 4
}

struct McpMetaToolService {
    tools: Arc<dyn ToolService>,
    definitions: Vec<ToolDefinition>,
    by_name: BTreeMap<ToolName, CatalogEntry>,
    catalog_digest: String,
    meta_definitions: Vec<ToolDefinition>,
}

struct CatalogEntry {
    definition: ToolDefinition,
    definition_digest: String,
    search_text: String,
}

impl McpMetaToolService {
    fn new(tools: Arc<dyn ToolService>, mut definitions: Vec<ToolDefinition>) -> Self {
        definitions.sort_by(|left, right| left.name.cmp(&right.name));
        let catalog_digest = digest_json(&definitions);
        let by_name = definitions
            .iter()
            .cloned()
            .map(|definition| {
                let definition_digest = digest_json(&definition);
                let search_text = format!(
                    "{} {} {}",
                    definition.name, definition.description, definition.parameters
                )
                .to_lowercase();
                (
                    definition.name.clone(),
                    CatalogEntry {
                        definition,
                        definition_digest,
                        search_text,
                    },
                )
            })
            .collect();
        let meta_definitions = meta_definitions(&catalog_digest);
        Self {
            tools,
            definitions,
            by_name,
            catalog_digest,
            meta_definitions,
        }
    }

    fn parse(&self, call: &ToolCall) -> Result<MetaCall, CoreError> {
        match call.name.as_str() {
            MCP_SEARCH_TOOLS_NAME => {
                let arguments = serde_json::from_value::<SearchArguments>(call.arguments.clone())
                    .map_err(|error| {
                    CoreError::Policy(format!("invalid MCP catalog search arguments: {error}"))
                })?;
                let query = arguments.query.trim();
                if query.is_empty() || query.len() > MCP_SEARCH_QUERY_BYTE_LIMIT {
                    return Err(CoreError::Policy(format!(
                        "MCP catalog search query must contain between 1 and {MCP_SEARCH_QUERY_BYTE_LIMIT} bytes"
                    )));
                }
                Ok(MetaCall::Search(query.to_owned()))
            }
            MCP_CALL_TOOL_NAME => {
                let arguments = serde_json::from_value::<CallArguments>(call.arguments.clone())
                    .map_err(|error| {
                        CoreError::Policy(format!("invalid MCP tool call arguments: {error}"))
                    })?;
                if arguments.catalog_digest != self.catalog_digest {
                    return Err(CoreError::Policy(
                        "MCP catalog changed; use search_tools again".into(),
                    ));
                }
                let name = ToolName::new(arguments.tool)
                    .map_err(|error| CoreError::Policy(error.to_string()))?;
                let entry = self.by_name.get(&name).ok_or_else(|| {
                    CoreError::Policy(format!("unknown tool {name}; use search_tools first"))
                })?;
                if arguments.definition_digest != entry.definition_digest {
                    return Err(CoreError::Policy(format!(
                        "unknown tool {name}; use search_tools first"
                    )));
                }
                Ok(MetaCall::Invoke(ToolCall {
                    id: call.id.clone(),
                    name,
                    arguments: arguments.arguments,
                }))
            }
            _ => Err(CoreError::Policy(format!(
                "MCP meta-tool service cannot handle {}",
                call.name
            ))),
        }
    }

    fn prepare_search(&self, query: &str) -> Result<ActionReviewRequest, CoreError> {
        let canonical = serde_json::to_vec(&serde_json::json!({
            "catalog_digest": self.catalog_digest,
            "query": query,
        }))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::SystemOperation,
                "search the frozen MCP tool catalog",
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, MCP_SEARCH_TOOLS_NAME),
            SandboxCompatibility::NotApplicable {
                reason: "MCP catalog search reads an immutable in-process projection".into(),
            },
            ActionPolicyRevision::new(MCP_CATALOG_POLICY_REVISION),
        ))
    }

    fn execute_search(
        &self,
        query: &str,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        if !matches!(
            authorization,
            ToolAuthorization::UnsandboxedGrant { grant_id }
                if grant_id.as_str() == "mcp-catalog-search-read-only"
        ) {
            return Err(CoreError::Policy(
                "MCP catalog search requires the host read-only grant".into(),
            ));
        }
        let normalized = query.to_lowercase();
        let terms = normalized
            .split(|character: char| !character.is_alphanumeric())
            .filter(|term| !term.is_empty())
            .collect::<Vec<_>>();
        let mut ranked = self
            .by_name
            .values()
            .filter_map(|entry| {
                let name = entry.definition.name.as_str().to_lowercase();
                let mut score = terms
                    .iter()
                    .filter(|term| entry.search_text.contains(**term))
                    .count() as u64;
                if name == normalized {
                    score += 10_000;
                } else if name.contains(&normalized) {
                    score += 1_000;
                }
                (score > 0).then_some((score, entry))
            })
            .collect::<Vec<_>>();
        ranked.sort_by(|(left_score, left), (right_score, right)| {
            right_score
                .cmp(left_score)
                .then_with(|| left.definition.name.cmp(&right.definition.name))
        });
        ranked.truncate(MCP_SEARCH_RESULT_LIMIT);
        if ranked.is_empty() {
            let servers = self
                .definitions
                .iter()
                .filter_map(|definition| definition.name.as_str().split_once("__"))
                .map(|(server, _)| server)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
                .join(", ");
            return Ok(ToolExecutionOutput::Failure(format!(
                "no MCP tools match {query:?}. Available servers: {servers}"
            )));
        }
        let tools = ranked
            .into_iter()
            .map(|(_, entry)| SearchMatch {
                name: entry.definition.name.clone(),
                description: entry.definition.description.clone(),
                schema: entry.definition.parameters.clone(),
                catalog_digest: self.catalog_digest.clone(),
                definition_digest: entry.definition_digest.clone(),
            })
            .collect();
        serde_json::to_string(&SearchOutput { tools })
            .map(ToolExecutionOutput::Success)
            .map_err(|error| CoreError::Execution(error.to_string()))
    }

    fn nested_call(&self, call: &ToolCall) -> Result<ToolCall, CoreError> {
        match self.parse(call)? {
            MetaCall::Invoke(call) => Ok(call),
            MetaCall::Search(_) => Err(CoreError::Policy(
                "search_tools does not route to an MCP executor".into(),
            )),
        }
    }
}

impl ToolService for McpMetaToolService {
    fn definitions(&self) -> Vec<ToolDefinition> {
        self.meta_definitions.clone()
    }

    fn source_provenance(&self, _: &ToolName) -> Vec<ToolSourceProvenance> {
        vec![ToolSourceProvenance::System {
            id: format!("mcp-catalog:{}", self.catalog_digest),
        }]
    }

    fn execution_interaction(&self, call: &ToolCall) -> Result<Option<AgentRequest>, CoreError> {
        match self.parse(call)? {
            MetaCall::Search(_) => Ok(None),
            MetaCall::Invoke(call) => self.tools.execution_interaction(&call),
        }
    }

    fn resolve_execution_interaction(
        &self,
        call: &ToolCall,
        request: &AgentRequest,
        response: &AgentResponse,
    ) -> Result<Option<ToolExecutionOutput>, CoreError> {
        self.tools
            .resolve_execution_interaction(&self.nested_call(call)?, request, response)
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        match self.parse(call)? {
            MetaCall::Search(query) => self.prepare_search(&query),
            MetaCall::Invoke(call) => self.tools.prepare(&call),
        }
    }

    fn review_evidence(&self, call: &ToolCall) -> Result<Vec<ReviewEvidence>, CoreError> {
        match self.parse(call)? {
            MetaCall::Search(_) => Ok(Vec::new()),
            MetaCall::Invoke(call) => self.tools.review_evidence(&call),
        }
    }

    fn execute(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        match self.parse(call)? {
            MetaCall::Search(query) => self.execute_search(&query, authorization, cancellation),
            MetaCall::Invoke(call) => self.tools.execute(&call, authorization, cancellation),
        }
    }

    fn execute_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
    ) -> Result<ToolExecutionOutput, CoreError> {
        match self.parse(call)? {
            MetaCall::Search(query) => self.execute_search(&query, authorization, cancellation),
            MetaCall::Invoke(call) => {
                self.tools
                    .execute_with_facts(&call, authorization, cancellation, facts)
            }
        }
    }

    fn execute_streaming(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        match self.parse(call)? {
            MetaCall::Search(query) => self.execute_search(&query, authorization, cancellation),
            MetaCall::Invoke(call) => {
                self.tools
                    .execute_streaming(&call, authorization, cancellation, sink)
            }
        }
    }

    fn execute_streaming_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        match self.parse(call)? {
            MetaCall::Search(query) => self.execute_search(&query, authorization, cancellation),
            MetaCall::Invoke(call) => self.tools.execute_streaming_with_facts(
                &call,
                authorization,
                cancellation,
                facts,
                sink,
            ),
        }
    }

    fn execute_streaming_with_facts_and_interactions(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        interactions: Arc<dyn ToolInteractionService>,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        match self.parse(call)? {
            MetaCall::Search(query) => self.execute_search(&query, authorization, cancellation),
            MetaCall::Invoke(call) => self.tools.execute_streaming_with_facts_and_interactions(
                &call,
                authorization,
                cancellation,
                facts,
                interactions,
                sink,
            ),
        }
    }
}

enum MetaCall {
    Search(String),
    Invoke(ToolCall),
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArguments {
    query: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CallArguments {
    tool: String,
    catalog_digest: String,
    definition_digest: String,
    arguments: serde_json::Value,
}

#[derive(serde::Serialize)]
struct SearchOutput {
    tools: Vec<SearchMatch>,
}

#[derive(serde::Serialize)]
struct SearchMatch {
    name: ToolName,
    description: String,
    schema: serde_json::Value,
    catalog_digest: String,
    definition_digest: String,
}

fn digest_json(value: &impl serde::Serialize) -> String {
    let bytes = serde_json::to_vec(value).expect("protocol tool definitions serialize");
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn meta_definitions(catalog_digest: &str) -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: ToolName::new(MCP_SEARCH_TOOLS_NAME).expect("static tool name is valid"),
            description: format!(
                "Search the frozen MCP catalog by capability. Returns at most five exact definitions and bindings. Catalog: {catalog_digest}."
            ),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Keywords describing the needed capability."
                    }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            strict: true,
        },
        ToolDefinition {
            name: ToolName::new(MCP_CALL_TOOL_NAME).expect("static tool name is valid"),
            description: format!(
                "Call one MCP definition returned by search_tools using its exact frozen binding. Catalog: {catalog_digest}."
            ),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "tool": {
                        "type": "string",
                        "description": "Exact fully qualified name returned by search_tools."
                    },
                    "catalog_digest": {
                        "type": "string",
                        "description": "Exact catalog digest returned by search_tools."
                    },
                    "definition_digest": {
                        "type": "string",
                        "description": "Exact definition digest returned by search_tools."
                    },
                    "arguments": {
                        "type": "object",
                        "description": "Arguments matching the returned tool schema.",
                        "additionalProperties": true
                    }
                },
                "required": ["tool", "catalog_digest", "definition_digest", "arguments"],
                "additionalProperties": false
            }),
            strict: true,
        },
    ]
}

#[cfg(test)]
#[path = "mcp_exposure_tests.rs"]
mod tests;
