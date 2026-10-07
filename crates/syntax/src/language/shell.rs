use super::LanguageDefinition;

pub(super) fn definition() -> LanguageDefinition {
    LanguageDefinition {
        language: tree_sitter_bash::LANGUAGE.into(),
        highlights: tree_sitter_bash::HIGHLIGHT_QUERY,
        tags: "",
    }
}
