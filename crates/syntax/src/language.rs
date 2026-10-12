use std::sync::Arc;
use std::sync::Mutex;

use tree_sitter::Language;
use tree_sitter::Parser;
use tree_sitter::Query;

use crate::SyntaxError;

mod javascript;
mod json;
mod jsonc;
mod rust;
mod shell;
mod typescript;

/// Source language selected for syntax analysis.
///
/// Each variant identifies a grammar and the structural queries that implementations must use.
/// Adding a language requires registering its grammar and tests in this crate; callers do not
/// supply arbitrary query source or native grammar pointers.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum SyntaxLanguage {
    Javascript,
    Javascriptreact,
    Json,
    Jsonc,
    Rust,
    Shell,
    Typescript,
    Typescriptreact,
}

impl SyntaxLanguage {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Javascript => "javascript",
            Self::Javascriptreact => "javascriptreact",
            Self::Json => "json",
            Self::Jsonc => "jsonc",
            Self::Rust => "rust",
            Self::Shell => "shell",
            Self::Typescript => "typescript",
            Self::Typescriptreact => "typescriptreact",
        }
    }
}

pub(crate) struct LanguageConfiguration {
    pub(crate) highlights: Query,
    pub(crate) tags: Query,
}

impl LanguageConfiguration {
    pub(crate) fn load(
        syntax_language: SyntaxLanguage,
        parser: &mut Parser,
    ) -> Result<Arc<Self>, SyntaxError> {
        let definition = definition(syntax_language);
        let language = definition.language;
        parser
            .set_language(&language)
            .map_err(|source| SyntaxError::Language {
                language: syntax_language,
                source,
            })?;
        // Queries are immutable; documents own their parsers and query cursors. Compiling
        // these for every file makes directory refresh and watcher shutdown unbounded in practice.
        static CONFIGURATIONS: [Mutex<Option<Arc<LanguageConfiguration>>>; 7] =
            [const { Mutex::new(None) }; 7];
        let index = match syntax_language {
            SyntaxLanguage::Javascript | SyntaxLanguage::Javascriptreact => 0,
            SyntaxLanguage::Json => 1,
            SyntaxLanguage::Jsonc => 2,
            SyntaxLanguage::Rust => 3,
            SyntaxLanguage::Shell => 4,
            SyntaxLanguage::Typescript => 5,
            SyntaxLanguage::Typescriptreact => 6,
        };
        let mut cached = CONFIGURATIONS[index]
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(configuration) = &*cached {
            return Ok(Arc::clone(configuration));
        }
        let highlights = query(
            syntax_language,
            &language,
            "highlights",
            definition.highlights,
        )?;
        let tags = query(
            syntax_language,
            &language,
            "tags",
            &definition.tags.join("\n"),
        )?;
        let configuration = Arc::new(Self { highlights, tags });
        *cached = Some(Arc::clone(&configuration));
        Ok(configuration)
    }
}

struct LanguageDefinition {
    language: Language,
    highlights: &'static str,
    tags: &'static [&'static str],
}

fn definition(syntax_language: SyntaxLanguage) -> LanguageDefinition {
    match syntax_language {
        SyntaxLanguage::Javascript | SyntaxLanguage::Javascriptreact => javascript::definition(),
        SyntaxLanguage::Json => json::definition(),
        SyntaxLanguage::Jsonc => jsonc::definition(),
        SyntaxLanguage::Rust => rust::definition(),
        SyntaxLanguage::Shell => shell::definition(),
        SyntaxLanguage::Typescript => typescript::definition(false),
        SyntaxLanguage::Typescriptreact => typescript::definition(true),
    }
}

fn query(
    syntax_language: SyntaxLanguage,
    language: &Language,
    query_name: &'static str,
    source: &str,
) -> Result<Query, SyntaxError> {
    Query::new(language, source).map_err(|source| SyntaxError::Query {
        language: syntax_language,
        query_name,
        source,
    })
}

#[cfg(test)]
#[path = "language_tests.rs"]
mod tests;
