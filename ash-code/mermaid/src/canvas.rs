use crate::RenderError;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum Stroke {
    #[default]
    Solid,
    Dashed,
}

#[derive(Clone, Default)]
struct Cell {
    text: Option<String>,
    strokes: u8,
    stroke: Stroke,
}

pub(crate) struct Canvas {
    width: usize,
    cells: Vec<Vec<Cell>>,
}

impl Canvas {
    pub(crate) fn new(width: usize, height: usize) -> Result<Self, RenderError> {
        if width.saturating_mul(height) > 128 * 1024 {
            return Err(RenderError::Limit);
        }
        Ok(Self {
            width,
            cells: vec![vec![Cell::default(); width]; height],
        })
    }

    pub(crate) fn text(&mut self, x: usize, y: usize, text: &str) -> Result<(), RenderError> {
        let mut x = x;
        for grapheme in text.graphemes(true) {
            let width = grapheme.width();
            if width == 0 || y >= self.cells.len() || x + width > self.width {
                return Err(RenderError::Width);
            }
            for offset in 0..width {
                let cell = &mut self.cells[y][x + offset];
                if cell.text.is_some() || cell.strokes != 0 {
                    return Err(RenderError::Unsupported);
                }
                cell.text = Some(if offset == 0 {
                    grapheme.to_owned()
                } else {
                    String::new()
                });
            }
            x += width;
        }
        Ok(())
    }

    pub(crate) fn box_at(
        &mut self,
        x: usize,
        y: usize,
        width: usize,
        label: &str,
    ) -> Result<(), RenderError> {
        self.text(x, y, &format!("┌{}┐", "─".repeat(width - 2)))?;
        self.text(
            x,
            y + 1,
            &format!("│ {}{} │", label, " ".repeat(width - label.width() - 4)),
        )?;
        self.text(x, y + 2, &format!("└{}┘", "─".repeat(width - 2)))
    }

    pub(crate) fn path(
        &mut self,
        points: &[(usize, usize)],
        stroke: Stroke,
    ) -> Result<(), RenderError> {
        for pair in points.windows(2) {
            let ((x1, y1), (x2, y2)) = (pair[0], pair[1]);
            if x1 == x2 {
                for y in y1.min(y2)..=y1.max(y2) {
                    let bits = u8::from(y > y1.min(y2)) | (u8::from(y < y1.max(y2)) << 1);
                    self.stroke(x1, y, bits, stroke)?;
                }
            } else if y1 == y2 {
                for x in x1.min(x2)..=x1.max(x2) {
                    let bits = (u8::from(x > x1.min(x2)) << 2) | (u8::from(x < x1.max(x2)) << 3);
                    self.stroke(x, y1, bits, stroke)?;
                }
            } else {
                return Err(RenderError::Unsupported);
            }
        }
        Ok(())
    }

    fn stroke(&mut self, x: usize, y: usize, bits: u8, stroke: Stroke) -> Result<(), RenderError> {
        let cell = self
            .cells
            .get_mut(y)
            .and_then(|row| row.get_mut(x))
            .ok_or(RenderError::Width)?;
        if cell
            .text
            .as_deref()
            .is_some_and(|text| !matches!(text, "▶" | "◀" | "▼" | "▲"))
        {
            return Err(RenderError::Unsupported);
        }
        if cell.strokes == 0 || stroke == Stroke::Solid {
            cell.stroke = stroke;
        }
        cell.strokes |= bits;
        Ok(())
    }

    pub(crate) fn arrow(&mut self, x: usize, y: usize, symbol: &str) -> Result<(), RenderError> {
        let cell = &mut self.cells[y][x];
        if cell.text.as_deref().is_some_and(|text| text != symbol) {
            return Err(RenderError::Unsupported);
        }
        cell.text = Some(symbol.into());
        Ok(())
    }

    pub(crate) fn rows(self) -> Vec<String> {
        self.cells
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .map(|cell| {
                        cell.text.unwrap_or_else(|| {
                            match cell.strokes {
                                1..=3 if cell.stroke == Stroke::Dashed => "┆",
                                4 | 8 | 12 if cell.stroke == Stroke::Dashed => "┄",
                                1..=3 => "│",
                                4 | 8 | 12 => "─",
                                5 => "┘",
                                6 => "┐",
                                9 => "└",
                                10 => "┌",
                                7 => "┤",
                                11 => "├",
                                13 => "┴",
                                14 => "┬",
                                15 => "┼",
                                _ => " ",
                            }
                            .into()
                        })
                    })
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect()
    }
}
