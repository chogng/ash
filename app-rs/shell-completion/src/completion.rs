use std::ops::Range;

/// Presentation-neutral category for one Shell completion candidate.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ShellCompletionKind {
    Alias,
    Command,
    Subcommand,
    Option,
    Value,
    Path,
}

/// One bounded replacement proposed by the Shell completion engine.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellCompletion {
    replacement: String,
    display: String,
    description: Option<String>,
    kind: ShellCompletionKind,
    replace_range: Range<usize>,
}

/// One completion query with candidate edits and exact-token metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellCompletionSnapshot {
    completions: Vec<ShellCompletion>,
    has_exact_match: bool,
}

impl ShellCompletionSnapshot {
    pub(crate) const fn new(completions: Vec<ShellCompletion>, has_exact_match: bool) -> Self {
        Self {
            completions,
            has_exact_match,
        }
    }

    /// Returns the bounded, ranked candidate edits for this query.
    pub fn completions(&self) -> &[ShellCompletion] {
        &self.completions
    }

    /// Consumes the snapshot and returns its candidate edits.
    pub fn into_completions(self) -> Vec<ShellCompletion> {
        self.completions
    }

    /// Reports whether the token under completion already exactly matches a candidate.
    pub const fn has_exact_match(&self) -> bool {
        self.has_exact_match
    }
}

impl ShellCompletion {
    pub(crate) fn new(
        replacement: impl Into<String>,
        display: impl Into<String>,
        description: Option<String>,
        kind: ShellCompletionKind,
        replace_range: Range<usize>,
    ) -> Self {
        Self {
            replacement: replacement.into(),
            display: display.into(),
            description,
            kind,
            replace_range,
        }
    }

    pub fn replacement(&self) -> &str {
        &self.replacement
    }

    pub fn display(&self) -> &str {
        &self.display
    }

    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub const fn kind(&self) -> ShellCompletionKind {
        self.kind
    }

    pub fn replace_range(&self) -> Range<usize> {
        self.replace_range.clone()
    }
}
