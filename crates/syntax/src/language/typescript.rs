use super::LanguageDefinition;

pub(super) fn definition(react: bool) -> LanguageDefinition {
    LanguageDefinition {
        language: if react {
            tree_sitter_typescript::LANGUAGE_TSX.into()
        } else {
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
        },
        highlights: tree_sitter_typescript::HIGHLIGHTS_QUERY,
        // TypeScript's tags extend JavaScript; its query alone misses ordinary functions and classes.
        tags: &[
            tree_sitter_javascript::TAGS_QUERY,
            tree_sitter_typescript::TAGS_QUERY,
        ],
    }
}
