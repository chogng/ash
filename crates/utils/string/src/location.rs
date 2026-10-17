/// Converts a Markdown location suffix such as `#L12C3-L14C9` to `:12:3-14:9`.
/// Malformed or empty line/column components are rejected; arbitrary URL anchors stay unchanged
/// at the calling boundary. This performs no filesystem or numeric-range resolution.
pub fn normalize_markdown_hash_location_suffix(suffix: &str) -> Option<String> {
    let fragment = suffix.strip_prefix('#')?;
    let (start, end) = fragment
        .split_once('-')
        .map_or((fragment, None), |(start, end)| (start, Some(end)));
    let mut normalized = location_point(start)?;
    if let Some(end) = end {
        normalized.push('-');
        normalized.push_str(&location_point(end)?);
    }
    Some(format!(":{normalized}"))
}

fn location_point(point: &str) -> Option<String> {
    let point = point.strip_prefix('L')?;
    let (line, column) = point
        .split_once('C')
        .map_or((point, None), |(line, column)| (line, Some(column)));
    let digits = |value: &str| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit());
    if !digits(line) || column.is_some_and(|column| !digits(column)) {
        return None;
    }
    Some(match column {
        Some(column) => format!("{line}:{column}"),
        None => line.to_owned(),
    })
}

#[cfg(test)]
#[path = "location_tests.rs"]
mod tests;
