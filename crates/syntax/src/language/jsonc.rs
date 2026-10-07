use super::LanguageDefinition;

/// JSONC shares the upstream JSON grammar, whose extras include line and block comments.
pub(super) fn definition() -> LanguageDefinition {
    LanguageDefinition {
        language: tree_sitter_json::LANGUAGE.into(),
        highlights: tree_sitter_json::HIGHLIGHTS_QUERY,
        tags: "",
    }
}
