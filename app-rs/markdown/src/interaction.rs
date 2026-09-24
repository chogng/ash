use std::cmp::Ordering;
use std::ops::Range;

/// UTF-8 byte position inside one projected Markdown block.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct MarkdownTextPosition {
    block: usize,
    offset: usize,
}

impl MarkdownTextPosition {
    pub const fn new(block: usize, offset: usize) -> Self {
        Self { block, offset }
    }

    pub const fn block(self) -> usize {
        self.block
    }

    pub const fn offset(self) -> usize {
        self.offset
    }
}

impl Ord for MarkdownTextPosition {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.block, self.offset).cmp(&(other.block, other.offset))
    }
}

impl PartialOrd for MarkdownTextPosition {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Anchor/focus range retained by the Markdown host while dragging or extending selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MarkdownSelection {
    anchor: MarkdownTextPosition,
    focus: MarkdownTextPosition,
}

/// Caller-retained pointer selection state.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MarkdownSelectionController {
    anchor: Option<MarkdownTextPosition>,
    focus: Option<MarkdownTextPosition>,
}

impl MarkdownSelectionController {
    pub const fn new() -> Self {
        Self {
            anchor: None,
            focus: None,
        }
    }

    pub fn begin(&mut self, position: MarkdownTextPosition) {
        self.anchor = Some(position);
        self.focus = Some(position);
    }

    pub fn extend(&mut self, position: MarkdownTextPosition) {
        if self.anchor.is_some() {
            self.focus = Some(position);
        }
    }

    pub fn clear(&mut self) {
        self.anchor = None;
        self.focus = None;
    }

    pub fn selection(self) -> Option<MarkdownSelection> {
        Some(MarkdownSelection::new(self.anchor?, self.focus?))
    }
}

impl MarkdownSelection {
    pub const fn new(anchor: MarkdownTextPosition, focus: MarkdownTextPosition) -> Self {
        Self { anchor, focus }
    }

    pub const fn anchor(self) -> MarkdownTextPosition {
        self.anchor
    }

    pub const fn focus(self) -> MarkdownTextPosition {
        self.focus
    }

    pub fn normalized(self) -> Range<MarkdownTextPosition> {
        if self.anchor <= self.focus {
            self.anchor..self.focus
        } else {
            self.focus..self.anchor
        }
    }
}

/// Case comparison used by literal Markdown document search.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MarkdownSearchCase {
    Sensitive,
    #[default]
    Insensitive,
}

/// One literal match in projected, copyable Markdown text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarkdownSearchMatch {
    range: Range<MarkdownTextPosition>,
}

impl MarkdownSearchMatch {
    pub(crate) const fn new(start: MarkdownTextPosition, end: MarkdownTextPosition) -> Self {
        Self { range: start..end }
    }

    pub fn range(&self) -> Range<MarkdownTextPosition> {
        self.range.clone()
    }
}
