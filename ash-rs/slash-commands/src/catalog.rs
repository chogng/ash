use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::SlashCommandArgumentMode;
use crate::SlashCommandDefinition;

/// Declares which composition boundary contributed a command to one client catalog.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SlashCommandOrigin {
    Local,
    Server,
}

/// Immutable validated Slash Commands snapshot.
///
/// Commands remain the canonical protocol model. Origin is catalog binding metadata and never
/// creates a second command model.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashCommandCatalog {
    commands: Vec<SlashCommandDefinition>,
    origins: BTreeMap<String, SlashCommandOrigin>,
}

impl Default for SlashCommandCatalog {
    fn default() -> Self {
        Self::new([
            SlashCommandDefinition {
                name: "advisor".into(),
                description: "Choose an advisor model, turn it off, or ask for a second opinion"
                    .into(),
                argument_mode: SlashCommandArgumentMode::Optional,
                argument_hint: Some("<provider/model|off|ask question>".into()),
            },
            SlashCommandDefinition {
                name: "compact".into(),
                description: "Summarize conversation history to free context space".into(),
                argument_mode: SlashCommandArgumentMode::Optional,
                argument_hint: None,
            },
            SlashCommandDefinition {
                name: "init".into(),
                description: "Create or update Ash-specific ASH.md guidance".into(),
                argument_mode: SlashCommandArgumentMode::Optional,
                argument_hint: Some("[workspace|user]".into()),
            },
            SlashCommandDefinition {
                name: "team".into(),
                description: "Coordinate a task with dedicated implementation and review Agents"
                    .into(),
                argument_mode: SlashCommandArgumentMode::Optional,
                argument_hint: Some("<task|status|resume|cancel>".into()),
            },
            SlashCommandDefinition {
                name: "develop".into(),
                description:
                    "Develop through versioned Intent, Spec, Plan, implementation, and acceptance"
                        .into(),
                argument_mode: SlashCommandArgumentMode::Optional,
                argument_hint: Some(
                    "<task|status|accept revision|resume decision|revise stage reason|cancel>"
                        .into(),
                ),
            },
        ])
        .expect("built-in slash command definitions are valid")
    }
}

impl SlashCommandCatalog {
    /// Constructs a server-owned catalog without client-local commands.
    pub fn new(
        definitions: impl IntoIterator<Item = SlashCommandDefinition>,
    ) -> Result<Self, SlashCommandCatalogError> {
        Self::with_local_and_server(std::iter::empty(), definitions)
    }

    /// Merges client-local and server-advertised definitions into one validated snapshot.
    pub fn with_local_and_server(
        local: impl IntoIterator<Item = SlashCommandDefinition>,
        server: impl IntoIterator<Item = SlashCommandDefinition>,
    ) -> Result<Self, SlashCommandCatalogError> {
        let mut names = BTreeSet::new();
        let mut commands = Vec::new();
        let mut origins = BTreeMap::new();
        append_commands(
            &mut commands,
            &mut names,
            &mut origins,
            local,
            SlashCommandOrigin::Local,
        )?;
        append_commands(
            &mut commands,
            &mut names,
            &mut origins,
            server,
            SlashCommandOrigin::Server,
        )?;
        Ok(Self { commands, origins })
    }

    pub fn commands(&self) -> &[SlashCommandDefinition] {
        &self.commands
    }

    pub fn command_named(&self, name: &str) -> Option<&SlashCommandDefinition> {
        self.commands.iter().find(|command| command.name == name)
    }

    pub fn origin(&self, name: &str) -> Option<SlashCommandOrigin> {
        self.origins.get(name).copied()
    }

    pub fn matching(&self, prefix: &str) -> Vec<SlashCommandDefinition> {
        self.commands
            .iter()
            .filter(|command| command.name.starts_with(prefix))
            .cloned()
            .collect()
    }
}

/// Failure to construct one canonical Slash Commands catalog.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashCommandCatalogError(pub String);

impl fmt::Display for SlashCommandCatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for SlashCommandCatalogError {}

fn append_commands(
    commands: &mut Vec<SlashCommandDefinition>,
    names: &mut BTreeSet<String>,
    origins: &mut BTreeMap<String, SlashCommandOrigin>,
    definitions: impl IntoIterator<Item = SlashCommandDefinition>,
    origin: SlashCommandOrigin,
) -> Result<(), SlashCommandCatalogError> {
    for definition in definitions {
        validate_command(&definition)?;
        if !names.insert(definition.name.clone()) {
            return Err(SlashCommandCatalogError(format!(
                "duplicate slash command name '{}'",
                definition.name
            )));
        }
        origins.insert(definition.name.clone(), origin);
        commands.push(definition);
    }
    Ok(())
}

fn validate_command(command: &SlashCommandDefinition) -> Result<(), SlashCommandCatalogError> {
    if command.name.is_empty()
        || command.name.starts_with('-')
        || command.name.ends_with('-')
        || !command.name.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
    {
        return Err(SlashCommandCatalogError(format!(
            "invalid slash command name '{}': use lowercase ASCII letters, digits, and interior hyphens",
            command.name
        )));
    }
    if command.description.trim().is_empty() {
        return Err(SlashCommandCatalogError(format!(
            "slash command '{}' must have a description",
            command.name
        )));
    }
    Ok(())
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
