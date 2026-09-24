use crate::{MarkdownImages, MarkdownSearchMatch, MarkdownSelection};

/// Optional, caller-owned interaction and resource snapshots for one Markdown layout.
#[derive(Clone, Debug, Default)]
pub struct MarkdownPresentation {
    selection: Option<MarkdownSelection>,
    search_matches: Vec<MarkdownSearchMatch>,
    images: MarkdownImages,
}

impl MarkdownPresentation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_selection(mut self, selection: MarkdownSelection) -> Self {
        self.selection = Some(selection);
        self
    }

    pub fn with_search_matches(mut self, matches: Vec<MarkdownSearchMatch>) -> Self {
        self.search_matches = matches;
        self
    }

    pub fn with_images(mut self, images: MarkdownImages) -> Self {
        self.images = images;
        self
    }

    pub(crate) const fn selection(&self) -> Option<MarkdownSelection> {
        self.selection
    }

    pub(crate) fn search_matches(&self) -> &[MarkdownSearchMatch] {
        &self.search_matches
    }

    pub(crate) const fn images(&self) -> &MarkdownImages {
        &self.images
    }
}
