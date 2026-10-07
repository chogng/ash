use std::ops::Range;

/// The exact terminator that followed a logical source line.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum LineEnding {
    Lf,
    CrLf,
    Cr,
    None,
}

/// One immutable source line with a one-based number and preserved terminator.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiffLine {
    number: usize,
    text: String,
    ending: LineEnding,
}

impl DiffLine {
    pub(crate) fn new(number: usize, text: String, ending: LineEnding) -> Self {
        Self {
            number,
            text,
            ending,
        }
    }

    pub const fn number(&self) -> usize {
        self.number
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub const fn ending(&self) -> LineEnding {
        self.ending
    }
}

/// The presentation-independent meaning of one mapped diff row.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiffRowKind {
    Context,
    Added,
    Removed,
    Modified,
}

/// One changed inline region, expressed as UTF-8 byte ranges on both sides.
///
/// An insertion has an empty original range; a deletion has an empty modified range. Range
/// boundaries always fall on Unicode grapheme boundaries.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InlineChange {
    old_range: Range<usize>,
    new_range: Range<usize>,
}

impl InlineChange {
    pub(crate) const fn new(old_range: Range<usize>, new_range: Range<usize>) -> Self {
        Self {
            old_range,
            new_range,
        }
    }

    pub fn old_range(&self) -> Range<usize> {
        self.old_range.clone()
    }

    pub fn new_range(&self) -> Range<usize> {
        self.new_range.clone()
    }
}

/// One original/modified line correspondence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiffRow {
    kind: DiffRowKind,
    old: Option<DiffLine>,
    new: Option<DiffLine>,
    inline_changes: Vec<InlineChange>,
}

impl DiffRow {
    pub(crate) fn new(
        kind: DiffRowKind,
        old: Option<DiffLine>,
        new: Option<DiffLine>,
        inline_changes: Vec<InlineChange>,
    ) -> Self {
        Self {
            kind,
            old,
            new,
            inline_changes,
        }
    }

    pub const fn kind(&self) -> DiffRowKind {
        self.kind
    }

    pub fn old(&self) -> Option<&DiffLine> {
        self.old.as_ref()
    }

    pub fn new_line(&self) -> Option<&DiffLine> {
        self.new.as_ref()
    }

    pub fn old_line(&self) -> Option<usize> {
        self.old.as_ref().map(DiffLine::number)
    }

    pub fn new_line_number(&self) -> Option<usize> {
        self.new.as_ref().map(DiffLine::number)
    }

    pub fn old_text(&self) -> Option<&str> {
        self.old.as_ref().map(DiffLine::text)
    }

    pub fn new_text(&self) -> Option<&str> {
        self.new.as_ref().map(DiffLine::text)
    }

    pub fn inline_changes(&self) -> &[InlineChange] {
        &self.inline_changes
    }
}

/// A Git-style hunk header and its half-open range in [`DiffDocument::rows`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiffHunk {
    row_start: usize,
    row_end: usize,
    old_start: usize,
    old_count: usize,
    new_start: usize,
    new_count: usize,
}

impl DiffHunk {
    pub(crate) const fn new(
        row_start: usize,
        row_end: usize,
        old_start: usize,
        old_count: usize,
        new_start: usize,
        new_count: usize,
    ) -> Self {
        Self {
            row_start,
            row_end,
            old_start,
            old_count,
            new_start,
            new_count,
        }
    }

    pub const fn row_start(self) -> usize {
        self.row_start
    }

    pub const fn row_end(self) -> usize {
        self.row_end
    }

    pub const fn old_start(self) -> usize {
        self.old_start
    }

    pub const fn old_count(self) -> usize {
        self.old_count
    }

    pub const fn new_start(self) -> usize {
        self.new_start
    }

    pub const fn new_count(self) -> usize {
        self.new_count
    }
}

/// The complete line mapping between original and modified text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiffDocument {
    rows: Vec<DiffRow>,
    hunks: Vec<DiffHunk>,
    old_line_count: usize,
    new_line_count: usize,
}

impl DiffDocument {
    pub(crate) fn new(
        rows: Vec<DiffRow>,
        hunks: Vec<DiffHunk>,
        old_line_count: usize,
        new_line_count: usize,
    ) -> Self {
        Self {
            rows,
            hunks,
            old_line_count,
            new_line_count,
        }
    }

    pub fn rows(&self) -> &[DiffRow] {
        &self.rows
    }

    pub fn hunks(&self) -> &[DiffHunk] {
        &self.hunks
    }

    pub fn rows_for_hunk(&self, hunk: DiffHunk) -> &[DiffRow] {
        &self.rows[hunk.row_start..hunk.row_end]
    }

    pub const fn old_line_count(&self) -> usize {
        self.old_line_count
    }

    pub const fn new_line_count(&self) -> usize {
        self.new_line_count
    }
}
