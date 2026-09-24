use crate::render::RenderContext;
use crate::terminal::hyperlinks::HyperlinkLine;
use crate::terminal::hyperlinks::wrap;
use pulldown_cmark::Alignment;
use ratatui::style::Style;
use ratatui::text::Span;

pub(super) struct Table {
    alignments: Vec<Alignment>,
    rows: Vec<Vec<HyperlinkLine>>,
}

impl Table {
    pub(super) fn new(alignments: Vec<Alignment>) -> Self {
        Self {
            alignments,
            rows: Vec::new(),
        }
    }
    pub(super) fn start_row(&mut self) {
        self.rows.push(Vec::new());
    }
    pub(super) fn push(&mut self, cell: HyperlinkLine) {
        if let Some(row) = self.rows.last_mut() {
            row.push(cell);
        }
    }
    pub(super) fn render(self, width: usize, context: RenderContext<'_>) -> Vec<HyperlinkLine> {
        let columns = self.alignments.len();
        if columns == 0 || self.rows.is_empty() {
            return Vec::new();
        }
        let gap = 3 * columns.saturating_sub(1);
        let mut widths = (0..columns)
            .map(|column| {
                self.rows
                    .iter()
                    .filter_map(|row| row.get(column))
                    .map(|cell| cell.line.width())
                    .max()
                    .unwrap_or(1)
                    .max(1)
            })
            .collect::<Vec<_>>();
        if width < columns * 6 + gap {
            let mut lines = Vec::new();
            for row in self.rows.iter().skip(1) {
                if !lines.is_empty() {
                    lines.push(HyperlinkLine::default());
                }
                for (index, cell) in row.iter().enumerate() {
                    let mut line = self.rows[0].get(index).cloned().unwrap_or_default();
                    line.push(": ", Style::default().fg(context.muted()), None);
                    append(&mut line, cell.clone());
                    lines.extend(wrap(&line, width));
                }
            }
            if lines.is_empty() {
                for cell in &self.rows[0] {
                    lines.extend(wrap(cell, width));
                }
            }
            return lines;
        }
        while widths.iter().sum::<usize>() + gap > width {
            let Some((index, largest)) = widths.iter().enumerate().max_by_key(|(_, size)| **size)
            else {
                break;
            };
            if *largest <= 1 {
                break;
            }
            widths[index] -= 1;
        }
        let mut output = Vec::new();
        for (row_index, row) in self.rows.iter().enumerate() {
            let cells = (0..columns)
                .map(|column| {
                    wrap(
                        row.get(column).unwrap_or(&HyperlinkLine::default()),
                        widths[column],
                    )
                })
                .collect::<Vec<_>>();
            let height = cells.iter().map(Vec::len).max().unwrap_or(1);
            for y in 0..height {
                let mut line = HyperlinkLine::default();
                for column in 0..columns {
                    if column > 0 {
                        line.push(" │ ", Style::default().fg(context.muted()), None);
                    }
                    let mut cell = cells[column].get(y).cloned().unwrap_or_default();
                    let padding = widths[column].saturating_sub(cell.line.width());
                    let left = match self.alignments[column] {
                        Alignment::Right => padding,
                        Alignment::Center => padding / 2,
                        _ => 0,
                    };
                    cell.prefix(Span::raw(" ".repeat(left)));
                    append(&mut line, cell);
                    line.push(&" ".repeat(padding - left), Style::default(), None);
                }
                output.push(line);
            }
            if row_index == 0 {
                let mut line = HyperlinkLine::default();
                line.push(
                    &widths
                        .iter()
                        .map(|size| "─".repeat(*size))
                        .collect::<Vec<_>>()
                        .join("─┼─"),
                    Style::default().fg(context.muted()),
                    None,
                );
                output.push(line);
            }
        }
        output
    }
}

fn append(target: &mut HyperlinkLine, mut value: HyperlinkLine) {
    let shift = target.line.width();
    for link in &mut value.links {
        link.columns = link.columns.start + shift..link.columns.end + shift;
    }
    target.line.spans.extend(value.line.spans);
    target.links.extend(value.links);
}
