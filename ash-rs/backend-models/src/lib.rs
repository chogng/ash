//! Provider backend HTTP request and response contracts.
//!
//! These types preserve each provider's fields and units. HTTP execution, account lifecycle,
//! response validation and Ash-facing interpretation belong to their consumers.

pub mod chatgpt;
pub mod coding_plan;
pub mod kimi;
pub mod supergrok;
pub mod zai;

#[cfg(test)]
mod contract_tests;
