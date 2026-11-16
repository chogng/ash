use crate::ColumnAlignment;
use crate::Error;
use crate::Node;
use crate::NodeKind;
use crate::SourceIndex;
use crate::TextEdit;
use serde::Deserialize;
use serde::Serialize;
use std::cmp::Ordering;

const MAX_CELLS: usize = 100_000;
const MAX_METADATA_BYTES: usize = 1_048_576;

/// Closed table fill palette; source metadata cannot inject arbitrary CSS.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TableColor {
    Gray,
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
}

fn one() -> usize {
    1
}
fn header_default() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TableCellLayout {
    pub row: usize,
    pub column: usize,
    #[serde(default = "one")]
    pub rowspan: usize,
    #[serde(default = "one")]
    pub colspan: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<TableColor>,
}

/// Source-owned table presentation. Ordinary GFM remains readable when the
/// annotation is ignored, including the complete rectangular cell contents.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TableLayout {
    #[serde(default)]
    pub widths: Vec<u32>,
    #[serde(default = "header_default")]
    pub header: bool,
    #[serde(default)]
    pub cells: Vec<TableCellLayout>,
}

impl Default for TableLayout {
    fn default() -> Self {
        Self {
            widths: Vec::new(),
            header: true,
            cells: Vec::new(),
        }
    }
}

impl TableLayout {
    pub(crate) fn normalized(mut self, rows: usize, columns: usize) -> Result<Self, Error> {
        dimensions(rows, columns)?;
        if self.widths.is_empty() {
            self.widths.resize(columns, 0);
        }
        if self.widths.len() != columns
            || self
                .widths
                .iter()
                .any(|width| *width != 0 && !(48..=4000).contains(width))
        {
            return Err(invalid("Invalid table column widths"));
        }
        if self.cells.len() > rows * columns {
            return Err(invalid("Too many table cell attributes"));
        }
        let mut occupied = vec![false; rows * columns];
        for cell in &self.cells {
            if cell.rowspan == 0
                || cell.colspan == 0
                || cell.row >= rows
                || cell.column >= columns
                || cell.rowspan > rows - cell.row
                || cell.colspan > columns - cell.column
            {
                return Err(invalid("Invalid table cell span"));
            }
            for row in cell.row..cell.row + cell.rowspan {
                for column in cell.column..cell.column + cell.colspan {
                    let slot = &mut occupied[row * columns + column];
                    if *slot {
                        return Err(invalid("Overlapping table cell attributes"));
                    }
                    *slot = true;
                }
            }
        }
        self.cells
            .retain(|cell| cell.rowspan > 1 || cell.colspan > 1 || cell.color.is_some());
        self.cells.sort_by_key(|cell| (cell.row, cell.column));
        Ok(self)
    }

    pub(crate) fn ordinary(&self) -> bool {
        self.header && self.widths.iter().all(|width| *width == 0) && self.cells.is_empty()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TableAction {
    SetCellBlock {
        top: usize,
        left: usize,
        bottom: usize,
        right: usize,
        block: crate::CellBlock,
        #[serde(default)]
        offset: Option<u32>,
    },
    InsertRow {
        index: usize,
    },
    DeleteRows {
        from: usize,
        to: usize,
    },
    MoveRow {
        from: usize,
        to: usize,
    },
    InsertColumn {
        index: usize,
    },
    DeleteColumns {
        from: usize,
        to: usize,
    },
    MoveColumn {
        from: usize,
        to: usize,
    },
    ClearCells {
        top: usize,
        left: usize,
        bottom: usize,
        right: usize,
    },
    PasteCells {
        row: usize,
        column: usize,
        values: Vec<Vec<String>>,
        #[serde(default)]
        cells: Option<Vec<TableCellLayout>>,
    },
    SetColumnWidth {
        column: usize,
        #[serde(default)]
        end_column: Option<usize>,
        width: u32,
    },
    SetColumnAlignment {
        from: usize,
        to: usize,
        alignment: ColumnAlignment,
    },
    SetCellColor {
        top: usize,
        left: usize,
        bottom: usize,
        right: usize,
        color: Option<TableColor>,
    },
    MergeCells {
        top: usize,
        left: usize,
        bottom: usize,
        right: usize,
    },
    SplitCell {
        row: usize,
        column: usize,
    },
    ToggleHeader {},
    SortColumn {
        column: usize,
        direction: SortDirection,
    },
    DeleteTable {},
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortDirection {
    Ascending,
    Descending,
}

/// Fold only a complete, validated annotation directly following its table.
/// Invalid or unrelated HTML remains inert source and visible to source editors.
pub(crate) fn fold_layouts(
    nodes: Vec<Node>,
    source: &str,
    index: &SourceIndex,
) -> Result<Vec<Node>, Error> {
    let mut output: Vec<Node> = Vec::new();
    let mut attached = false;
    for mut node in nodes {
        node.children = fold_layouts(node.children, source, index)?;
        if !attached {
            if let Some(previous) = output.last_mut() {
                if let NodeKind::Table { alignments, layout } = &mut previous.kind {
                    let text = &source[node.source.bytes.start..node.source.bytes.end];
                    let gap = &source[previous.source.bytes.end..node.source.bytes.start];
                    if matches!(node.kind, NodeKind::HtmlBlock | NodeKind::RawHtml { .. })
                        && gap.trim().is_empty()
                        && text.len() <= MAX_METADATA_BYTES
                    {
                        if let Some(json) = text
                            .trim()
                            .strip_prefix("<!-- ash-table ")
                            .and_then(|value| value.strip_suffix(" -->"))
                        {
                            if let Some(value) = serde_json::from_str::<TableLayout>(json)
                                .ok()
                                .and_then(|value| {
                                    value
                                        .normalized(previous.children.len(), alignments.len())
                                        .ok()
                                })
                            {
                                *layout = value;
                                previous.source = index.source_span(
                                    previous.source.bytes.start..node.source.bytes.end,
                                )?;
                                attached = true;
                                continue;
                            }
                        }
                    }
                }
            }
        }
        if let NodeKind::Table { alignments, layout } = &mut node.kind {
            // Pulldown pads short rows with zero-width cells at row.end, which
            // includes the newline. Keep virtual targets inside their own row.
            for row in &mut node.children {
                let raw = &source[row.source.bytes.start..row.source.bytes.end];
                let end = row.source.bytes.start + raw.trim_end_matches(['\r', '\n']).len();
                for cell in &mut row.children {
                    if cell.source.bytes.start == row.source.bytes.end
                        && cell.source.bytes.start == cell.source.bytes.end
                        && cell.children.is_empty()
                    {
                        cell.kind = NodeKind::TableCell { missing: true };
                        cell.source = index.source_span(end..end)?;
                    }
                }
            }
            *layout = layout
                .clone()
                .normalized(node.children.len(), alignments.len())?;
        }
        output.push(node);
        attached = false;
    }
    Ok(output)
}

pub(crate) fn edit(
    source: &str,
    nodes: &[Node],
    offset: u32,
    action: TableAction,
) -> Result<Vec<TextEdit>, Error> {
    let table = nodes
        .iter()
        .find(|node| {
            matches!(node.kind, NodeKind::Table { .. })
                && node.source.utf16.start <= offset
                && offset <= node.source.utf16.end
        })
        .ok_or_else(|| invalid("Table actions require a top-level table"))?;
    if matches!(action, TableAction::DeleteTable {}) {
        return Ok(vec![TextEdit {
            range: table.source.utf16,
            text: String::new(),
        }]);
    }
    let NodeKind::Table { alignments, layout } = &table.kind else {
        unreachable!()
    };
    let mut matrix = Matrix {
        values: table
            .children
            .iter()
            .map(|row| {
                let mut values: Vec<String> = row
                    .children
                    .iter()
                    .map(|cell| {
                        source[cell.source.bytes.start..cell.source.bytes.end]
                            .trim()
                            .to_owned()
                    })
                    .collect();
                values.resize(alignments.len(), String::new());
                values.truncate(alignments.len());
                values
            })
            .collect(),
        alignments: alignments.clone(),
        layout: layout.clone(),
    };
    let before = matrix.clone();
    matrix.apply(action, source, table)?;
    if !matrix.values.is_empty() && !matrix.alignments.is_empty() {
        matrix.layout = matrix
            .layout
            .normalized(matrix.values.len(), matrix.alignments.len())?;
    }
    if matrix == before {
        return Ok(Vec::new());
    }
    let text = if matrix.values.is_empty() || matrix.alignments.is_empty() {
        String::new()
    } else {
        matrix.layout = matrix
            .layout
            .normalized(matrix.values.len(), matrix.alignments.len())?;
        matrix.serialize(
            source[table.source.bytes.start..table.source.bytes.end].contains("\r\n"),
            source[..table.source.bytes.end].ends_with('\n'),
        )?
    };
    if source[table.source.bytes.start..table.source.bytes.end] == text {
        return Ok(Vec::new());
    }
    Ok(vec![TextEdit {
        range: table.source.utf16,
        text,
    }])
}

#[derive(Clone, PartialEq, Eq)]
struct Matrix {
    values: Vec<Vec<String>>,
    alignments: Vec<ColumnAlignment>,
    layout: TableLayout,
}

#[derive(Clone, Copy)]
struct Rect {
    top: usize,
    left: usize,
    bottom: usize,
    right: usize,
}

impl Rect {
    fn intersects(self, cell: &TableCellLayout) -> bool {
        self.top < cell.row + cell.rowspan
            && self.bottom >= cell.row
            && self.left < cell.column + cell.colspan
            && self.right >= cell.column
    }
    fn contains(self, cell: &TableCellLayout) -> bool {
        self.top <= cell.row
            && self.left <= cell.column
            && self.bottom + 1 >= cell.row + cell.rowspan
            && self.right + 1 >= cell.column + cell.colspan
    }
}

impl Matrix {
    fn rows(&self) -> usize {
        self.values.len()
    }
    fn columns(&self) -> usize {
        self.alignments.len()
    }
    fn rect(&self, top: usize, left: usize, bottom: usize, right: usize) -> Result<Rect, Error> {
        if top > bottom || left > right || bottom >= self.rows() || right >= self.columns() {
            return Err(invalid("Invalid table cell selection"));
        }
        let rect = Rect {
            top,
            left,
            bottom,
            right,
        };
        if self
            .layout
            .cells
            .iter()
            .any(|cell| rect.intersects(cell) && !rect.contains(cell))
        {
            return Err(invalid("Selection crosses a merged cell"));
        }
        Ok(rect)
    }
    fn unmerged(&self) -> Result<(), Error> {
        if self
            .layout
            .cells
            .iter()
            .any(|cell| cell.rowspan > 1 || cell.colspan > 1)
        {
            Err(invalid("Split merged cells before reordering a table"))
        } else {
            Ok(())
        }
    }
    fn apply(&mut self, action: TableAction, source: &str, table: &Node) -> Result<(), Error> {
        match action {
            TableAction::SetCellBlock {
                top,
                left,
                bottom,
                right,
                block,
                offset,
            } => {
                let rect = self.rect(top, left, bottom, right)?;
                if let Some(offset) = offset {
                    crate::SourceIndex::new(source)?.utf16_to_byte(offset)?;
                    let cell = &table.children[top].children[left];
                    if top != bottom
                        || left != right
                        || offset < cell.source.utf16.start
                        || offset > cell.source.utf16.end
                    {
                        return Err(invalid("Block caret must stay inside its target cell"));
                    }
                }
                for row in rect.top..=rect.bottom {
                    for column in rect.left..=rect.right {
                        if self.layout.cells.iter().any(|cell| {
                            cell.row <= row
                                && row < cell.row + cell.rowspan
                                && cell.column <= column
                                && column < cell.column + cell.colspan
                                && (cell.row != row || cell.column != column)
                        }) {
                            continue;
                        }
                        self.values[row][column] = crate::table_cell::format(
                            &table.children[row].children[column],
                            source,
                            block,
                            offset,
                        )?;
                    }
                }
            }
            TableAction::InsertRow { index } => {
                if index > self.rows() {
                    return Err(invalid("Invalid row insertion index"));
                }
                dimensions(self.rows() + 1, self.columns())?;
                self.values
                    .insert(index, vec![String::new(); self.columns()]);
                for cell in &mut self.layout.cells {
                    if cell.row >= index {
                        cell.row += 1;
                    } else if cell.row + cell.rowspan > index {
                        cell.rowspan += 1;
                    }
                }
            }
            TableAction::DeleteRows { from, to } => {
                interval(from, to, self.rows())?;
                self.delete_axis(from, to, true);
            }
            TableAction::MoveRow { from, to } => {
                interval(from, from, self.rows())?;
                interval(to, to, self.rows())?;
                self.unmerged()?;
                let value = self.values.remove(from);
                self.values.insert(to, value);
                for cell in &mut self.layout.cells {
                    cell.row = moved_index(cell.row, from, to);
                }
            }
            TableAction::InsertColumn { index } => {
                if index > self.columns() {
                    return Err(invalid("Invalid column insertion index"));
                }
                dimensions(self.rows(), self.columns() + 1)?;
                self.alignments.insert(index, ColumnAlignment::None);
                self.layout.widths.insert(index, 0);
                for row in &mut self.values {
                    row.insert(index, String::new());
                }
                for cell in &mut self.layout.cells {
                    if cell.column >= index {
                        cell.column += 1;
                    } else if cell.column + cell.colspan > index {
                        cell.colspan += 1;
                    }
                }
            }
            TableAction::DeleteColumns { from, to } => {
                interval(from, to, self.columns())?;
                self.delete_axis(from, to, false);
            }
            TableAction::MoveColumn { from, to } => {
                interval(from, from, self.columns())?;
                interval(to, to, self.columns())?;
                self.unmerged()?;
                let alignment = self.alignments.remove(from);
                self.alignments.insert(to, alignment);
                let width = self.layout.widths.remove(from);
                self.layout.widths.insert(to, width);
                for row in &mut self.values {
                    let value = row.remove(from);
                    row.insert(to, value);
                }
                for cell in &mut self.layout.cells {
                    cell.column = moved_index(cell.column, from, to);
                }
            }
            TableAction::ClearCells {
                top,
                left,
                bottom,
                right,
            } => {
                let rect = self.rect(top, left, bottom, right)?;
                for row in rect.top..=rect.bottom {
                    for column in rect.left..=rect.right {
                        self.values[row][column].clear();
                    }
                }
            }
            TableAction::PasteCells {
                row,
                column,
                values,
                cells,
            } => {
                if values.is_empty()
                    || values[0].is_empty()
                    || values.iter().any(|value| value.len() != values[0].len())
                {
                    return Err(invalid("Pasted cells must form a non-empty rectangle"));
                }
                let fragment = cells
                    .map(|cells| {
                        TableLayout {
                            widths: Vec::new(),
                            header: true,
                            cells,
                        }
                        .normalized(values.len(), values[0].len())
                    })
                    .transpose()?;
                if row >= self.rows() || column >= self.columns() {
                    return Err(invalid("Paste origin must address a table cell"));
                }
                let rows = row
                    .checked_add(values.len())
                    .ok_or_else(|| invalid("Pasted table is too large"))?;
                let columns = column
                    .checked_add(values[0].len())
                    .ok_or_else(|| invalid("Pasted table is too large"))?;
                dimensions(rows.max(self.rows()), columns.max(self.columns()))?;
                let rect = Rect {
                    top: row,
                    left: column,
                    bottom: rows - 1,
                    right: columns - 1,
                };
                if self
                    .layout
                    .cells
                    .iter()
                    .any(|cell| rect.intersects(cell) && !rect.contains(cell))
                {
                    return Err(invalid("Paste crosses a merged cell"));
                }
                if let Some(fragment) = fragment {
                    self.layout.cells.retain(|cell| !rect.intersects(cell));
                    self.layout
                        .cells
                        .extend(fragment.cells.into_iter().map(|mut cell| {
                            cell.row += row;
                            cell.column += column;
                            cell
                        }));
                } else {
                    self.layout.cells.retain_mut(|cell| {
                        if rect.intersects(cell) {
                            cell.rowspan = 1;
                            cell.colspan = 1;
                        }
                        cell.color.is_some() || cell.rowspan > 1 || cell.colspan > 1
                    });
                }
                self.alignments
                    .resize(columns.max(self.columns()), ColumnAlignment::None);
                self.layout.widths.resize(self.columns(), 0);
                let columns = self.columns();
                for value in &mut self.values {
                    value.resize(columns, String::new());
                }
                self.values
                    .resize_with(rows.max(self.rows()), || vec![String::new(); columns]);
                let mut bytes = 0;
                for (r, values) in values.into_iter().enumerate() {
                    for (c, value) in values.into_iter().enumerate() {
                        bytes += value.len();
                        if bytes > crate::MAX_SOURCE_BYTES {
                            return Err(invalid("Pasted cells are too large"));
                        }
                        self.values[row + r][column + c] = escape_cell(&value);
                    }
                }
            }
            TableAction::SetColumnWidth {
                column,
                end_column,
                width,
            } => {
                let end = end_column.unwrap_or(column);
                interval(column, end, self.columns())?;
                if width != 0 && !(48..=4000).contains(&width) {
                    return Err(invalid("Column width must be auto or between 48 and 4000"));
                }
                self.layout.widths[column..=end].fill(width);
            }
            TableAction::SetColumnAlignment {
                from,
                to,
                alignment,
            } => {
                interval(from, to, self.columns())?;
                self.alignments[from..=to].fill(alignment);
            }
            TableAction::SetCellColor {
                top,
                left,
                bottom,
                right,
                color,
            } => {
                let rect = self.rect(top, left, bottom, right)?;
                let columns = self.columns();
                let mut owners = vec![None; self.rows() * columns];
                for (index, cell) in self.layout.cells.iter().enumerate() {
                    for row in cell.row..cell.row + cell.rowspan {
                        for column in cell.column..cell.column + cell.colspan {
                            owners[row * columns + column] = Some(index);
                        }
                    }
                }
                for row in rect.top..=rect.bottom {
                    for column in rect.left..=rect.right {
                        if let Some(index) = owners[row * columns + column] {
                            let cell = &mut self.layout.cells[index];
                            if cell.row == row && cell.column == column {
                                cell.color = color;
                            }
                        } else if color.is_some() {
                            self.layout.cells.push(TableCellLayout {
                                row,
                                column,
                                rowspan: 1,
                                colspan: 1,
                                color,
                            });
                        }
                    }
                }
            }
            TableAction::MergeCells {
                top,
                left,
                bottom,
                right,
            } => {
                let rect = self.rect(top, left, bottom, right)?;
                if top == bottom && left == right {
                    return Err(invalid("Select more than one cell to merge"));
                }
                let color = self
                    .layout
                    .cells
                    .iter()
                    .find(|cell| cell.row == top && cell.column == left)
                    .and_then(|cell| cell.color);
                let mut content = Vec::new();
                for row in top..=bottom {
                    for column in left..=right {
                        let value = std::mem::take(&mut self.values[row][column]);
                        if !value.is_empty() {
                            content.push(value);
                        }
                    }
                }
                self.values[top][left] = content.join(" ");
                self.layout.cells.retain(|cell| !rect.intersects(cell));
                self.layout.cells.push(TableCellLayout {
                    row: top,
                    column: left,
                    rowspan: bottom - top + 1,
                    colspan: right - left + 1,
                    color,
                });
            }
            TableAction::SplitCell { row, column } => {
                interval(row, row, self.rows())?;
                interval(column, column, self.columns())?;
                if let Some(cell) = self.layout.cells.iter_mut().find(|cell| {
                    row >= cell.row
                        && row < cell.row + cell.rowspan
                        && column >= cell.column
                        && column < cell.column + cell.colspan
                }) {
                    cell.rowspan = 1;
                    cell.colspan = 1;
                }
            }
            TableAction::ToggleHeader {} => self.layout.header = !self.layout.header,
            TableAction::SortColumn { column, direction } => {
                interval(column, column, self.columns())?;
                self.unmerged()?;
                let start = usize::from(self.layout.header);
                let mut order: Vec<usize> = (start..self.rows()).collect();
                let keys: Vec<_> = self
                    .values
                    .iter()
                    .map(|row| sort_key(&row[column]))
                    .collect();
                let numeric = order.iter().any(|index| !keys[*index].text.is_empty())
                    && order
                        .iter()
                        .all(|index| keys[*index].text.is_empty() || keys[*index].number.is_some());
                order.sort_by(|a, b| {
                    let a = &keys[*a];
                    let b = &keys[*b];
                    // Empty cells stay last in both directions. Reversing this
                    // comparison would incorrectly move blanks to the front.
                    match (a.text.is_empty(), b.text.is_empty()) {
                        (true, true) => return Ordering::Equal,
                        (true, false) => return Ordering::Greater,
                        (false, true) => return Ordering::Less,
                        (false, false) => {}
                    }
                    let value = if numeric {
                        a.number
                            .expect("numeric column key")
                            .partial_cmp(&b.number.expect("numeric column key"))
                            .expect("numeric keys are finite")
                    } else {
                        natural_compare(&a.natural, &b.natural)
                    };
                    match direction {
                        SortDirection::Ascending => value,
                        SortDirection::Descending => value.reverse(),
                    }
                });
                let old = self.values.clone();
                for (index, previous) in order.iter().enumerate() {
                    self.values[start + index] = old[*previous].clone();
                }
                for cell in &mut self.layout.cells {
                    if cell.row >= start {
                        cell.row = start
                            + order
                                .iter()
                                .position(|row| *row == cell.row)
                                .expect("sort permutation retains each row");
                    }
                }
            }
            TableAction::DeleteTable {} => unreachable!("handled before constructing the matrix"),
        }
        Ok(())
    }

    fn delete_axis(&mut self, from: usize, to: usize, rows: bool) {
        let count = to - from + 1;
        let mut retained = Vec::new();
        for mut cell in std::mem::take(&mut self.layout.cells) {
            let start = if rows { cell.row } else { cell.column };
            let span = if rows { cell.rowspan } else { cell.colspan };
            let end = start + span;
            let removed = end.min(to + 1).saturating_sub(start.max(from));
            if removed == span {
                continue;
            }
            let anchor_removed = start >= from && start <= to;
            let value = anchor_removed.then(|| self.values[cell.row][cell.column].clone());
            let new_start = if start > to {
                start - count
            } else {
                start.min(from)
            };
            if rows {
                cell.row = new_start;
                cell.rowspan -= removed;
            } else {
                cell.column = new_start;
                cell.colspan -= removed;
            }
            retained.push((cell, value));
        }
        if rows {
            self.values.drain(from..=to);
        } else {
            self.alignments.drain(from..=to);
            self.layout.widths.drain(from..=to);
            for row in &mut self.values {
                row.drain(from..=to);
            }
        }
        for (cell, value) in retained {
            if let Some(value) = value {
                self.values[cell.row][cell.column] = value;
            }
            self.layout.cells.push(cell);
        }
    }

    fn serialize(&self, crlf: bool, trailing_newline: bool) -> Result<String, Error> {
        let newline = if crlf { "\r\n" } else { "\n" };
        let mut text = String::new();
        for (index, row) in self.values.iter().enumerate() {
            text.push_str("| ");
            text.push_str(&row.join(" | "));
            text.push_str(" |");
            text.push_str(newline);
            if index == 0 {
                text.push_str("| ");
                text.push_str(
                    &self
                        .alignments
                        .iter()
                        .map(|alignment| match alignment {
                            ColumnAlignment::None => "---",
                            ColumnAlignment::Left => ":---",
                            ColumnAlignment::Center => ":---:",
                            ColumnAlignment::Right => "---:",
                        })
                        .collect::<Vec<_>>()
                        .join(" | "),
                );
                text.push_str(" |");
                text.push_str(newline);
            }
        }
        if !self.layout.ordinary() {
            text.push_str(newline);
            text.push_str("<!-- ash-table ");
            let metadata =
                serde_json::to_string(&self.layout).map_err(|error| invalid(error.to_string()))?;
            if metadata.len() > MAX_METADATA_BYTES {
                return Err(invalid("Table layout annotation is too large"));
            }
            text.push_str(&metadata);
            text.push_str(" -->");
            text.push_str(newline);
        }
        if !trailing_newline {
            text.truncate(text.len() - newline.len());
        }
        crate::check_source_size(text.len())?;
        Ok(text)
    }
}

fn moved_index(index: usize, from: usize, to: usize) -> usize {
    if index == from {
        to
    } else if from < to && index > from && index <= to {
        index - 1
    } else if to < from && index >= to && index < from {
        index + 1
    } else {
        index
    }
}
fn dimensions(rows: usize, columns: usize) -> Result<(), Error> {
    if rows == 0
        || columns == 0
        || rows
            .checked_mul(columns)
            .is_none_or(|count| count > MAX_CELLS)
    {
        Err(invalid("Table dimensions exceed the supported limit"))
    } else {
        Ok(())
    }
}
fn interval(from: usize, to: usize, length: usize) -> Result<(), Error> {
    if from > to || to >= length {
        Err(invalid("Invalid table row or column range"))
    } else {
        Ok(())
    }
}
fn escape_cell(text: &str) -> String {
    let mut escaped = String::new();
    for ch in text.replace("\r\n", "\n").replace('\r', "\n").chars() {
        if ch == '\n' {
            escaped.push_str("&#10;");
        } else if ch == '\t' {
            escaped.push_str("&#9;");
        } else {
            if matches!(
                ch,
                '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '|' | '&'
            ) {
                escaped.push('\\');
            }
            escaped.push(ch);
        }
    }
    escaped
}
struct SortKey {
    text: String,
    natural: String,
    number: Option<f64>,
}

fn sort_key(value: &str) -> SortKey {
    let text = pulldown_cmark::Parser::new(value)
        .filter_map(|event| match event {
            pulldown_cmark::Event::Text(text) | pulldown_cmark::Event::Code(text) => {
                Some(text.to_string())
            }
            _ => None,
        })
        .collect::<String>()
        .trim_matches(sort_whitespace)
        .to_owned();
    SortKey {
        natural: base_text(&text),
        number: sort_number(&text),
        text,
    }
}

fn sort_whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn sort_number(text: &str) -> Option<f64> {
    let stripped: String = text
        .chars()
        .filter(|ch| !matches!(ch, '$' | '€' | '£' | '%'))
        .collect();
    let trimmed = stripped.trim_matches(sort_whitespace);
    if trimmed.is_empty() || trimmed.chars().any(sort_whitespace) {
        return None;
    }
    let number = if trimmed.contains(',') {
        // Match only conventional thousands groups, not decimal commas or
        // ambiguous grouping. A mixed column must use one text comparator.
        let unsigned = trimmed.strip_prefix('-').unwrap_or(trimmed);
        let (integer, fraction) = unsigned
            .split_once('.')
            .map_or((unsigned, None), |(integer, fraction)| {
                (integer, Some(fraction))
            });
        if fraction.is_some_and(|value| {
            value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit())
        }) {
            return None;
        }
        let mut groups = integer.split(',');
        let first = groups.next()?;
        if first.is_empty() || first.len() > 3 || !first.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        if !groups.all(|group| group.len() == 3 && group.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return None;
        }
        trimmed.replace(',', "").parse::<f64>().ok()?
    } else if let Some(digits) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        radix_number(digits, 16)?
    } else if let Some(digits) = trimmed
        .strip_prefix("0b")
        .or_else(|| trimmed.strip_prefix("0B"))
    {
        radix_number(digits, 2)?
    } else if let Some(digits) = trimmed
        .strip_prefix("0o")
        .or_else(|| trimmed.strip_prefix("0O"))
    {
        radix_number(digits, 8)?
    } else {
        trimmed.parse::<f64>().ok()?
    };
    number.is_finite().then_some(number)
}

fn radix_number(digits: &str, radix: u32) -> Option<f64> {
    if digits.is_empty() {
        return None;
    }
    digits.chars().try_fold(0.0, |number, ch| {
        ch.to_digit(radix)
            .map(|digit| number * f64::from(radix) + f64::from(digit))
    })
}

fn natural_compare(a: &str, b: &str) -> Ordering {
    let mut a = a.chars().peekable();
    let mut b = b.chars().peekable();
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(left), Some(right)) if left.is_ascii_digit() && right.is_ascii_digit() => {
                let mut left = String::new();
                let mut right = String::new();
                while a.peek().is_some_and(char::is_ascii_digit) {
                    left.push(a.next().expect("digit is present"));
                }
                while b.peek().is_some_and(char::is_ascii_digit) {
                    right.push(b.next().expect("digit is present"));
                }
                let left = left.trim_start_matches('0');
                let right = right.trim_start_matches('0');
                let order = left.len().cmp(&right.len()).then_with(|| left.cmp(right));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(left), Some(right)) => {
                let order = left.cmp(&right);
                if order != Ordering::Equal {
                    return order;
                }
                a.next();
                b.next();
            }
        }
    }
}

fn base_text(text: &str) -> String {
    // Keep sorting portable across native and WASM without a host locale or a
    // collation database. Fold common Latin base accents and numeric runs;
    // other scripts retain deterministic Unicode lowercase ordering.
    let mut output = String::new();
    for ch in text.chars().flat_map(char::to_lowercase) {
        let base = match ch {
            '\u{0300}'..='\u{036f}'
            | '\u{1ab0}'..='\u{1aff}'
            | '\u{1dc0}'..='\u{1dff}'
            | '\u{20d0}'..='\u{20ff}'
            | '\u{fe20}'..='\u{fe2f}' => continue,
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
            'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
            'ď' | 'đ' | 'ð' => 'd',
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
            'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
            'ĥ' | 'ħ' => 'h',
            'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => 'i',
            'ĵ' => 'j',
            'ķ' => 'k',
            'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => 'l',
            'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => 'o',
            'ŕ' | 'ŗ' | 'ř' => 'r',
            'ś' | 'ŝ' | 'ş' | 'š' => 's',
            'ţ' | 'ť' | 'ŧ' => 't',
            'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
            'ŵ' => 'w',
            'ý' | 'ÿ' | 'ŷ' => 'y',
            'ź' | 'ż' | 'ž' => 'z',
            'æ' => {
                output.push_str("ae");
                continue;
            }
            'œ' => {
                output.push_str("oe");
                continue;
            }
            'ß' => {
                output.push_str("ss");
                continue;
            }
            _ => ch,
        };
        output.push(base);
    }
    output
}
fn invalid(message: impl Into<String>) -> Error {
    Error::InvalidRequest {
        message: message.into(),
    }
}

pub(crate) fn render_html(table: &Node, source: &str) -> Result<String, Error> {
    let NodeKind::Table { alignments, layout } = &table.kind else {
        unreachable!()
    };
    let columns = alignments.len();
    let mut covered = vec![false; table.children.len() * columns];
    let attributes: std::collections::BTreeMap<_, _> = layout
        .cells
        .iter()
        .map(|cell| ((cell.row, cell.column), cell))
        .collect();
    for cell in &layout.cells {
        for row in cell.row..cell.row + cell.rowspan {
            for column in cell.column..cell.column + cell.colspan {
                if row != cell.row || column != cell.column {
                    covered[row * columns + column] = true;
                }
            }
        }
    }
    let mut html = String::from("<table><colgroup>");
    for width in &layout.widths {
        if *width == 0 {
            html.push_str("<col>");
        } else {
            html.push_str(&format!("<col style=\"width:{width}px\">"));
        }
    }
    html.push_str("</colgroup><tbody>\n");
    for (row_index, row) in table.children.iter().enumerate() {
        html.push_str("<tr>");
        for column in 0..columns {
            if covered[row_index * columns + column] {
                continue;
            }
            let tag = if row_index == 0 && layout.header {
                "th"
            } else {
                "td"
            };
            html.push('<');
            html.push_str(tag);
            if tag == "th" {
                html.push_str(" scope=\"col\"");
            }
            let attrs = attributes.get(&(row_index, column));
            if let Some(cell) = attrs {
                if cell.rowspan > 1 {
                    html.push_str(&format!(" rowspan=\"{}\"", cell.rowspan));
                }
                if cell.colspan > 1 {
                    html.push_str(&format!(" colspan=\"{}\"", cell.colspan));
                }
            }
            let mut styles = vec!["white-space:pre-wrap".to_owned()];
            if alignments[column] != ColumnAlignment::None {
                styles.push(format!(
                    "text-align:{}",
                    match alignments[column] {
                        ColumnAlignment::Left => "left",
                        ColumnAlignment::Center => "center",
                        ColumnAlignment::Right => "right",
                        ColumnAlignment::None => unreachable!(),
                    }
                ));
            }
            if let Some(color) = attrs.and_then(|cell| cell.color) {
                styles.push(format!(
                    "background-color:{}",
                    match color {
                        TableColor::Gray => "#eeeeec",
                        TableColor::Red => "#fce8e8",
                        TableColor::Orange => "#fbe8da",
                        TableColor::Yellow => "#faf0ce",
                        TableColor::Green => "#e4f0df",
                        TableColor::Blue => "#e0edfb",
                        TableColor::Purple => "#ede6fa",
                    }
                ));
            }
            if !styles.is_empty() {
                html.push_str(" style=\"");
                html.push_str(&styles.join(";"));
                html.push('"');
            }
            html.push('>');
            if let Some(cell) = row.children.get(column) {
                if crate::table_cell::has_blocks(&cell.children) {
                    html.push_str(&crate::table_cell::render_html(&cell.children, source)?);
                } else {
                    let content = crate::markdown::render_html(
                        source[cell.source.bytes.start..cell.source.bytes.end].trim(),
                    )?;
                    html.push_str(
                        content
                            .strip_prefix("<p>")
                            .and_then(|value| value.strip_suffix("</p>\n"))
                            .unwrap_or(&content),
                    );
                }
            }
            html.push_str("</");
            html.push_str(tag);
            html.push('>');
        }
        html.push_str("</tr>\n");
    }
    html.push_str("</tbody></table>\n");
    Ok(html)
}
