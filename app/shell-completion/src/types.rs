use std::fmt;
use std::ops::Range;

/// Syntactic location of one token inside a pipeline or command list.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ShellTokenPosition {
    pub command_index: usize,
    pub token_index: usize,
}

/// Semantic category attached to an exact Shell token.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShellTokenKind {
    EnvironmentAssignment,
    Alias,
    Command,
    Subcommand,
    Option,
    OptionValue,
    Argument,
    Path,
    RedirectionTarget,
}

/// Structural explanation for an exact token recognized by the engine.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellTokenDescription {
    kind: ShellTokenKind,
    detail: Option<String>,
}

impl ShellTokenDescription {
    pub(crate) fn new(kind: ShellTokenKind, detail: impl Into<Option<String>>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }

    pub const fn kind(&self) -> ShellTokenKind {
        self.kind
    }

    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }
}

/// Parsed token and the exact structural evidence known for it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellToken {
    text: String,
    span: Range<usize>,
    position: ShellTokenPosition,
    description: Option<ShellTokenDescription>,
}

impl ShellToken {
    pub(crate) fn new(
        text: String,
        span: Range<usize>,
        position: ShellTokenPosition,
        description: Option<ShellTokenDescription>,
    ) -> Self {
        Self {
            text,
            span,
            position,
            description,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn span(&self) -> Range<usize> {
        self.span.clone()
    }

    pub const fn position(&self) -> ShellTokenPosition {
        self.position
    }

    pub fn description(&self) -> Option<&ShellTokenDescription> {
        self.description.as_ref()
    }
}

/// Immutable token evidence for one classified or completed input buffer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellTokenSnapshot {
    input: String,
    tokens: Vec<ShellToken>,
}

impl ShellTokenSnapshot {
    pub(crate) fn new(input: String, tokens: Vec<ShellToken>) -> Self {
        Self { input, tokens }
    }

    pub fn input(&self) -> &str {
        &self.input
    }

    pub fn tokens(&self) -> &[ShellToken] {
        &self.tokens
    }
}

/// One session alias supplied by the product's Shell authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellAlias {
    name: String,
    replacement: String,
}

impl ShellAlias {
    pub fn new(
        name: impl Into<String>,
        replacement: impl Into<String>,
    ) -> Result<Self, ShellAliasError> {
        let name = name.into();
        let replacement = replacement.into();
        if name.is_empty()
            || name.chars().any(char::is_whitespace)
            || name.contains(['|', ';', '&', '<', '>'])
        {
            return Err(ShellAliasError::InvalidName(name));
        }
        if replacement.trim().is_empty() {
            return Err(ShellAliasError::EmptyReplacement(name));
        }
        Ok(Self { name, replacement })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn replacement(&self) -> &str {
        &self.replacement
    }

    pub(crate) fn into_parts(self) -> (String, String) {
        (self.name, self.replacement)
    }
}

/// Invalid alias configuration rejected before it can influence classification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShellAliasError {
    InvalidName(String),
    EmptyReplacement(String),
}

impl fmt::Display for ShellAliasError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidName(name) => write!(formatter, "invalid Shell alias name '{name}'"),
            Self::EmptyReplacement(name) => {
                write!(formatter, "Shell alias '{name}' has an empty replacement")
            }
        }
    }
}

impl std::error::Error for ShellAliasError {}
