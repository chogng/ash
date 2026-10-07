use super::LanguageDefinition;

pub(super) fn definition() -> LanguageDefinition {
    LanguageDefinition {
        language: tree_sitter_javascript::LANGUAGE.into(),
        highlights: tree_sitter_javascript::HIGHLIGHT_QUERY,
        tags: tree_sitter_javascript::TAGS_QUERY,
    }
}
