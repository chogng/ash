use super::LanguageDefinition;

pub(super) fn definition() -> LanguageDefinition {
    LanguageDefinition {
        language: tree_sitter_rust::LANGUAGE.into(),
        highlights: tree_sitter_rust::HIGHLIGHTS_QUERY,
        tags: tree_sitter_rust::TAGS_QUERY,
    }
}
