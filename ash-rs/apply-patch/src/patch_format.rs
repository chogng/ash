use crate::TextFileFormat;
use std::collections::BTreeSet;
use std::fmt;
use std::path::PathBuf;

pub(super) struct PatchDocument {
    pub(super) operations: Vec<PatchOperation>,
}

pub(super) enum PatchOperation {
    Update {
        path: PathBuf,
        hunks: Vec<PatchHunk>,
    },
    Add {
        path: PathBuf,
        lines: Vec<String>,
    },
    Delete {
        path: PathBuf,
    },
}

pub(super) struct PatchHunk {
    lines: Vec<PatchLine>,
}

enum PatchLine {
    Context(String),
    Remove(String),
    Add(String),
}

pub(super) enum PatchError {
    Message(String),
    Io(String),
}

impl PatchError {
    pub(super) fn io(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }

    pub(super) fn sandbox(error: impl fmt::Display) -> Self {
        Self::Message(error.to_string())
    }
}

impl fmt::Display for PatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Message(message) | Self::Io(message) => formatter.write_str(message),
        }
    }
}

impl PatchDocument {
    pub(super) fn parse(patch: &str) -> Result<Self, PatchError> {
        let lines = patch.lines().collect::<Vec<_>>();
        if lines.first().copied() != Some("*** Begin Patch") {
            return Err(PatchError::Message(
                "patch must begin with '*** Begin Patch'".to_owned(),
            ));
        }
        let mut index = 1;
        let mut operations = Vec::new();
        let mut paths = BTreeSet::new();
        let mut saw_end = false;
        while index < lines.len() {
            let line = lines[index];
            if line == "*** End Patch" {
                saw_end = true;
                index += 1;
                break;
            }
            let (kind, path) = parse_operation_header(line)?;
            if !paths.insert(path.clone()) {
                return Err(PatchError::Message(format!(
                    "patch changes a path more than once: {}",
                    path.display()
                )));
            }
            index += 1;
            let operation = match kind {
                PatchOperationKind::Update => {
                    let (hunks, next) = parse_hunks(&lines, index)?;
                    index = next;
                    PatchOperation::Update { path, hunks }
                }
                PatchOperationKind::Add => {
                    let (lines, next) = parse_added_lines(&lines, index)?;
                    index = next;
                    PatchOperation::Add { path, lines }
                }
                PatchOperationKind::Delete => PatchOperation::Delete { path },
            };
            operations.push(operation);
        }
        if !saw_end {
            return Err(PatchError::Message(
                "patch must end with '*** End Patch'".to_owned(),
            ));
        }
        if index != lines.len() {
            return Err(PatchError::Message(
                "patch has content after '*** End Patch'".to_owned(),
            ));
        }
        if operations.is_empty() {
            return Err(PatchError::Message(
                "patch contains no operations".to_owned(),
            ));
        }
        Ok(Self { operations })
    }
}

enum PatchOperationKind {
    Update,
    Add,
    Delete,
}

fn parse_operation_header(line: &str) -> Result<(PatchOperationKind, PathBuf), PatchError> {
    let (kind, raw_path) = if let Some(path) = line.strip_prefix("*** Update File: ") {
        (PatchOperationKind::Update, path)
    } else if let Some(path) = line.strip_prefix("*** Add File: ") {
        (PatchOperationKind::Add, path)
    } else if let Some(path) = line.strip_prefix("*** Delete File: ") {
        (PatchOperationKind::Delete, path)
    } else {
        return Err(PatchError::Message(format!(
            "unknown patch operation: {line}"
        )));
    };
    let path = PathBuf::from(raw_path);
    if raw_path.trim().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(PatchError::Message(format!(
            "patch path must be relative and must not contain '..': {raw_path}"
        )));
    }
    Ok((kind, path))
}

fn parse_hunks(lines: &[&str], mut index: usize) -> Result<(Vec<PatchHunk>, usize), PatchError> {
    let mut hunks = Vec::new();
    while index < lines.len() && !lines[index].starts_with("*** ") {
        if !lines[index].starts_with("@@") {
            return Err(PatchError::Message(format!(
                "expected hunk header beginning with '@@', found: {}",
                lines[index]
            )));
        }
        index += 1;
        let mut hunk_lines = Vec::new();
        while index < lines.len()
            && !lines[index].starts_with("@@")
            && !lines[index].starts_with("*** ")
        {
            hunk_lines.push(parse_hunk_line(lines[index])?);
            index += 1;
        }
        if hunk_lines.is_empty() {
            return Err(PatchError::Message("patch hunk is empty".to_owned()));
        }
        hunks.push(PatchHunk { lines: hunk_lines });
    }
    if hunks.is_empty() {
        return Err(PatchError::Message(
            "update operation must contain at least one hunk".to_owned(),
        ));
    }
    Ok((hunks, index))
}

fn parse_hunk_line(line: &str) -> Result<PatchLine, PatchError> {
    let Some(marker) = line.chars().next() else {
        return Err(PatchError::Message(
            "patch hunk contains an empty line".to_owned(),
        ));
    };
    let content = &line[marker.len_utf8()..];
    match marker {
        ' ' => Ok(PatchLine::Context(content.to_owned())),
        '-' => Ok(PatchLine::Remove(content.to_owned())),
        '+' => Ok(PatchLine::Add(content.to_owned())),
        _ => Err(PatchError::Message(format!(
            "patch hunk line must begin with space, '+', or '-': {line}"
        ))),
    }
}

fn parse_added_lines(lines: &[&str], mut index: usize) -> Result<(Vec<String>, usize), PatchError> {
    let mut added = Vec::new();
    while index < lines.len() && !lines[index].starts_with("*** ") {
        let Some(content) = lines[index].strip_prefix('+') else {
            return Err(PatchError::Message(format!(
                "added-file line must begin with '+': {}",
                lines[index]
            )));
        };
        added.push(content.to_owned());
        index += 1;
    }
    Ok((added, index))
}

pub(super) fn apply_hunks(original: &str, hunks: &[PatchHunk]) -> Result<String, PatchError> {
    let format = TextFileFormat::for_existing(original);
    let trailing_newline = original.ends_with(['\r', '\n']);
    let mut lines = split_text_lines(original);
    let mut cursor = 0;
    for hunk in hunks {
        let before = hunk
            .lines
            .iter()
            .filter_map(|line| match line {
                PatchLine::Context(text) | PatchLine::Remove(text) => Some(text.as_str()),
                PatchLine::Add(_) => None,
            })
            .collect::<Vec<_>>();
        let Some(position) = find_lines(&lines, &before, cursor) else {
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
                    ending: format.eol,
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
            format.eol
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
