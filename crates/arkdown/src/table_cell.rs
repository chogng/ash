use crate::Error;
use crate::ListKind;
use crate::Node;
use crate::NodeKind;
use crate::SourceSpan;
use serde::Deserialize;

/// Cell blocks use a closed HTML vocabulary inside a GFM cell. The surrounding
/// pipe row stays on one source line, and unknown HTML remains inert text.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CellBlock {
    Heading { level: u8 },
    List { list: ListKind },
}

pub(crate) fn tag(text: &str) -> Option<(NodeKind, &'static str)> {
    match text {
        "<p>" => Some((NodeKind::Paragraph, "</p>")),
        "<h1>" => Some((NodeKind::Heading { level: 1 }, "</h1>")),
        "<h2>" => Some((NodeKind::Heading { level: 2 }, "</h2>")),
        "<h3>" => Some((NodeKind::Heading { level: 3 }, "</h3>")),
        "<h4>" => Some((NodeKind::Heading { level: 4 }, "</h4>")),
        "<h5>" => Some((NodeKind::Heading { level: 5 }, "</h5>")),
        "<h6>" => Some((NodeKind::Heading { level: 6 }, "</h6>")),
        "<ul>" => Some((NodeKind::List { start: None }, "</ul>")),
        "<ol>" => Some((NodeKind::List { start: Some(1) }, "</ol>")),
        "<li>" => Some((NodeKind::Item, "</li>")),
        _ => None,
    }
}

pub(crate) fn finish(node: &mut Node, opening: SourceSpan, source: &str) {
    let mut content = SourceSpan {
        bytes: crate::ByteRange {
            start: opening.bytes.end,
            end: opening.bytes.end,
        },
        utf16: crate::Utf16Range {
            start: opening.utf16.end,
            end: opening.utf16.end,
        },
    };
    if matches!(node.kind, NodeKind::Item) {
        let raw = &source[content.bytes.start..node.source.bytes.end];
        if ["[ ] ", "[x] ", "[X] "]
            .iter()
            .any(|marker| raw.starts_with(marker))
        {
            let end = content.bytes.start + 4;
            // The marker may span several parser Text events. Strip only its
            // literal ASCII prefix, retaining every later source-backed child.
            node.children.retain_mut(|child| {
                if child.source.bytes.end <= end {
                    return false;
                }
                if child.source.bytes.start < end {
                    if let NodeKind::Text { text } = &mut child.kind {
                        let removed = end - child.source.bytes.start;
                        text.drain(..removed);
                        child.source.bytes.start += removed;
                        child.source.utf16.start += removed as u32;
                    }
                }
                true
            });
            let marker = Node {
                kind: NodeKind::TaskListMarker {
                    checked: !raw.starts_with("[ ]"),
                },
                source: SourceSpan {
                    bytes: crate::ByteRange {
                        start: content.bytes.start,
                        end: content.bytes.start + 3,
                    },
                    utf16: crate::Utf16Range {
                        start: content.utf16.start,
                        end: content.utf16.start + 3,
                    },
                },
                children: Vec::new(),
            };
            node.children.insert(0, marker);
            content.bytes.start += 4;
            content.bytes.end += 4;
            content.utf16.start += 4;
            content.utf16.end += 4;
        }
    }
    if matches!(
        node.kind,
        NodeKind::Heading { .. } | NodeKind::Paragraph | NodeKind::Item
    ) && node
        .children
        .iter()
        .all(|child| matches!(child.kind, NodeKind::TaskListMarker { .. }))
    {
        node.children.push(Node {
            kind: NodeKind::Text {
                text: String::new(),
            },
            source: content,
            children: Vec::new(),
        });
    }
}

fn inner<'a>(node: &Node, source: &'a str) -> &'a str {
    let raw = &source[node.source.bytes.start..node.source.bytes.end];
    match node.kind {
        NodeKind::Heading { .. } | NodeKind::Paragraph | NodeKind::List { .. } | NodeKind::Item => {
            let start = raw.find('>').map_or(0, |position| position + 1);
            let end = raw.rfind("</").unwrap_or(raw.len());
            &raw[start..end]
        }
        _ => raw.trim(),
    }
}

fn without_task(value: &str) -> (&str, Option<&str>) {
    if ["[ ] ", "[x] ", "[X] "]
        .iter()
        .any(|marker| value.starts_with(marker))
    {
        (&value[4..], Some(&value[..3]))
    } else {
        (value, None)
    }
}

pub(crate) fn format(
    cell: &Node,
    source: &str,
    block: CellBlock,
    offset: Option<u32>,
) -> Result<String, Error> {
    if offset.is_none()
        && cell.children.len() > 1
        && cell
            .children
            .iter()
            .all(|node| has_blocks(std::slice::from_ref(node)))
    {
        return cell
            .children
            .iter()
            .map(|node| format_node(node, source, block))
            .collect();
    }
    let mut root = cell;
    if let Some(offset) = offset {
        let mut path = Vec::new();
        let mut children = &cell.children;
        while let Some(node) = children
            .iter()
            .find(|node| node.source.utf16.start <= offset && offset <= node.source.utf16.end)
        {
            if matches!(
                node.kind,
                NodeKind::Heading { .. } | NodeKind::Paragraph | NodeKind::List { .. }
            ) {
                path.push(node);
            }
            children = &node.children;
        }
        root = match block {
            CellBlock::Heading { .. } => path
                .iter()
                .rev()
                .find(|node| matches!(node.kind, NodeKind::Heading { .. } | NodeKind::Paragraph))
                .copied()
                .or_else(|| path.last().copied())
                .unwrap_or(cell),
            CellBlock::List { .. } => path
                .iter()
                .rev()
                .find(|node| matches!(node.kind, NodeKind::List { .. }))
                .copied()
                .or_else(|| path.last().copied())
                .unwrap_or(cell),
        };
    } else if cell.children.len() == 1 && has_blocks(&cell.children) {
        root = &cell.children[0];
    }
    let formatted = format_node(root, source, block)?;
    if std::ptr::eq(root, cell) {
        return Ok(formatted);
    }
    Ok(format!(
        "{}{}{}",
        &source[cell.source.bytes.start..root.source.bytes.start],
        formatted,
        &source[root.source.bytes.end..cell.source.bytes.end]
    )
    .trim()
    .to_owned())
}

fn format_node(root: &Node, source: &str, block: CellBlock) -> Result<String, Error> {
    let content = inner(root, source);
    match block {
        CellBlock::Heading { level } => {
            if level > 6 {
                return Err(Error::InvalidRequest {
                    message: "Heading level must be between 0 and 6".to_owned(),
                });
            }
            let content = if matches!(root.kind, NodeKind::List { .. }) {
                root.children
                    .iter()
                    .map(|item| {
                        if item
                            .children
                            .iter()
                            .any(|child| matches!(child.kind, NodeKind::TaskListMarker { .. }))
                        {
                            without_task(inner(item, source)).0
                        } else {
                            inner(item, source)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("&#10;")
            } else {
                content.to_owned()
            };
            if level == 0 {
                Ok(format!("<p>{content}</p>"))
            } else {
                Ok(format!("<h{level}>{content}</h{level}>"))
            }
        }
        CellBlock::List { list } => {
            let values = if matches!(root.kind, NodeKind::List { .. }) {
                root.children
                    .iter()
                    .map(|item| {
                        if item
                            .children
                            .iter()
                            .any(|child| matches!(child.kind, NodeKind::TaskListMarker { .. }))
                        {
                            without_task(inner(item, source))
                        } else {
                            (inner(item, source), None)
                        }
                    })
                    .collect::<Vec<_>>()
            } else {
                vec![(content, None)]
            };
            let items = values
                .iter()
                .map(|(content, checked)| {
                    let task = match list {
                        ListKind::Task => format!("{} ", checked.unwrap_or("[ ]")),
                        ListKind::Bullet | ListKind::Ordered => String::new(),
                    };
                    format!("<li>{task}{content}</li>")
                })
                .collect::<String>();
            let tag = match list {
                ListKind::Ordered => "ol",
                ListKind::Bullet | ListKind::Task => "ul",
            };
            Ok(format!("<{tag}>{items}</{tag}>"))
        }
    }
}

pub(crate) fn has_blocks(nodes: &[Node]) -> bool {
    nodes.iter().any(|node| {
        matches!(
            node.kind,
            NodeKind::Heading { .. } | NodeKind::Paragraph | NodeKind::List { .. }
        )
    })
}

/// Export the projected structural tags, while inline runs still pass through
/// the Markdown exporter's escaping and URL policy.
pub(crate) fn render_html(nodes: &[Node], source: &str) -> Result<String, Error> {
    let mut html = String::new();
    let mut position = 0;
    while position < nodes.len() {
        let node = &nodes[position];
        let tag = match node.kind {
            NodeKind::Heading { level } => Some(format!("h{level}")),
            NodeKind::Paragraph => Some("p".to_owned()),
            NodeKind::List { start } => Some(if start.is_some() { "ol" } else { "ul" }.to_owned()),
            NodeKind::Item => Some("li".to_owned()),
            _ => None,
        };
        if let Some(tag) = tag {
            html.push_str(&format!("<{tag}>"));
            if matches!(node.kind, NodeKind::Item)
                && matches!(
                    node.children.first().map(|child| &child.kind),
                    Some(NodeKind::TaskListMarker { .. })
                )
                && !has_blocks(&node.children)
            {
                let checked = matches!(
                    node.children[0].kind,
                    NodeKind::TaskListMarker { checked: true }
                );
                html.push_str(if checked {
                    "<input type=\"checkbox\" disabled checked>"
                } else {
                    "<input type=\"checkbox\" disabled>"
                });
                html.push_str(&render_inline(without_task(inner(node, source)).0)?);
            } else if node.children.iter().any(|child| {
                has_blocks(std::slice::from_ref(child))
                    || matches!(child.kind, NodeKind::Item | NodeKind::TaskListMarker { .. })
            }) {
                html.push_str(&render_html(&node.children, source)?);
            } else {
                html.push_str(&render_inline(inner(node, source))?);
            }
            html.push_str(&format!("</{tag}>"));
            position += 1;
        } else if let NodeKind::TaskListMarker { checked } = node.kind {
            html.push_str(if checked {
                "<input type=\"checkbox\" disabled checked>"
            } else {
                "<input type=\"checkbox\" disabled>"
            });
            position += 1;
        } else {
            let start = position;
            while position < nodes.len()
                && !has_blocks(&nodes[position..position + 1])
                && !matches!(
                    nodes[position].kind,
                    NodeKind::Item | NodeKind::TaskListMarker { .. }
                )
            {
                position += 1;
            }
            let raw =
                &source[nodes[start].source.bytes.start..nodes[position - 1].source.bytes.end];
            let rendered = crate::markdown::render_html(raw)?;
            html.push_str(
                rendered
                    .strip_prefix("<p>")
                    .and_then(|value| value.strip_suffix("</p>\n"))
                    .unwrap_or(&rendered),
            );
        }
    }
    Ok(html)
}

fn render_inline(source: &str) -> Result<String, Error> {
    let rendered = crate::markdown::render_html(source)?;
    Ok(rendered
        .strip_prefix("<p>")
        .and_then(|value| value.strip_suffix("</p>\n"))
        .unwrap_or(&rendered)
        .to_owned())
}
