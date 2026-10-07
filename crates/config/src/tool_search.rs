use ash_protocol::ModelRef;
use serde::Deserialize;
use serde::Serialize;

/// User-selected retrieval policy for deferred Agent tools.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ToolSearchModeConfig {
    /// Search names and metadata locally with exact/regex matching and BM25 ranking.
    #[default]
    Lexical,
    /// Require a ready embedding model, then merge its ranking with local lexical retrieval.
    HybridEmbedding,
}

/// Runtime-free user preference for deferred Agent-tool retrieval.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolSearchConfig {
    #[serde(default)]
    pub mode: ToolSearchModeConfig,
    /// Exact embedding model used only when hybrid retrieval is enabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_model: Option<ModelRef>,
}
