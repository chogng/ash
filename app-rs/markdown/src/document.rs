use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use thiserror::Error;

use crate::image::MarkdownImageSource;
use crate::table::{MarkdownTable, TableBuilder};

const MAX_MARKDOWN_BYTES: usize = 4 * 1024 * 1024;
const MAX_BLOCKS: usize = 100_000;
const MAX_NESTING_DEPTH: usize = 64;

/// Parsed, presentation-independent Markdown snapshot.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MarkdownDocument {
    pub(crate) blocks: Vec<MarkdownBlock>,
    images: Vec<MarkdownImageSource>,
}

impl MarkdownDocument {
    /// Parses bounded CommonMark plus tables, strikethrough, task lists, and GFM block quotes.
    ///
    /// Raw HTML is retained as visible text. It is never interpreted or passed to a web runtime.
    pub fn parse(markdown: &str) -> Result<Self, MarkdownError> {
        if markdown.len() > MAX_MARKDOWN_BYTES {
            return Err(MarkdownError::InputTooLarge {
                actual: markdown.len(),
                limit: MAX_MARKDOWN_BYTES,
            });
        }
        DocumentBuilder::parse(markdown)
    }

    pub fn is_empty(&self) -> bool {
        self.blocks.is_empty()
    }

    pub fn block_count(&self) -> usize {
        self.blocks.len()
    }

    /// Returns parsed image references in document order; this does not load them.
    pub fn images(&self) -> impl Iterator<Item = &MarkdownImageSource> {
        self.images.iter()
    }
}

/// Bounded Markdown parsing failure.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum MarkdownError {
    #[error("Markdown input exceeds the {limit}-byte limit with {actual} bytes")]
    InputTooLarge { actual: usize, limit: usize },
    #[error("Markdown nesting exceeds the supported depth of {limit}")]
    NestingTooDeep { limit: usize },
    #[error("Markdown contains more than the supported {limit} blocks")]
    TooManyBlocks { limit: usize },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MarkdownBlock {
    pub(crate) kind: MarkdownBlockKind,
    pub(crate) context: BlockContext,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum MarkdownBlockKind {
    Paragraph(Vec<InlineRun>),
    Heading {
        level: u8,
        runs: Vec<InlineRun>,
    },
    CodeBlock {
        language: Option<String>,
        text: String,
    },
    Image(MarkdownImageSource),
    Math {
        text: String,
        display: bool,
    },
    Table(MarkdownTable),
    Rule,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct BlockContext {
    pub(crate) quote_depth: usize,
    pub(crate) list_depth: usize,
    pub(crate) marker: Option<String>,
    pub(crate) footnote: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct InlineRun {
    pub(crate) text: String,
    pub(crate) format: InlineFormat,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct InlineFormat {
    pub(crate) emphasis: bool,
    pub(crate) strong: bool,
    pub(crate) code: bool,
    pub(crate) strikethrough: bool,
    pub(crate) link: Option<String>,
    pub(crate) image: Option<MarkdownImageSource>,
    pub(crate) math: bool,
}

#[derive(Clone, Debug)]
enum CurrentBlockKind {
    Paragraph,
    Heading(u8),
    Html,
    TableCell,
}

#[derive(Clone, Debug)]
struct CurrentBlock {
    kind: CurrentBlockKind,
    runs: Vec<InlineRun>,
    context: BlockContext,
}

#[derive(Clone, Debug)]
struct CodeBlockBuilder {
    language: Option<String>,
    text: String,
    context: BlockContext,
}

#[derive(Clone, Debug)]
struct ListState {
    next: Option<u64>,
}

#[derive(Clone, Debug)]
struct ImageBuilder {
    destination: String,
    title: String,
    alt: String,
}

#[derive(Default)]
struct DocumentBuilder {
    blocks: Vec<MarkdownBlock>,
    current: Option<CurrentBlock>,
    code: Option<CodeBlockBuilder>,
    format: InlineFormat,
    links: Vec<String>,
    quote_depth: usize,
    lists: Vec<ListState>,
    pending_marker: Option<String>,
    table: Option<TableBuilder>,
    image: Option<ImageBuilder>,
    images: Vec<MarkdownImageSource>,
    footnote: Option<String>,
}

impl DocumentBuilder {
    fn parse(markdown: &str) -> Result<MarkdownDocument, MarkdownError> {
        let options = Options::ENABLE_TABLES
            | Options::ENABLE_STRIKETHROUGH
            | Options::ENABLE_TASKLISTS
            | Options::ENABLE_GFM
            | Options::ENABLE_FOOTNOTES
            | Options::ENABLE_MATH;
        let mut builder = Self::default();
        for event in Parser::new_ext(markdown, options) {
            builder.consume(event)?;
        }
        builder.finish_current()?;
        Ok(MarkdownDocument {
            blocks: builder.blocks,
            images: builder.images,
        })
    }

    fn consume(&mut self, event: Event<'_>) -> Result<(), MarkdownError> {
        match event {
            Event::Start(tag) => self.start(tag)?,
            Event::End(tag) => self.end(tag)?,
            Event::Text(text) => self.push_text(&text),
            Event::Code(text) => self.push_code(&text),
            Event::InlineMath(text) => self.push_math(&text),
            Event::DisplayMath(text) => {
                self.finish_current()?;
                let context = self.context();
                self.push_block(
                    MarkdownBlockKind::Math {
                        text: text.into_string(),
                        display: true,
                    },
                    context,
                )?;
            }
            Event::Html(html) | Event::InlineHtml(html) => self.push_text(&html),
            Event::FootnoteReference(label) => {
                let previous = self.format.link.replace(format!("#fn-{label}"));
                self.push_text(&format!("[{label}]"));
                self.format.link = previous;
            }
            Event::SoftBreak => self.push_text(" "),
            Event::HardBreak => self.push_text("\n"),
            Event::Rule => {
                let context = self.take_empty_current_context();
                self.push_block(MarkdownBlockKind::Rule, context)?;
            }
            Event::TaskListMarker(checked) => {
                self.pending_marker = Some(if checked { "☑" } else { "☐" }.into());
                if let Some(current) = self.current.as_mut() {
                    current.context.marker = self.pending_marker.take();
                }
            }
        }
        Ok(())
    }

    fn start(&mut self, tag: Tag<'_>) -> Result<(), MarkdownError> {
        match tag {
            Tag::Paragraph => {
                if !matches!(
                    self.current,
                    Some(CurrentBlock {
                        kind: CurrentBlockKind::Paragraph,
                        ref runs,
                        ..
                    }) if runs.is_empty()
                ) {
                    self.begin(CurrentBlockKind::Paragraph);
                }
            }
            Tag::Heading { level, .. } => {
                self.begin(CurrentBlockKind::Heading(heading_level(level)))
            }
            Tag::BlockQuote(_) => {
                self.quote_depth += 1;
                self.validate_depth()?;
            }
            Tag::CodeBlock(kind) => {
                let context = match self.current.take() {
                    Some(current) if current.runs.is_empty() => current.context,
                    Some(current) => {
                        self.current = Some(current);
                        self.finish_current()?;
                        self.context()
                    }
                    None => self.context(),
                };
                self.code = Some(CodeBlockBuilder {
                    language: match kind {
                        CodeBlockKind::Indented => None,
                        CodeBlockKind::Fenced(language) => {
                            let language = language.trim();
                            (!language.is_empty()).then(|| language.to_owned())
                        }
                    },
                    text: String::new(),
                    context,
                });
            }
            Tag::HtmlBlock => self.begin(CurrentBlockKind::Html),
            Tag::List(start) => {
                self.finish_current()?;
                self.lists.push(ListState { next: start });
                self.validate_depth()?;
            }
            Tag::Item => {
                self.pending_marker = Some(match self.lists.last_mut() {
                    Some(ListState { next: Some(next) }) => {
                        let marker = format!("{next}.");
                        *next = next.saturating_add(1);
                        marker
                    }
                    _ => "•".into(),
                });
                self.begin(CurrentBlockKind::Paragraph);
            }
            Tag::Table(_) => {
                self.table = Some(TableBuilder::new(self.context()));
            }
            Tag::TableHead => {
                if let Some(table) = self.table.as_mut() {
                    table.begin_header();
                }
            }
            Tag::TableRow => {
                if let Some(table) = self.table.as_mut() {
                    table.begin_row();
                }
            }
            Tag::TableCell => self.begin(CurrentBlockKind::TableCell),
            Tag::Emphasis => self.format.emphasis = true,
            Tag::Strong => self.format.strong = true,
            Tag::Strikethrough => self.format.strikethrough = true,
            Tag::Link { dest_url, .. } => {
                self.links.push(dest_url.into_string());
                self.format.link = self.links.last().cloned();
            }
            Tag::Image {
                dest_url, title, ..
            } => {
                self.image = Some(ImageBuilder {
                    destination: dest_url.into_string(),
                    title: title.into_string(),
                    alt: String::new(),
                });
            }
            Tag::FootnoteDefinition(label) => {
                self.finish_current()?;
                self.footnote = Some(label.into_string());
            }
            Tag::DefinitionList
            | Tag::DefinitionListTitle
            | Tag::DefinitionListDefinition
            | Tag::Superscript
            | Tag::Subscript
            | Tag::MetadataBlock(_) => {}
        }
        Ok(())
    }

    fn end(&mut self, tag: TagEnd) -> Result<(), MarkdownError> {
        match tag {
            TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::HtmlBlock => self.finish_current()?,
            TagEnd::BlockQuote(_) => self.quote_depth = self.quote_depth.saturating_sub(1),
            TagEnd::CodeBlock => {
                if let Some(code) = self.code.take() {
                    self.push_block(
                        MarkdownBlockKind::CodeBlock {
                            language: code.language,
                            text: code.text.trim_end_matches('\n').to_owned(),
                        },
                        code.context,
                    )?;
                }
            }
            TagEnd::List(_) => {
                self.lists.pop();
            }
            TagEnd::Item => {
                self.finish_current()?;
                self.pending_marker = None;
            }
            TagEnd::Table => {
                if let Some(table) = self.table.take()
                    && let Some((table, context)) = table.finish()
                {
                    self.push_block(MarkdownBlockKind::Table(table), context)?;
                }
            }
            TagEnd::TableHead => {
                if let Some(table) = self.table.as_mut() {
                    table.end_header();
                }
            }
            TagEnd::TableRow => {
                if let Some(table) = self.table.as_mut() {
                    table.finish_row();
                }
            }
            TagEnd::TableCell => {
                if let Some(cell) = self.current.take()
                    && let Some(table) = self.table.as_mut()
                {
                    table.push_cell(cell.runs);
                }
            }
            TagEnd::Emphasis => self.format.emphasis = false,
            TagEnd::Strong => self.format.strong = false,
            TagEnd::Strikethrough => self.format.strikethrough = false,
            TagEnd::Link => {
                self.links.pop();
                self.format.link = self.links.last().cloned();
            }
            TagEnd::Image => {
                if let Some(image) = self.image.take() {
                    let source = MarkdownImageSource::new(
                        image.destination.clone(),
                        image.title,
                        image.alt.clone(),
                    );
                    self.images.push(source.clone());
                    let standalone = self
                        .current
                        .as_ref()
                        .is_none_or(|current| current.runs.is_empty());
                    if standalone {
                        let context = self.take_empty_current_context();
                        self.push_block(MarkdownBlockKind::Image(source), context)?;
                    } else {
                        let previous_link = self.format.link.replace(image.destination);
                        let previous_image = self.format.image.replace(source);
                        self.push_text(if image.alt.is_empty() {
                            "[Image]"
                        } else {
                            &image.alt
                        });
                        self.format.image = previous_image;
                        self.format.link = previous_link;
                    }
                }
            }
            TagEnd::FootnoteDefinition => {
                self.finish_current()?;
                self.footnote = None;
            }
            TagEnd::DefinitionList
            | TagEnd::DefinitionListTitle
            | TagEnd::DefinitionListDefinition
            | TagEnd::Superscript
            | TagEnd::Subscript
            | TagEnd::MetadataBlock(_) => {}
        }
        Ok(())
    }

    fn begin(&mut self, kind: CurrentBlockKind) {
        let context = self.take_empty_current_context();
        self.current = Some(CurrentBlock {
            kind,
            runs: Vec::new(),
            context,
        });
        if let Some(marker) = self.pending_marker.take()
            && let Some(current) = self.current.as_mut()
        {
            current.context.marker = Some(marker);
        }
    }

    fn take_empty_current_context(&mut self) -> BlockContext {
        match self.current.take() {
            Some(current) if current.runs.is_empty() => current.context,
            Some(current) => {
                debug_assert!(
                    false,
                    "Markdown parser started a block before ending its sibling"
                );
                current.context
            }
            None => self.context(),
        }
    }

    fn finish_current(&mut self) -> Result<(), MarkdownError> {
        let Some(current) = self.current.take() else {
            return Ok(());
        };
        if current.runs.is_empty() {
            return Ok(());
        }
        let kind = match current.kind {
            CurrentBlockKind::Paragraph | CurrentBlockKind::Html => {
                MarkdownBlockKind::Paragraph(current.runs)
            }
            CurrentBlockKind::Heading(level) => MarkdownBlockKind::Heading {
                level,
                runs: current.runs,
            },
            CurrentBlockKind::TableCell => {
                if let Some(table) = self.table.as_mut() {
                    table.push_cell(current.runs);
                }
                return Ok(());
            }
        };
        self.push_block(kind, current.context)
    }

    fn push_text(&mut self, text: &str) {
        if let Some(image) = self.image.as_mut() {
            image.alt.push_str(text);
        } else if let Some(code) = self.code.as_mut() {
            code.text.push_str(text);
        } else if let Some(current) = self.current.as_mut() {
            push_run(&mut current.runs, text, self.format.clone());
        }
    }

    fn push_code(&mut self, text: &str) {
        let previous = self.format.code;
        self.format.code = true;
        self.push_text(text);
        self.format.code = previous;
    }

    fn push_math(&mut self, text: &str) {
        let previous = self.format.math;
        self.format.math = true;
        self.push_text(text);
        self.format.math = previous;
    }

    fn push_block(
        &mut self,
        kind: MarkdownBlockKind,
        context: BlockContext,
    ) -> Result<(), MarkdownError> {
        if self.blocks.len() >= MAX_BLOCKS {
            return Err(MarkdownError::TooManyBlocks { limit: MAX_BLOCKS });
        }
        self.blocks.push(MarkdownBlock { kind, context });
        Ok(())
    }

    fn context(&self) -> BlockContext {
        BlockContext {
            quote_depth: self.quote_depth,
            list_depth: self.lists.len(),
            marker: self.footnote.as_ref().map(|label| format!("[{label}]")),
            footnote: self.footnote.clone(),
        }
    }

    fn validate_depth(&self) -> Result<(), MarkdownError> {
        if self.quote_depth + self.lists.len() > MAX_NESTING_DEPTH {
            return Err(MarkdownError::NestingTooDeep {
                limit: MAX_NESTING_DEPTH,
            });
        }
        Ok(())
    }
}

fn push_run(runs: &mut Vec<InlineRun>, text: &str, format: InlineFormat) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = runs.last_mut()
        && last.format == format
    {
        last.text.push_str(text);
        return;
    }
    runs.push(InlineRun {
        text: text.to_owned(),
        format,
    });
}

const fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}
