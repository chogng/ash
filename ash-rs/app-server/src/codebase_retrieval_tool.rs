use std::num::NonZeroUsize;
use std::sync::Arc;

use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::Capability;
use ash_action_policy::CapabilityKind;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_cloud_codebase::CloudCodebaseController;
use ash_cloud_codebase::CodebaseDeploymentMode;
use ash_codebase::CodebaseRetrievalQuery;
use ash_codebase::CodebaseRetrievalService;
use ash_codebase::CodebaseSemanticService;
use ash_codebase::SymbolIndex;
use ash_core::ToolAuthorization;
use ash_core::ToolService;
use ash_file_access::Authorization;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use core_api::CoreError;
use serde::Deserialize;
use serde_json::json;

pub(crate) const CODE_RETRIEVAL_TOOL_NAME: &str = "search_code";

#[derive(Deserialize)]
struct SearchCodeArguments {
    query: String,
    max_results: Option<usize>,
}

/// Agent-facing read-only tool backed by Ash's canonical codebase-retrieval coordinator.
pub(crate) struct CodebaseRetrievalTool {
    authorization: Authorization,
    retrieval: CodebaseRetrievalService,
    symbol_index: Option<Arc<SymbolIndex>>,
    semantic: Option<Arc<CodebaseSemanticService>>,
    cloud: Option<Arc<CloudCodebaseController>>,
    definition: ToolDefinition,
    action_policy_revision: ActionPolicyRevision,
}

impl CodebaseRetrievalTool {
    pub(crate) fn new(
        authorization: Authorization,
        retrieval: CodebaseRetrievalService,
        symbol_index: Option<Arc<SymbolIndex>>,
        semantic: Option<Arc<CodebaseSemanticService>>,
        cloud: Option<Arc<CloudCodebaseController>>,
    ) -> Self {
        Self {
            authorization,
            retrieval,
            symbol_index,
            semantic,
            cloud,
            action_policy_revision: super::local_tools::local_policy_revision(),
            definition: ToolDefinition {
                name: ToolName::new(CODE_RETRIEVAL_TOOL_NAME)
                    .expect("static codebase-retrieval tool name is valid"),
                description: "Search the indexed codebase for code relevant to a natural-language query. Returns bounded, current source excerpts and reports whether semantic retrieval degraded to local lexical search.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Natural-language description, symbol, or behavior to find."
                        },
                        "max_results": {
                            "type": ["integer", "null"],
                            "minimum": 1,
                            "maximum": 20,
                            "description": "Maximum excerpts. Use null for 10."
                        }
                    },
                    "required": ["query", "max_results"],
                    "additionalProperties": false
                }),
                strict: true,
            },
        }
    }

    pub(crate) fn with_action_policy_revision(mut self, revision: ActionPolicyRevision) -> Self {
        self.action_policy_revision = revision;
        self
    }

    fn query(&self, call: &ToolCall) -> Result<CodebaseRetrievalQuery, CoreError> {
        self.authorization
            .ensure_active()
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        if call.name != self.definition.name {
            return Err(CoreError::Policy(format!(
                "tool is not available: {}",
                call.name
            )));
        }
        let arguments = serde_json::from_value::<SearchCodeArguments>(call.arguments.clone())
            .map_err(|error| {
                CoreError::Policy(format!("invalid search_code arguments: {error}"))
            })?;
        let limit = NonZeroUsize::new(arguments.max_results.unwrap_or(10))
            .filter(|limit| limit.get() <= 20)
            .ok_or_else(|| CoreError::Policy("max_results must be 1..=20".into()))?;
        CodebaseRetrievalQuery::new(arguments.query, limit)
            .map_err(|error| CoreError::Policy(error.to_string()))
    }

    fn service(&self) -> Result<CodebaseRetrievalService, CoreError> {
        let cloud = self.cloud.as_ref().filter(|cloud| {
            !matches!(
                cloud.status(),
                Ok(status) if status.deployment_mode == CodebaseDeploymentMode::LocalOnly
            )
        });
        let service = match (&self.semantic, cloud) {
            (_, Some(cloud)) => self
                .retrieval
                .clone()
                .with_enhancement(Arc::clone(cloud) as Arc<dyn ash_codebase::CodebaseEnhancement>),
            (Some(semantic), None) => self.retrieval.clone().with_semantic(Arc::clone(semantic)),
            (None, None) => Ok(self.retrieval.clone()),
        }
        .map_err(|error| CoreError::Execution(error.to_string()))?;
        match &self.symbol_index {
            Some(symbol_index) => service
                .with_symbol_index(Arc::clone(symbol_index))
                .map_err(|error| CoreError::Execution(error.to_string())),
            None => Ok(service),
        }
    }
}

impl ToolService for CodebaseRetrievalTool {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![self.definition.clone()]
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        let query = self.query(call)?;
        let canonical = serde_json::to_vec(&json!({
            "root": self.retrieval.root_id().as_str(),
            "query": query.text(),
            "max_results": query.result_limit().get(),
        }))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::SystemOperation,
                "retrieve bounded source excerpts from the active Codebase",
                CapabilitySet::new([Capability::new(
                    CapabilityKind::FileRead,
                    self.authorization
                        .dir()
                        .canonical_path()
                        .display()
                        .to_string(),
                )]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, CODE_RETRIEVAL_TOOL_NAME),
            SandboxCompatibility::NotApplicable {
                reason: "code retrieval reads an authorized in-process codebase index".into(),
            },
            self.action_policy_revision.clone(),
        ))
    }

    fn execute(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        if !matches!(
            authorization,
            ToolAuthorization::UnsandboxedGrant { grant_id }
                if grant_id.as_str() == "codebase-read"
        ) && !matches!(
            authorization,
            ToolAuthorization::ExecPolicyGranted(grant)
                if grant.policy_grant().source().rule_id().as_str()
                    == "codebase-read"
        ) {
            return Err(CoreError::Policy(
                "search_code requires the exact read-only codebase grant".into(),
            ));
        }
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let result = self
            .service()?
            .retrieve_with_cancellation(&self.query(call)?, cancellation)
            .map_err(|error| match error {
                ash_codebase::CodebaseRetrievalError::Cancelled(reason) => {
                    CoreError::Cancelled(reason)
                }
                other => CoreError::Execution(other.to_string()),
            })?;
        let hits = result
            .hits
            .into_iter()
            .map(|hit| {
                json!({
                    "path": hit.reference.relative_path,
                    "start_line": hit.reference.span.start_line,
                    "end_line_exclusive": hit.reference.span.end_line_exclusive,
                    "language": hit.language.id(),
                    "content": hit.content,
                    "origins": hit.origins.into_iter().map(|origin| format!("{origin:?}")).collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>();
        serde_json::to_string_pretty(&json!({
            "hits": hits,
            "degradations": result.degradations.into_iter().map(|item| format!("{item:?}")).collect::<Vec<_>>(),
        }))
        .map(ToolExecutionOutput::Success)
        .map_err(|error| CoreError::Execution(error.to_string()))
    }
}

#[cfg(test)]
#[path = "codebase_retrieval_tool_tests.rs"]
mod tests;
