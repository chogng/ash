//! Stateless Markdown parsing for the client-owned editor. Source ranges use UTF-16,
//! matching Ash's text model; parsing never serializes or normalizes the document.

use external_ext_sdk::Command;
use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use pulldown_cmark::Event;
use pulldown_cmark::HeadingLevel;
use pulldown_cmark::Options;
use pulldown_cmark::Parser;
use pulldown_cmark::Tag;
use serde::Deserialize;
use serde::Serialize;
use std::ops::Range;

#[derive(Default)]
/// Stateless parsing capability registered with the shared extension host.
pub struct MarkdownExtension;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ParseRequest {
    protocol_version: u32,
    uri: String,
    version: u64,
    text: String,
}

impl Extension for MarkdownExtension {
    fn id(&self) -> &str {
        "ash.markdown-parser"
    }

    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let messages = if context
            .initialization()
            .and_then(|facts| facts.language.as_deref())
            == Some("zh-CN")
        {
            include_str!("../package.nls.zh-CN.json")
        } else {
            include_str!("../package.nls.json")
        };
        let messages: serde_json::Value = serde_json::from_str(messages).map_err(|_| {
            ExtensionError::new(HostErrorCode::Internal, "Invalid extension localization")
        })?;
        let title = messages["parse"]
            .as_str()
            .ok_or_else(|| ExtensionError::new(HostErrorCode::Internal, "Missing command title"))?;
        context.commands.register_command(Command::new("_markdown.parse", title), |invocation, token| {
            token.check_cancelled()?;
            let [argument] = invocation.arguments.as_slice() else {
                return Err(ExtensionError::new(HostErrorCode::InvalidRequest, "Expected one document snapshot"));
            };
            let request: ParseRequest = serde_json::from_value(argument.clone()).map_err(|_| ExtensionError::new(HostErrorCode::InvalidRequest, "Invalid Markdown snapshot"))?;
            if request.protocol_version != 1 || request.version == 0 || request.version > 9_007_199_254_740_991 || request.uri.is_empty() || request.uri.len() > 32768 || request.uri.contains('\0') {
                return Err(ExtensionError::new(HostErrorCode::InvalidRequest, "Unsupported Markdown snapshot contract"));
            }
            let document = parse_checked(&request.text, || token.check_cancelled())?;
            token.check_cancelled()?;
            Ok(serde_json::json!({ "protocol_version": 1, "uri": request.uri, "version": request.version, "blocks": document.blocks }))
        })
    }
}

#[derive(Debug, Serialize)]
struct Document {
    blocks: Vec<Block>,
}

#[derive(Debug, Serialize)]
struct Block {
    start: u32,
    end: u32,
    content: Node,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
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
fn parse_checked(
    source: &str,
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
        | Options::ENABLE_MATH
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
        let content = node(event, range.clone(), &mut events, source, &offsets, 0);
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
) -> Node {
    match event {
        Event::Start(tag) => {
            // Malicious nesting must not exhaust the process stack. Consume the full
            // subtree and expose its exact source through the ordinary text input.
            if depth >= 64 {
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
                children.push(node(event, range, events, source, offsets, depth + 1));
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
        },
        Event::DisplayMath(value) => Node::Math {
            value: value.into_string(),
            display: true,
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
mod tests;
