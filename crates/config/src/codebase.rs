use ash_protocol::ModelRef;
use serde::Deserialize;
use serde::Serialize;

/// User-selected device-local models for semantic codebase indexing and query.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodebaseModelSelection {
    pub embedding_model: ModelRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rerank_model: Option<ModelRef>,
}

/// Whether code retrieval is automatically added to the first model invocation of a Turn.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum CodebaseAutomaticContext {
    #[default]
    Off,
    FirstInvocation,
}

/// Durable local Codebase preferences. Cloud publication consent is owned by Cloud Codebase.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodebaseConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<CodebaseModelSelection>,
    #[serde(default)]
    pub automatic_context: CodebaseAutomaticContext,
}

impl CodebaseConfig {
    pub(crate) fn replace_models(&mut self, models: Option<CodebaseModelSelection>) {
        self.models = models;
    }

    pub(crate) fn replace_automatic_context(
        &mut self,
        automatic_context: CodebaseAutomaticContext,
    ) {
        self.automatic_context = automatic_context;
    }
}
