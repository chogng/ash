use std::ops::Range;

use crate::{
    SlashCommandArgumentMode, SlashCommandCatalog, SlashCommandDefinition, SlashCommandOrigin,
};

/// Editable Slash Command name under the composer cursor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashCommandQuery<'a> {
    pub text: &'a str,
}

/// Text replacement required to complete one selected Slash Command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashCommandCompletion {
    pub range: Range<usize>,
    pub replacement: String,
}

/// Complete recognized Slash Command and its trimmed argument range.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashCommandInvocation {
    pub command: SlashCommandDefinition,
    pub origin: SlashCommandOrigin,
    pub arguments_range: Range<usize>,
}

/// Read-only interpretation of composer text against one canonical catalog snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SlashCommandInput<'a, 'c> {
    text: &'a str,
    cursor: usize,
    catalog: &'c SlashCommandCatalog,
}

impl<'a, 'c> SlashCommandInput<'a, 'c> {
    pub fn at_cursor(text: &'a str, cursor: usize, catalog: &'c SlashCommandCatalog) -> Self {
        Self {
            text,
            cursor,
            catalog,
        }
    }

    pub fn for_submission(text: &'a str, catalog: &'c SlashCommandCatalog) -> Self {
        Self::at_cursor(text, text.len(), catalog)
    }

    pub fn query(self) -> Option<SlashCommandQuery<'a>> {
        self.text.strip_prefix('/')?;
        let text = self.text.get(1..self.cursor)?;
        (!text.contains(char::is_whitespace)).then_some(SlashCommandQuery { text })
    }

    pub fn matching_commands(self) -> Option<Vec<SlashCommandDefinition>> {
        self.query().map(|query| self.catalog.matching(query.text))
    }

    pub fn completion(self, command: &SlashCommandDefinition) -> Option<SlashCommandCompletion> {
        self.query()?;
        let accepted_end = 1 + command.name.len();
        // Accepting an already spelled command moves across its existing token.
        // Any other text after the cursor remains part of the draft.
        let end = if self.cursor > 1
            && self.text.get(1..accepted_end) == Some(command.name.as_str())
            && self.text[accepted_end..]
                .chars()
                .next()
                .is_none_or(char::is_whitespace)
        {
            accepted_end
        } else {
            self.cursor
        };
        let separator = self.text[end..]
            .chars()
            .next()
            .filter(|next| *next != '\n' && next.is_whitespace());
        Some(SlashCommandCompletion {
            range: 0..end + separator.map_or(0, char::len_utf8),
            replacement: format!("/{} ", command.name),
        })
    }

    pub fn invocation(self) -> Option<SlashCommandInvocation> {
        let command_range = command_name_range(self.text)?;
        let name = &self.text[1..command_range.end];
        let command = self.catalog.command_named(name)?.clone();
        let origin = self.catalog.origin(name)?;
        let arguments_range = trimmed_range(self.text, command_range.end..self.text.len());
        if !arguments_range.is_empty() && command.argument_mode == SlashCommandArgumentMode::None {
            return None;
        }
        Some(SlashCommandInvocation {
            command,
            origin,
            arguments_range,
        })
    }

    pub fn unknown_command_name(self) -> Option<&'a str> {
        let command_range = command_name_range(self.text)?;
        let name = &self.text[1..command_range.end];
        (!name.is_empty() && self.catalog.command_named(name).is_none()).then_some(name)
    }

    pub fn command_element_range(self) -> Option<Range<usize>> {
        let command_range = command_name_range(self.text)?;
        if (1..command_range.end).contains(&self.cursor) {
            return None;
        }
        let next = self.text[command_range.end..].chars().next()?;
        if !next.is_whitespace() {
            return None;
        }
        let command = self
            .catalog
            .command_named(&self.text[1..command_range.end])?;
        let arguments = self.text[command_range.end..].trim();
        if !arguments.is_empty() && command.argument_mode == SlashCommandArgumentMode::None {
            return None;
        }
        Some(command_range)
    }

    pub fn argument_hint(self) -> Option<&'c str> {
        let command_range = command_name_range(self.text)?;
        let command = self
            .catalog
            .command_named(&self.text[1..command_range.end])?;
        let hint = command.argument_hint.as_deref()?;
        let trailing = &self.text[command_range.end..];
        if trailing.starts_with(char::is_whitespace)
            && trailing.trim().is_empty()
            && self.cursor == self.text.len()
        {
            Some(hint)
        } else {
            None
        }
    }
}

fn command_name_range(text: &str) -> Option<Range<usize>> {
    let name = text.strip_prefix('/')?;
    let name_end = name
        .find(char::is_whitespace)
        .map(|index| 1 + index)
        .unwrap_or(text.len());
    Some(0..name_end)
}

fn trimmed_range(text: &str, range: Range<usize>) -> Range<usize> {
    let value = &text[range.clone()];
    let start = value.len() - value.trim_start().len();
    let end = value.trim_end().len();
    range.start + start..range.start + end.max(start)
}

#[cfg(test)]
#[path = "input_tests.rs"]
mod tests;
