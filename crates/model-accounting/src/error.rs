use thiserror::Error;

/// A rate-card validation or exact-arithmetic failure.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum AccountingError {
    #[error("{0} must not be empty")]
    EmptyIdentifier(&'static str),
    #[error("currency code must contain exactly three uppercase ASCII letters")]
    InvalidCurrencyCode,
    #[error("invalid non-negative decimal amount: {0}")]
    InvalidDecimalAmount(String),
    #[error("per-million token price cannot be represented as whole pico-units per token: {0}")]
    UnsupportedRatePrecision(String),
    #[error("accounting arithmetic overflow")]
    ArithmeticOverflow,
    #[error("cannot add {right} to {left}")]
    CurrencyMismatch { left: String, right: String },
    #[error("unsupported rate-card schema version {0}")]
    UnsupportedSchemaVersion(u32),
    #[error("rate card contains no rules")]
    EmptyRateCard,
    #[error("rate card review date must not be empty")]
    EmptyRateCardReviewDate,
    #[error("rate card must cite at least one source URL")]
    EmptyRateCardSources,
    #[error("rate rule {0} contains no token rates")]
    EmptyRateRule(usize),
    #[error("rate rule {0} has an invalid input-token range")]
    InvalidInputRange(usize),
    #[error("rate rule {0} has an invalid effective-time range")]
    InvalidEffectiveRange(usize),
    #[error("rate rules {first} and {second} overlap")]
    OverlappingRateRules { first: usize, second: usize },
    #[error("rate-card JSON is invalid: {0}")]
    InvalidRateCardJson(String),
    #[error("input token total is smaller than its cache token details")]
    InvalidInputTokenBreakdown,
}
