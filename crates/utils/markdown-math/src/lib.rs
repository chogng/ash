//! Shared Markdown formula-rendering contract. The renderer belongs to the optional
//! `markdown-math` extension.
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;

pub const CHANNEL: &str = "math.render.v2";

/// One immutable document render; macro definitions never outlive this request.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RenderRequest {
    pub formulas: Vec<Formula>,
    #[serde(default)]
    pub macros: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Formula {
    pub source: String,
    pub display: Display,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Display {
    Inline,
    Block,
}

/// One result per input formula, in source order. Source fallbacks retain no duplicate source text.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RenderResponse {
    pub results: Vec<FormulaResult>,
}

/// Rendering failures and output limits affect an individual formula, not its siblings.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum FormulaResult {
    Rendered { html: String },
    Source { diagnostic: Diagnostic },
}

/// Stable reasons for consumers to present localized explanations alongside formula source.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "code", rename_all = "camelCase", deny_unknown_fields)]
pub enum Diagnostic {
    /// The bounded engine message is diagnostic detail, not product UI copy.
    InvalidFormula {
        message: String,
    },
    OutputLimit {},
}
