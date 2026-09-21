use crate::ModelId;
use crate::ModelInputEstimate;
use crate::ModelInvocationId;
use crate::ModelRef;
use crate::ModelUsage;
use crate::ThreadId;
use crate::TurnId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use ts_rs::TS;

/// How the backend established the model identity or service tier used for pricing.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelBillingEvidence {
    ResponseField,
    ResponseHeader,
    AcceptedRequest,
    FixedModelIdentity,
}

/// Billing surface selected by the immutable model runtime.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelBillingScope {
    PublicApi,
    SubscriptionPlan,
    #[default]
    Unavailable,
}

/// Auditable pricing dimensions frozen for one completed provider request.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelBillingRecord {
    pub billing_platform: String,
    pub operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub requested_service_tier: Option<String>,
    pub applied_service_tier: String,
    pub service_tier_evidence: ModelBillingEvidence,
    pub region: String,
    pub pricing_variant: String,
    pub rate_card_revision: String,
}

/// Exact monetary amount encoded as a decimal integer to remain lossless in JSON clients.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelMoneyAmount {
    pub currency: String,
    pub pico_units: String,
}

/// Reference-cost totals accumulated from durable model invocation facts.
///
/// `known_amounts` is sorted by currency. `complete` is false when at least one invocation could
/// not be fully priced, while the known amounts remain useful lower bounds.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelReferenceCostSummary {
    pub known_amounts: Vec<ModelMoneyAmount>,
    pub complete: bool,
}

impl Default for ModelReferenceCostSummary {
    fn default() -> Self {
        Self {
            known_amounts: Vec::new(),
            complete: true,
        }
    }
}

impl ModelReferenceCostSummary {
    /// Returns the next aggregate, or `None` when an amount is malformed or overflows.
    pub fn checked_record(&self, reference_cost: &ModelReferenceCostRecord) -> Option<Self> {
        let (amount, complete) = match reference_cost {
            ModelReferenceCostRecord::Complete { cost } => (Some(&cost.amount), self.complete),
            ModelReferenceCostRecord::Partial { known_minimum, .. } => {
                (Some(&known_minimum.amount), false)
            }
            ModelReferenceCostRecord::Unpriced { .. } => (None, false),
        };
        self.checked_add(amount, complete)
    }

    /// Marks one legacy invocation as unpriced without discarding known totals.
    pub fn record_unpriced(&self) -> Self {
        Self {
            known_amounts: self.known_amounts.clone(),
            complete: false,
        }
    }

    fn checked_add(&self, amount: Option<&ModelMoneyAmount>, complete: bool) -> Option<Self> {
        let mut totals = BTreeMap::new();
        for known in &self.known_amounts {
            if known.currency.trim().is_empty() {
                return None;
            }
            let pico_units = known.pico_units.parse::<u128>().ok()?;
            if totals.insert(known.currency.clone(), pico_units).is_some() {
                return None;
            }
        }
        if let Some(amount) = amount {
            if amount.currency.trim().is_empty() {
                return None;
            }
            let pico_units = amount.pico_units.parse::<u128>().ok()?;
            let total = totals.entry(amount.currency.clone()).or_insert(0u128);
            *total = total.checked_add(pico_units)?;
        }
        Some(Self {
            known_amounts: totals
                .into_iter()
                .map(|(currency, pico_units)| ModelMoneyAmount {
                    currency,
                    pico_units: pico_units.to_string(),
                })
                .collect(),
            complete,
        })
    }
}

/// One reproducible token-cost contribution.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelCostLineItem {
    pub dimension: String,
    #[ts(type = "number")]
    pub quantity: u64,
    pub rate_pico_units_per_token: String,
    pub amount: ModelMoneyAmount,
}

/// A complete or known-minimum reference cost from one immutable rate card.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RatedModelCost {
    pub amount: ModelMoneyAmount,
    pub revision: String,
    pub line_items: Vec<ModelCostLineItem>,
}

/// Why a reference cost is incomplete or unavailable.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ModelReferenceCostReason {
    MissingTokenQuantities {
        dimensions: Vec<String>,
    },
    MissingTokenRates {
        dimensions: Vec<String>,
    },
    MissingQuantitiesAndRates {
        quantities: Vec<String>,
        rates: Vec<String>,
    },
    MissingRate,
    MissingUsage,
    MissingBillingContext,
    SubscriptionPlan,
    UnresolvedModelAlias,
}

/// Lossless persisted result of reference-cost calculation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ModelReferenceCostRecord {
    Complete {
        cost: RatedModelCost,
    },
    Partial {
        known_minimum: RatedModelCost,
        reason: ModelReferenceCostReason,
    },
    Unpriced {
        reason: ModelReferenceCostReason,
    },
}

/// Terminal state of one provider request.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelInvocationOutcome {
    Completed,
    Failed,
    Cancelled,
}

/// Durable facts for one provider request, independent from its containing Turn.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelInvocationRecord {
    /// Exact immutable time facts included in this request; absent when disabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub time_context: Option<crate::TimeContext>,
    pub invocation_id: ModelInvocationId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub tool_call_id: Option<crate::ToolCallId>,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub requested_model: Option<ModelRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub resolved_model: Option<ModelId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub billing: Option<ModelBillingRecord>,
    #[ts(type = "number")]
    pub started_at_unix_ms: u64,
    #[ts(type = "number")]
    pub completed_at_unix_ms: u64,
    pub outcome: ModelInvocationOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub usage: Option<ModelUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub input_estimate: Option<ModelInputEstimate>,
    pub reference_cost: ModelReferenceCostRecord,
}
