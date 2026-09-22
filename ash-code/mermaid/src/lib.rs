//! Terminal diagram layout without product state or terminal-widget dependencies.

mod canvas;
mod flowchart;
mod sequence;

use unicode_width::UnicodeWidthStr;

/// A diagram that cannot be represented faithfully by this renderer stays source text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RenderError {
    Unsupported,
    Limit,
    Width,
}

/// Renders the supported Mermaid subset into complete, unstyled terminal rows.
pub fn render(source: &str, width: usize) -> Result<Vec<String>, RenderError> {
    if source.len() > 64 * 1024 {
        return Err(RenderError::Limit);
    }
    if source
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return Err(RenderError::Unsupported);
    }
    let mut lines = source
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("%%"));
    let header = lines.next().ok_or(RenderError::Unsupported)?;
    let rows = if header == "sequenceDiagram" {
        sequence::render(lines, width)?
    } else {
        let direction = header
            .strip_prefix("flowchart ")
            .or_else(|| header.strip_prefix("graph "))
            .ok_or(RenderError::Unsupported)?;
        flowchart::render(direction.trim(), lines, width)?
    };
    if rows.iter().any(|row| row.width() > width) {
        return Err(RenderError::Width);
    }
    Ok(rows)
}

pub(crate) fn label(text: &str) -> Result<&str, RenderError> {
    let text = text.trim();
    let text = if text.starts_with('"') && text.ends_with('"') && text.len() >= 2 {
        &text[1..text.len() - 1]
    } else {
        text
    };
    if text.is_empty() || text.contains(['<', '>', '&', '#', '\\', '"', '\t']) || text.width() > 160
    {
        return Err(RenderError::Unsupported);
    }
    Ok(text)
}

pub(crate) fn identifier(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

#[cfg(test)]
#[path = "render_tests.rs"]
mod tests;
