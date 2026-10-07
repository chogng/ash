use std::ops::Range;

/// Editable Slash Launcher query under the composer cursor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashLauncherQuery<'a> {
    pub text: &'a str,
    pub range: Range<usize>,
}

/// Read-only interpretation of composer text as a slash-triggered launcher query.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SlashLauncherInput<'a> {
    text: &'a str,
    cursor: usize,
}

impl<'a> SlashLauncherInput<'a> {
    pub fn at_cursor(text: &'a str, cursor: usize) -> Self {
        Self { text, cursor }
    }

    pub fn query(self) -> Option<SlashLauncherQuery<'a>> {
        if self.cursor < 1 || !self.text.is_char_boundary(self.cursor) {
            return None;
        }
        let token_range = launcher_token_range(self.text)?;
        let first_line_end = self.text.find('\n').unwrap_or(self.text.len());
        if self.cursor > first_line_end || self.cursor > token_range.end {
            return None;
        }
        Some(SlashLauncherQuery {
            text: &self.text[1..self.cursor],
            range: token_range,
        })
    }
}

fn launcher_token_range(text: &str) -> Option<Range<usize>> {
    let query = text.strip_prefix('/')?;
    let end = query
        .find(char::is_whitespace)
        .map(|index| 1 + index)
        .unwrap_or(text.len());
    Some(0..end)
}

#[cfg(test)]
#[path = "input_tests.rs"]
mod tests;
