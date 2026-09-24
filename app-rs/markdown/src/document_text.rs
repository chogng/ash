use crate::document::{MarkdownBlock, MarkdownBlockKind, MarkdownDocument};
use crate::{MarkdownSearchCase, MarkdownSearchMatch, MarkdownSelection, MarkdownTextPosition};

impl MarkdownDocument {
    /// Returns projected text for a selection, with blank lines between blocks.
    pub fn text_for_selection(&self, selection: MarkdownSelection) -> String {
        let range = selection.normalized();
        if range.start == range.end || range.start.block() >= self.blocks.len() {
            return String::new();
        }
        let end_block = range.end.block().min(self.blocks.len().saturating_sub(1));
        (range.start.block()..=end_block)
            .filter_map(|index| {
                let text = self.blocks[index].plain_text();
                let start = if index == range.start.block() {
                    range.start.offset().min(text.len())
                } else {
                    0
                };
                let end = if index == range.end.block() {
                    range.end.offset().min(text.len())
                } else {
                    text.len()
                };
                text.get(start..end).map(str::to_owned)
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// Finds non-overlapping literal matches in projected, copyable text.
    pub fn search(&self, query: &str, case: MarkdownSearchCase) -> Vec<MarkdownSearchMatch> {
        if query.is_empty() {
            return Vec::new();
        }
        self.blocks
            .iter()
            .enumerate()
            .flat_map(|(block, item)| {
                let text = item.plain_text();
                search_ranges(&text, query, case)
                    .into_iter()
                    .map(move |range| {
                        MarkdownSearchMatch::new(
                            MarkdownTextPosition::new(block, range.start),
                            MarkdownTextPosition::new(block, range.end),
                        )
                    })
            })
            .collect()
    }
}

impl MarkdownBlock {
    pub(crate) fn plain_text(&self) -> String {
        match &self.kind {
            MarkdownBlockKind::Paragraph(runs) | MarkdownBlockKind::Heading { runs, .. } => {
                runs.iter().map(|run| run.text.as_str()).collect()
            }
            MarkdownBlockKind::CodeBlock { text, .. } | MarkdownBlockKind::Math { text, .. } => {
                text.clone()
            }
            MarkdownBlockKind::Image(image) => image.alt().to_owned(),
            MarkdownBlockKind::Table(table) => table
                .rows
                .iter()
                .map(|row| {
                    row.cells
                        .iter()
                        .map(|cell| cell.iter().map(|run| run.text.as_str()).collect::<String>())
                        .collect::<Vec<_>>()
                        .join("\t")
                })
                .collect::<Vec<_>>()
                .join("\n"),
            MarkdownBlockKind::Rule => String::new(),
        }
    }
}

fn search_ranges(text: &str, query: &str, case: MarkdownSearchCase) -> Vec<std::ops::Range<usize>> {
    match case {
        MarkdownSearchCase::Sensitive => text
            .match_indices(query)
            .map(|(start, value)| start..start + value.len())
            .collect(),
        MarkdownSearchCase::Insensitive => {
            let (folded_text, text_boundaries) = fold_with_boundaries(text);
            let (folded_query, _) = fold_with_boundaries(query);
            folded_text
                .match_indices(&folded_query)
                .filter_map(|(start, value)| {
                    let end = start + value.len();
                    Some(boundary_at(&text_boundaries, start)?..boundary_at(&text_boundaries, end)?)
                })
                .collect()
        }
    }
}

fn fold_with_boundaries(value: &str) -> (String, Vec<(usize, usize)>) {
    let mut folded = String::new();
    let mut boundaries = vec![(0, 0)];
    for (start, character) in value.char_indices() {
        let end = start + character.len_utf8();
        for lowered in character.to_lowercase() {
            folded.push(lowered);
            boundaries.push((folded.len(), end));
        }
    }
    (folded, boundaries)
}

fn boundary_at(boundaries: &[(usize, usize)], offset: usize) -> Option<usize> {
    boundaries
        .binary_search_by_key(&offset, |(folded, _)| *folded)
        .ok()
        .map(|index| boundaries[index].1)
}
