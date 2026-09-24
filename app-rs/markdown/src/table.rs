use crate::document::{BlockContext, InlineRun};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MarkdownTable {
    pub(crate) rows: Vec<MarkdownTableRow>,
}

impl MarkdownTable {
    pub(crate) fn column_count(&self) -> usize {
        self.rows
            .iter()
            .map(|row| row.cells.len())
            .max()
            .unwrap_or(0)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MarkdownTableRow {
    pub(crate) header: bool,
    pub(crate) cells: Vec<Vec<InlineRun>>,
}

#[derive(Clone, Debug)]
pub(crate) struct TableBuilder {
    in_header: bool,
    cells: Vec<Vec<InlineRun>>,
    rows: Vec<MarkdownTableRow>,
    context: BlockContext,
}

impl TableBuilder {
    pub(crate) fn new(context: BlockContext) -> Self {
        Self {
            in_header: false,
            cells: Vec::new(),
            rows: Vec::new(),
            context,
        }
    }

    pub(crate) fn begin_header(&mut self) {
        self.in_header = true;
        self.cells.clear();
    }

    pub(crate) fn end_header(&mut self) {
        self.finish_row();
        self.in_header = false;
    }

    pub(crate) fn begin_row(&mut self) {
        self.cells.clear();
    }

    pub(crate) fn push_cell(&mut self, runs: Vec<InlineRun>) {
        self.cells.push(runs);
    }

    pub(crate) fn finish_row(&mut self) {
        if self.cells.is_empty() {
            return;
        }
        self.rows.push(MarkdownTableRow {
            header: self.in_header,
            cells: std::mem::take(&mut self.cells),
        });
    }

    pub(crate) fn finish(mut self) -> Option<(MarkdownTable, BlockContext)> {
        self.finish_row();
        (!self.rows.is_empty()).then_some((MarkdownTable { rows: self.rows }, self.context))
    }
}
