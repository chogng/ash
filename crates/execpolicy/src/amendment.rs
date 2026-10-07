use crate::ExecPolicyError;
use crate::ExecPolicyLayerKind;
use crate::ExecPolicyRevision;
use crate::ExecPolicyRule;
use crate::ExecPolicyRuleId;
use crate::ExecPolicySnapshot;
use std::fmt;

/// Optimistic, pure mutation applied by a persistence adapter to an immutable policy snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecPolicyAmendment {
    expected_revision: ExecPolicyRevision,
    target_layer: crate::ExecPolicyLayerId,
    operation: ExecPolicyAmendmentOperation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ExecPolicyAmendmentOperation {
    Upsert(ExecPolicyRule),
    Remove(ExecPolicyRuleId),
}

impl ExecPolicyAmendment {
    pub fn upsert_user_rule(
        expected_revision: ExecPolicyRevision,
        target_layer: crate::ExecPolicyLayerId,
        rule: ExecPolicyRule,
    ) -> Self {
        Self {
            expected_revision,
            target_layer,
            operation: ExecPolicyAmendmentOperation::Upsert(rule),
        }
    }

    pub fn remove_user_rule(
        expected_revision: ExecPolicyRevision,
        target_layer: crate::ExecPolicyLayerId,
        rule_id: ExecPolicyRuleId,
    ) -> Self {
        Self {
            expected_revision,
            target_layer,
            operation: ExecPolicyAmendmentOperation::Remove(rule_id),
        }
    }

    /// Produces the next semantic snapshot without reading or writing configuration files.
    ///
    /// Only a user layer can be amended through this API. Host and organization policy remain
    /// controlled by their trusted adapters, while directory configuration cannot grant itself
    /// broader execution authority.
    pub fn apply(
        self,
        snapshot: &ExecPolicySnapshot,
    ) -> Result<ExecPolicySnapshot, ExecPolicyAmendmentError> {
        if snapshot.revision() != &self.expected_revision {
            return Err(ExecPolicyAmendmentError::RevisionMismatch {
                expected: self.expected_revision,
                actual: snapshot.revision().clone(),
            });
        }
        let mut layers = snapshot.layers().to_vec();
        let layer = layers
            .iter_mut()
            .find(|layer| layer.id() == &self.target_layer)
            .ok_or_else(|| ExecPolicyAmendmentError::LayerNotFound(self.target_layer.clone()))?;
        if layer.kind() != ExecPolicyLayerKind::User {
            return Err(ExecPolicyAmendmentError::LayerNotUser(self.target_layer));
        }
        match self.operation {
            ExecPolicyAmendmentOperation::Upsert(rule) => {
                if let Some(existing) = layer
                    .rules_mut()
                    .iter_mut()
                    .find(|existing| existing.id() == rule.id())
                {
                    *existing = rule;
                } else {
                    layer.rules_mut().push(rule);
                }
            }
            ExecPolicyAmendmentOperation::Remove(rule_id) => {
                let original = layer.rules().len();
                layer.rules_mut().retain(|rule| rule.id() != &rule_id);
                if layer.rules().len() == original {
                    return Err(ExecPolicyAmendmentError::RuleNotFound(rule_id));
                }
            }
        }
        ExecPolicySnapshot::new(snapshot.default().clone(), layers)
            .map_err(ExecPolicyAmendmentError::InvalidSnapshot)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExecPolicyAmendmentError {
    RevisionMismatch {
        expected: ExecPolicyRevision,
        actual: ExecPolicyRevision,
    },
    LayerNotFound(crate::ExecPolicyLayerId),
    LayerNotUser(crate::ExecPolicyLayerId),
    RuleNotFound(ExecPolicyRuleId),
    InvalidSnapshot(ExecPolicyError),
}

impl fmt::Display for ExecPolicyAmendmentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RevisionMismatch { expected, actual } => write!(
                formatter,
                "execution-policy revision mismatch: expected {expected}, actual {actual}"
            ),
            Self::LayerNotFound(id) => {
                write!(
                    formatter,
                    "execution-policy layer not found: {}",
                    id.as_str()
                )
            }
            Self::LayerNotUser(id) => write!(
                formatter,
                "execution-policy layer is not user-mutable: {}",
                id.as_str()
            ),
            Self::RuleNotFound(id) => write!(
                formatter,
                "execution-policy rule not found: {}",
                id.as_str()
            ),
            Self::InvalidSnapshot(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ExecPolicyAmendmentError {}
