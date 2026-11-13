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
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnAlignment {
    None,
    Left,
    Center,
    Right,
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
    Heading { level: u8 },
    BlockQuote { callout: Option<String> },
    CodeBlock { info: String },
    HtmlBlock,
    List { start: Option<u64> },
    Item,
    FootnoteDefinition { label: String },
    DefinitionList,
    DefinitionListTitle,
    DefinitionListDefinition,
    Table { alignments: Vec<ColumnAlignment> },
    TableHead,
    TableRow,
    TableCell,
    Emphasis,
    Strong,
    Strikethrough,
    Superscript,
    Subscript,
    Link { destination: String, title: String },
    Image { destination: String, title: String },
    MetadataBlock { format: String },
    Text { text: String },
    Code { text: String },
    InlineMath { text: String },
    DisplayMath { text: String },
    RawHtml { text: String },
    FootnoteReference { label: String },
    SoftBreak,
    HardBreak,
    Rule,
    TaskListMarker { checked: bool },
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
    Ok(roots)
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
        Tag::TableCell => NodeKind::TableCell,
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

/// Produces preview HTML with raw HTML escaped and active URL schemes removed.
/// Hosts still own resource fetching, navigation and their content security policy.
pub fn render_html(source: &str) -> Result<String, Error> {
    check_source_size(source.len())?;
    let mut links = Vec::new();
    let mut images = Vec::new();
    let events = Parser::new_ext(source, options()).filter_map(|event| match event {
        Event::Html(text) | Event::InlineHtml(text) => Some(Event::Text(text)),
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
        _ => false,
    }
}
