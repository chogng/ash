//! Shared Markdown formula-rendering contract. The renderer belongs to the optional
//! `markdown-math` extension.
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;

pub const CHANNEL: &str = "math.render.v1";

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

/// Results retain request order, including invalid formulas rendered as escaped source.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RenderResponse {
    pub html: Vec<String>,
}
