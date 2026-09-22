use std::fs;
use std::ops::Range;
use std::path::Path;

use super::CommandState;
use super::ShellCompletionEngine;
use super::expand_home;
use crate::completion::ShellCompletion;
use crate::completion::ShellCompletionKind;
use crate::completion::ShellCompletionSnapshot;
use crate::parser::normalized_shell_word;
use crate::parser::parse_shell_commands;
use crate::registry::ShellArgumentSpec;
use crate::registry::ShellValueHint;

const MAX_COMPLETIONS: usize = 100;

impl ShellCompletionEngine {
    pub fn complete(&self, input: &str, cursor: usize) -> Vec<ShellCompletion> {
        self.complete_snapshot(input, cursor).into_completions()
    }

    /// Returns candidate edits together with whether the current token is already exact.
    pub fn complete_snapshot(&self, input: &str, cursor: usize) -> ShellCompletionSnapshot {
        let cursor = floor_char_boundary(input, cursor.min(input.len()));
        let prefix_input = &input[..cursor];
        let completions = if ends_with_command_separator(prefix_input) {
            self.command_completions("", cursor..cursor)
        } else {
            let commands = parse_shell_commands(prefix_input);
            let Some(command) = commands.last() else {
                return completion_snapshot(input, self.command_completions("", cursor..cursor));
            };
            let Some(current_word) = command.words.last() else {
                return completion_snapshot(input, self.command_completions("", cursor..cursor));
            };
            let trailing_space = prefix_input
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace)
                && current_word.span.end < cursor;
            let trailing_option_equals = !trailing_space
                && prefix_input.ends_with('=')
                && current_word.span.end + 1 == cursor;
            let (prefix, mut replace_range, committed_words) =
                if trailing_space || trailing_option_equals {
                    ("".to_owned(), cursor..cursor, command.words.as_slice())
                } else {
                    (
                        normalized_shell_word(&current_word.text),
                        current_word.span.clone(),
                        &command.words[..command.words.len().saturating_sub(1)],
                    )
                };
            if !trailing_space && !trailing_option_equals {
                replace_range.end = completion_word_end(input, replace_range.start, cursor);
            }
            let state = self.command_state(committed_words);
            self.completions_for_state(&state, &prefix, replace_range)
        };
        completion_snapshot(input, completions)
    }

    fn completions_for_state(
        &self,
        state: &CommandState,
        prefix: &str,
        replace_range: Range<usize>,
    ) -> Vec<ShellCompletion> {
        if state.command.is_none() {
            if state.command_unresolved {
                return Vec::new();
            }
            return self.command_completions(prefix, replace_range);
        }
        let command = state.command.as_ref().expect("command state must exist");
        let mut completions = Vec::new();
        if let Some(value) = state.pending_value.as_ref() {
            self.value_completions(value, prefix, replace_range, &mut completions);
            return finalize_completions(completions);
        }
        if state.wrapper_accepts_options && !prefix.starts_with('-') {
            return self.command_completions(prefix, replace_range);
        }
        if prefix.starts_with('-') && !state.options_ended {
            for option in command.options() {
                for name in option.names() {
                    if name.starts_with(prefix) {
                        completions.push(ShellCompletion::new(
                            name,
                            name,
                            Some(option.description().to_owned()),
                            ShellCompletionKind::Option,
                            replace_range.clone(),
                        ));
                    }
                }
            }
            return finalize_completions(completions);
        }
        for subcommand in command.subcommands() {
            if subcommand.name().starts_with(prefix) {
                completions.push(ShellCompletion::new(
                    subcommand.name(),
                    subcommand.name(),
                    Some(subcommand.description().to_owned()),
                    ShellCompletionKind::Subcommand,
                    replace_range.clone(),
                ));
            }
        }
        for (value, description) in self.dir_catalog.candidates(&state.command_path) {
            if value.starts_with(prefix) {
                completions.push(ShellCompletion::new(
                    value,
                    value,
                    Some(description.to_owned()),
                    ShellCompletionKind::Value,
                    replace_range.clone(),
                ));
            }
        }
        if let Some(argument) = state.current_argument(command.arguments()) {
            self.value_completions(argument, prefix, replace_range.clone(), &mut completions);
        }
        if completions.is_empty() || prefix.contains(['/', '.']) {
            self.path_completions(prefix, replace_range, &mut completions);
        }
        finalize_completions(completions)
    }

    fn command_completions(
        &self,
        prefix: &str,
        replace_range: Range<usize>,
    ) -> Vec<ShellCompletion> {
        let mut completions = Vec::new();
        for command in self.registry.commands() {
            if command.name().starts_with(prefix)
                && (!command.requires_executable() || self.executables.contains(command.name()))
            {
                completions.push(ShellCompletion::new(
                    command.name(),
                    command.name(),
                    Some(command.description().to_owned()),
                    ShellCompletionKind::Command,
                    replace_range.clone(),
                ));
            }
        }
        for (command, path) in self.executables.commands() {
            if command.starts_with(prefix) {
                completions.push(ShellCompletion::new(
                    escape_unquoted_shell_word(command),
                    command,
                    Some(path.display().to_string()),
                    ShellCompletionKind::Command,
                    replace_range.clone(),
                ));
            }
        }
        for (alias, replacement) in &self.aliases {
            if alias.starts_with(prefix) {
                completions.push(ShellCompletion::new(
                    alias,
                    alias,
                    Some(format!("Alias for {replacement}")),
                    ShellCompletionKind::Alias,
                    replace_range.clone(),
                ));
            }
        }
        if prefix.contains(['/', '.']) {
            self.path_completions(prefix, replace_range, &mut completions);
        }
        finalize_completions(completions)
    }

    fn value_completions(
        &self,
        argument: &ShellArgumentSpec,
        prefix: &str,
        replace_range: Range<usize>,
        completions: &mut Vec<ShellCompletion>,
    ) {
        match argument.value_hint() {
            ShellValueHint::Choices(choices) => {
                for choice in choices {
                    if choice.value().starts_with(prefix) {
                        completions.push(ShellCompletion::new(
                            choice.value(),
                            choice.value(),
                            choice.description().map(str::to_owned),
                            ShellCompletionKind::Value,
                            replace_range.clone(),
                        ));
                    }
                }
            }
            ShellValueHint::Path | ShellValueHint::Directory | ShellValueHint::File => {
                self.path_completions(prefix, replace_range, completions);
            }
            ShellValueHint::Opaque | ShellValueHint::Integer => {}
            ShellValueHint::Command => {
                completions.extend(self.command_completions(prefix, replace_range));
            }
        }
    }

    fn path_completions(
        &self,
        prefix: &str,
        replace_range: Range<usize>,
        completions: &mut Vec<ShellCompletion>,
    ) {
        let path_prefix = CompletionPathPrefix::parse(prefix);
        let unquoted_prefix = &path_prefix.value;
        let path = Path::new(&unquoted_prefix);
        let (directory_text, name_prefix) = if unquoted_prefix.ends_with(['/', '\\']) {
            (unquoted_prefix.as_str(), "")
        } else {
            (
                path.parent()
                    .and_then(Path::to_str)
                    .filter(|parent| !parent.is_empty())
                    .unwrap_or("."),
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(""),
            )
        };
        let Some(directory_path) = expand_home(directory_text) else {
            return;
        };
        let directory = if directory_path.is_absolute() {
            directory_path
        } else {
            self.working_directory.join(directory_path)
        };
        let Ok(entries) = fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !name.starts_with(name_prefix) {
                continue;
            }
            let mut replacement = if directory_text == "." {
                name.clone()
            } else {
                format!("{}{name}", ensure_trailing_separator(directory_text))
            };
            let is_directory = entry.file_type().is_ok_and(|file_type| file_type.is_dir());
            if is_directory {
                replacement.push(std::path::MAIN_SEPARATOR);
            }
            completions.push(ShellCompletion::new(
                path_prefix.render_replacement(&replacement, is_directory),
                name,
                None,
                ShellCompletionKind::Path,
                replace_range.clone(),
            ));
        }
    }
}

#[derive(Clone, Copy)]
enum CompletionQuote {
    Unquoted,
    Single,
    Double,
}

struct CompletionPathPrefix {
    value: String,
    quote: CompletionQuote,
}

impl CompletionPathPrefix {
    fn parse(prefix: &str) -> Self {
        if let Some(value) = prefix.strip_prefix('\'') {
            return Self {
                value: value.strip_suffix('\'').unwrap_or(value).to_owned(),
                quote: CompletionQuote::Single,
            };
        }
        if let Some(value) = prefix.strip_prefix('"') {
            return Self {
                value: value.strip_suffix('"').unwrap_or(value).to_owned(),
                quote: CompletionQuote::Double,
            };
        }
        Self {
            value: normalized_shell_word(prefix),
            quote: CompletionQuote::Unquoted,
        }
    }

    fn render_replacement(&self, value: &str, is_directory: bool) -> String {
        match self.quote {
            CompletionQuote::Unquoted => escape_unquoted_shell_word(value),
            CompletionQuote::Single => {
                let value = value.replace('\'', "'\\''");
                format!("'{value}{}", if is_directory { "" } else { "'" })
            }
            CompletionQuote::Double => {
                let value = escape_double_quoted_shell_word(value);
                format!("\"{value}{}", if is_directory { "" } else { "\"" })
            }
        }
    }
}

fn escape_double_quoted_shell_word(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '\\' | '"' | '$' | '`') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn escape_unquoted_shell_word(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_whitespace()
            || matches!(
                character,
                '\\' | '\''
                    | '"'
                    | '$'
                    | '`'
                    | '|'
                    | '&'
                    | ';'
                    | '<'
                    | '>'
                    | '('
                    | ')'
                    | '['
                    | ']'
                    | '{'
                    | '}'
                    | '*'
                    | '?'
                    | '!'
                    | '#'
            )
        {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn finalize_completions(mut completions: Vec<ShellCompletion>) -> Vec<ShellCompletion> {
    completions.sort_by(|left, right| {
        left.kind()
            .cmp(&right.kind())
            .then_with(|| left.display().cmp(right.display()))
    });
    completions.dedup_by(|left, right| left.replacement() == right.replacement());
    completions.truncate(MAX_COMPLETIONS);
    completions
}

fn remove_noop_completions(input: &str, completions: Vec<ShellCompletion>) -> Vec<ShellCompletion> {
    completions
        .into_iter()
        .filter(|completion| {
            input.get(completion.replace_range()) != Some(completion.replacement())
        })
        .collect()
}

fn completion_snapshot(input: &str, completions: Vec<ShellCompletion>) -> ShellCompletionSnapshot {
    let has_exact_match = completions
        .iter()
        .any(|completion| input.get(completion.replace_range()) == Some(completion.replacement()));
    ShellCompletionSnapshot::new(remove_noop_completions(input, completions), has_exact_match)
}

fn ensure_trailing_separator(directory: &str) -> String {
    if directory.ends_with(['/', '\\']) {
        directory.to_owned()
    } else {
        format!("{directory}{}", std::path::MAIN_SEPARATOR)
    }
}

fn floor_char_boundary(value: &str, index: usize) -> usize {
    let mut index = index.min(value.len());
    while !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn completion_word_end(input: &str, word_start: usize, cursor: usize) -> usize {
    parse_shell_commands(input)
        .iter()
        .flat_map(|command| &command.words)
        .find(|word| word.span.start == word_start && word.span.end >= cursor)
        .map_or(cursor, |word| word.span.end)
}

fn ends_with_command_separator(input: &str) -> bool {
    #[derive(Clone, Copy, Eq, PartialEq)]
    enum LastSyntax {
        Other,
        Separator,
    }

    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let mut at_word_boundary = true;
    let mut last = None;
    for character in input.chars() {
        if comment {
            if character == '\n' {
                comment = false;
                at_word_boundary = true;
                last = Some(LastSyntax::Separator);
            }
            continue;
        }
        if escaped {
            escaped = false;
            at_word_boundary = false;
            last = Some(LastSyntax::Other);
            continue;
        }
        if let Some(active_quote) = quote {
            if character == active_quote {
                quote = None;
            } else if active_quote != '\'' && character == '\\' {
                escaped = true;
            }
            at_word_boundary = false;
            last = Some(LastSyntax::Other);
            continue;
        }
        match character {
            '\\' => {
                escaped = true;
                at_word_boundary = false;
                last = Some(LastSyntax::Other);
            }
            '\'' | '"' | '`' => {
                quote = Some(character);
                at_word_boundary = false;
                last = Some(LastSyntax::Other);
            }
            '#' if at_word_boundary => comment = true,
            '\n' | ';' | '|' | '&' | '(' | ')' => {
                at_word_boundary = true;
                last = Some(LastSyntax::Separator);
            }
            character if character.is_whitespace() => at_word_boundary = true,
            _ => {
                at_word_boundary = false;
                last = Some(LastSyntax::Other);
            }
        }
    }
    last == Some(LastSyntax::Separator)
}
