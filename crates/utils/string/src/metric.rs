/// Normalizes a metric label to ASCII letters, digits, `.`, `_`, `-`, and `/`.
///
/// Matches Codex's tag contract, including its 256-byte limit and empty-value fallback.
/// This is formatting, not redaction or cardinality control; callers own those policies.
pub fn sanitize_metric_tag_value(value: &str) -> String {
    let value: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '/') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let value = value.trim_matches('_');
    if !value.bytes().any(|ch| ch.is_ascii_alphanumeric()) {
        return "unspecified".into();
    }
    value[..value.len().min(256)].to_owned()
}

#[cfg(test)]
#[path = "metric_tests.rs"]
mod tests;
