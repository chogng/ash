use crate::AccountingError;
use crate::CostLineItem;
use crate::CurrencyCode;
use crate::IncompleteCostReason;
use crate::ModelBillingContext;
use crate::ModelReferenceCost;
use crate::RateSelector;
use crate::TokenDimension;
use crate::TokenQuantities;
use crate::TokenRate;
use crate::UnpricedReason;
use crate::model::empty_rated_cost;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fmt;

const RATE_CARD_SCHEMA_VERSION: u32 = 1;
const BUNDLED_ACCELERATED_PUBLIC_PRICES: &str =
    include_str!("../rate_cards/accelerated-public-2026-09-04.json");

/// Stable identity of one immutable rate-card payload.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct RateCardRevision(String);

impl RateCardRevision {
    pub fn new(value: impl Into<String>) -> Result<Self, AccountingError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(AccountingError::EmptyIdentifier("rate-card revision"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RateCardRevision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for RateCardRevision {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Auditable metadata retained with every rated result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateCardMetadata {
    pub schema_version: u32,
    pub revision: RateCardRevision,
    pub reviewed_at: String,
    #[serde(default = "minimum_unix_ms")]
    pub effective_from_unix_ms: i64,
    pub source_urls: Vec<String>,
}

/// SHA-256 digest of the exact rate-card JSON bytes loaded by this process.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct RateCardDigest([u8; 32]);

impl RateCardDigest {
    pub const fn bytes(self) -> [u8; 32] {
        self.0
    }
}

impl fmt::Display for RateCardDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

/// Validated immutable collection of mutually exclusive price rules.
#[derive(Clone, Debug)]
pub struct RateCard {
    metadata: RateCardMetadata,
    digest: RateCardDigest,
    rules: Vec<RateRule>,
}

impl RateCard {
    /// Loads the audited public prices for currently supported accelerated model families.
    pub fn bundled_accelerated_public_prices() -> Result<Self, AccountingError> {
        Self::from_json(BUNDLED_ACCELERATED_PUBLIC_PRICES)
    }

    pub fn from_json(json: &str) -> Result<Self, AccountingError> {
        let digest = RateCardDigest(Sha256::digest(json.as_bytes()).into());
        let definition = serde_json::from_str::<RateCardDefinition>(json)
            .map_err(|error| AccountingError::InvalidRateCardJson(error.to_string()))?;
        Self::from_definition(definition, digest)
    }

    pub const fn metadata(&self) -> &RateCardMetadata {
        &self.metadata
    }

    pub fn revision(&self) -> &RateCardRevision {
        &self.metadata.revision
    }

    pub const fn digest(&self) -> RateCardDigest {
        self.digest
    }

    pub const fn rule_count(&self) -> usize {
        self.rules.len()
    }

    pub fn rate(
        &self,
        context: &ModelBillingContext,
        quantities: &TokenQuantities,
    ) -> Result<ModelReferenceCost, AccountingError> {
        let Some(rule) = self.rules.iter().find(|rule| rule.matches(context)) else {
            return Ok(ModelReferenceCost::Unpriced {
                reason: UnpricedReason::MissingRate,
            });
        };
        if !quantities.iter().any(|(_, quantity)| quantity.is_some()) {
            return Ok(ModelReferenceCost::Unpriced {
                reason: UnpricedReason::MissingUsage,
            });
        }
        self.rate_with_rule(rule, quantities)
    }

    fn from_definition(
        definition: RateCardDefinition,
        digest: RateCardDigest,
    ) -> Result<Self, AccountingError> {
        if definition.metadata.schema_version != RATE_CARD_SCHEMA_VERSION {
            return Err(AccountingError::UnsupportedSchemaVersion(
                definition.metadata.schema_version,
            ));
        }
        if definition.rules.is_empty() {
            return Err(AccountingError::EmptyRateCard);
        }
        if definition.metadata.reviewed_at.trim().is_empty() {
            return Err(AccountingError::EmptyRateCardReviewDate);
        }
        if definition.metadata.source_urls.is_empty() {
            return Err(AccountingError::EmptyRateCardSources);
        }
        let rules = definition
            .rules
            .into_iter()
            .enumerate()
            .map(|(index, rule)| {
                RateRule::from_definition(index, rule, definition.metadata.effective_from_unix_ms)
            })
            .collect::<Result<Vec<_>, _>>()?;
        for first in 0..rules.len() {
            for second in (first + 1)..rules.len() {
                if rules[first].overlaps(&rules[second]) {
                    return Err(AccountingError::OverlappingRateRules { first, second });
                }
            }
        }
        Ok(Self {
            metadata: definition.metadata,
            digest,
            rules,
        })
    }

    fn rate_with_rule(
        &self,
        rule: &RateRule,
        quantities: &TokenQuantities,
    ) -> Result<ModelReferenceCost, AccountingError> {
        let mut rated = empty_rated_cost(rule.currency.clone(), self.revision().clone());
        let mut missing_quantities = Vec::new();
        let mut missing_rates = Vec::new();

        for (dimension, rate) in &rule.rates {
            match quantities.get(dimension) {
                Some(Some(quantity)) => {
                    let amount = rate.cost(quantity)?;
                    rated.amount = rated.amount.checked_add(&amount)?;
                    rated.line_items.push(CostLineItem {
                        dimension: dimension.clone(),
                        quantity,
                        rate: rate.clone(),
                        amount,
                    });
                }
                Some(None) | None => missing_quantities.push(dimension.clone()),
            }
        }

        for (dimension, quantity) in quantities.iter() {
            if !rule.rates.contains_key(dimension) && quantity.is_none_or(|value| value > 0) {
                missing_rates.push(dimension.clone());
            }
        }

        if missing_quantities.is_empty() && missing_rates.is_empty() {
            return Ok(ModelReferenceCost::Complete(rated));
        }
        let reason = match (missing_quantities.is_empty(), missing_rates.is_empty()) {
            (false, true) => IncompleteCostReason::MissingTokenQuantities(missing_quantities),
            (true, false) => IncompleteCostReason::MissingTokenRates(missing_rates),
            (false, false) => IncompleteCostReason::MissingQuantitiesAndRates {
                quantities: missing_quantities,
                rates: missing_rates,
            },
            (true, true) => unreachable!("complete costs return before partial construction"),
        };
        Ok(ModelReferenceCost::Partial {
            known_minimum: rated,
            reason,
        })
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateCardDefinition {
    #[serde(flatten)]
    metadata: RateCardMetadata,
    rules: Vec<RateRuleDefinition>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateRuleDefinition {
    selector: RateSelector,
    #[serde(default)]
    input_range: InputRange,
    #[serde(default)]
    effective_range: EffectiveRangeDefinition,
    currency: CurrencyCode,
    rates: BTreeMap<TokenDimension, String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputRange {
    #[serde(default)]
    min_inclusive: u64,
    #[serde(default)]
    max_exclusive: Option<u64>,
}

impl Default for InputRange {
    fn default() -> Self {
        Self {
            min_inclusive: 0,
            max_exclusive: None,
        }
    }
}

impl InputRange {
    fn is_valid(self) -> bool {
        self.max_exclusive
            .map_or(self.min_inclusive < u64::MAX, |maximum| {
                self.min_inclusive < maximum
            })
    }

    fn contains(self, value: u64) -> bool {
        value >= self.min_inclusive && self.max_exclusive.is_none_or(|maximum| value < maximum)
    }

    fn overlaps(self, other: Self) -> bool {
        let self_maximum = self.max_exclusive.unwrap_or(u64::MAX);
        let other_maximum = other.max_exclusive.unwrap_or(u64::MAX);
        self.min_inclusive < other_maximum && other.min_inclusive < self_maximum
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffectiveRangeDefinition {
    #[serde(default)]
    from_inclusive_unix_ms: Option<i64>,
    #[serde(default)]
    until_exclusive_unix_ms: Option<i64>,
}

impl EffectiveRangeDefinition {
    fn resolve(self, default_from_unix_ms: i64) -> EffectiveRange {
        EffectiveRange {
            from_inclusive_unix_ms: self.from_inclusive_unix_ms.unwrap_or(default_from_unix_ms),
            until_exclusive_unix_ms: self.until_exclusive_unix_ms,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct EffectiveRange {
    from_inclusive_unix_ms: i64,
    until_exclusive_unix_ms: Option<i64>,
}

impl EffectiveRange {
    fn is_valid(self) -> bool {
        self.until_exclusive_unix_ms
            .map_or(self.from_inclusive_unix_ms < i64::MAX, |until| {
                self.from_inclusive_unix_ms < until
            })
    }

    fn contains(self, value: i64) -> bool {
        value >= self.from_inclusive_unix_ms
            && self
                .until_exclusive_unix_ms
                .is_none_or(|until| value < until)
    }

    fn overlaps(self, other: Self) -> bool {
        let self_until = self.until_exclusive_unix_ms.unwrap_or(i64::MAX);
        let other_until = other.until_exclusive_unix_ms.unwrap_or(i64::MAX);
        self.from_inclusive_unix_ms < other_until && other.from_inclusive_unix_ms < self_until
    }
}

const fn minimum_unix_ms() -> i64 {
    i64::MIN
}

#[derive(Clone, Debug)]
struct RateRule {
    selector: RateSelector,
    input_range: InputRange,
    effective_range: EffectiveRange,
    currency: CurrencyCode,
    rates: BTreeMap<TokenDimension, TokenRate>,
}

impl RateRule {
    fn from_definition(
        index: usize,
        definition: RateRuleDefinition,
        default_from_unix_ms: i64,
    ) -> Result<Self, AccountingError> {
        if definition.rates.is_empty() {
            return Err(AccountingError::EmptyRateRule(index));
        }
        if !definition.input_range.is_valid() {
            return Err(AccountingError::InvalidInputRange(index));
        }
        let effective_range = definition.effective_range.resolve(default_from_unix_ms);
        if !effective_range.is_valid() {
            return Err(AccountingError::InvalidEffectiveRange(index));
        }
        let rates = definition
            .rates
            .into_iter()
            .map(|(dimension, amount)| {
                TokenRate::from_per_million_tokens(definition.currency.clone(), &amount)
                    .map(|rate| (dimension, rate))
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        Ok(Self {
            selector: definition.selector,
            input_range: definition.input_range,
            effective_range,
            currency: definition.currency,
            rates,
        })
    }

    fn matches(&self, context: &ModelBillingContext) -> bool {
        self.selector == *context.selector()
            && self.input_range.contains(context.input_tokens())
            && self.effective_range.contains(context.started_at_unix_ms())
    }

    fn overlaps(&self, other: &Self) -> bool {
        self.selector == other.selector
            && self.input_range.overlaps(other.input_range)
            && self.effective_range.overlaps(other.effective_range)
    }
}
