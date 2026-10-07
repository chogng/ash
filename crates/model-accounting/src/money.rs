use crate::AccountingError;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use std::fmt;

const PICO_UNITS_PER_UNIT: u128 = 1_000_000_000_000;
const TOKENS_PER_MILLION: u128 = 1_000_000;

/// Validated ISO-style three-letter currency code used by one rate rule.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct CurrencyCode(String);

impl CurrencyCode {
    pub fn new(value: impl Into<String>) -> Result<Self, AccountingError> {
        let value = value.into();
        if value.len() != 3 || !value.bytes().all(|byte| byte.is_ascii_uppercase()) {
            return Err(AccountingError::InvalidCurrencyCode);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CurrencyCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for CurrencyCode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// An exact money amount represented in 10^-12 currency units.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MoneyAmount {
    currency: CurrencyCode,
    pico_units: u128,
}

impl MoneyAmount {
    pub const fn new(currency: CurrencyCode, pico_units: u128) -> Self {
        Self {
            currency,
            pico_units,
        }
    }

    pub const fn zero(currency: CurrencyCode) -> Self {
        Self::new(currency, 0)
    }

    pub const fn pico_units(&self) -> u128 {
        self.pico_units
    }

    pub const fn currency(&self) -> &CurrencyCode {
        &self.currency
    }

    pub fn checked_add(&self, other: &Self) -> Result<Self, AccountingError> {
        if self.currency != other.currency {
            return Err(AccountingError::CurrencyMismatch {
                left: self.currency.to_string(),
                right: other.currency.to_string(),
            });
        }
        let pico_units = self
            .pico_units
            .checked_add(other.pico_units)
            .ok_or(AccountingError::ArithmeticOverflow)?;
        Ok(Self::new(self.currency.clone(), pico_units))
    }
}

/// Exact per-token price derived from a decimal price per one million tokens.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenRate {
    currency: CurrencyCode,
    pico_units_per_token: u128,
}

impl TokenRate {
    pub fn from_per_million_tokens(
        currency: CurrencyCode,
        amount: &str,
    ) -> Result<Self, AccountingError> {
        let pico_units_per_million = parse_decimal_pico_units(amount)?;
        if pico_units_per_million % TOKENS_PER_MILLION != 0 {
            return Err(AccountingError::UnsupportedRatePrecision(amount.into()));
        }
        Ok(Self {
            currency,
            pico_units_per_token: pico_units_per_million / TOKENS_PER_MILLION,
        })
    }

    pub const fn currency(&self) -> &CurrencyCode {
        &self.currency
    }

    pub const fn pico_units_per_token(&self) -> u128 {
        self.pico_units_per_token
    }

    pub fn cost(&self, tokens: u64) -> Result<MoneyAmount, AccountingError> {
        let pico_units = self
            .pico_units_per_token
            .checked_mul(u128::from(tokens))
            .ok_or(AccountingError::ArithmeticOverflow)?;
        Ok(MoneyAmount::new(self.currency.clone(), pico_units))
    }
}

fn parse_decimal_pico_units(amount: &str) -> Result<u128, AccountingError> {
    let parts = amount.split('.').collect::<Vec<_>>();
    if parts.len() > 2 || parts[0].is_empty() || !parts[0].bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(AccountingError::InvalidDecimalAmount(amount.into()));
    }
    let whole = parts[0]
        .parse::<u128>()
        .map_err(|_| AccountingError::InvalidDecimalAmount(amount.into()))?;
    let fraction = parts.get(1).copied().unwrap_or("");
    if fraction.len() > 12 || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AccountingError::InvalidDecimalAmount(amount.into()));
    }
    let fraction_value = if fraction.is_empty() {
        0
    } else {
        fraction
            .parse::<u128>()
            .map_err(|_| AccountingError::InvalidDecimalAmount(amount.into()))?
    };
    let fraction_scale = 10_u128
        .checked_pow(
            u32::try_from(12_usize.saturating_sub(fraction.len()))
                .map_err(|_| AccountingError::ArithmeticOverflow)?,
        )
        .ok_or(AccountingError::ArithmeticOverflow)?;
    whole
        .checked_mul(PICO_UNITS_PER_UNIT)
        .and_then(|value| value.checked_add(fraction_value.checked_mul(fraction_scale)?))
        .ok_or(AccountingError::ArithmeticOverflow)
}
