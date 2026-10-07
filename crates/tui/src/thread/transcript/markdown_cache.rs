//! Reuses unchanged Markdown blocks from complete transcript values.
//!
//! The transcript remains the text owner. Replacement, shrink, removal, width and theme changes
//! invalidate display state; late link definitions are resolved by the document parser.

use crate::render::RenderContext;
use crate::render::StreamingCodeHighlighter;
use crate::render::code_within_limits;
use crate::render::highlight_code;
use crate::render::links::HyperlinkLine;
use crate::render::markdown;
use ratatui::text::Line;
use std::cell::RefCell;
use std::collections::HashSet;
use std::collections::VecDeque;

const MAX_CODE_BLOCKS: usize = 64;
const MAX_CODE_SOURCE_BYTES: usize = 2 * 1024 * 1024;

const MAX_MESSAGES: usize = 64;
const MAX_SOURCE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Default)]
pub(in crate::thread::transcript) struct MarkdownCache {
    entries: RefCell<VecDeque<Message>>,
    code_blocks: RefCell<CodeBlockEntries>,
}

#[derive(Debug)]
struct Message {
    id: String,
    width: usize,
    theme_revision: u64,
    language: crate::nls::Language,
    preview_revision: u64,
    blocks: Vec<Block>,
}

#[derive(Debug)]
struct Block {
    source: String,
    lines: Vec<HyperlinkLine>,
}

impl MarkdownCache {
    pub(in crate::thread::transcript) fn retain(&self, ids: &HashSet<&String>) {
        self.entries
            .borrow_mut()
            .retain(|entry| ids.contains(&entry.id));
        self.code_blocks.borrow_mut().retain(ids);
    }

    pub(in crate::thread::transcript) fn render(
        &self,
        id: &str,
        source: &str,
        width: usize,
        context: RenderContext<'_>,
        highlight: &mut impl FnMut(usize, &str, &str) -> Vec<Line<'static>>,
    ) -> Vec<HyperlinkLine> {
        let mut entries = self.entries.borrow_mut();
        let old = entries
            .iter()
            .position(|entry| entry.id == id)
            .and_then(|index| entries.remove(index));
        let old = old.filter(|entry| {
            entry.width == width
                && entry.theme_revision == context.theme_revision()
                && entry.language == context.language()
                && entry.preview_revision == context.preview_revision()
        });
        let parsed = markdown::blocks(source);
        let mut blocks = Vec::with_capacity(parsed.len());
        for (index, block) in parsed.iter().enumerate() {
            let text = &source[block.source.clone()];
            let lines = old
                .as_ref()
                .and_then(|entry| entry.blocks.get(index))
                .filter(|previous| previous.source == text)
                .map(|previous| previous.lines.clone())
                .unwrap_or_else(|| markdown::render(block, width, context, highlight));
            blocks.push(Block {
                source: text.to_owned(),
                lines,
            });
        }
        let mut lines = Vec::new();
        for block in &blocks {
            if !lines.is_empty() {
                lines.push(HyperlinkLine::default());
            }
            lines.extend(block.lines.clone());
        }
        if source.len() <= MAX_SOURCE_BYTES {
            entries.push_back(Message {
                id: id.to_owned(),
                width,
                theme_revision: context.theme_revision(),
                language: context.language(),
                preview_revision: context.preview_revision(),
                blocks,
            });
        }
        while entries.len() > MAX_MESSAGES
            || entries
                .iter()
                .flat_map(|entry| &entry.blocks)
                .map(|block| block.source.len())
                .sum::<usize>()
                > MAX_SOURCE_BYTES
        {
            entries.pop_front();
        }
        lines
    }
}

#[derive(Debug, Default)]
struct CodeBlockEntries {
    entries: VecDeque<CodeBlockEntry>,
    source_bytes: usize,
}

#[derive(Debug)]
struct CodeBlockEntry {
    key: (String, usize),
    render: CodeBlockRender,
}

#[derive(Debug)]
struct CodeBlockRender {
    language: String,
    theme_revision: u64,
    complete_source: String,
    complete_lines: Vec<Line<'static>>,
    highlighter: Option<StreamingCodeHighlighter>,
}

impl CodeBlockEntries {
    fn retain(&mut self, cell_ids: &HashSet<&String>) {
        self.entries.retain(|entry| cell_ids.contains(&entry.key.0));
        self.source_bytes = self
            .entries
            .iter()
            .map(|entry| entry.render.complete_source.len())
            .sum();
    }

    fn take(&mut self, key: &(String, usize)) -> Option<CodeBlockRender> {
        let index = self.entries.iter().position(|entry| &entry.key == key)?;
        let entry = self
            .entries
            .remove(index)
            .expect("the matching code block entry exists");
        self.source_bytes = self
            .source_bytes
            .saturating_sub(entry.render.complete_source.len());
        Some(entry.render)
    }

    fn remove(&mut self, key: &(String, usize)) {
        let _ = self.take(key);
    }

    fn insert(&mut self, key: (String, usize), render: CodeBlockRender) {
        self.source_bytes = self
            .source_bytes
            .saturating_add(render.complete_source.len());
        self.entries.push_back(CodeBlockEntry { key, render });
        while self.entries.len() > MAX_CODE_BLOCKS || self.source_bytes > MAX_CODE_SOURCE_BYTES {
            let Some(entry) = self.entries.pop_front() else {
                break;
            };
            self.source_bytes = self
                .source_bytes
                .saturating_sub(entry.render.complete_source.len());
        }
    }
}

impl CodeBlockRender {
    fn new(language: &str, source: &str, context: RenderContext<'_>) -> Self {
        let (complete, _) = complete_source(source);
        let (highlighter, complete_lines) = StreamingCodeHighlighter::start(
            complete,
            language,
            context.into(),
            context.theme_revision(),
        )
        .expect("a complete code prefix is accepted by the streaming highlighter");
        Self {
            language: language.to_owned(),
            theme_revision: context.theme_revision(),
            complete_source: complete.to_owned(),
            complete_lines,
            highlighter: Some(highlighter),
        }
    }

    fn update(
        &mut self,
        language: &str,
        source: &str,
        context: RenderContext<'_>,
    ) -> Vec<Line<'static>> {
        let (complete, partial) = complete_source(source);
        let reusable = self.language == language
            && self.theme_revision == context.theme_revision()
            && complete.starts_with(&self.complete_source);
        if reusable && complete.len() > self.complete_source.len() {
            let appended = &complete[self.complete_source.len()..];
            let highlighter = self
                .highlighter
                .take()
                .expect("code block render state owns its highlighter");
            if let Some((highlighter, lines)) =
                highlighter.append(appended, context.into(), context.theme_revision())
            {
                self.highlighter = Some(highlighter);
                self.complete_source.push_str(appended);
                self.complete_lines.extend(lines);
            } else {
                let replacement = StreamingCodeHighlighter::start(
                    complete,
                    language,
                    context.into(),
                    context.theme_revision(),
                )
                .expect("a complete code prefix is accepted by the streaming highlighter");
                self.replace(language, complete, context, replacement);
            }
        } else if !reusable || complete.len() < self.complete_source.len() {
            let replacement = StreamingCodeHighlighter::start(
                complete,
                language,
                context.into(),
                context.theme_revision(),
            )
            .expect("a complete code prefix is accepted by the streaming highlighter");
            self.replace(language, complete, context, replacement);
        }

        if !partial.is_empty() {
            return highlight_code(source, language, context.into());
        }
        let mut lines = self.complete_lines.clone();
        if lines.is_empty() {
            lines.push(Line::default());
        }
        lines
    }

    fn replace(
        &mut self,
        language: &str,
        complete: &str,
        context: RenderContext<'_>,
        replacement: (StreamingCodeHighlighter, Vec<Line<'static>>),
    ) {
        self.language = language.to_owned();
        self.theme_revision = context.theme_revision();
        self.complete_source = complete.to_owned();
        self.highlighter = Some(replacement.0);
        self.complete_lines = replacement.1;
    }
}

fn complete_source(source: &str) -> (&str, &str) {
    let complete_len = source.rfind('\n').map_or(0, |index| index + 1);
    source.split_at(complete_len)
}

impl MarkdownCache {
    pub(super) fn clear(&self) {
        self.entries.borrow_mut().clear();
        *self.code_blocks.borrow_mut() = CodeBlockEntries::default();
    }
    pub(crate) fn highlight_code_block(
        &self,
        cell_id: Option<&str>,
        block_index: usize,
        language: &str,
        source: &str,
        context: RenderContext<'_>,
    ) -> Vec<Line<'static>> {
        let Some(cell_id) = cell_id else {
            return highlight_code(source, language, context.into());
        };
        let key = (cell_id.to_owned(), block_index);
        let mut blocks = self.code_blocks.borrow_mut();
        if !code_within_limits(source) {
            blocks.remove(&key);
            return highlight_code(source, language, context.into());
        }
        let mut block = blocks
            .take(&key)
            .unwrap_or_else(|| CodeBlockRender::new(language, source, context));
        let lines = block.update(language, source, context);
        blocks.insert(key, block);
        lines
    }
}

#[cfg(test)]
#[path = "markdown_cache_tests.rs"]
mod tests;
