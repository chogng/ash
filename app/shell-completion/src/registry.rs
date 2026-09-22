use std::collections::BTreeMap;

/// One exact value suggested and recognized for an argument.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellChoice {
    value: String,
    description: Option<String>,
}

impl ShellChoice {
    pub fn new(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            description: None,
        }
    }

    pub fn described(value: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            description: Some(description.into()),
        }
    }

    pub fn value(&self) -> &str {
        &self.value
    }

    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }
}

/// Validation and completion semantics for one option value or positional argument.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShellValueHint {
    /// The signature knows the argument slot but has no deterministic evidence for arbitrary values.
    Opaque,
    /// An existing file or directory relative to the command working directory.
    Path,
    /// An existing directory relative to the command working directory.
    Directory,
    /// An existing regular file relative to the command working directory.
    File,
    /// A base-10 integer.
    Integer,
    /// Another executable or registered command whose signature takes over parsing.
    Command,
    /// One value from an exact static set.
    Choices(Vec<ShellChoice>),
}

/// One positional argument accepted by a command signature.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellArgumentSpec {
    name: String,
    value_hint: ShellValueHint,
    repeated: bool,
}

impl ShellArgumentSpec {
    pub fn opaque(name: impl Into<String>) -> Self {
        Self::new(name, ShellValueHint::Opaque)
    }

    pub fn path(name: impl Into<String>) -> Self {
        Self::new(name, ShellValueHint::Path)
    }

    pub fn directory(name: impl Into<String>) -> Self {
        Self::new(name, ShellValueHint::Directory)
    }

    pub fn file(name: impl Into<String>) -> Self {
        Self::new(name, ShellValueHint::File)
    }

    pub fn integer(name: impl Into<String>) -> Self {
        Self::new(name, ShellValueHint::Integer)
    }

    pub fn command(name: impl Into<String>) -> Self {
        Self::new(name, ShellValueHint::Command)
    }

    pub fn choices(
        name: impl Into<String>,
        choices: impl IntoIterator<Item = ShellChoice>,
    ) -> Self {
        Self::new(name, ShellValueHint::Choices(choices.into_iter().collect()))
    }

    fn new(name: impl Into<String>, value_hint: ShellValueHint) -> Self {
        Self {
            name: name.into(),
            value_hint,
            repeated: false,
        }
    }

    pub fn repeated(mut self) -> Self {
        self.repeated = true;
        self
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn value_hint(&self) -> &ShellValueHint {
        &self.value_hint
    }

    pub fn is_repeated(&self) -> bool {
        self.repeated
    }
}

/// One exact long or short option accepted by a command signature.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellOptionSpec {
    names: Vec<String>,
    description: String,
    value: Option<ShellArgumentSpec>,
}

impl ShellOptionSpec {
    pub fn flag(
        names: impl IntoIterator<Item = impl Into<String>>,
        description: impl Into<String>,
    ) -> Self {
        Self {
            names: names.into_iter().map(Into::into).collect(),
            description: description.into(),
            value: None,
        }
    }

    pub fn value(
        names: impl IntoIterator<Item = impl Into<String>>,
        value: ShellArgumentSpec,
        description: impl Into<String>,
    ) -> Self {
        Self {
            names: names.into_iter().map(Into::into).collect(),
            description: description.into(),
            value: Some(value),
        }
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.names.iter().map(String::as_str)
    }

    pub fn primary_name(&self) -> &str {
        self.names.first().map_or("", String::as_str)
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn value_spec(&self) -> Option<&ShellArgumentSpec> {
        self.value.as_ref()
    }

    pub(crate) fn matches(&self, candidate: &str) -> bool {
        self.names.iter().any(|name| name == candidate)
    }
}

/// Recursive command grammar used for token descriptions and completion candidates.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellCommandSpec {
    name: String,
    description: String,
    requires_executable: bool,
    options: Vec<ShellOptionSpec>,
    arguments: Vec<ShellArgumentSpec>,
    subcommands: BTreeMap<String, ShellCommandSpec>,
}

impl ShellCommandSpec {
    pub fn new(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            requires_executable: false,
            options: Vec::new(),
            arguments: Vec::new(),
            subcommands: BTreeMap::new(),
        }
    }

    pub fn with_option(mut self, option: ShellOptionSpec) -> Self {
        self.options.push(option);
        self
    }

    pub fn with_argument(mut self, argument: ShellArgumentSpec) -> Self {
        self.arguments.push(argument);
        self
    }

    pub fn with_subcommand(mut self, subcommand: ShellCommandSpec) -> Self {
        self.subcommands.insert(subcommand.name.clone(), subcommand);
        self
    }

    pub(crate) fn requiring_executable(mut self) -> Self {
        self.requires_executable = true;
        self
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn options(&self) -> &[ShellOptionSpec] {
        &self.options
    }

    pub fn arguments(&self) -> &[ShellArgumentSpec] {
        &self.arguments
    }

    pub fn subcommands(&self) -> impl Iterator<Item = &ShellCommandSpec> {
        self.subcommands.values()
    }

    pub(crate) const fn requires_executable(&self) -> bool {
        self.requires_executable
    }

    pub(crate) fn option(&self, name: &str) -> Option<&ShellOptionSpec> {
        self.options.iter().find(|option| option.matches(name))
    }

    pub(crate) fn subcommand(&self, name: &str) -> Option<&ShellCommandSpec> {
        self.subcommands.get(name)
    }
}

/// Mutable registry of product-neutral command signatures.
#[derive(Clone, Debug, Default)]
pub struct ShellCommandRegistry {
    commands: BTreeMap<String, ShellCommandSpec>,
}

impl ShellCommandRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_ash_defaults() -> Self {
        crate::catalog::default_registry()
    }

    pub fn register(&mut self, mut command: ShellCommandSpec) {
        if self
            .commands
            .get(&command.name)
            .is_some_and(|existing| !existing.requires_executable)
        {
            command.requires_executable = false;
        }
        self.commands.insert(command.name.clone(), command);
    }

    pub fn command(&self, name: &str) -> Option<&ShellCommandSpec> {
        self.commands.get(name)
    }

    pub fn commands(&self) -> impl Iterator<Item = &ShellCommandSpec> {
        self.commands.values()
    }
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;
