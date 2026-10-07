//! Versioned model rate cards and exact reference-cost calculation.

mod error;
mod model;
mod money;
mod pricing;
mod rate_card;
mod summary;

pub use error::AccountingError;
pub use model::ApiOperationId;
pub use model::BillingPlatformId;
pub use model::BillingRegionId;
pub use model::CostLineItem;
pub use model::IncompleteCostReason;
pub use model::ModelBillingContext;
pub use model::ModelReferenceCost;
pub use model::PricingVariantId;
pub use model::RateSelector;
pub use model::RatedCost;
pub use model::ServiceTierEvidence;
pub use model::ServiceTierId;
pub use model::TokenDimension;
pub use model::TokenQuantities;
pub use model::UnpricedReason;
pub use money::CurrencyCode;
pub use money::MoneyAmount;
pub use money::TokenRate;
pub use pricing::InvocationPrice;
pub use rate_card::RateCard;
pub use rate_card::RateCardDigest;
pub use rate_card::RateCardMetadata;
pub use rate_card::RateCardRevision;

#[cfg(test)]
#[path = "accounting_tests.rs"]
mod tests;

pub use summary::checked_record_reference_cost;
