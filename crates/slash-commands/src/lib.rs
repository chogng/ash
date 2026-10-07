//! Headless Slash Commands catalog, input grammar, and interaction state.

mod catalog;
mod definition;
mod input;
mod state;

pub use catalog::{
    SlashCommandCatalog, SlashCommandCatalogError, SlashCommandOrigin, matched_character_indices,
};
pub use definition::ProductSlashCommand;
pub use definition::SlashCommandArgumentMode;
pub use definition::SlashCommandDefinition;
pub use input::{
    SlashCommandCompletion, SlashCommandInput, SlashCommandInvocation, SlashCommandQuery,
};
pub use state::{SlashCommandsState, SlashCommandsView};

#[cfg(test)]
#[path = "conformance_tests.rs"]
mod conformance_tests;
