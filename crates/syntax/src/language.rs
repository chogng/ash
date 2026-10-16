use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use tree_sitter::Language;
use tree_sitter::Parser;
use tree_sitter::Query;

use crate::SyntaxError;

include!("languages.generated.rs");

pub(crate) struct LanguageConfiguration {
    pub(crate) folding: &'static ash_language::FoldingRules,
    pub(crate) highlights: Query,
    pub(crate) tags: Query,
    pub(crate) folds: Query,
    pub(crate) editor_highlights: Query,
    pub(crate) editor_brackets: Query,
    pub(crate) injections: Option<Query>,
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
        static CONFIGURATIONS: OnceLock<
            Mutex<HashMap<SyntaxLanguage, Arc<LanguageConfiguration>>>,
        > = OnceLock::new();
        let key = if syntax_language == SyntaxLanguage::Javascriptreact {
            SyntaxLanguage::Javascript
        } else {
            syntax_language
        };
        let mut cached = CONFIGURATIONS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(configuration) = cached.get(&key) {
            return Ok(Arc::clone(configuration));
        }
        let highlights = query(
            syntax_language,
            &language,
            "highlights",
            definition.highlights,
        )?;
        let tags = query(syntax_language, &language, "tags", &(definition.tags)())?;
        let editor_highlights = query(
            syntax_language,
            &language,
            "editor highlights",
            definition.editor_highlights,
        )?;
        // Grammars expose different punctuation sets. Include only complete bracket pairs
        // actually present in this grammar; named string/comment nodes are never brackets.
        let mut brackets = Vec::new();
        for (open, close) in [("(", ")"), ("[", "]"), ("{", "}")] {
            if language.id_for_node_kind(open, false) != 0
                && language.id_for_node_kind(close, false) != 0
            {
                brackets.push(format!("\"{open}\" \"{close}\""));
            }
        }
        let bracket_source = if brackets.is_empty() {
            String::new()
        } else {
            format!("[{}] @bracket", brackets.join(" "))
        };
        let editor_brackets = query(
            syntax_language,
            &language,
            "editor brackets",
            &bracket_source,
        )?;
        let injection_source = definition.injections;
        let injections = if injection_source.is_empty() {
            None
        } else {
            Some(query(
                syntax_language,
                &language,
                "injections",
                injection_source,
            )?)
        };
        let configuration = Arc::new(Self {
            folding: ash_language::folding_rules(syntax_language.editor_id()),
            highlights,
            tags,
            editor_highlights,
            folds: query(syntax_language, &language, "folds", definition.folds)?,
            editor_brackets,
            injections,
        });
        cached.insert(key, Arc::clone(&configuration));
        Ok(configuration)
    }
}

struct LanguageDefinition {
    language: Language,
    highlights: &'static str,
    // Resolve upstream bundle queries only when compiling an uncached configuration.
    tags: fn() -> String,
    editor_highlights: &'static str,
    injections: &'static str,
    folds: &'static str,
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
