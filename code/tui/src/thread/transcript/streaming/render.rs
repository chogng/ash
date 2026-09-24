//! Reuses unchanged Markdown blocks from complete transcript values.
//!
//! The transcript remains the text owner. Replacement, shrink, removal, width and theme changes
//! invalidate display state; late link definitions are resolved by the document parser.

use crate::render::RenderContext;
use crate::render::markdown;
use crate::terminal::hyperlinks::HyperlinkLine;
use ratatui::text::Line;
use std::collections::HashSet;
use std::collections::VecDeque;

const MAX_MESSAGES: usize = 64;
const MAX_SOURCE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Default)]
pub(in crate::thread::transcript) struct StreamingRender {
    entries: VecDeque<Message>,
}

#[derive(Debug)]
struct Message {
    id: String,
    width: usize,
    theme_revision: u64,
    blocks: Vec<Block>,
}

#[derive(Debug)]
struct Block {
    source: String,
    lines: Vec<HyperlinkLine>,
}

impl StreamingRender {
    pub(in crate::thread::transcript) fn retain(&mut self, ids: &HashSet<&String>) {
        self.entries.retain(|entry| ids.contains(&entry.id));
    }

    pub(in crate::thread::transcript) fn render(
        &mut self,
        id: &str,
        source: &str,
        width: usize,
        context: RenderContext<'_>,
        highlight: &mut impl FnMut(usize, &str, &str) -> Vec<Line<'static>>,
    ) -> Vec<HyperlinkLine> {
        let old = self
            .entries
            .iter()
            .position(|entry| entry.id == id)
            .and_then(|index| self.entries.remove(index));
        let old = old.filter(|entry| {
            entry.width == width && entry.theme_revision == context.theme_revision()
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
            self.entries.push_back(Message {
                id: id.to_owned(),
                width,
                theme_revision: context.theme_revision(),
                blocks,
            });
        }
        while self.entries.len() > MAX_MESSAGES
            || self
                .entries
                .iter()
                .flat_map(|entry| &entry.blocks)
                .map(|block| block.source.len())
                .sum::<usize>()
                > MAX_SOURCE_BYTES
        {
            self.entries.pop_front();
        }
        lines
    }
}

#[cfg(test)]
#[path = "render_tests.rs"]
mod tests;
