use ratatui::style::Color;
use ratatui::text::Line;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ListSelectionPreview {
    title: String,
    lines: Vec<Line<'static>>,
    caption: Option<Line<'static>>,
    separator_color: Option<Color>,
    top_margin: usize,
    bottom_margin: usize,
}

impl ListSelectionPreview {
    pub(crate) fn new(title: impl Into<String>, lines: Vec<Line<'static>>) -> Self {
        Self {
            title: title.into(),
            lines,
            caption: None,
            separator_color: None,
            top_margin: 0,
            bottom_margin: 0,
        }
    }

    pub(crate) fn with_caption(mut self, caption: Line<'static>) -> Self {
        self.caption = Some(caption);
        self
    }

    pub(crate) fn with_separator_color(mut self, color: Color) -> Self {
        self.separator_color = Some(color);
        self
    }

    pub(crate) fn with_margins(mut self, top: usize, bottom: usize) -> Self {
        self.top_margin = top;
        self.bottom_margin = bottom;
        self
    }

    pub(crate) fn title(&self) -> &str {
        &self.title
    }

    pub(crate) fn lines(&self) -> &[Line<'static>] {
        &self.lines
    }

    pub(crate) fn caption(&self) -> Option<&Line<'static>> {
        self.caption.as_ref()
    }

    pub(crate) fn separator_color(&self) -> Option<Color> {
        self.separator_color
    }

    pub(crate) fn top_margin(&self) -> usize {
        self.top_margin
    }

    pub(crate) fn bottom_margin(&self) -> usize {
        self.bottom_margin
    }

    pub(crate) fn desired_height(&self) -> usize {
        self.top_margin
            .saturating_add(self.lines.len())
            .saturating_add(2)
            .saturating_add(usize::from(self.caption.is_some()))
            .saturating_add(self.bottom_margin)
    }
}
