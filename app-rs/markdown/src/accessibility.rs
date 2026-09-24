use zui::ui::Rect;

/// Presentation-independent role exposed by the Markdown semantic tree.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarkdownSemanticRole {
    Document,
    Paragraph,
    Heading,
    Link,
    Image,
    Code,
    ListItem,
    Table,
    Row,
    Cell,
    Math,
    Footnote,
    Separator,
}

/// One semantic node with viewport geometry for accessibility adapters.
#[derive(Clone, Debug, PartialEq)]
pub struct MarkdownSemanticNode {
    role: MarkdownSemanticRole,
    label: String,
    bounds: Rect,
    level: Option<u8>,
    destination: Option<String>,
    identifier: Option<String>,
    children: Vec<MarkdownSemanticNode>,
}

impl MarkdownSemanticNode {
    pub(crate) fn new(role: MarkdownSemanticRole, label: String, bounds: Rect) -> Self {
        Self {
            role,
            label,
            bounds,
            level: None,
            destination: None,
            identifier: None,
            children: Vec::new(),
        }
    }

    pub(crate) fn with_level(mut self, level: u8) -> Self {
        self.level = Some(level);
        self
    }

    pub(crate) fn with_destination(mut self, destination: String) -> Self {
        self.destination = Some(destination);
        self
    }

    pub(crate) fn with_identifier(mut self, identifier: String) -> Self {
        self.identifier = Some(identifier);
        self
    }

    pub(crate) fn push_child(&mut self, child: Self) {
        self.children.push(child);
    }

    pub(crate) fn last_child_mut(&mut self) -> Option<&mut Self> {
        self.children.last_mut()
    }

    pub const fn role(&self) -> MarkdownSemanticRole {
        self.role
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    pub const fn level(&self) -> Option<u8> {
        self.level
    }

    pub fn destination(&self) -> Option<&str> {
        self.destination.as_deref()
    }

    pub fn identifier(&self) -> Option<&str> {
        self.identifier.as_deref()
    }

    pub fn children(&self) -> &[Self] {
        &self.children
    }

    pub(crate) fn find_identifier(&self, identifier: &str) -> Option<&Self> {
        if self.identifier.as_deref() == Some(identifier) {
            return Some(self);
        }
        self.children
            .iter()
            .find_map(|child| child.find_identifier(identifier))
    }
}

pub(crate) fn enclosing_bounds(bounds: &[Rect]) -> Option<Rect> {
    let first = *bounds.first()?;
    let (left, top, right, bottom) = bounds.iter().skip(1).fold(
        (
            first.origin.x,
            first.origin.y,
            first.right(),
            first.bottom(),
        ),
        |(left, top, right, bottom), bounds| {
            (
                left.min(bounds.origin.x),
                top.min(bounds.origin.y),
                right.max(bounds.right()),
                bottom.max(bounds.bottom()),
            )
        },
    );
    Some(Rect::from_xywh(left, top, right - left, bottom - top))
}
