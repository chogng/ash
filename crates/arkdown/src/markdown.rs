use crate::Error;
use crate::SourceIndex;
use crate::SourceSpan;
use crate::check_source_size;
use pulldown_cmark::Alignment;
use pulldown_cmark::BlockQuoteKind;
use pulldown_cmark::CodeBlockKind;
use pulldown_cmark::Event;
use pulldown_cmark::MetadataBlockKind;
use pulldown_cmark::Options;
use pulldown_cmark::Parser;
use pulldown_cmark::Tag;
use pulldown_cmark::TagEnd;
use pulldown_cmark::html;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnAlignment {
    None,
    Left,
    Center,
    Right,
}

/// Closed document palette. Source attributes cannot supply arbitrary CSS.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextColor {
    Red,
    Yellow,
    Green,
    Teal,
    Purple,
}

/// A source-backed projection, never a second writable copy of the document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Node {
    #[serde(flatten)]
    pub kind: NodeKind,
    pub source: SourceSpan,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Node>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NodeKind {
    Paragraph,
    Heading {
        level: u8,
    },
    BlockQuote {
        callout: Option<String>,
    },
    CodeBlock {
        info: String,
    },
    HtmlBlock,
    List {
        start: Option<u64>,
    },
    Item,
    FootnoteDefinition {
        label: String,
    },
    DefinitionList,
    DefinitionListTitle,
    DefinitionListDefinition,
    Table {
        alignments: Vec<ColumnAlignment>,
        layout: crate::TableLayout,
    },
    TableHead,
    TableRow,
    TableCell {
        missing: bool,
    },
    Emphasis,
    Strong,
    Strikethrough,
    Underline,
    TextColor {
        color: TextColor,
    },
    Highlight,
    Comment {
        thread_id: String,
    },
    Superscript,
    Subscript,
    Link {
        destination: String,
        title: String,
    },
    Image {
        destination: String,
        title: String,
    },
    MetadataBlock {
        format: String,
    },
    Text {
        text: String,
    },
    Code {
        text: String,
    },
    InlineMath {
        text: String,
    },
    DisplayMath {
        text: String,
    },
    RawHtml {
        text: String,
    },
    FootnoteReference {
        label: String,
    },
    SoftBreak,
    HardBreak,
    Rule,
    TaskListMarker {
        checked: bool,
    },
}

fn options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_MATH
        | Options::ENABLE_GFM
}

/// Parses without rewriting whitespace, delimiters, entities or line endings.
/// Source spans cover syntax in the original string, not decoded text positions.
pub fn parse(source: &str) -> Result<Vec<Node>, Error> {
    let index = SourceIndex::new(source)?;
    let mut roots = Vec::new();
    let mut stack: Vec<Node> = Vec::new();
    let mut node_count = 0;
    for (event, range) in Parser::new_ext(source, options()).into_offset_iter() {
        if let Event::End(_) = event {
            let node = stack.pop().expect("parser events are balanced");
            append(&mut roots, &mut stack, node);
            continue;
        }
        let container = matches!(event, Event::Start(_));
        node_count += 1;
        if node_count > 100_000 || container && stack.len() >= 128 {
            return Err(Error::ParseLimit {
                limit: if node_count > 100_000 {
                    "100000 nodes"
                } else {
                    "128 nested containers"
                }
                .to_owned(),
            });
        }
        let kind = match event {
            Event::Start(tag) => tag_kind(tag),
            Event::End(_) => unreachable!("handled before node creation"),
            Event::Text(text) => NodeKind::Text {
                text: text.into_string(),
            },
            Event::Code(text) => NodeKind::Code {
                text: text.into_string(),
            },
            Event::InlineMath(text) => NodeKind::InlineMath {
                text: text.into_string(),
            },
            Event::DisplayMath(text) => NodeKind::DisplayMath {
                text: text.into_string(),
            },
            Event::Html(text) | Event::InlineHtml(text) => NodeKind::RawHtml {
                text: text.into_string(),
            },
            Event::FootnoteReference(label) => NodeKind::FootnoteReference {
                label: label.into_string(),
            },
            Event::SoftBreak => NodeKind::SoftBreak,
            Event::HardBreak => NodeKind::HardBreak,
            Event::Rule => NodeKind::Rule,
            Event::TaskListMarker(checked) => NodeKind::TaskListMarker { checked },
        };
        let node = Node {
            kind,
            source: index.source_span(range)?,
            children: Vec::new(),
        };
        if container {
            stack.push(node);
        } else {
            append(&mut roots, &mut stack, node);
        }
    }
    debug_assert!(stack.is_empty());
    crate::table::fold_layouts(fold_inline_formats(roots, 0)?, source, &index)
}

/// Interpret only the exact inline tags emitted by Docs. Unknown HTML remains
/// inert source text, and an unmatched tag never consumes the rest of a block.
fn fold_inline_formats(nodes: Vec<Node>, depth: usize) -> Result<Vec<Node>, Error> {
    fn height(node: &Node) -> usize {
        1 + node.children.iter().map(height).max().unwrap_or(0)
    }
    struct Frame {
        open: Node,
        kind: NodeKind,
        close: &'static str,
        children: Vec<Node>,
    }
    let mut output = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();
    for mut node in nodes {
        if !matches!(node.kind, NodeKind::CodeBlock { .. } | NodeKind::HtmlBlock) {
            node.children = fold_inline_formats(node.children, depth + 1)?;
        }
        if let NodeKind::RawHtml { ref text } = node.kind {
            if let Some((kind, close)) = inline_format(text) {
                if depth + stack.len() >= 128 {
                    return Err(Error::ParseLimit {
                        limit: "128 nested containers".to_owned(),
                    });
                }
                stack.push(Frame {
                    open: node,
                    kind,
                    close,
                    children: Vec::new(),
                });
                continue;
            }
            if stack.last().is_some_and(|frame| frame.close == text) {
                let frame = stack
                    .pop()
                    .expect("matching inline tag has an opening frame");
                node = Node {
                    kind: frame.kind,
                    source: SourceSpan {
                        bytes: crate::ByteRange {
                            start: frame.open.source.bytes.start,
                            end: node.source.bytes.end,
                        },
                        utf16: crate::Utf16Range {
                            start: frame.open.source.utf16.start,
                            end: node.source.utf16.end,
                        },
                    },
                    children: frame.children,
                };
            }
        }
        // HTML marks can surround an already parsed Markdown subtree. Count
        // both kinds of ancestors before retaining it in another inline frame.
        if depth + stack.len() + height(&node) > 128 {
            return Err(Error::ParseLimit {
                limit: "128 nested containers".to_owned(),
            });
        }
        if let Some(frame) = stack.last_mut() {
            frame.children.push(node);
        } else {
            output.push(node);
        }
    }
    while let Some(frame) = stack.pop() {
        let target = stack
            .last_mut()
            .map_or(&mut output, |parent| &mut parent.children);
        target.push(frame.open);
        target.extend(frame.children);
    }
    Ok(output)
}

fn inline_format(text: &str) -> Option<(NodeKind, &'static str)> {
    match text {
        "<u>" => Some((NodeKind::Underline, "</u>")),
        "<mark>" => Some((NodeKind::Highlight, "</mark>")),
        _ => {
            if let Some(id) = text
                .strip_prefix("<span data-comment-id=\"")
                .and_then(|value| value.strip_suffix("\">"))
            {
                // Only canonical UUID-shaped identifiers can become attributes.
                let bytes = id.as_bytes();
                if bytes.len() != 36
                    || !bytes.iter().enumerate().all(|(index, byte)| {
                        if matches!(index, 8 | 13 | 18 | 23) {
                            *byte == b'-'
                        } else {
                            byte.is_ascii_hexdigit()
                        }
                    })
                    || !matches!(bytes[14], b'1'..=b'8')
                    || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
                {
                    return None;
                }
                return Some((
                    NodeKind::Comment {
                        thread_id: id.to_ascii_lowercase(),
                    },
                    "</span>",
                ));
            }
            let color = text
                .strip_prefix("<span data-text-color=\"")?
                .strip_suffix("\">")?;
            let color = match color {
                "red" => TextColor::Red,
                "yellow" => TextColor::Yellow,
                "green" => TextColor::Green,
                "teal" => TextColor::Teal,
                "purple" => TextColor::Purple,
                _ => return None,
            };
            Some((NodeKind::TextColor { color }, "</span>"))
        }
    }
}

fn append(roots: &mut Vec<Node>, stack: &mut [Node], node: Node) {
    if let Some(parent) = stack.last_mut() {
        parent.children.push(node);
    } else {
        roots.push(node);
    }
}

fn tag_kind(tag: Tag<'_>) -> NodeKind {
    match tag {
        Tag::Paragraph => NodeKind::Paragraph,
        Tag::Heading { level, .. } => NodeKind::Heading { level: level as u8 },
        Tag::BlockQuote(callout) => NodeKind::BlockQuote {
            callout: callout.map(|kind| {
                match kind {
                    BlockQuoteKind::Note => "note",
                    BlockQuoteKind::Tip => "tip",
                    BlockQuoteKind::Important => "important",
                    BlockQuoteKind::Warning => "warning",
                    BlockQuoteKind::Caution => "caution",
                }
                .to_owned()
            }),
        },
        Tag::CodeBlock(kind) => NodeKind::CodeBlock {
            info: match kind {
                CodeBlockKind::Fenced(info) => info.into_string(),
                CodeBlockKind::Indented => String::new(),
            },
        },
        Tag::HtmlBlock => NodeKind::HtmlBlock,
        Tag::List(start) => NodeKind::List { start },
        Tag::Item => NodeKind::Item,
        Tag::FootnoteDefinition(label) => NodeKind::FootnoteDefinition {
            label: label.into_string(),
        },
        Tag::DefinitionList => NodeKind::DefinitionList,
        Tag::DefinitionListTitle => NodeKind::DefinitionListTitle,
        Tag::DefinitionListDefinition => NodeKind::DefinitionListDefinition,
        Tag::Table(alignments) => NodeKind::Table {
            layout: crate::TableLayout::default(),
            alignments: alignments
                .into_iter()
                .map(|alignment| match alignment {
                    Alignment::None => ColumnAlignment::None,
                    Alignment::Left => ColumnAlignment::Left,
                    Alignment::Center => ColumnAlignment::Center,
                    Alignment::Right => ColumnAlignment::Right,
                })
                .collect(),
        },
        Tag::TableHead => NodeKind::TableHead,
        Tag::TableRow => NodeKind::TableRow,
        Tag::TableCell => NodeKind::TableCell { missing: false },
        Tag::Emphasis => NodeKind::Emphasis,
        Tag::Strong => NodeKind::Strong,
        Tag::Strikethrough => NodeKind::Strikethrough,
        Tag::Superscript => NodeKind::Superscript,
        Tag::Subscript => NodeKind::Subscript,
        Tag::Link {
            dest_url, title, ..
        } => NodeKind::Link {
            destination: dest_url.into_string(),
            title: title.into_string(),
        },
        Tag::Image {
            dest_url, title, ..
        } => NodeKind::Image {
            destination: dest_url.into_string(),
            title: title.into_string(),
        },
        Tag::MetadataBlock(kind) => NodeKind::MetadataBlock {
            format: match kind {
                MetadataBlockKind::YamlStyle => "yaml",
                MetadataBlockKind::PlusesStyle => "toml",
            }
            .to_owned(),
        },
    }
}

/// Produces preview HTML with unknown HTML escaped and active URL schemes removed.
/// Hosts still own resource fetching, navigation and their content security policy.
pub fn render_html(source: &str) -> Result<String, Error> {
    check_source_size(source.len())?;
    let mut inline_tags = HashSet::new();
    let table_nodes =
        (source.contains("<!-- ash-table ") || source.contains("&#10;") || source.contains("&#9;"))
            .then(|| parse(source))
            .transpose()?;
    let mut tables = std::collections::BTreeMap::new();
    let mut table_metadata = Vec::new();
    fn collect_tables(
        nodes: &[Node],
        source: &str,
        tables: &mut std::collections::BTreeMap<usize, String>,
        metadata: &mut Vec<std::ops::Range<usize>>,
    ) -> Result<(), Error> {
        for node in nodes {
            if let NodeKind::Table { .. } = node.kind {
                let tail = node
                    .children
                    .last()
                    .map_or(node.source.bytes.start, |row| row.source.bytes.end);
                if let Some(position) = source[tail..node.source.bytes.end].find("<!-- ash-table ")
                {
                    metadata.push(tail + position..node.source.bytes.end);
                    tables.insert(
                        node.source.bytes.start,
                        crate::table::render_html(node, source)?,
                    );
                } else if source[node.source.bytes.start..node.source.bytes.end].contains("&#10;")
                    || source[node.source.bytes.start..node.source.bytes.end].contains("&#9;")
                {
                    tables.insert(
                        node.source.bytes.start,
                        crate::table::render_html(node, source)?,
                    );
                }
            }
            collect_tables(&node.children, source, tables, metadata)?;
        }
        Ok(())
    }
    if let Some(nodes) = &table_nodes {
        collect_tables(nodes, source, &mut tables, &mut table_metadata)?;
    }
    fn collect(nodes: &[Node], source: &str, tags: &mut HashSet<(usize, usize)>) {
        for node in nodes {
            if matches!(
                node.kind,
                NodeKind::Underline
                    | NodeKind::Highlight
                    | NodeKind::TextColor { .. }
                    | NodeKind::Comment { .. }
            ) {
                let start = node.source.bytes.start;
                let end = node.source.bytes.end;
                if let (Some(open), Some(close)) =
                    (source[start..end].find('>'), source[start..end].rfind("</"))
                {
                    tags.insert((start, start + open + 1));
                    tags.insert((start + close, end));
                }
            }
            collect(&node.children, source, tags);
        }
    }
    if source.contains("<u>")
        || source.contains("<mark>")
        || source.contains("<span data-text-color=")
        || source.contains("<span data-comment-id=")
    {
        collect(&parse(source)?, source, &mut inline_tags);
    }
    let mut links = Vec::new();
    let mut images = Vec::new();
    let mut table_hidden = false;
    let events = Parser::new_ext(source, options())
        .into_offset_iter()
        .filter_map(|(event, range)| {
            if table_hidden {
                if matches!(event, Event::End(TagEnd::Table)) {
                    table_hidden = false;
                }
                return None;
            }
            if matches!(event, Event::Start(Tag::Table(_))) {
                if let Some(html) = tables.remove(&range.start) {
                    table_hidden = true;
                    return Some(Event::Html(html.into()));
                }
            }
            match event {
                Event::Html(text) | Event::InlineHtml(text) => {
                    if table_metadata
                        .iter()
                        .any(|metadata| metadata.start <= range.start && range.end <= metadata.end)
                    {
                        return None;
                    }
                    Some(if inline_tags.contains(&(range.start, range.end)) {
                        Event::InlineHtml(text)
                    } else {
                        Event::Text(text)
                    })
                }
                Event::Start(Tag::Link { ref dest_url, .. }) => {
                    let allowed = allowed_url(dest_url, false);
                    links.push(allowed);
                    allowed.then_some(event)
                }
                Event::End(TagEnd::Link) => links.pop().unwrap_or(false).then_some(event),
                Event::Start(Tag::Image { ref dest_url, .. }) => {
                    let allowed = allowed_url(dest_url, true);
                    images.push(allowed);
                    allowed.then_some(event)
                }
                Event::End(TagEnd::Image) => images.pop().unwrap_or(false).then_some(event),
                event => Some(event),
            }
        });
    let mut html = String::new();
    html::push_html(&mut html, events);
    Ok(html)
}

fn allowed_url(url: &str, image: bool) -> bool {
    if url.chars().any(char::is_control) {
        return false;
    }
    let url = url.trim();
    let Some(colon) = url.find(':') else {
        return true;
    };
    if url[..colon].contains(['/', '?', '#']) {
        return true;
    }
    match url[..colon].to_ascii_lowercase().as_str() {
        "http" | "https" => true,
        "mailto" | "tel" => !image,
        "data" if image => allowed_embedded_image(url),
        _ => false,
    }
}

fn allowed_embedded_image(url: &str) -> bool {
    // Documents embed raster bytes; active data schemes and SVG remain inert.
    let Some((header, data)) = url.split_once(',') else {
        return false;
    };
    if !matches!(
        header,
        "data:image/png;base64"
            | "data:image/jpeg;base64"
            | "data:image/gif;base64"
            | "data:image/webp;base64"
    ) || data.is_empty()
        || data.len() > (8 * 1024 * 1024_usize).div_ceil(3) * 4
        || !data.len().is_multiple_of(4)
    {
        return false;
    }
    let content = data.trim_end_matches('=');
    data.len() - content.len() <= 2
        && !content.is_empty()
        && content
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
}
