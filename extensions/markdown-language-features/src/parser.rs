//! Stateless rendering parse of immutable editor snapshots. Offsets are UTF-16.
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use pulldown_cmark::Event;
use pulldown_cmark::HeadingLevel;
use pulldown_cmark::Options;
use pulldown_cmark::Parser;
use pulldown_cmark::Tag;
use serde::Serialize;
use std::ops::Range;

#[derive(Debug, Serialize)]
pub(crate) struct Document {
    pub(crate) blocks: Vec<Block>,
}

impl Document {
    pub(crate) fn render_math(
        &mut self,
        client: &external_ext_sdk::client::Client,
        configuration: &serde_json::Value,
        token: &external_ext_sdk::CancellationToken,
    ) -> Result<(), ExtensionError> {
        let mut formulas = Vec::new();
        for block in &mut self.blocks {
            block.content.visit_math(&mut |value, display, _| {
                formulas.push(ash_utils_markdown_math::Formula {
                    source: value.into(),
                    display: if display {
                        ash_utils_markdown_math::Display::Block
                    } else {
                        ash_utils_markdown_math::Display::Inline
                    },
                })
            });
        }
        if let Some(html) = super::math::render(client, formulas, configuration, token)? {
            let mut html = html.into_iter();
            for block in &mut self.blocks {
                block
                    .content
                    .visit_math(&mut |_, _, rendered| *rendered = html.next());
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct Block {
    start: u32,
    end: u32,
    content: Node,
}

#[derive(Debug)]
enum Node {
    Text {
        value: String,
    },
    Element {
        tag: Element,
        children: Vec<Node>,
    },
    OrderedList {
        first: u64,
        children: Vec<Node>,
    },
    Link {
        destination: String,
        children: Vec<Node>,
    },
    Image {
        destination: String,
        children: Vec<Node>,
    },
    Code {
        value: String,
    },
    Math {
        value: String,
        display: bool,
        html: Option<String>,
    },
    Task {
        checked: bool,
        offset: u32,
    },
    Break,
    Rule,
    Raw {
        value: String,
    },
}

impl Node {
    fn visit_math(&mut self, visitor: &mut impl FnMut(&str, bool, &mut Option<String>)) {
        match self {
            Self::Math {
                value,
                display,
                html,
            } => visitor(value, *display, html),
            Self::Element { children, .. }
            | Self::OrderedList { children, .. }
            | Self::Link { children, .. }
            | Self::Image { children, .. } => {
                for child in children {
                    child.visit_math(visitor);
                }
            }
            Self::Text { .. }
            | Self::Code { .. }
            | Self::Task { .. }
            | Self::Break
            | Self::Rule
            | Self::Raw { .. } => {}
        }
    }
}

// This private render wire format avoids repeating field names for every inline
// node. A prose-heavy snapshot can otherwise exceed the host response quota well
// before reaching the source limit. The renderer consumes these tuples directly.
impl Serialize for Block {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        (&self.start, &self.end, &self.content).serialize(serializer)
    }
}

impl Serialize for Node {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Text { value } => ("t", value).serialize(serializer),
            Self::Element { tag, children } => ("el", tag, children).serialize(serializer),
            Self::OrderedList { first, children } => ("ol", first, children).serialize(serializer),
            Self::Link {
                destination,
                children,
            } => ("a", destination, children).serialize(serializer),
            Self::Image {
                destination,
                children,
            } => ("img", destination, children).serialize(serializer),
            Self::Code { value } => ("code", value).serialize(serializer),
            Self::Math {
                value,
                display,
                html,
            } => ("math", value, display, html).serialize(serializer),
            Self::Task { checked, offset } => ("task", checked, offset).serialize(serializer),
            Self::Break => ["br"].serialize(serializer),
            Self::Rule => ["hr"].serialize(serializer),
            Self::Raw { value } => ("raw", value).serialize(serializer),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum Element {
    P,
    H1,
    H2,
    H3,
    H4,
    H5,
    H6,
    Blockquote,
    Ul,
    Li,
    Pre,
    Table,
    Thead,
    Tr,
    Td,
    Em,
    Strong,
    Del,
}

/// Parses a bounded snapshot. Gaps are retained as raw blocks, including reference
/// definitions, front matter and whitespace which do not produce parser events.
pub(crate) fn parse_checked(
    source: &str,
    math_enabled: bool,
    check: impl Fn() -> Result<(), ExtensionError>,
) -> Result<Document, ExtensionError> {
    check()?;
    if source.len() > 16 * 1024 * 1024 {
        return Err(ExtensionError::new(
            HostErrorCode::InvalidRequest,
            "Markdown snapshot exceeds the parser limit",
        ));
    }
    let mut offsets = vec![0; source.len() + 1];
    let mut position = 0;
    for (byte, character) in source.char_indices() {
        if byte % 4096 == 0 {
            check()?;
        }
        offsets[byte] = position;
        position += character.len_utf16() as u32;
        offsets[byte + character.len_utf8()] = position;
    }
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | if math_enabled {
            Options::ENABLE_MATH
        } else {
            Options::empty()
        }
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS;
    let mut events = Parser::new_ext(source, options)
        .into_offset_iter()
        .take_while(|_| check().is_ok())
        .peekable();
    let mut blocks = Vec::new();
    let mut cursor = 0;
    while let Some((event, range)) = events.next() {
        check()?;
        if range.start > cursor {
            blocks.push(raw_block(source, cursor..range.start, &offsets));
        }
        let end = range.end;
        let content = node(
            event,
            range.clone(),
            &mut events,
            source,
            &offsets,
            0,
            math_enabled,
        );
        blocks.push(Block {
            start: offsets[range.start],
            end: offsets[end],
            content,
        });
        cursor = end;
    }
    if cursor < source.len() || blocks.is_empty() {
        blocks.push(raw_block(source, cursor..source.len(), &offsets));
    }
    check()?;
    Ok(Document { blocks })
}

fn raw_block(source: &str, range: Range<usize>, offsets: &[u32]) -> Block {
    Block {
        start: offsets[range.start],
        end: offsets[range.end],
        content: Node::Raw {
            value: source[range].into(),
        },
    }
}

fn node<'a>(
    event: Event<'a>,
    range: Range<usize>,
    events: &mut impl Iterator<Item = (Event<'a>, Range<usize>)>,
    source: &str,
    offsets: &[u32],
    depth: usize,
    math_enabled: bool,
) -> Node {
    match event {
        Event::Start(tag) => {
            // Each element adds two JSON levels. Leave room for block and response
            // envelopes under the transport decoder's recursion limit as well as
            // bounding the Rust stack. Keep the full subtree as editable source.
            if depth >= 48 {
                let mut nesting = 1;
                for (event, _) in events.by_ref() {
                    match event {
                        Event::Start(_) => nesting += 1,
                        Event::End(_) => nesting -= 1,
                        _ => {}
                    }
                    if nesting == 0 {
                        break;
                    }
                }
                return Node::Raw {
                    value: source[range].into(),
                };
            }
            let mut children = Vec::new();
            while let Some((event, range)) = events.next() {
                if matches!(event, Event::End(_)) {
                    break;
                }
                children.push(node(
                    event,
                    range,
                    events,
                    source,
                    offsets,
                    depth + 1,
                    math_enabled,
                ));
            }
            let element = |tag, children| Node::Element { tag, children };
            match tag {
                Tag::Paragraph => element(Element::P, children),
                Tag::Heading { level, .. } => element(
                    match level {
                        HeadingLevel::H1 => Element::H1,
                        HeadingLevel::H2 => Element::H2,
                        HeadingLevel::H3 => Element::H3,
                        HeadingLevel::H4 => Element::H4,
                        HeadingLevel::H5 => Element::H5,
                        HeadingLevel::H6 => Element::H6,
                    },
                    children,
                ),
                Tag::BlockQuote(_) => element(Element::Blockquote, children),
                Tag::List(Some(first)) => Node::OrderedList { first, children },
                Tag::List(None) => element(Element::Ul, children),
                Tag::Item => element(Element::Li, children),
                Tag::CodeBlock(pulldown_cmark::CodeBlockKind::Fenced(info))
                    if math_enabled && info.split_whitespace().next() == Some("math") =>
                {
                    let value = children
                        .into_iter()
                        .filter_map(|child| match child {
                            Node::Text { value } => Some(value),
                            _ => None,
                        })
                        .collect();
                    Node::Math {
                        value,
                        display: true,
                        html: None,
                    }
                }
                Tag::CodeBlock(_) => element(Element::Pre, children),
                Tag::Table(_) => element(Element::Table, children),
                Tag::TableHead => element(Element::Thead, children),
                Tag::TableRow => element(Element::Tr, children),
                Tag::TableCell => element(Element::Td, children),
                Tag::Emphasis => element(Element::Em, children),
                Tag::Strong => element(Element::Strong, children),
                Tag::Strikethrough => element(Element::Del, children),
                Tag::Link { dest_url, .. } => Node::Link {
                    destination: dest_url.into_string(),
                    children,
                },
                Tag::Image { dest_url, .. } => Node::Image {
                    destination: dest_url.into_string(),
                    children,
                },
                // Unsupported extensions remain visible, editable source.
                Tag::HtmlBlock
                | Tag::FootnoteDefinition(_)
                | Tag::DefinitionList
                | Tag::DefinitionListTitle
                | Tag::DefinitionListDefinition
                | Tag::Superscript
                | Tag::Subscript
                | Tag::MetadataBlock(_) => Node::Raw {
                    value: source[range].into(),
                },
            }
        }
        Event::Text(value) => Node::Text {
            value: value.into_string(),
        },
        Event::Code(value) => Node::Code {
            value: value.into_string(),
        },
        Event::InlineMath(value) => Node::Math {
            value: value.into_string(),
            display: false,
            html: None,
        },
        Event::DisplayMath(value) => Node::Math {
            value: value.into_string(),
            display: true,
            html: None,
        },
        Event::TaskListMarker(checked) => Node::Task {
            checked,
            offset: offsets[range.start],
        },
        Event::SoftBreak | Event::HardBreak => Node::Break,
        Event::Rule => Node::Rule,
        Event::Html(_) | Event::InlineHtml(_) | Event::FootnoteReference(_) | Event::End(_) => {
            Node::Raw {
                value: source[range].into(),
            }
        }
    }
}

#[cfg(test)]
#[path = "parser_tests.rs"]
mod tests;
