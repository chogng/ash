use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Selects how a model may use the ordinary Tool catalog for one Turn.
///
/// `Direct` is the compatibility default. `CodeMode` keeps the ordinary direct surface and adds
/// the Code Mode entry points. `CodeModeOnly` exposes only those entry points while the projected
/// ordinary tools remain callable from JavaScript.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ToolMode {
    #[default]
    Direct,
    CodeMode,
    CodeModeOnly,
}

impl ToolMode {
    /// Returns whether the model receives ordinary direct Tool definitions.
    pub fn exposes_direct_tools(self) -> bool {
        matches!(self, Self::Direct | Self::CodeMode)
    }

    /// Returns whether this Turn requires the Code Mode runtime.
    pub fn requires_code_mode(self) -> bool {
        matches!(self, Self::CodeMode | Self::CodeModeOnly)
    }
}
