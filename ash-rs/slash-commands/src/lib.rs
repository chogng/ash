//! Headless Slash Commands catalog, input grammar, and interaction state.

mod catalog;
mod input;
mod state;

pub use ash_app_server_protocol::protocol::slash_commands::{
    ProductSlashCommand, SlashCommandArgumentModeDto as SlashCommandArgumentMode,
    SlashCommandDefinition,
};
pub use catalog::{SlashCommandCatalog, SlashCommandCatalogError, SlashCommandOrigin};
pub use input::{
    SlashCommandCompletion, SlashCommandInput, SlashCommandInvocation, SlashCommandQuery,
};
pub use state::{SlashCommandsState, SlashCommandsView};

#[cfg(test)]
#[path = "conformance_tests.rs"]
mod conformance_tests;
