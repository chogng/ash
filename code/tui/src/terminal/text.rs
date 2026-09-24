use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use unicode_width::UnicodeWidthStr;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ScreenSelectionRange {
    pub(crate) start: Position,
    pub(crate) end: Position,
}

impl ScreenSelectionRange {
    pub(crate) fn new(anchor: Position, focus: Position) -> Self {
        let (start, end) = if position_index(anchor) <= position_index(focus) {
            (anchor, focus)
        } else {
            (focus, anchor)
        };
        Self { start, end }
    }

    pub(crate) fn contains(self, position: Position) -> bool {
        position_index(self.start) <= position_index(position)
            && position_index(position) <= position_index(self.end)
    }
}

pub(crate) fn token_range_at(buffer: &Buffer, position: Position) -> Option<ScreenSelectionRange> {
    let area = buffer.area;
    if !area.contains(position) {
        return None;
    }
    let units = row_units(buffer, position.y);
    let selected = units
        .iter()
        .position(|unit| unit.start <= position.x && position.x <= unit.end)?;
    let class = units[selected].class;
    let mut first = selected;
    while first > 0 && units[first - 1].class == class {
        first -= 1;
    }
    let mut last = selected;
    while last + 1 < units.len() && units[last + 1].class == class {
        last += 1;
    }
    let range = ScreenSelectionRange::new(
        Position::new(units[first].start, position.y),
        Position::new(units[last].end, position.y),
    );
    text_in_range(buffer, range).map(|_| range)
}

pub(crate) fn line_range_at(buffer: &Buffer, position: Position) -> Option<ScreenSelectionRange> {
    let area = buffer.area;
    if !area.contains(position) || area.is_empty() {
        return None;
    }
    let range = ScreenSelectionRange::new(
        Position::new(area.x, position.y),
        Position::new(area.right().saturating_sub(1), position.y),
    );
    text_in_range(buffer, range).map(|_| range)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CellClass {
    Whitespace,
    Word,
    Symbol,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RowUnit {
    start: u16,
    end: u16,
    class: CellClass,
}

fn row_units(buffer: &Buffer, row: u16) -> Vec<RowUnit> {
    let area = buffer.area;
    let mut units = Vec::with_capacity(usize::from(area.width));
    let mut column = area.x;
    while column < area.right() {
        let Some(cell) = buffer.cell(Position::new(column, row)) else {
            column = column.saturating_add(1);
            continue;
        };
        let symbol = cell.symbol();
        let width = u16::try_from(symbol.width().max(1)).unwrap_or(u16::MAX);
        let end = column
            .saturating_add(width.saturating_sub(1))
            .min(area.right().saturating_sub(1));
        units.push(RowUnit {
            start: column,
            end,
            class: cell_class(symbol),
        });
        column = end.saturating_add(1);
    }
    units
}

fn cell_class(symbol: &str) -> CellClass {
    if symbol.chars().all(char::is_whitespace) {
        CellClass::Whitespace
    } else if symbol
        .chars()
        .any(|character| character.is_alphanumeric() || character == '_')
    {
        CellClass::Word
    } else {
        CellClass::Symbol
    }
}

pub(crate) fn text_in_range(buffer: &Buffer, range: ScreenSelectionRange) -> Option<String> {
    let area = buffer.area;
    if area.is_empty() {
        return None;
    }
    let top = range.start.y.max(area.y);
    let bottom = range.end.y.min(area.bottom().saturating_sub(1));
    if top > bottom {
        return None;
    }

    let mut lines = Vec::new();
    for row in top..=bottom {
        let left = if row == range.start.y {
            range.start.x.max(area.x)
        } else {
            area.x
        };
        let right = if row == range.end.y {
            range.end.x.min(area.right().saturating_sub(1))
        } else {
            area.right().saturating_sub(1)
        };
        if left > right {
            lines.push(String::new());
            continue;
        }

        let mut line = String::new();
        let mut continuation_cells = 0usize;
        for column in area.x..=right {
            let Some(cell) = buffer.cell(Position::new(column, row)) else {
                continue;
            };
            if continuation_cells > 0 {
                continuation_cells -= 1;
                continue;
            }
            continuation_cells = cell.symbol().width().saturating_sub(1);
            if column >= left {
                line.push_str(cell.symbol());
            }
        }
        if right == area.right().saturating_sub(1) {
            line.truncate(line.trim_end().len());
        }
        lines.push(line);
    }
    let text = lines.join("\n");
    (!text.is_empty()).then_some(text)
}

const fn position_index(position: Position) -> u32 {
    (position.y as u32) << 16 | position.x as u32
}

#[cfg(test)]
#[path = "text_tests.rs"]
mod tests;
