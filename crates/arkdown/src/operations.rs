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
    SetHeading {
        offset: u32,
        level: u8,
    },
    SetListKind {
        offset: u32,
        list: ListKind,
    },
    SetTaskChecked {
        offset: u32,
        checked: bool,
    },
    IndentList {
        offset: u32,
        end: u32,
        direction: IndentDirection,
    },
    InsertTableRow {
        offset: u32,
    },
    DeleteTableRow {
        offset: u32,
    },
    Table {
        offset: u32,
        action: crate::TableAction,
    },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListKind {
    Bullet,
    Ordered,
    Task,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndentDirection {
    Increase,
    Decrease,
}

pub fn operation_edits(source: &str, operation: Operation) -> Result<Vec<TextEdit>, Error> {
    let index = SourceIndex::new(source)?;
    let offset = match operation {
        Operation::SetHeading { offset, .. }
        | Operation::SetListKind { offset, .. }
        | Operation::SetTaskChecked { offset, .. }
        | Operation::IndentList { offset, .. }
        | Operation::InsertTableRow { offset }
        | Operation::DeleteTableRow { offset }
        | Operation::Table { offset, .. } => offset,
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
            | Operation::IndentList { .. }
            | Operation::InsertTableRow { .. }
            | Operation::DeleteTableRow { .. }
            | Operation::Table { .. } => None,
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
        Operation::Table { action, .. } => crate::table::edit(source, &nodes, offset, action),
        Operation::IndentList { end, direction, .. } => {
            index.utf16_to_byte(end)?;
            if end < offset {
                return Err(invalid("Selection end precedes its start"));
            }
            indent_list(source, &index, &nodes, offset, end, direction)
        }
        Operation::SetHeading { level, .. } => {
            if level > 6 {
                return Err(invalid("Heading level must be between 0 and 6"));
            }
            let path = conversion_path(&nodes, offset, index.utf16_len());
            let block = path
                .iter()
                .rev()
                .find(|node| {
                    matches!(
                        node.kind,
                        NodeKind::Paragraph | NodeKind::Heading { .. } | NodeKind::Item
                    )
                })
                .ok_or_else(|| invalid("Heading conversion requires a text block"))?;
            let prefix = if level == 0 {
                String::new()
            } else {
                format!("{} ", "#".repeat(level as usize))
            };
            text_block_edits(source, &index, block, prefix)
        }
        Operation::SetListKind { list, .. } => {
            let path = conversion_path(&nodes, offset, index.utf16_len());
            // The innermost list owns its sibling markers. Paragraphs inside an
            // item must not turn a list-kind change into a second list marker.
            let block = path
                .iter()
                .rev()
                .find(|node| matches!(node.kind, NodeKind::List { .. }))
                .or_else(|| {
                    path.iter().rev().find(|node| {
                        matches!(node.kind, NodeKind::Paragraph | NodeKind::Heading { .. })
                    })
                })
                .ok_or_else(|| invalid("List conversion requires a text block or list"))?;
            let marker = |number: usize| match list {
                ListKind::Bullet => "- ".to_owned(),
                ListKind::Ordered => format!("{}. ", number + 1),
                ListKind::Task => "- [ ] ".to_owned(),
            };
            if !matches!(block.kind, NodeKind::List { .. }) {
                text_block_edits(source, &index, block, marker(0))
            } else {
                let mut edits = Vec::new();
                for (number, item) in block.children.iter().enumerate() {
                    let raw = &source[item.source.bytes.start..item.source.bytes.end];
                    let indent = raw.bytes().take_while(|&byte| byte == b' ').count();
                    let marker_end = indent + list_marker_end(&raw[indent..]);
                    let mut removed = marker_end;
                    let checkbox = raw
                        .get(removed..removed + 3)
                        .filter(|value| matches!(*value, "[ ]" | "[x]" | "[X]"));
                    let checkbox = checkbox.filter(|_| {
                        find(
                            &item.children,
                            item.source.utf16.start + marker_end as u32,
                            |kind| matches!(kind, NodeKind::TaskListMarker { .. }),
                        )
                        .is_some()
                    });
                    if checkbox.is_some() {
                        removed += 3;
                        removed += raw[removed..]
                            .bytes()
                            .take_while(|byte| matches!(byte, b' ' | b'\t'))
                            .count();
                    }
                    let text = match list {
                        ListKind::Task => format!("- {} ", checkbox.unwrap_or("[ ]")),
                        ListKind::Bullet | ListKind::Ordered => marker(number),
                    };
                    let new_indent = indent + list_marker_end(&text);
                    edits.push(TextEdit {
                        range: Utf16Range {
                            start: item.source.utf16.start + indent as u32,
                            end: index.byte_to_utf16(item.source.bytes.start + removed)?,
                        },
                        text,
                    });
                    // Continuations and child lists follow the marker's content
                    // column, not the checkbox width. Keep them in the same item.
                    reindent_continuations(
                        source, &index, item, marker_end, new_indent, &mut edits,
                    )?;
                }
                Ok(edits)
            }
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
                    if matches!(&table.kind, NodeKind::Table { layout, .. } if !layout.ordinary()) {
                        let index = table
                            .children
                            .iter()
                            .position(|value| std::ptr::eq(value, row))
                            .expect("row belongs to its table");
                        crate::table::edit(
                            source,
                            &nodes,
                            offset,
                            crate::TableAction::DeleteRows {
                                from: index,
                                to: index,
                            },
                        )
                    } else {
                        Ok(vec![TextEdit {
                            range: row.source.utf16,
                            text: String::new(),
                        }])
                    }
                }
                Operation::InsertTableRow { .. } => {
                    // Insert at the table end so a header insertion cannot split
                    // the header from its mandatory delimiter line.
                    let NodeKind::Table { ref alignments, .. } = table.kind else {
                        unreachable!()
                    };
                    let end = source[table.source.bytes.start..table.source.bytes.end]
                        .rfind("<!-- ash-table ")
                        .filter(|position| {
                            table.source.bytes.start + position
                                >= table
                                    .children
                                    .last()
                                    .map_or(table.source.bytes.start, |row| row.source.bytes.end)
                        })
                        .map_or(table.source.bytes.end, |position| {
                            let prefix = &source
                                [table.source.bytes.start..table.source.bytes.start + position];
                            table.source.bytes.start
                                + prefix.trim_end_matches(['\r', '\n', ' ', '\t']).len()
                        });
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
                    let start = index.byte_to_utf16(end)?;
                    Ok(vec![TextEdit {
                        range: Utf16Range { start, end: start },
                        text,
                    }])
                }
                Operation::SetTaskChecked { .. }
                | Operation::IndentList { .. }
                | Operation::SetHeading { .. }
                | Operation::SetListKind { .. }
                | Operation::Table { .. } => unreachable!(),
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

/// Only descend through editable block containers. Inline syntax and table/code
/// contents are not independent blocks, even when their text contains Markdown.
fn conversion_path(nodes: &[Node], offset: u32, length: u32) -> Vec<&Node> {
    let mut path = Vec::new();
    let mut children = nodes;
    while let Some(node) = children.iter().find(|node| {
        node.source.utf16.start <= offset
            && (offset < node.source.utf16.end
                || offset == length && offset == node.source.utf16.end)
    }) {
        if !matches!(
            node.kind,
            NodeKind::Paragraph
                | NodeKind::Heading { .. }
                | NodeKind::BlockQuote { .. }
                | NodeKind::List { .. }
                | NodeKind::Item
                | NodeKind::FootnoteDefinition { .. }
        ) {
            if matches!(
                node.kind,
                NodeKind::CodeBlock { .. }
                    | NodeKind::HtmlBlock
                    | NodeKind::Table { .. }
                    | NodeKind::Rule
            ) {
                return Vec::new();
            }
            break;
        }
        path.push(node);
        children = &node.children;
    }
    path
}

fn list_marker_end(raw: &str) -> usize {
    let marker = if raw.starts_with(['-', '+', '*']) {
        1
    } else {
        raw.bytes().take_while(u8::is_ascii_digit).count() + 1
    };
    marker
        + raw[marker..]
            .bytes()
            .take_while(|byte| matches!(byte, b' ' | b'\t'))
            .count()
}

fn text_block_edits(
    source: &str,
    index: &SourceIndex,
    block: &Node,
    prefix: String,
) -> Result<Vec<TextEdit>, Error> {
    let start = block.source.bytes.start;
    let raw = &source[start..block.source.bytes.end];
    let first_line = raw.split(['\r', '\n']).next().unwrap_or("");
    let hashes = first_line.bytes().take_while(|&byte| byte == b'#').count();
    let heading = matches!(block.kind, NodeKind::Heading { .. });
    let atx = heading
        && (1..=6).contains(&hashes)
        && (hashes == first_line.len() || first_line[hashes..].starts_with([' ', '\t']));
    let mut removed = if atx {
        hashes
            + first_line[hashes..]
                .bytes()
                .take_while(|byte| matches!(byte, b' ' | b'\t'))
                .count()
    } else {
        0
    };
    if matches!(block.kind, NodeKind::Item) {
        if prefix.is_empty() {
            return Ok(Vec::new());
        }
        let indent = raw.bytes().take_while(|&byte| byte == b' ').count();
        let content = indent + list_marker_end(&raw[indent..]);
        removed = block
            .children
            .iter()
            .find(|child| !matches!(child.kind, NodeKind::TaskListMarker { .. }))
            .map_or(content, |child| child.source.bytes.start - start);
        // Keep the owning list marker. A heading replaces the item's paragraph
        // (and its task marker), never the surrounding list or its child blocks.
        return Ok(vec![TextEdit {
            range: Utf16Range {
                start: index.byte_to_utf16(start + content)?,
                end: index.byte_to_utf16(start + removed)?,
            },
            text: prefix,
        }]);
    }
    let join_lines = prefix.starts_with('#') || heading && !atx;
    let mut edits = vec![TextEdit {
        range: Utf16Range {
            start: block.source.utf16.start,
            end: index.byte_to_utf16(start + removed)?,
        },
        text: prefix,
    }];
    if heading && !atx {
        // Setext's underline belongs to this heading. Remove it together with
        // its preceding line break, leaving the final line ending untouched.
        let body = raw.trim_end_matches(['\r', '\n']);
        let underline = body
            .rfind('\n')
            .ok_or_else(|| invalid("Missing heading underline"))?;
        let from = underline - usize::from(body[..underline].ends_with('\r'));
        edits.push(TextEdit {
            range: Utf16Range {
                start: index.byte_to_utf16(start + from)?,
                end: index.byte_to_utf16(start + body.len())?,
            },
            text: String::new(),
        });
    } else if atx {
        let trimmed = first_line.trim_end_matches([' ', '\t']);
        let before_hashes = trimmed.trim_end_matches('#');
        if before_hashes.len() < trimmed.len() && before_hashes.ends_with([' ', '\t']) {
            // A closing hash run is syntax, not list/paragraph content. Do not
            // overlap the opening marker for an empty heading such as `## ##`.
            let content_end = before_hashes
                .trim_end_matches([' ', '\t'])
                .len()
                .max(removed);
            if content_end < first_line.len() {
                edits.push(TextEdit {
                    range: Utf16Range {
                        start: index.byte_to_utf16(start + content_end)?,
                        end: index.byte_to_utf16(start + first_line.len())?,
                    },
                    text: String::new(),
                });
            }
        }
    }
    if join_lines {
        join_heading_lines(&block.children, index, &mut edits)?;
    }
    edits.sort_by_key(|edit| edit.range.start);
    Ok(edits)
}

fn join_heading_lines(
    nodes: &[Node],
    index: &SourceIndex,
    edits: &mut Vec<TextEdit>,
) -> Result<(), Error> {
    for (position, node) in nodes.iter().enumerate() {
        if matches!(node.kind, NodeKind::SoftBreak | NodeKind::HardBreak) {
            let end = nodes
                .get(position + 1)
                .map_or(node.source.bytes.end, |next| next.source.bytes.start);
            edits.push(TextEdit {
                range: Utf16Range {
                    start: node.source.utf16.start,
                    end: index.byte_to_utf16(end)?,
                },
                text: " ".to_owned(),
            });
        } else {
            join_heading_lines(&node.children, index, edits)?;
        }
    }
    Ok(())
}

fn reindent_continuations(
    source: &str,
    index: &SourceIndex,
    item: &Node,
    old_indent: usize,
    new_indent: usize,
    edits: &mut Vec<TextEdit>,
) -> Result<(), Error> {
    if old_indent == new_indent {
        return Ok(());
    }
    let start = item.source.bytes.start;
    let line_start = source[..start]
        .rfind('\n')
        .map_or(0, |position| position + 1);
    let container = &source[line_start..start];
    let mut byte = start;
    for (line_number, line) in source[start..item.source.bytes.end]
        .split_inclusive('\n')
        .enumerate()
    {
        if line_number > 0 {
            if let Some(content) = line.strip_prefix(container) {
                let spaces = content.bytes().take_while(|&byte| byte == b' ').count();
                if spaces >= old_indent && !content.trim().is_empty() {
                    let start = index.byte_to_utf16(byte + container.len())?;
                    edits.push(TextEdit {
                        range: Utf16Range {
                            start,
                            end: start + old_indent.saturating_sub(new_indent) as u32,
                        },
                        text: " ".repeat(new_indent.saturating_sub(old_indent)),
                    });
                }
            }
        }
        byte += line.len();
    }
    Ok(())
}

fn indent_list(
    source: &str,
    index: &SourceIndex,
    nodes: &[Node],
    offset: u32,
    end: u32,
    direction: IndentDirection,
) -> Result<Vec<TextEdit>, Error> {
    fn path<'a>(nodes: &'a [Node], offset: u32, parents: &mut Vec<&'a Node>) {
        for node in nodes {
            if node.source.utf16.start <= offset && offset < node.source.utf16.end {
                if matches!(node.kind, NodeKind::List { .. } | NodeKind::Item) {
                    parents.push(node);
                }
                path(&node.children, offset, parents);
                break;
            }
        }
    }
    let lookup = offset.min(index.utf16_len().saturating_sub(1));
    let mut parents = Vec::new();
    path(nodes, lookup, &mut parents);
    let position = parents
        .iter()
        .rposition(|node| matches!(node.kind, NodeKind::List { .. }))
        .ok_or_else(|| invalid("Indentation requires a list item"))?;
    let list = parents[position];
    if end > list.source.utf16.end {
        return Err(invalid("Selection must stay within one list"));
    }
    let first = list
        .children
        .iter()
        .position(|item| item.source.utf16.start <= lookup && lookup < item.source.utf16.end)
        .ok_or_else(|| invalid("Selection must address a list item"))?;
    let last = list
        .children
        .iter()
        .rposition(|item| item.source.utf16.start < end.max(offset + 1))
        .unwrap_or(first);
    let line_start = |byte: usize| {
        source[..byte]
            .rfind('\n')
            .map_or(0, |position| position + 1)
    };
    let indentation = |item: &Node| item.source.bytes.start - line_start(item.source.bytes.start);
    let amount = match direction {
        IndentDirection::Increase => {
            if first == 0 {
                return Err(invalid("The first list item has no preceding parent"));
            }
            let previous = &list.children[first - 1];
            let raw = &source[previous.source.bytes.start..previous.source.bytes.end];
            let marker = if raw.starts_with(['-', '*', '+']) {
                1
            } else {
                raw.bytes().take_while(u8::is_ascii_digit).count() + 1
            };
            if raw[marker..].starts_with('\t') {
                return Err(invalid("Use source to indent tab-based lists"));
            }
            marker
                + raw[marker..]
                    .bytes()
                    .take_while(|byte| *byte == b' ')
                    .count()
        }
        IndentDirection::Decrease => {
            let parent = parents[..position]
                .iter()
                .rev()
                .find(|node| matches!(node.kind, NodeKind::Item))
                .ok_or_else(|| invalid("The list is already at its outermost level"))?;
            indentation(&list.children[first])
                .checked_sub(indentation(parent))
                .filter(|amount| *amount > 0)
                .ok_or_else(|| invalid("Unsupported list indentation"))?
        }
    };
    if amount == 0 || amount > 16 {
        return Err(invalid("Unsupported list indentation"));
    }
    let start = line_start(list.children[first].source.bytes.start);
    let finish = list.children[last].source.bytes.end;
    let mut edits = Vec::new();
    let mut byte = start;
    for line in source[start..finish].split_inclusive('\n') {
        if !line.trim().is_empty() {
            if line
                .bytes()
                .take_while(|byte| matches!(byte, b' ' | b'\t'))
                .any(|byte| byte == b'\t')
            {
                return Err(invalid("Use source to indent tab-based lists"));
            }
            let units = index.byte_to_utf16(byte)?;
            let (end, text) = match direction {
                IndentDirection::Increase => (units, " ".repeat(amount)),
                IndentDirection::Decrease => {
                    if line.bytes().take(amount).any(|byte| byte != b' ') {
                        return Err(invalid("Use source to indent tab-based lists"));
                    }
                    (units + amount as u32, String::new())
                }
            };
            edits.push(TextEdit {
                range: Utf16Range { start: units, end },
                text,
            });
        }
        byte += line.len();
    }
    Ok(edits)
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
