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
                description: "Configure or ask the advisor for a second opinion".into(),
                argument_mode: SlashCommandArgumentMode::Optional,
                argument_hint: Some("<question|provider/model|off|clear>".into()),
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

    /// Orders name matches before description matches, retaining catalog order for ties.
    pub fn matching(&self, query: &str) -> Vec<SlashCommandDefinition> {
        if query.is_empty() {
            return self.commands.clone();
        }
        let query = query.to_ascii_lowercase();
        let mut matches = self
            .commands
            .iter()
            .enumerate()
            .filter_map(|(index, command)| {
                command_match_score(&command.name, &query)
                    .or_else(|| description_match_score(&command.description, &query))
                    .map(|score| (score, index, command.clone()))
            })
            .collect::<Vec<_>>();
        matches.sort_by_key(|(score, index, _)| (*score, *index));
        matches.into_iter().map(|(_, _, command)| command).collect()
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum MatchKind {
    Exact,
    Prefix,
    WordPrefix,
    Substring,
    Subsequence,
    DescriptionWordPrefix,
    DescriptionSubstring,
    DescriptionSubsequence,
}

type MatchScore = (MatchKind, usize, usize);

fn command_match_score(name: &str, query: &str) -> Option<MatchScore> {
    if name == query {
        return Some((MatchKind::Exact, 0, 0));
    }
    if name.starts_with(query) {
        return Some((MatchKind::Prefix, 0, 0));
    }
    // A single character away from the start would flood the popup with weak matches.
    if query.chars().count() < 2 {
        return None;
    }
    if let Some(start) = name
        .match_indices(query)
        .map(|(start, _)| start)
        .find(|&start| start > 0 && name.as_bytes()[start - 1] == b'-')
    {
        return Some((MatchKind::WordPrefix, 0, start));
    }
    if let Some(start) = name.find(query) {
        return Some((MatchKind::Substring, 0, start));
    }
    let (gap, start) = subsequence_score(name, query)?;
    Some((MatchKind::Subsequence, gap, start))
}

fn description_match_score(description: &str, query: &str) -> Option<MatchScore> {
    if query.chars().count() < 2 {
        return None;
    }
    let description = description.to_ascii_lowercase();
    if let Some(start) = description
        .match_indices(query)
        .map(|(start, _)| start)
        .find(|&start| {
            description[..start]
                .chars()
                .last()
                .is_none_or(|character| !character.is_alphanumeric())
        })
    {
        return Some((
            MatchKind::DescriptionWordPrefix,
            0,
            description[..start].chars().count(),
        ));
    }
    if let Some(start) = description.find(query) {
        return Some((
            MatchKind::DescriptionSubstring,
            0,
            description[..start].chars().count(),
        ));
    }
    let (gap, start) = subsequence_score(&description, query)?;
    Some((MatchKind::DescriptionSubsequence, gap, start))
}

/// Character positions to emphasize in a displayed command name or description.
pub fn matched_character_indices(text: &str, query: &str) -> Vec<usize> {
    if query.is_empty() {
        return Vec::new();
    }
    let text = text
        .chars()
        .map(|character| character.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let query = query
        .chars()
        .map(|character| character.to_ascii_lowercase())
        .collect::<Vec<_>>();
    if query.len() > text.len() {
        return Vec::new();
    }
    for start in 0..=text.len() - query.len() {
        if text[start..start + query.len()] == query {
            return (start..start + query.len()).collect();
        }
    }
    let mut best: Option<(usize, usize, Vec<usize>)> = None;
    for start in 0..text.len() {
        if text[start] != query[0] {
            continue;
        }
        let mut indices = vec![start];
        for (index, character) in text.iter().enumerate().skip(start + 1) {
            if *character == query[indices.len()] {
                indices.push(index);
                if indices.len() == query.len() {
                    let score = (index - start + 1 - query.len(), start);
                    if best
                        .as_ref()
                        .is_none_or(|(gap, offset, _)| score < (*gap, *offset))
                    {
                        best = Some((score.0, score.1, indices));
                    }
                    break;
                }
            }
        }
    }
    best.map_or_else(Vec::new, |(_, _, indices)| indices)
}

fn subsequence_score(name: &str, query: &str) -> Option<(usize, usize)> {
    let name = name.chars().collect::<Vec<_>>();
    let query = query.chars().collect::<Vec<_>>();
    let mut best = None;
    for start in 0..name.len() {
        if name[start] != query[0] {
            continue;
        }
        let mut matched = 1;
        for (end, &character) in name.iter().enumerate().skip(start + 1) {
            if character == query[matched] {
                matched += 1;
                if matched == query.len() {
                    let score = (end - start + 1 - query.len(), start);
                    best = Some(best.map_or(score, |current: (usize, usize)| current.min(score)));
                    break;
                }
            }
        }
    }
    best
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
