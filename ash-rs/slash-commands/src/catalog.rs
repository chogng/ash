use fuzzy_match::FuzzyMatcher;
use std::cmp::Reverse;
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
/// Definitions belong to this domain. Origin records which client composition boundary
/// contributed each command; transport exports do not own catalog behavior.
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

    /// Suggests only a unique one-edit correction so a typo cannot silently select a command.
    pub fn suggested_command(&self, name: &str) -> Option<&SlashCommandDefinition> {
        let name = name.to_ascii_lowercase();
        if !name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return None;
        }
        let mut candidates = self
            .commands
            .iter()
            .filter(|command| one_edit_away(name.as_bytes(), command.name.as_bytes()));
        let suggestion = candidates.next()?;
        candidates.next().is_none().then_some(suggestion)
    }

    pub fn origin(&self, name: &str) -> Option<SlashCommandOrigin> {
        self.origins.get(name).copied()
    }

    /// Orders name matches before description matches, retaining catalog order for ties.
    pub fn matching(&self, query: &str) -> Vec<SlashCommandDefinition> {
        if query.is_empty() {
            return self.commands.clone();
        }
        let query = query.to_lowercase();
        let mut matcher = FuzzyMatcher::new(&query);
        let mut matches = self
            .commands
            .iter()
            .enumerate()
            .filter_map(|(index, command)| {
                command_match_score(&command.name, &query, &mut matcher)
                    .or_else(|| description_match_score(&command.description, &query, &mut matcher))
                    .map(|score| (score, index, command.clone()))
            })
            .collect::<Vec<_>>();
        matches.sort_by_key(|(score, index, _)| (*score, *index));
        matches.into_iter().map(|(_, _, command)| command).collect()
    }
}

fn one_edit_away(input: &[u8], command: &[u8]) -> bool {
    match input.len().cmp(&command.len()) {
        std::cmp::Ordering::Equal => {
            let mismatches = input
                .iter()
                .zip(command)
                .enumerate()
                .filter_map(|(index, (left, right))| (left != right).then_some(index))
                .collect::<Vec<_>>();
            matches!(mismatches.as_slice(), [_])
                || matches!(mismatches.as_slice(), [first, second]
                    if *second == *first + 1
                        && input[*first] == command[*second]
                        && input[*second] == command[*first])
        }
        std::cmp::Ordering::Less => one_missing_byte(input, command),
        std::cmp::Ordering::Greater => one_missing_byte(command, input),
    }
}

fn one_missing_byte(shorter: &[u8], longer: &[u8]) -> bool {
    if longer.len() != shorter.len() + 1 {
        return false;
    }
    let first_difference = shorter
        .iter()
        .zip(longer)
        .position(|(left, right)| left != right)
        .unwrap_or(shorter.len());
    shorter[first_difference..] == longer[first_difference + 1..]
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

type MatchScore = (MatchKind, Reverse<u16>, usize);

fn command_match_score(name: &str, query: &str, matcher: &mut FuzzyMatcher) -> Option<MatchScore> {
    if name == query {
        return Some((MatchKind::Exact, Reverse(0), 0));
    }
    if name.starts_with(query) {
        return Some((MatchKind::Prefix, Reverse(0), 0));
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
        return Some((MatchKind::WordPrefix, Reverse(0), start));
    }
    if let Some(start) = name.find(query) {
        return Some((MatchKind::Substring, Reverse(0), start));
    }
    Some((MatchKind::Subsequence, Reverse(matcher.score(name)?), 0))
}

fn description_match_score(
    description: &str,
    query: &str,
    matcher: &mut FuzzyMatcher,
) -> Option<MatchScore> {
    if query.chars().count() < 2 {
        return None;
    }
    let description = description.to_lowercase();
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
            Reverse(0),
            description[..start].chars().count(),
        ));
    }
    if let Some(start) = description.find(query) {
        return Some((
            MatchKind::DescriptionSubstring,
            Reverse(0),
            description[..start].chars().count(),
        ));
    }
    Some((
        MatchKind::DescriptionSubsequence,
        Reverse(matcher.score(&description)?),
        0,
    ))
}

/// Character positions to emphasize in a displayed command name or description.
pub fn matched_character_indices(text: &str, query: &str) -> Vec<usize> {
    FuzzyMatcher::new(query).indices(text)
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
