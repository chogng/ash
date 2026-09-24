//! Built-in language editing rules consumed directly by CodeEditor commands.

use super::CodeEditorLanguage;

pub(super) fn paired_delimiter_close(
    language: CodeEditorLanguage,
    open: &str,
) -> Option<&'static str> {
    match open {
        "(" => Some(")"),
        "[" => Some("]"),
        "{" => Some("}"),
        "\"" if supports_double_quotes(language) => Some("\""),
        "'" if supports_single_quotes(language) => Some("'"),
        "`" if supports_backticks(language) => Some("`"),
        _ => None,
    }
}

pub(super) fn is_closing_delimiter(language: CodeEditorLanguage, text: &str) -> bool {
    matches!(text, ")" | "]" | "}")
        || (text == "\"" && supports_double_quotes(language))
        || (text == "'" && supports_single_quotes(language))
        || (text == "`" && supports_backticks(language))
}

pub(super) fn line_comment_marker(language: CodeEditorLanguage) -> Option<&'static str> {
    match language {
        CodeEditorLanguage::Rust | CodeEditorLanguage::Jsonc => Some("//"),
        CodeEditorLanguage::Shell => Some("#"),
        CodeEditorLanguage::PlainText | CodeEditorLanguage::Json => None,
    }
}

const fn supports_double_quotes(_language: CodeEditorLanguage) -> bool {
    true
}

const fn supports_single_quotes(language: CodeEditorLanguage) -> bool {
    matches!(
        language,
        CodeEditorLanguage::Rust | CodeEditorLanguage::Shell
    )
}

const fn supports_backticks(language: CodeEditorLanguage) -> bool {
    matches!(
        language,
        CodeEditorLanguage::Rust | CodeEditorLanguage::Shell
    )
}
