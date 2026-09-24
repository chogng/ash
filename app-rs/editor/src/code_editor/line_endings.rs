//! Shared document line-ending selection for editor-owned text transformations.

/// Returns the preferred separator while preserving the first line-ending style present.
pub(super) fn preferred_line_ending(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "\r\n"
    } else if text.contains('\n') {
        "\n"
    } else if text.contains('\r') {
        "\r"
    } else {
        "\n"
    }
}
