//! Source-language identities and package-declared file associations and folding rules.
//!
//! Language identity is independent of available parsers, language servers, and indexing support.
//! Built-in declarations are generated from the same extension manifests consumed by the Editor.
//! This crate does not read files, own editor documents, or activate providers.

use std::borrow::Cow;
use std::fmt;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use regex::RegexBuilder;

/// Canonical source-language identity, including languages contributed by external packages.
///
/// Unknown valid identities survive persistence and routing even when no parser supports them.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LanguageId(Cow<'static, str>);

impl LanguageId {
    pub const PLAIN_TEXT: Self = Self(Cow::Borrowed("plaintext"));
    pub const RUST: Self = Self(Cow::Borrowed("rust"));

    /// Validates an identity at a configuration, persistence, or protocol boundary.
    /// Legacy grammar identities are normalized to their public editor language identity.
    pub fn parse(value: &str) -> Result<Self, InvalidLanguageId> {
        let value = canonical_language_id(value);
        if value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(InvalidLanguageId);
        }
        let identity = DECLARATIONS
            .iter()
            .find(|declaration| declaration.id == value)
            .map_or_else(
                || Cow::Owned(value.to_owned()),
                |declaration| Cow::Borrowed(declaration.id),
            );
        Ok(Self(identity))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for LanguageId {
    fn default() -> Self {
        Self::PLAIN_TEXT
    }
}

impl fmt::Display for LanguageId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug)]
pub struct InvalidLanguageId;

impl fmt::Display for InvalidLanguageId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "language ID must contain 1-128 ASCII letters, digits, dots, underscores, or hyphens",
        )
    }
}

impl std::error::Error for InvalidLanguageId {}

struct Association {
    id: &'static str,
    extensions: &'static [&'static str],
    filenames: &'static [&'static str],
    patterns: &'static [&'static str],
    first_line: Option<&'static str>,
}

struct FoldingDeclaration {
    id: &'static str,
    off_side: bool,
    markers: Option<(&'static str, &'static str, &'static str, &'static str)>,
}

/// Package-owned rules for indentation fallback and explicit folding regions.
pub struct FoldingRules {
    off_side: bool,
    markers: Option<(Regex, Regex)>,
}

/// A line's explicit region role, independently of its parser node or indentation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FoldingMarker {
    None,
    Start,
    End,
}

impl FoldingRules {
    pub fn off_side(&self) -> bool {
        self.off_side
    }

    pub fn marker(&self, line: &str) -> FoldingMarker {
        match &self.markers {
            Some((_, end)) if end.is_match(line) => FoldingMarker::End,
            Some((start, _)) if start.is_match(line) => FoldingMarker::Start,
            _ => FoldingMarker::None,
        }
    }
}

/// Reads the immutable rules generated from a language package's configuration.
pub fn folding_rules(language_id: &str) -> &'static FoldingRules {
    static DEFAULT: FoldingRules = FoldingRules {
        off_side: false,
        markers: None,
    };
    static RULES: LazyLock<Vec<(&'static str, FoldingRules)>> = LazyLock::new(|| {
        FOLDING_DECLARATIONS
            .iter()
            .map(|declaration| {
                (
                    declaration.id,
                    FoldingRules {
                        off_side: declaration.off_side,
                        markers: declaration
                            .markers
                            .map(|(start, start_flags, end, end_flags)| {
                                (
                                    compile_expression(start, start_flags),
                                    compile_expression(end, end_flags),
                                )
                            }),
                    },
                )
            })
            .collect()
    });
    let language_id = canonical_language_id(language_id);
    RULES
        .iter()
        .find(|(id, _)| *id == language_id)
        .map_or(&DEFAULT, |(_, rules)| rules)
}

fn compile_expression(source: &str, flags: &str) -> Regex {
    // Keep JavaScript identity escapes and ASCII word boundaries consistent across runtimes.
    let source = source
        .replace("\\<", "<")
        .replace("\\!", "!")
        .replace("\\b", "(?-u:\\b)");
    let source = if flags.contains('y') {
        format!("\\A(?:{source})")
    } else {
        source
    };
    RegexBuilder::new(&source)
        .case_insensitive(flags.contains('i'))
        .multi_line(flags.contains('m'))
        .dot_matches_new_line(flags.contains('s'))
        .build()
        .expect("generated language expression must compile")
}

include!("languages.generated.rs");

struct CompiledAssociation {
    declaration: &'static Association,
    patterns: Vec<Regex>,
    first_line: Option<Regex>,
}

static ASSOCIATIONS: LazyLock<Vec<CompiledAssociation>> = LazyLock::new(|| {
    DECLARATIONS
        .iter()
        .map(|declaration| CompiledAssociation {
            declaration,
            patterns: declaration
                .patterns
                .iter()
                .map(|pattern| compile_glob(pattern))
                .collect(),
            first_line: declaration.first_line.map(|source| {
                let source = if source.starts_with('^') {
                    source.to_owned()
                } else {
                    format!("^(?:{source})")
                };
                compile_expression(&source, "")
            }),
        })
        .collect()
});

/// Detects a built-in language without consulting the filesystem.
///
/// As in the Editor, exact filenames precede globs, longest suffixes, and first-line patterns.
/// Equal matches use declaration order. Unrecognized files remain plain text; callers decide
/// independently whether the detected language has a parser or an installed language server.
pub fn detect_language(path: &Path, first_line: Option<&str>) -> LanguageId {
    let path = path.to_string_lossy().replace('\\', "/").to_lowercase();
    let filename = path.rsplit('/').next().unwrap_or(&path);
    let first_line = first_line.map(|line| {
        let line = line.strip_prefix('\u{feff}').unwrap_or(line);
        let mut units = 0;
        let end = line
            .char_indices()
            .find_map(|(offset, character)| {
                units += character.len_utf16();
                (units > 1000).then_some(offset)
            })
            .unwrap_or(line.len());
        &line[..end]
    });
    ASSOCIATIONS
        .iter()
        .enumerate()
        .filter_map(|(order, association)| {
            let declaration = association.declaration;
            let score = if declaration.filenames.contains(&filename) {
                Some((3, filename.len()))
            } else if let Some((index, _)) = association
                .patterns
                .iter()
                .enumerate()
                .find(|(_, pattern)| pattern.is_match(&path) || pattern.is_match(filename))
            {
                Some((2, declaration.patterns[index].len()))
            } else if let Some(extension) = declaration
                .extensions
                .iter()
                .filter(|extension| path.ends_with(**extension))
                .max_by_key(|extension| extension.len())
            {
                Some((1, extension.len()))
            } else if first_line.is_some_and(|line| {
                association
                    .first_line
                    .as_ref()
                    .is_some_and(|pattern| pattern.is_match(line))
            }) {
                Some((0, declaration.first_line.unwrap_or_default().len()))
            } else {
                None
            };
            score.map(|(rank, specificity)| ((rank, specificity, order), declaration.id))
        })
        .max_by_key(|(score, _)| *score)
        .map_or(LanguageId::PLAIN_TEXT, |(_, id)| {
            LanguageId(Cow::Borrowed(id))
        })
}

fn compile_glob(pattern: &str) -> Regex {
    let mut expression = String::from("^");
    let mut characters = pattern.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '*' if characters.peek() == Some(&'*') => {
                characters.next();
                expression.push_str(".*");
            }
            '*' => expression.push_str("[^/]*"),
            '?' => expression.push_str("[^/]"),
            character => expression.push_str(&regex::escape(&character.to_string())),
        }
    }
    expression.push('$');
    Regex::new(&expression).expect("escaped association glob must compile")
}

#[cfg(test)]
#[path = "language_tests.rs"]
mod tests;
