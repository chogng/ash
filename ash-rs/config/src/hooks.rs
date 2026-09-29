use crate::ConfigError;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

/// Stable namespaced identity for one declarative Hook.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(transparent)]
pub struct HookId(String);

impl HookId {
    pub fn new(value: impl Into<String>) -> Result<Self, ConfigError> {
        let value = value.into();
        let Some((namespace, local_id)) = value.split_once(":hook:") else {
            return Err(ConfigError(
                "Hook id must use '<namespace>:hook:<local-id>' form".into(),
            ));
        };
        if namespace.trim().is_empty()
            || local_id.trim().is_empty()
            || namespace.contains(char::is_whitespace)
            || local_id.contains(':')
            || local_id.contains(char::is_whitespace)
            || value.contains('\0')
        {
            return Err(ConfigError(
                "Hook id must use '<namespace>:hook:<local-id>' form".into(),
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn belongs_to_namespace(&self, namespace: &str) -> bool {
        self.0
            .strip_prefix(namespace)
            .is_some_and(|suffix| suffix.starts_with(":hook:"))
    }
}

impl std::fmt::Display for HookId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for HookId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

pub use ash_protocol::HookEvent;

/// Desired enablement of one Hook declaration.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum HookEnablement {
    #[default]
    Disabled,
    Enabled,
}

/// Optional exact tool-name filter for tool-related Hook events.
///
/// An empty set matches every tool for `beforeTool` and `afterTool`. `turnCompleted` requires an
/// empty set because it has no tool subject.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookMatcher {
    #[serde(default)]
    pub tool_names: BTreeSet<String>,
}

/// Declarative Hook action. Runtime execution still requires policy and sandbox approval.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", tag = "type", deny_unknown_fields)]
pub enum HookAction {
    Process {
        program: String,
        #[serde(default)]
        args: Vec<String>,
    },
}

/// Runtime-free Hook declaration stored in User or Directory TOML.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookConfig {
    pub id: HookId,
    pub event: HookEvent,
    #[serde(default)]
    pub matcher: HookMatcher,
    pub action: HookAction,
    #[serde(default)]
    pub enablement: HookEnablement,
}

impl HookConfig {
    fn validate(&self) -> Result<(), ConfigError> {
        if !self.event.accepts_tool_matcher() && !self.matcher.tool_names.is_empty() {
            return Err(ConfigError(
                "this Hook event cannot match tool names".into(),
            ));
        }
        for tool_name in &self.matcher.tool_names {
            validate_text(tool_name, "Hook tool name")?;
        }
        match &self.action {
            HookAction::Process { program, args } => {
                validate_text(program, "Hook process program")?;
                for argument in args {
                    validate_text(argument, "Hook process argument")?;
                }
            }
        }
        Ok(())
    }
}

/// Hook declarations keyed by namespaced identity.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HooksConfig {
    #[serde(default)]
    pub hooks: BTreeMap<HookId, HookConfig>,
}

impl HooksConfig {
    pub(crate) fn validate_for_namespace(&self, namespace: &str) -> Result<(), ConfigError> {
        for (hook_id, hook) in &self.hooks {
            if &hook.id != hook_id {
                return Err(ConfigError(format!(
                    "Hook entry '{}' contains declaration for '{}'",
                    hook_id, hook.id
                )));
            }
            if !hook_id.belongs_to_namespace(namespace) {
                return Err(ConfigError(format!(
                    "Hook '{}' is outside the '{namespace}' namespace",
                    hook_id
                )));
            }
            hook.validate()?;
        }
        Ok(())
    }
}

fn validate_text(value: &str, label: &str) -> Result<(), ConfigError> {
    if value.trim().is_empty() || value.contains('\0') || value.contains(['\n', '\r']) {
        return Err(ConfigError(format!("{label} must be non-empty plain text")));
    }
    Ok(())
}
