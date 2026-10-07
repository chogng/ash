use crate::ConfigError;
use crate::DirId;
use ash_execpolicy::ExecPolicyDefault;
use ash_execpolicy::ExecPolicyLayer;
use ash_execpolicy::ExecPolicyLayerId;
use ash_execpolicy::ExecPolicyLayerKind;
use ash_execpolicy::ExecPolicyRule;
use ash_execpolicy::ExecPolicyRuleId;
use ash_execpolicy::ExecPolicySnapshot;
use serde::Deserialize;
use serde::Serialize;

/// Durable user-owned execution-policy rules.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserExecPolicyConfig {
    #[serde(default)]
    pub rules: Vec<ExecPolicyRule>,
}

impl UserExecPolicyConfig {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        self.snapshot_layer().map(|_| ())
    }

    pub(crate) fn snapshot_layer(&self) -> Result<ExecPolicyLayer, ConfigError> {
        let layer = ExecPolicyLayer::new(
            ExecPolicyLayerId::new("user"),
            ExecPolicyLayerKind::User,
            self.rules.clone(),
        );
        ExecPolicySnapshot::new(ExecPolicyDefault::Continue, vec![layer.clone()])
            .map_err(|error| ConfigError(error.to_string()))?;
        Ok(layer)
    }

    pub(crate) fn upsert(&mut self, rule: ExecPolicyRule) {
        if let Some(existing) = self
            .rules
            .iter_mut()
            .find(|existing| existing.id() == rule.id())
        {
            *existing = rule;
        } else {
            self.rules.push(rule);
        }
    }

    pub(crate) fn remove(&mut self, rule_id: &ExecPolicyRuleId) -> bool {
        let original = self.rules.len();
        self.rules.retain(|rule| rule.id() != rule_id);
        self.rules.len() != original
    }
}

/// Directory-authored policy restrictions preserved as capability-gated configuration input.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirExecPolicyConfig {
    #[serde(default)]
    pub rules: Vec<ExecPolicyRule>,
}

impl DirExecPolicyConfig {
    pub(crate) fn snapshot_layer(&self, dir_id: &DirId) -> Result<ExecPolicyLayer, ConfigError> {
        let layer = ExecPolicyLayer::new(
            ExecPolicyLayerId::new(format!("dir:{}", dir_id.as_str())),
            ExecPolicyLayerKind::Directory,
            self.rules.clone(),
        );
        ExecPolicySnapshot::new(ExecPolicyDefault::Continue, vec![layer.clone()])
            .map_err(|error| ConfigError(error.to_string()))?;
        Ok(layer)
    }
}

/// Composes host/organization authority layers with durable User rules and restrictive directory
/// rules into the immutable snapshot consumed by action policy.
pub fn compose_exec_policy(
    default: ExecPolicyDefault,
    mut authority_layers: Vec<ExecPolicyLayer>,
    user: &UserExecPolicyConfig,
    dir: Option<(&DirId, &DirExecPolicyConfig)>,
) -> Result<ExecPolicySnapshot, ConfigError> {
    if authority_layers.iter().any(|layer| {
        !matches!(
            layer.kind(),
            ExecPolicyLayerKind::Host | ExecPolicyLayerKind::Organization
        )
    }) {
        return Err(ConfigError(
            "execution-policy authority inputs must be Host or Organization layers".into(),
        ));
    }
    authority_layers.push(user.snapshot_layer()?);
    if let Some((dir_id, dir)) = dir {
        authority_layers.push(dir.snapshot_layer(dir_id)?);
    }
    ExecPolicySnapshot::new(default, authority_layers)
        .map_err(|error| ConfigError(error.to_string()))
}

#[cfg(test)]
#[path = "exec_policy_tests.rs"]
mod tests;
