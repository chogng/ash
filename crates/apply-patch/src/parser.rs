use std::collections::BTreeSet;
use std::fmt;
use std::path::PathBuf;

pub(super) struct PatchDocument {
    pub(super) operations: Vec<PatchOperation>,
}

pub(super) enum PatchOperation {
    Update {
        path: PathBuf,
        move_path: Option<PathBuf>,
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
    pub(super) context: Option<String>,
    pub(super) end_of_file: bool,
    pub(super) lines: Vec<PatchLine>,
}

pub(super) enum PatchLine {
    Context(String),
    Remove(String),
    Add(String),
}

pub(super) enum PatchError {
    Message(String),
}

impl fmt::Display for PatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Message(message) => formatter.write_str(message),
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
                    let move_path = lines
                        .get(index)
                        .and_then(|line| line.strip_prefix("*** Move to: "));
                    let move_path = move_path.map(parse_path).transpose()?;
                    if let Some(target) = &move_path {
                        if !paths.insert(target.clone()) {
                            return Err(PatchError::Message(format!(
                                "patch changes a path more than once: {}",
                                target.display()
                            )));
                        }
                        index += 1;
                    }
                    let (hunks, next) = parse_hunks(&lines, index)?;
                    if hunks.is_empty() && move_path.is_none() {
                        return Err(PatchError::Message(
                            "update operation must contain at least one hunk".to_owned(),
                        ));
                    }
                    index = next;
                    PatchOperation::Update {
                        path,
                        move_path,
                        hunks,
                    }
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

    pub(super) fn paths(&self) -> Vec<PathBuf> {
        self.operations
            .iter()
            .flat_map(|operation| match operation {
                PatchOperation::Update {
                    path, move_path, ..
                } => std::iter::once(path.clone())
                    .chain(move_path.iter().cloned())
                    .collect::<Vec<_>>(),
                PatchOperation::Add { path, .. } | PatchOperation::Delete { path } => {
                    vec![path.clone()]
                }
            })
            .collect()
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
    Ok((kind, parse_path(raw_path)?))
}

fn parse_path(raw_path: &str) -> Result<PathBuf, PatchError> {
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
    Ok(path)
}

fn parse_hunks(lines: &[&str], mut index: usize) -> Result<(Vec<PatchHunk>, usize), PatchError> {
    let mut hunks = Vec::new();
    while index < lines.len() && !lines[index].starts_with("*** ") {
        let header = lines[index];
        let context = if header == "@@" {
            None
        } else if let Some(context) = header.strip_prefix("@@ ") {
            Some(context.to_owned())
        } else {
            return Err(PatchError::Message(format!(
                "expected '@@' or '@@ context', found: {header}"
            )));
        };
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
        let end_of_file = lines.get(index).copied() == Some("*** End of File");
        if end_of_file {
            index += 1;
        }
        hunks.push(PatchHunk {
            context,
            end_of_file,
            lines: hunk_lines,
        });
        if end_of_file {
            break;
        }
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
