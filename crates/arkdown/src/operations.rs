use crate::Error;
use crate::Node;
use crate::NodeKind;
use crate::SourceIndex;
use crate::TextEdit;
use crate::Utf16Range;
use crate::parse;
use serde::Deserialize;

/// Source-preserving structural proposals. Hosts commit the returned edits through
/// their existing transaction/history owner; parsing never becomes writable state.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    SetHeading { offset: u32, level: u8 },
    SetListKind { offset: u32, list: ListKind },
    SetTaskChecked { offset: u32, checked: bool },
    InsertTableRow { offset: u32 },
    DeleteTableRow { offset: u32 },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListKind {
    Bullet,
    Ordered,
    Task,
}

pub fn operation_edits(source: &str, operation: Operation) -> Result<Vec<TextEdit>, Error> {
    let index = SourceIndex::new(source)?;
    let offset = match operation {
        Operation::SetHeading { offset, .. }
        | Operation::SetListKind { offset, .. }
        | Operation::SetTaskChecked { offset, .. }
        | Operation::InsertTableRow { offset }
        | Operation::DeleteTableRow { offset } => offset,
    };
    let byte = index.utf16_to_byte(offset)?;
    let nodes = parse(source)?;
    let line_start = source[..byte]
        .rfind('\n')
        .map_or(0, |position| position + 1);
    let line_end = source[byte..]
        .find('\n')
        .map_or(source.len(), |position| byte + position);
    if source[line_start..line_end].trim().is_empty()
        && !nodes
            .iter()
            .any(|node| node.source.bytes.start <= byte && byte < node.source.bytes.end)
    {
        let text = match operation {
            Operation::SetHeading { level: 0, .. } => return Ok(Vec::new()),
            Operation::SetHeading {
                level: level @ 1..=6,
                ..
            } => Some(format!("{} ", "#".repeat(level as usize))),
            Operation::SetListKind { list, .. } => Some(
                match list {
                    ListKind::Bullet => "- ",
                    ListKind::Ordered => "1. ",
                    ListKind::Task => "- [ ] ",
                }
                .to_owned(),
            ),
            Operation::SetHeading { .. }
            | Operation::SetTaskChecked { .. }
            | Operation::InsertTableRow { .. }
            | Operation::DeleteTableRow { .. } => None,
        };
        if let Some(text) = text {
            let start = index.byte_to_utf16(line_start)?;
            return Ok(vec![TextEdit {
                range: Utf16Range { start, end: start },
                text,
            }]);
        }
    }
    let edits = match operation {
        Operation::SetHeading { level, .. } => {
            if level > 6 {
                return Err(invalid("Heading level must be between 0 and 6"));
            }
            let block = nodes
                .iter()
                .find(|node| {
                    node.source.utf16.start <= offset
                        && offset <= node.source.utf16.end
                        && matches!(node.kind, NodeKind::Paragraph | NodeKind::Heading { .. })
                })
                .ok_or_else(|| {
                    invalid("Heading conversion requires a top-level paragraph or heading")
                })?;
            let raw = &source[block.source.bytes.start..block.source.bytes.end];
            let first_line = raw.split(['\r', '\n']).next().unwrap_or("");
            let hashes = first_line.bytes().take_while(|&byte| byte == b'#').count();
            let prefix =
                if matches!(block.kind, NodeKind::Heading { .. }) && hashes > 0 && hashes <= 6 {
                    hashes
                        + first_line[hashes..]
                            .bytes()
                            .take_while(|&byte| byte == b' ' || byte == b'\t')
                            .count()
                } else {
                    0
                };
            if matches!(block.kind, NodeKind::Heading { .. }) && prefix == 0 {
                return Err(invalid("Setext heading conversion requires source editing"));
            }
            let start = block.source.utf16.start;
            let text = if level == 0 {
                String::new()
            } else {
                format!("{} ", "#".repeat(level as usize))
            };
            let mut edits = vec![TextEdit {
                range: Utf16Range {
                    start,
                    end: start + prefix as u32,
                },
                text,
            }];
            if level == 0 && matches!(block.kind, NodeKind::Heading { .. }) {
                let trimmed = first_line.trim_end_matches([' ', '\t']);
                let before_hashes = trimmed.trim_end_matches('#');
                if before_hashes.len() < trimmed.len() && before_hashes.ends_with([' ', '\t']) {
                    let content_end = before_hashes.trim_end_matches([' ', '\t']).len();
                    edits.push(TextEdit {
                        range: Utf16Range {
                            start: index.byte_to_utf16(block.source.bytes.start + content_end)?,
                            end: index
                                .byte_to_utf16(block.source.bytes.start + first_line.len())?,
                        },
                        text: String::new(),
                    });
                }
            }
            Ok(edits)
        }
        Operation::SetListKind { list, .. } => {
            let block = nodes
                .iter()
                .find(|node| {
                    node.source.utf16.start <= offset
                        && offset <= node.source.utf16.end
                        && matches!(node.kind, NodeKind::Paragraph | NodeKind::List { .. })
                })
                .ok_or_else(|| invalid("List conversion requires a top-level paragraph or list"))?;
            let items: Vec<&Node> = if matches!(block.kind, NodeKind::List { .. }) {
                block.children.iter().collect()
            } else {
                vec![block]
            };
            let mut edits = Vec::new();
            for (number, item) in items.iter().enumerate() {
                let raw = &source[item.source.bytes.start..item.source.bytes.end];
                let line = raw.split(['\r', '\n']).next().unwrap_or("");
                let mut removed = 0;
                let mut indent = 0;
                if matches!(block.kind, NodeKind::List { .. }) {
                    indent = line.bytes().take_while(|&byte| byte == b' ').count();
                    let marker = if line[indent..].starts_with(['-', '+', '*']) {
                        1
                    } else {
                        line[indent..]
                            .bytes()
                            .take_while(u8::is_ascii_digit)
                            .count()
                            + 1
                    };
                    removed = indent
                        + marker
                        + line[indent + marker..]
                            .bytes()
                            .take_while(|&byte| byte == b' ' || byte == b'\t')
                            .count();
                    if ["[ ] ", "[x] ", "[X] "]
                        .iter()
                        .any(|marker| line[removed..].starts_with(marker))
                    {
                        removed += 4;
                    }
                }
                let text = match list {
                    ListKind::Bullet => "- ".to_owned(),
                    ListKind::Ordered => format!("{}. ", number + 1),
                    ListKind::Task => {
                        let checkbox = line
                            .get(removed.saturating_sub(4)..removed)
                            .filter(|value| value.starts_with('['))
                            .unwrap_or("[ ] ");
                        format!("- {checkbox}")
                    }
                };
                let start = item.source.utf16.start + indent as u32;
                edits.push(TextEdit {
                    range: Utf16Range {
                        start,
                        end: item.source.utf16.start + removed as u32,
                    },
                    text,
                });
            }
            Ok(edits)
        }
        Operation::SetTaskChecked { checked, .. } => {
            let marker = find(&nodes, offset, |kind| {
                matches!(kind, NodeKind::TaskListMarker { .. })
            })
            .ok_or_else(|| invalid("Offset must address a task marker"))?;
            if matches!(marker.kind, NodeKind::TaskListMarker { checked: current } if current == checked)
            {
                return Ok(Vec::new());
            }
            let range = marker.source.bytes;
            let text = &source[range.start..range.end];
            if text.len() != 3 || !text.starts_with('[') || !text.ends_with(']') {
                return Err(invalid("Unsupported task marker"));
            }
            let start = marker.source.utf16.start + 1;
            let text = if checked { "x" } else { " " };
            Ok(vec![TextEdit {
                range: Utf16Range {
                    start,
                    end: start + 1,
                },
                text: text.to_owned(),
            }])
        }
        Operation::InsertTableRow { .. } | Operation::DeleteTableRow { .. } => {
            let table = find(&nodes, offset, |kind| {
                matches!(kind, NodeKind::Table { .. })
            })
            .ok_or_else(|| invalid("Offset must address a table"))?;
            // Nested containers need their own indentation/quote prefixes. Refuse
            // them rather than silently moving a row outside its owning container.
            if !nodes.iter().any(|node| std::ptr::eq(node, table)) {
                return Err(invalid("Table row operations require a top-level table"));
            }
            let row = table
                .children
                .iter()
                .find(|row| row.source.utf16.start <= offset && offset < row.source.utf16.end)
                .ok_or_else(|| invalid("Offset must address a table row"))?;
            match operation {
                Operation::DeleteTableRow { .. } => {
                    if !matches!(row.kind, NodeKind::TableRow) {
                        return Err(invalid("The table header cannot be deleted as a body row"));
                    }
                    Ok(vec![TextEdit {
                        range: row.source.utf16,
                        text: String::new(),
                    }])
                }
                Operation::InsertTableRow { .. } => {
                    // Insert at the table end so a header insertion cannot split
                    // the header from its mandatory delimiter line.
                    let NodeKind::Table { ref alignments } = table.kind else {
                        unreachable!()
                    };
                    let end = table.source.bytes.end;
                    let newline = if source[table.source.bytes.start..end].contains("\r\n") {
                        "\r\n"
                    } else {
                        "\n"
                    };
                    let prefix = if source[..end].ends_with('\n') {
                        ""
                    } else {
                        newline
                    };
                    let text = format!("{prefix}|{}{newline}", "   |".repeat(alignments.len()));
                    let start = table.source.utf16.end;
                    Ok(vec![TextEdit {
                        range: Utf16Range { start, end: start },
                        text,
                    }])
                }
                Operation::SetTaskChecked { .. }
                | Operation::SetHeading { .. }
                | Operation::SetListKind { .. } => unreachable!(),
            }
        }
    }?;
    let mut proposal = crate::Document::new(source)?;
    Ok(proposal
        .apply(crate::Transaction {
            expected_revision: 0,
            edits,
        })?
        .edits)
}

fn find(
    nodes: &[Node],
    offset: u32,
    predicate: impl Fn(&NodeKind) -> bool + Copy,
) -> Option<&Node> {
    for node in nodes {
        if node.source.utf16.start <= offset && offset < node.source.utf16.end {
            if predicate(&node.kind) {
                return Some(node);
            }
            if let Some(found) = find(&node.children, offset, predicate) {
                return Some(found);
            }
        }
    }
    None
}

fn invalid(message: &str) -> Error {
    Error::InvalidRequest {
        message: message.to_owned(),
    }
}
