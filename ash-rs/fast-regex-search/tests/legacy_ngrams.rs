//! Regression coverage for the retained sparse n-gram comparison algorithm.
include!("../benches/algorithms/ngram.rs");

#[path = "../benches/algorithms/ngram_tests.rs"]
mod tests;
