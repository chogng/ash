use zui::ui::{FontWeight, TextLayoutEngine, TextLayoutWidth};

use crate::inline_layout::{InlineLayout, layout_inline};
use crate::math::MarkdownMathImages;
use crate::table::MarkdownTable;
use crate::{MarkdownImages, MarkdownStyle};

pub(crate) const CELL_HORIZONTAL_PADDING: f32 = 10.0;
pub(crate) const CELL_VERTICAL_PADDING: f32 = 5.0;
const MINIMUM_COLUMN_WIDTH: f32 = 56.0;

pub(crate) struct TableLayout {
    pub(crate) width: f32,
    pub(crate) column_widths: Vec<f32>,
    pub(crate) rows: Vec<TableRowLayout>,
    pub(crate) height: f32,
}

pub(crate) struct TableRowLayout {
    pub(crate) header: bool,
    pub(crate) cells: Vec<InlineLayout>,
    pub(crate) height: f32,
}

pub(crate) fn layout_table(
    text: &mut TextLayoutEngine,
    table: &MarkdownTable,
    width: f32,
    style: &MarkdownStyle,
    images: &MarkdownImages,
    inline_math: &MarkdownMathImages,
) -> TableLayout {
    let column_count = table.column_count();
    if column_count == 0 {
        return TableLayout {
            width,
            column_widths: Vec::new(),
            rows: Vec::new(),
            height: 0.0,
        };
    }
    let mut preferred = vec![MINIMUM_COLUMN_WIDTH; column_count];
    for row in &table.rows {
        let base = table_text_style(row.header, style);
        for (index, cell) in row.cells.iter().enumerate() {
            let layout = layout_inline(
                text,
                cell,
                base.clone(),
                TextLayoutWidth::Unbounded,
                style,
                images,
                inline_math,
            );
            preferred[index] =
                preferred[index].max(layout.size.width + CELL_HORIZONTAL_PADDING * 2.0);
        }
    }
    let column_widths = fit_column_widths(&preferred, width);
    let mut rows = Vec::with_capacity(table.rows.len());
    let mut height = 0.0;
    for row in &table.rows {
        let base = table_text_style(row.header, style);
        let cells = row
            .cells
            .iter()
            .enumerate()
            .map(|(index, cell)| {
                layout_inline(
                    text,
                    cell,
                    base.clone(),
                    TextLayoutWidth::Wrap(
                        (column_widths[index] - CELL_HORIZONTAL_PADDING * 2.0).max(1.0),
                    ),
                    style,
                    images,
                    inline_math,
                )
            })
            .collect::<Vec<_>>();
        let row_height = cells
            .iter()
            .map(|cell| cell.size.height)
            .fold(base.line_height(), f32::max)
            + CELL_VERTICAL_PADDING * 2.0;
        height += row_height;
        rows.push(TableRowLayout {
            header: row.header,
            cells,
            height: row_height,
        });
    }
    TableLayout {
        width,
        column_widths,
        rows,
        height,
    }
}

fn table_text_style(header: bool, style: &MarkdownStyle) -> zui::ui::TextStyle {
    if header {
        style.body().clone().with_weight(FontWeight::Bold)
    } else {
        style.body().clone()
    }
}

fn fit_column_widths(preferred: &[f32], total_width: f32) -> Vec<f32> {
    let count = preferred.len();
    if count == 0 {
        return Vec::new();
    }
    let width = total_width.max(1.0);
    let minimum = MINIMUM_COLUMN_WIDTH.min(width / count as f32);
    let minimum_total = minimum * count as f32;
    let preferred_total = preferred.iter().sum::<f32>();
    let mut widths = if preferred_total <= width {
        let extra = (width - preferred_total) / count as f32;
        preferred.iter().map(|value| value + extra).collect()
    } else if minimum_total >= width {
        vec![width / count as f32; count]
    } else {
        let flexible = preferred
            .iter()
            .map(|value| (value - minimum).max(0.0))
            .sum::<f32>();
        let available = width - minimum_total;
        preferred
            .iter()
            .map(|value| {
                minimum
                    + if flexible > 0.0 {
                        available * (value - minimum).max(0.0) / flexible
                    } else {
                        available / count as f32
                    }
            })
            .collect::<Vec<_>>()
    };
    let correction = width - widths.iter().sum::<f32>();
    if let Some(last) = widths.last_mut() {
        *last += correction;
    }
    widths
}

#[cfg(test)]
#[path = "table_layout_tests.rs"]
mod tests;
