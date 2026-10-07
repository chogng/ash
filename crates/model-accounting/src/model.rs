use crate::AccountingError;
use crate::CurrencyCode;
use crate::MoneyAmount;
use crate::RateCardRevision;
use crate::TokenRate;
use ash_protocol::ModelId;
use ash_protocol::ModelUsage;
use ash_protocol::ProviderId;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fmt;

macro_rules! string_id {
    ($name:ident, $label:literal) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, AccountingError> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err(AccountingError::EmptyIdentifier($label));
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }
    };
}

string_id!(BillingPlatformId, "billing platform ID");
string_id!(ApiOperationId, "API operation ID");
string_id!(ServiceTierId, "service tier ID");
string_id!(BillingRegionId, "billing region ID");
string_id!(PricingVariantId, "pricing variant ID");
string_id!(TokenDimension, "token dimension");

impl TokenDimension {
    pub const UNCACHED_INPUT: &'static str = "uncached_input_tokens";
    pub const CACHED_INPUT: &'static str = "cached_input_tokens";
    pub const CACHE_WRITE_INPUT: &'static str = "cache_write_input_tokens";
    pub const OUTPUT: &'static str = "output_tokens";
}

/// Exact dimensions used to choose one price rule.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateSelector {
    pub provider: ProviderId,
    pub billing_platform: BillingPlatformId,
    pub model: ModelId,
    pub operation: ApiOperationId,
    pub service_tier: ServiceTierId,
    pub region: BillingRegionId,
    pub pricing_variant: PricingVariantId,
}

impl RateSelector {
    pub fn new(
        provider: ProviderId,
        billing_platform: BillingPlatformId,
        model: ModelId,
        operation: ApiOperationId,
        service_tier: ServiceTierId,
        region: BillingRegionId,
        pricing_variant: PricingVariantId,
    ) -> Self {
        Self {
            provider,
            billing_platform,
            model,
            operation,
            service_tier,
            region,
            pricing_variant,
        }
    }
}

/// Evidence used to establish the tier that was actually billed.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceTierEvidence {
    ResponseField,
    ResponseHeader,
    AcceptedRequest,
    FixedModelIdentity,
}

/// Frozen pricing context for one provider request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelBillingContext {
    selector: RateSelector,
    requested_service_tier: Option<ServiceTierId>,
    service_tier_evidence: ServiceTierEvidence,
    input_tokens: u64,
    started_at_unix_ms: i64,
}

impl ModelBillingContext {
    pub fn new(
        selector: RateSelector,
        service_tier_evidence: ServiceTierEvidence,
        input_tokens: u64,
        started_at_unix_ms: i64,
    ) -> Self {
        Self {
            selector,
            requested_service_tier: None,
            service_tier_evidence,
            input_tokens,
            started_at_unix_ms,
        }
    }

    pub fn with_requested_service_tier(mut self, service_tier: ServiceTierId) -> Self {
        self.requested_service_tier = Some(service_tier);
        self
    }

    pub fn selector(&self) -> &RateSelector {
        &self.selector
    }

    pub fn requested_service_tier(&self) -> Option<&ServiceTierId> {
        self.requested_service_tier.as_ref()
    }

    pub const fn service_tier_evidence(&self) -> ServiceTierEvidence {
        self.service_tier_evidence
    }

    pub const fn input_tokens(&self) -> u64 {
        self.input_tokens
    }

    pub const fn started_at_unix_ms(&self) -> i64 {
        self.started_at_unix_ms
    }
}

/// Token quantities keyed by the exact charge dimensions named in a rate rule.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TokenQuantities(BTreeMap<TokenDimension, Option<u64>>);

impl TokenQuantities {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_model_usage(usage: &ModelUsage) -> Result<Self, AccountingError> {
        let uncached_input_tokens = match (
            usage.input_tokens,
            usage.cached_input_tokens,
            usage.cache_write_input_tokens,
        ) {
            (Some(input), Some(cached), Some(written)) => input
                .checked_sub(cached)
                .and_then(|remaining| remaining.checked_sub(written))
                .ok_or(AccountingError::InvalidInputTokenBreakdown)
                .map(Some)?,
            _ => None,
        };
        let mut quantities = Self::new();
        quantities.insert(
            TokenDimension::new(Self::uncached_input_name())?,
            uncached_input_tokens,
        );
        quantities.insert(
            TokenDimension::new(Self::cached_input_name())?,
            usage.cached_input_tokens,
        );
        quantities.insert(
            TokenDimension::new(Self::cache_write_input_name())?,
            usage.cache_write_input_tokens,
        );
        quantities.insert(
            TokenDimension::new(Self::output_name())?,
            usage.output_tokens,
        );
        Ok(quantities)
    }

    pub fn insert(&mut self, dimension: TokenDimension, quantity: Option<u64>) {
        self.0.insert(dimension, quantity);
    }

    pub fn with(mut self, dimension: TokenDimension, quantity: Option<u64>) -> Self {
        self.insert(dimension, quantity);
        self
    }

    pub fn get(&self, dimension: &TokenDimension) -> Option<Option<u64>> {
        self.0.get(dimension).copied()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&TokenDimension, &Option<u64>)> {
        self.0.iter()
    }

    const fn uncached_input_name() -> &'static str {
        TokenDimension::UNCACHED_INPUT
    }

    const fn cached_input_name() -> &'static str {
        TokenDimension::CACHED_INPUT
    }

    const fn cache_write_input_name() -> &'static str {
        TokenDimension::CACHE_WRITE_INPUT
    }

    const fn output_name() -> &'static str {
        TokenDimension::OUTPUT
    }
}

/// One reproducible cost contribution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CostLineItem {
    pub dimension: TokenDimension,
    pub quantity: u64,
    pub rate: TokenRate,
    pub amount: MoneyAmount,
}

/// A complete or known-minimum reference cost produced by one rate-card revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RatedCost {
    pub amount: MoneyAmount,
    pub revision: RateCardRevision,
    pub line_items: Vec<CostLineItem>,
}

/// Why a known-minimum result is not the complete reference cost.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IncompleteCostReason {
    MissingTokenQuantities(Vec<TokenDimension>),
    MissingTokenRates(Vec<TokenDimension>),
    MissingQuantitiesAndRates {
        quantities: Vec<TokenDimension>,
        rates: Vec<TokenDimension>,
    },
}

/// Why no monetary result could be produced.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnpricedReason {
    MissingRate,
    MissingUsage,
    MissingBillingContext,
    SubscriptionPlan,
    UnresolvedModelAlias,
}

/// Reference-cost result that never turns missing billing facts into zero.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModelReferenceCost {
    Complete(RatedCost),
    Partial {
        known_minimum: RatedCost,
        reason: IncompleteCostReason,
    },
    Unpriced {
        reason: UnpricedReason,
    },
}

impl ModelReferenceCost {
    pub fn to_record(&self) -> ash_protocol::ModelReferenceCostRecord {
        match self {
            Self::Complete(cost) => ash_protocol::ModelReferenceCostRecord::Complete {
                cost: rated_cost_record(cost),
            },
            Self::Partial {
                known_minimum,
                reason,
            } => ash_protocol::ModelReferenceCostRecord::Partial {
                known_minimum: rated_cost_record(known_minimum),
                reason: incomplete_reason_record(reason),
            },
            Self::Unpriced { reason } => ash_protocol::ModelReferenceCostRecord::Unpriced {
                reason: unpriced_reason_record(*reason),
            },
        }
    }
}

fn rated_cost_record(cost: &RatedCost) -> ash_protocol::RatedModelCost {
    ash_protocol::RatedModelCost {
        amount: money_record(&cost.amount),
        revision: cost.revision.to_string(),
        line_items: cost
            .line_items
            .iter()
            .map(|item| ash_protocol::ModelCostLineItem {
                dimension: item.dimension.to_string(),
                quantity: item.quantity,
                rate_pico_units_per_token: item.rate.pico_units_per_token().to_string(),
                amount: money_record(&item.amount),
            })
            .collect(),
    }
}

fn money_record(amount: &MoneyAmount) -> ash_protocol::ModelMoneyAmount {
    ash_protocol::ModelMoneyAmount {
        currency: amount.currency().to_string(),
        pico_units: amount.pico_units().to_string(),
    }
}

fn incomplete_reason_record(
    reason: &IncompleteCostReason,
) -> ash_protocol::ModelReferenceCostReason {
    match reason {
        IncompleteCostReason::MissingTokenQuantities(dimensions) => {
            ash_protocol::ModelReferenceCostReason::MissingTokenQuantities {
                dimensions: dimensions.iter().map(ToString::to_string).collect(),
            }
        }
        IncompleteCostReason::MissingTokenRates(dimensions) => {
            ash_protocol::ModelReferenceCostReason::MissingTokenRates {
                dimensions: dimensions.iter().map(ToString::to_string).collect(),
            }
        }
        IncompleteCostReason::MissingQuantitiesAndRates { quantities, rates } => {
            ash_protocol::ModelReferenceCostReason::MissingQuantitiesAndRates {
                quantities: quantities.iter().map(ToString::to_string).collect(),
                rates: rates.iter().map(ToString::to_string).collect(),
            }
        }
    }
}

fn unpriced_reason_record(reason: UnpricedReason) -> ash_protocol::ModelReferenceCostReason {
    match reason {
        UnpricedReason::MissingRate => ash_protocol::ModelReferenceCostReason::MissingRate,
        UnpricedReason::MissingUsage => ash_protocol::ModelReferenceCostReason::MissingUsage,
        UnpricedReason::MissingBillingContext => {
            ash_protocol::ModelReferenceCostReason::MissingBillingContext
        }
        UnpricedReason::SubscriptionPlan => {
            ash_protocol::ModelReferenceCostReason::SubscriptionPlan
        }
        UnpricedReason::UnresolvedModelAlias => {
            ash_protocol::ModelReferenceCostReason::UnresolvedModelAlias
        }
    }
}

pub(crate) fn empty_rated_cost(currency: CurrencyCode, revision: RateCardRevision) -> RatedCost {
    RatedCost {
        amount: MoneyAmount::zero(currency),
        revision,
        line_items: Vec::new(),
    }
}
