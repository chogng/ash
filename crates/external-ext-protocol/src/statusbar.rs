use serde::Deserialize;
use serde::Serialize;
use serde_json::Number;
use serde_json::Value;

use crate::ProtocolError;
use crate::validation::validate_identifier;

/// UI values only; the client owns entry accessors and command execution.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionStatusBarEntry {
    pub id: String,
    pub text: String,
    pub tooltip: Option<String>,
    pub aria_label: Option<String>,
    pub alignment: ExtensionStatusBarAlignment,
    #[cfg_attr(feature = "json-schema", schemars(with = "f64"))]
    #[cfg_attr(feature = "export", ts(type = "number"))]
    pub priority: Number,
    pub command: Option<ExtensionStatusBarCommand>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ExtensionStatusBarAlignment {
    Left,
    Right,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "export", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionStatusBarCommand {
    pub command: String,
    pub arguments: Vec<Value>,
}

pub(crate) fn validate_entries(
    revision: u64,
    entries: &[ExtensionStatusBarEntry],
) -> Result<(), ProtocolError> {
    if revision == 0 || revision > 9_007_199_254_740_991 || entries.len() > 128 {
        return Err(ProtocolError::InvalidProtocol(
            "invalid status bar revision or entry count".into(),
        ));
    }
    let mut ids = std::collections::BTreeSet::new();
    for entry in entries {
        validate_identifier(&entry.id)?;
        if !ids.insert(&entry.id)
            || entry
                .priority
                .as_f64()
                .is_none_or(|value| !value.is_finite())
            || [
                &entry.text,
                entry.tooltip.as_ref().unwrap_or(&entry.text),
                entry.aria_label.as_ref().unwrap_or(&entry.text),
            ]
            .iter()
            .any(|value| value.len() > 8192 || value.contains('\0'))
        {
            return Err(ProtocolError::InvalidProtocol(
                "invalid status bar entry".into(),
            ));
        }
        if let Some(command) = &entry.command {
            validate_identifier(&command.command)?;
            if command.arguments.len() > 1024 {
                return Err(ProtocolError::QuotaExceeded("status bar command arguments"));
            }
        }
    }
    Ok(())
}
