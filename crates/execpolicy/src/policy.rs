use crate::ExecPolicyDefault;
use crate::ExecPolicyEffect;
use crate::ExecPolicyLayer;
use crate::ExecPolicyLayerId;
use crate::ExecPolicyLayerKind;
use crate::ExecPolicyRuleId;
use crate::ExecPolicySubject;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::fmt;

/// Semantic identity of an immutable, fully composed execution-policy snapshot.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ExecPolicyRevision(String);

impl ExecPolicyRevision {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ExecPolicyRevision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Exact layer and rule that supplied the effective deterministic result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecPolicySource {
    layer_id: ExecPolicyLayerId,
    layer_kind: ExecPolicyLayerKind,
    rule_id: ExecPolicyRuleId,
}

impl ExecPolicySource {
    pub fn layer_id(&self) -> &ExecPolicyLayerId {
        &self.layer_id
    }

    pub fn layer_kind(&self) -> ExecPolicyLayerKind {
        self.layer_kind
    }

    pub fn rule_id(&self) -> &ExecPolicyRuleId {
        &self.rule_id
    }
}

/// Audit record for one rule matched during evaluation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecPolicyMatchedRule {
    source: ExecPolicySource,
    effect: ExecPolicyEffect,
}

impl ExecPolicyMatchedRule {
    pub fn source(&self) -> &ExecPolicySource {
        &self.source
    }

    pub fn effect(&self) -> &ExecPolicyEffect {
        &self.effect
    }
}

/// Complete deterministic output consumed by the action-policy authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecPolicyEvaluation {
    revision: ExecPolicyRevision,
    effect: ExecPolicyEffect,
    source: Option<ExecPolicySource>,
    matched_rules: Vec<ExecPolicyMatchedRule>,
}

impl ExecPolicyEvaluation {
    pub fn revision(&self) -> &ExecPolicyRevision {
        &self.revision
    }

    pub fn effect(&self) -> &ExecPolicyEffect {
        &self.effect
    }

    pub fn source(&self) -> Option<&ExecPolicySource> {
        self.source.as_ref()
    }

    pub fn matched_rules(&self) -> &[ExecPolicyMatchedRule] {
        &self.matched_rules
    }
}

/// Immutable, validated composition of all active deterministic rule layers.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecPolicySnapshot {
    revision: ExecPolicyRevision,
    default: ExecPolicyDefault,
    layers: Vec<ExecPolicyLayer>,
}

impl ExecPolicySnapshot {
    pub fn new(
        default: ExecPolicyDefault,
        mut layers: Vec<ExecPolicyLayer>,
    ) -> Result<Self, ExecPolicyError> {
        for layer in &mut layers {
            layer.canonicalize();
        }
        validate(&default, &layers)?;
        layers.sort_by_key(|layer| (layer.kind(), layer.id().clone()));
        let canonical = serde_json::to_vec(&(&default, &layers))
            .map_err(|error| ExecPolicyError::Serialization(error.to_string()))?;
        let revision = ExecPolicyRevision(format!("{:x}", Sha256::digest(canonical)));
        Ok(Self {
            revision,
            default,
            layers,
        })
    }

    pub fn permissive_empty() -> Self {
        Self::new(ExecPolicyDefault::Continue, Vec::new())
            .expect("the empty continue policy is valid")
    }

    pub fn revision(&self) -> &ExecPolicyRevision {
        &self.revision
    }

    pub fn default(&self) -> &ExecPolicyDefault {
        &self.default
    }

    pub fn layers(&self) -> &[ExecPolicyLayer] {
        &self.layers
    }

    pub fn evaluate(&self, subject: &ExecPolicySubject<'_>) -> ExecPolicyEvaluation {
        let mut matched_rules = Vec::new();
        let mut effective: Option<(ExecPolicyEffect, ExecPolicySource)> = None;
        for layer in &self.layers {
            for rule in layer.rules() {
                if !rule.selector().matches(subject) {
                    continue;
                }
                let source = ExecPolicySource {
                    layer_id: layer.id().clone(),
                    layer_kind: layer.kind(),
                    rule_id: rule.id().clone(),
                };
                let effect = rule.effect().clone();
                matched_rules.push(ExecPolicyMatchedRule {
                    source: source.clone(),
                    effect: effect.clone(),
                });
                if effective
                    .as_ref()
                    .is_none_or(|(current, _)| effect.precedence() > current.precedence())
                {
                    effective = Some((effect, source));
                }
            }
        }
        let (effect, source) = effective.map_or_else(
            || {
                (
                    match &self.default {
                        ExecPolicyDefault::Continue => ExecPolicyEffect::Continue,
                        ExecPolicyDefault::Deny(reason) => ExecPolicyEffect::Deny(reason.clone()),
                    },
                    None,
                )
            },
            |(effect, source)| (effect, Some(source)),
        );
        ExecPolicyEvaluation {
            revision: self.revision.clone(),
            effect,
            source,
            matched_rules,
        }
    }
}

fn validate(
    default: &ExecPolicyDefault,
    layers: &[ExecPolicyLayer],
) -> Result<(), ExecPolicyError> {
    if !default.is_valid() {
        return Err(ExecPolicyError::InvalidDefault);
    }
    let mut layer_ids = BTreeSet::new();
    for layer in layers {
        if layer.id().as_str().is_empty() {
            return Err(ExecPolicyError::EmptyLayerId);
        }
        if !layer_ids.insert(layer.id().clone()) {
            return Err(ExecPolicyError::DuplicateLayerId(layer.id().clone()));
        }
        let mut rule_ids = BTreeSet::new();
        for rule in layer.rules() {
            if !rule.is_valid() {
                return Err(ExecPolicyError::InvalidRule(rule.id().clone()));
            }
            if layer.kind() == ExecPolicyLayerKind::Directory
                && matches!(rule.effect(), ExecPolicyEffect::AllowUnsandboxed)
            {
                return Err(ExecPolicyError::DirectoryRuleMayNotAllow(rule.id().clone()));
            }
            if !rule_ids.insert(rule.id().clone()) {
                return Err(ExecPolicyError::DuplicateRuleId(rule.id().clone()));
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExecPolicyError {
    EmptyLayerId,
    DuplicateLayerId(ExecPolicyLayerId),
    DuplicateRuleId(ExecPolicyRuleId),
    InvalidDefault,
    InvalidRule(ExecPolicyRuleId),
    DirectoryRuleMayNotAllow(ExecPolicyRuleId),
    Serialization(String),
}

impl fmt::Display for ExecPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyLayerId => {
                formatter.write_str("execution-policy layer ID must not be empty")
            }
            Self::DuplicateLayerId(id) => {
                write!(
                    formatter,
                    "duplicate execution-policy layer ID: {}",
                    id.as_str()
                )
            }
            Self::DuplicateRuleId(id) => {
                write!(
                    formatter,
                    "duplicate execution-policy rule ID: {}",
                    id.as_str()
                )
            }
            Self::InvalidDefault => formatter.write_str("invalid execution-policy default"),
            Self::InvalidRule(id) => {
                write!(formatter, "invalid execution-policy rule: {}", id.as_str())
            }
            Self::DirectoryRuleMayNotAllow(id) => write!(
                formatter,
                "directory execution-policy rule may not allow unsandboxed execution: {}",
                id.as_str()
            ),
            Self::Serialization(reason) => {
                write!(
                    formatter,
                    "could not derive execution-policy revision: {reason}"
                )
            }
        }
    }
}

impl std::error::Error for ExecPolicyError {}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
