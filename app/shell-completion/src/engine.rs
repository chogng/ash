use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;

use crate::dir::DirCatalog;
use crate::environment::ExecutableCatalog;
use crate::environment::executable_file;
use crate::parser::ParsedShellCommand;
use crate::parser::ParsedShellWord;
use crate::parser::ParsedWordKind;
use crate::parser::is_environment_assignment;
use crate::parser::normalized_shell_word;
use crate::parser::parse_shell_commands;
use crate::registry::ShellArgumentSpec;
use crate::registry::ShellCommandRegistry;
use crate::registry::ShellCommandSpec;
use crate::registry::ShellValueHint;
use crate::types::ShellAlias;
use crate::types::ShellToken;
use crate::types::ShellTokenDescription;
use crate::types::ShellTokenKind;
use crate::types::ShellTokenPosition;
use crate::types::ShellTokenSnapshot;

const MAX_ALIAS_EXPANSION_DEPTH: usize = 3;
const COMMAND_WRAPPERS: &[&str] = &["command", "env", "exec", "nohup", "sudo", "time", "xargs"];

mod completions;

/// Stateful owner of Shell parsing, command signatures, PATH and directory completion evidence.
#[derive(Clone, Debug)]
pub struct ShellCompletionEngine {
    working_directory: PathBuf,
    registry: ShellCommandRegistry,
    executables: ExecutableCatalog,
    dir_catalog: DirCatalog,
    aliases: BTreeMap<String, String>,
}

impl ShellCompletionEngine {
    pub fn for_working_directory(working_directory: impl Into<PathBuf>) -> Self {
        let working_directory = working_directory.into();
        Self {
            registry: ShellCommandRegistry::with_ash_defaults(),
            executables: ExecutableCatalog::from_process_path(),
            dir_catalog: DirCatalog::discover(&working_directory),
            aliases: BTreeMap::new(),
            working_directory,
        }
    }

    pub fn with_registry(
        working_directory: impl Into<PathBuf>,
        registry: ShellCommandRegistry,
    ) -> Self {
        let working_directory = working_directory.into();
        Self {
            registry,
            executables: ExecutableCatalog::from_process_path(),
            dir_catalog: DirCatalog::discover(&working_directory),
            aliases: BTreeMap::new(),
            working_directory,
        }
    }

    pub fn set_working_directory(&mut self, working_directory: &Path) {
        self.working_directory = working_directory.to_path_buf();
        self.dir_catalog = DirCatalog::discover(working_directory);
    }

    pub fn set_path_entries(&mut self, entries: impl IntoIterator<Item = PathBuf>) {
        self.executables.replace_path_entries(entries);
    }

    pub fn replace_aliases(&mut self, aliases: impl IntoIterator<Item = ShellAlias>) {
        self.aliases = aliases.into_iter().map(ShellAlias::into_parts).collect();
    }

    pub fn refresh_dir_catalog(&mut self) {
        self.dir_catalog = DirCatalog::discover(&self.working_directory);
    }

    pub fn analyze(&self, input: &str) -> ShellTokenSnapshot {
        let commands = parse_shell_commands(input);
        let mut tokens = Vec::new();
        for (command_index, command) in commands.iter().enumerate() {
            tokens.extend(self.analyze_command(command_index, command));
        }
        ShellTokenSnapshot::new(input.to_owned(), tokens)
    }

    fn analyze_command(
        &self,
        command_index: usize,
        command: &ParsedShellCommand,
    ) -> Vec<ShellToken> {
        let mut state = CommandState::default();
        command
            .words
            .iter()
            .enumerate()
            .map(|(token_index, word)| {
                let description = self.describe_word(word, &mut state);
                ShellToken::new(
                    word.text.clone(),
                    word.span.clone(),
                    ShellTokenPosition {
                        command_index,
                        token_index,
                    },
                    description,
                )
            })
            .collect()
    }

    fn command_state(&self, words: &[ParsedShellWord]) -> CommandState {
        let mut state = CommandState::default();
        for word in words {
            self.describe_word(word, &mut state);
        }
        state
    }

    fn describe_word(
        &self,
        word: &ParsedShellWord,
        state: &mut CommandState,
    ) -> Option<ShellTokenDescription> {
        let normalized = normalized_shell_word(&word.text);
        if word.kind == ParsedWordKind::RedirectionTarget {
            return self.describe_path(&normalized, ShellTokenKind::RedirectionTarget);
        }
        if state.command.is_none() {
            if state.command_unresolved {
                return None;
            }
            return self.describe_initial_word(&normalized, state);
        }
        if let Some(value) = state.pending_value.take() {
            if matches!(value.value_hint(), ShellValueHint::Command) {
                let mut command_state = CommandState::default();
                let description = self.describe_initial_word(&normalized, &mut command_state);
                if description.is_some() {
                    *state = command_state;
                    return Some(ShellTokenDescription::new(
                        ShellTokenKind::OptionValue,
                        Some(format!("{} command", value.name())),
                    ));
                }
                return None;
            }
            return self.describe_value(&normalized, &value, ShellTokenKind::OptionValue);
        }
        let command = state.command.clone().expect("command state must exist");
        if normalized == "--" {
            state.options_ended = true;
            return Some(ShellTokenDescription::new(
                ShellTokenKind::Option,
                Some("End command options".to_owned()),
            ));
        }
        if !state.options_ended && normalized.starts_with('-') {
            let option = command.option(&normalized);
            if let Some(option) = option {
                state.pending_value = option.value_spec().cloned();
                return Some(ShellTokenDescription::new(
                    ShellTokenKind::Option,
                    Some(option.description().to_owned()),
                ));
            }
            if let Some(description) = self.describe_compact_options(&command, &normalized, state) {
                return Some(description);
            }
            return None;
        }
        if state.wrapper_accepts_options {
            if is_environment_assignment(&normalized) {
                return Some(ShellTokenDescription::new(
                    ShellTokenKind::EnvironmentAssignment,
                    None,
                ));
            }
            let mut wrapped_state = CommandState::default();
            let description = self.describe_initial_word(&normalized, &mut wrapped_state);
            *state = wrapped_state;
            return description;
        }
        if let Some(subcommand) = command.subcommand(&normalized).cloned() {
            state.command_path.push(normalized);
            let detail = Some(subcommand.description().to_owned());
            state.command = Some(subcommand);
            state.argument_index = 0;
            return Some(ShellTokenDescription::new(
                ShellTokenKind::Subcommand,
                detail,
            ));
        }
        if let Some(description) = self
            .dir_catalog
            .description(&state.command_path, &normalized)
        {
            state.advance_argument(command.arguments());
            return Some(ShellTokenDescription::new(
                ShellTokenKind::Argument,
                Some(description.to_owned()),
            ));
        }
        let argument = state.current_argument(command.arguments()).cloned();
        let description = argument
            .as_ref()
            .and_then(|argument| {
                self.describe_value(&normalized, argument, ShellTokenKind::Argument)
            })
            .or_else(|| self.describe_path(&normalized, ShellTokenKind::Path));
        if argument.is_some() {
            state.advance_argument(command.arguments());
        }
        description
    }

    fn describe_initial_word(
        &self,
        normalized: &str,
        state: &mut CommandState,
    ) -> Option<ShellTokenDescription> {
        if is_environment_assignment(normalized) {
            return Some(ShellTokenDescription::new(
                ShellTokenKind::EnvironmentAssignment,
                None,
            ));
        }
        if let Some(replacement) = self.aliases.get(normalized) {
            let Some(expanded_words) = self.expanded_alias_words(normalized) else {
                state.command_unresolved = true;
                return None;
            };
            let mut expanded_state = CommandState::default();
            for expanded_word in expanded_words {
                let word = ParsedShellWord {
                    text: expanded_word,
                    span: 0..0,
                    kind: ParsedWordKind::Word,
                };
                self.describe_word(&word, &mut expanded_state);
            }
            if expanded_state.command.is_some() {
                *state = expanded_state;
                return Some(ShellTokenDescription::new(
                    ShellTokenKind::Alias,
                    Some(format!("Alias for {replacement}")),
                ));
            }
        }
        let resolved = self.resolve_plain_command(normalized);
        let Some(command) = resolved.command else {
            state.command_unresolved = true;
            return None;
        };
        state.command_path.push(resolved.lookup_name.clone());
        state.command = Some(command);
        state.wrapper_accepts_options = COMMAND_WRAPPERS.contains(&resolved.lookup_name.as_str());
        Some(ShellTokenDescription::new(resolved.kind, resolved.detail))
    }

    fn expanded_alias_words(&self, name: &str) -> Option<Vec<String>> {
        let mut words = vec![name.to_owned()];
        let mut visited = BTreeSet::new();
        for _ in 0..MAX_ALIAS_EXPANSION_DEPTH {
            let command_index = words
                .iter()
                .position(|word| !is_environment_assignment(word))?;
            let command = words[command_index].clone();
            let Some(replacement) = self.aliases.get(&command) else {
                return Some(words);
            };
            if !visited.insert(command) {
                return None;
            }
            let replacement = parse_shell_commands(replacement).into_iter().next()?;
            let replacement_words = replacement
                .words
                .into_iter()
                .filter(|word| word.kind == ParsedWordKind::Word)
                .map(|word| normalized_shell_word(&word.text))
                .collect::<Vec<_>>();
            if replacement_words.is_empty() {
                return None;
            }
            words.splice(command_index..=command_index, replacement_words);
        }
        let command = words.iter().find(|word| !is_environment_assignment(word))?;
        (!self.aliases.contains_key(command)).then_some(words)
    }

    fn resolve_plain_command(&self, name: &str) -> ResolvedCommand {
        let catalog = self.registry.command(name).cloned();
        let is_path_command = name.contains('/') || name.contains('\\');
        let path_is_executable = is_path_command && self.resolve_executable_path(name);
        let installed = self.executables.contains(name) || path_is_executable;
        let command = catalog
            .filter(|command| !command.requires_executable() || installed)
            .or_else(|| installed.then(|| ShellCommandSpec::new(name, "Installed executable")));
        ResolvedCommand {
            command,
            lookup_name: name.to_owned(),
            kind: ShellTokenKind::Command,
            detail: installed
                .then_some("Installed executable".to_owned())
                .or_else(|| {
                    self.registry
                        .command(name)
                        .map(|command| command.description().to_owned())
                }),
        }
    }

    fn describe_compact_options(
        &self,
        command: &ShellCommandSpec,
        value: &str,
        state: &mut CommandState,
    ) -> Option<ShellTokenDescription> {
        let compact = value.strip_prefix('-')?;
        if compact.is_empty() || compact.starts_with('-') {
            return None;
        }
        if compact.chars().all(|character| character.is_ascii_digit()) {
            let option = command.option("-n")?;
            let argument = option.value_spec()?;
            if matches!(argument.value_hint(), ShellValueHint::Integer) {
                return Some(ShellTokenDescription::new(
                    ShellTokenKind::Option,
                    Some(option.description().to_owned()),
                ));
            }
        }
        for (offset, character) in compact.char_indices() {
            let option_name = format!("-{character}");
            let option = command.option(&option_name)?;
            let Some(argument) = option.value_spec() else {
                continue;
            };
            let value_start = offset + character.len_utf8();
            let attached_value = &compact[value_start..];
            if attached_value.is_empty() {
                state.pending_value = Some(argument.clone());
            } else {
                self.describe_value(attached_value, argument, ShellTokenKind::OptionValue)?;
            }
            break;
        }
        Some(ShellTokenDescription::new(
            ShellTokenKind::Option,
            Some("Combined short options".to_owned()),
        ))
    }

    fn describe_value(
        &self,
        value: &str,
        argument: &ShellArgumentSpec,
        kind: ShellTokenKind,
    ) -> Option<ShellTokenDescription> {
        let detail = || Some(format!("{} value", argument.name()));
        match argument.value_hint() {
            ShellValueHint::Opaque => None,
            ShellValueHint::Path => self.describe_path(value, ShellTokenKind::Path),
            ShellValueHint::Directory => self
                .resolve_path(value)
                .filter(|path| path.is_dir())
                .map(|_| ShellTokenDescription::new(ShellTokenKind::Path, detail())),
            ShellValueHint::File => self
                .resolve_path(value)
                .filter(|path| path.is_file())
                .map(|_| ShellTokenDescription::new(ShellTokenKind::Path, detail())),
            ShellValueHint::Integer => value
                .parse::<i64>()
                .ok()
                .map(|_| ShellTokenDescription::new(kind, detail())),
            ShellValueHint::Command => self
                .resolve_plain_command(value)
                .command
                .map(|_| ShellTokenDescription::new(kind, detail())),
            ShellValueHint::Choices(choices) => choices
                .iter()
                .find(|choice| choice.value() == value)
                .map(|choice| {
                    ShellTokenDescription::new(
                        kind,
                        choice.description().map(str::to_owned).or_else(detail),
                    )
                }),
        }
    }

    fn describe_path(&self, value: &str, kind: ShellTokenKind) -> Option<ShellTokenDescription> {
        self.resolve_path(value)
            .map(|_| ShellTokenDescription::new(kind, Some("Existing filesystem path".to_owned())))
    }

    fn resolve_path(&self, value: &str) -> Option<PathBuf> {
        if value.is_empty() || value.contains(['*', '?', '$']) {
            return None;
        }
        let path = expand_home(value)?;
        let candidate = if path.is_absolute() {
            path
        } else {
            self.working_directory.join(path)
        };
        candidate.exists().then_some(candidate)
    }

    fn resolve_executable_path(&self, value: &str) -> bool {
        let Some(path) = expand_home(value) else {
            return false;
        };
        let candidate = if path.is_absolute() {
            path
        } else {
            self.working_directory.join(path)
        };
        executable_file(&candidate)
    }
}

#[derive(Clone, Debug, Default)]
struct CommandState {
    command: Option<ShellCommandSpec>,
    command_unresolved: bool,
    command_path: Vec<String>,
    pending_value: Option<ShellArgumentSpec>,
    argument_index: usize,
    options_ended: bool,
    wrapper_accepts_options: bool,
}

impl CommandState {
    fn current_argument<'a>(
        &self,
        arguments: &'a [ShellArgumentSpec],
    ) -> Option<&'a ShellArgumentSpec> {
        arguments
            .get(self.argument_index)
            .or_else(|| arguments.last().filter(|argument| argument.is_repeated()))
    }

    fn advance_argument(&mut self, arguments: &[ShellArgumentSpec]) {
        if arguments
            .get(self.argument_index)
            .is_some_and(|argument| !argument.is_repeated())
        {
            self.argument_index += 1;
        }
    }
}

struct ResolvedCommand {
    command: Option<ShellCommandSpec>,
    lookup_name: String,
    kind: ShellTokenKind,
    detail: Option<String>,
}

fn expand_home(value: &str) -> Option<PathBuf> {
    if value == "~" {
        return home_directory();
    }
    if let Some(remainder) = value.strip_prefix("~/") {
        return home_directory().map(|home| home.join(remainder));
    }
    Some(PathBuf::from(value))
}

fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
