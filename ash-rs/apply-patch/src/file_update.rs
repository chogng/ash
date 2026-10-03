use crate::parser::PatchError;
use crate::parser::PatchHunk;
use crate::parser::PatchLine;
use ash_file_system::TextFileFormat;

pub(super) fn apply_hunks(original: &str, hunks: &[PatchHunk]) -> Result<String, PatchError> {
    let format = TextFileFormat::for_existing(original);
    let trailing_newline = original.ends_with(['\r', '\n']);
    let mut lines = split_text_lines(original);
    let mut cursor = 0;
    for hunk in hunks {
        if let Some(context) = &hunk.context {
            let Some(position) = find_lines(&lines, &[context.as_str()], cursor) else {
                return Err(PatchError::Message(format!(
                    "patch change context was not found: {context}"
                )));
            };
            cursor = position + 1;
        }
        let before = hunk
            .lines
            .iter()
            .filter_map(|line| match line {
                PatchLine::Context(text) | PatchLine::Remove(text) => Some(text.as_str()),
                PatchLine::Add(_) => None,
            })
            .collect::<Vec<_>>();
        // An addition without old lines denotes an append. EOF-marked chunks
        // must match the final source lines instead of an earlier duplicate.
        let position = if before.is_empty() {
            Some(lines.len())
        } else if hunk.end_of_file {
            lines.len().checked_sub(before.len()).filter(|position| {
                *position >= cursor && find_lines(&lines, &before, *position) == Some(*position)
            })
        } else {
            find_lines(&lines, &before, cursor)
        };
        let Some(position) = position else {
            return Err(PatchError::Message(
                "patch hunk context does not match the current file".to_owned(),
            ));
        };
        let mut source = position;
        let mut replacement = Vec::new();
        for line in &hunk.lines {
            match line {
                PatchLine::Context(_) => {
                    replacement.push(lines[source].clone());
                    source += 1;
                }
                PatchLine::Remove(_) => source += 1,
                PatchLine::Add(text) => replacement.push(TextLine {
                    text: text.clone(),
                    ending: format.eol(),
                }),
            }
        }
        let replacement_len = replacement.len();
        lines.splice(position..position + before.len(), replacement);
        cursor = position + replacement_len;
    }
    // Context and untouched lines retain their exact endings, including mixed
    // files. Only inserted lines use the preferred format; EOF keeps its original
    // convention even when the last line is replaced or becomes an interior line.
    let last = lines.len().saturating_sub(1);
    let mut result = String::new();
    for (index, line) in lines.iter().enumerate() {
        result.push_str(&line.text);
        if index == last && !trailing_newline {
            continue;
        }
        result.push_str(if line.ending.is_empty() {
            format.eol()
        } else {
            line.ending
        });
    }
    Ok(result)
}

pub(super) fn new_file_content(lines: &[String]) -> String {
    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

#[derive(Clone)]
struct TextLine {
    text: String,
    ending: &'static str,
}

fn split_text_lines(text: &str) -> Vec<TextLine> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut index = 0;
    let bytes = text.as_bytes();
    while index < bytes.len() {
        let ending = match bytes[index] {
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => "\r\n",
            b'\r' => "\r",
            b'\n' => "\n",
            _ => {
                index += 1;
                continue;
            }
        };
        lines.push(TextLine {
            text: text[start..index].to_owned(),
            ending,
        });
        index += ending.len();
        start = index;
    }
    if start < text.len() {
        lines.push(TextLine {
            text: text[start..].to_owned(),
            ending: "",
        });
    }
    lines
}

fn find_lines(lines: &[TextLine], needle: &[&str], start: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(start.min(lines.len()));
    }
    lines
        .windows(needle.len())
        .enumerate()
        .skip(start)
        .find_map(|(index, candidate)| {
            candidate
                .iter()
                .zip(needle)
                .all(|(line, expected)| line.text == *expected)
                .then_some(index)
        })
}
