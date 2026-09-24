use zui::ui::{PaintRect, Point, Rect};

use crate::component::Markdown;
use crate::inline_layout::offset_rect;
use crate::{
    MarkdownLink, MarkdownLinkError, MarkdownLinkPolicy, MarkdownLinkTarget, MarkdownPresentation,
    MarkdownSelection, MarkdownSemanticNode, MarkdownStyle, MarkdownTextPosition,
};

impl Markdown {
    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    pub const fn content_height(&self) -> f32 {
        self.content_height
    }

    pub const fn vertical_offset(&self) -> f32 {
        self.vertical_offset
    }

    pub fn links(&self) -> &[MarkdownLink] {
        &self.links
    }

    pub fn link_at(&self, point: Point) -> Option<&MarkdownLink> {
        self.bounds.contains(point).then_some(())?;
        self.links
            .iter()
            .find(|link| link.bounds.iter().any(|bounds| bounds.contains(point)))
    }

    pub fn activate_link_at(
        &self,
        point: Point,
        policy: &MarkdownLinkPolicy,
    ) -> Result<Option<MarkdownLinkTarget>, MarkdownLinkError> {
        self.link_at(point)
            .map(|link| policy.evaluate(link.destination()))
            .transpose()
    }

    pub fn text_position_at(&self, point: Point) -> Option<MarkdownTextPosition> {
        self.bounds.contains(point).then_some(())?;
        self.text_regions
            .iter()
            .filter(|region| region.bounds().contains(point))
            .find_map(|region| {
                let local = Point::new(point.x - region.origin.x, point.y - region.origin.y);
                region.layout.hit_test(local).map(|offset| {
                    MarkdownTextPosition::new(region.block, region.source_start + offset)
                })
            })
    }

    pub fn selection_bounds(&self, selection: MarkdownSelection) -> Vec<Rect> {
        self.fragments_for_range(selection.normalized())
    }

    pub const fn semantics(&self) -> &MarkdownSemanticNode {
        &self.semantics
    }

    pub fn fragment_bounds(&self, fragment: &str) -> Option<Rect> {
        self.semantics
            .find_identifier(fragment)
            .map(MarkdownSemanticNode::bounds)
    }

    pub(crate) fn apply_presentation(
        &mut self,
        presentation: &MarkdownPresentation,
        style: &MarkdownStyle,
    ) {
        for search_match in presentation.search_matches() {
            for bounds in self.fragments_for_range(search_match.range()) {
                self.rects
                    .push(PaintRect::new(bounds, style.search_match_background()));
            }
        }
        if let Some(selection) = presentation.selection() {
            for bounds in self.selection_bounds(selection) {
                self.rects
                    .push(PaintRect::new(bounds, style.selection_background()));
            }
        }
    }

    fn fragments_for_range(&self, range: std::ops::Range<MarkdownTextPosition>) -> Vec<Rect> {
        self.text_regions
            .iter()
            .filter(|region| {
                region.block >= range.start.block() && region.block <= range.end.block()
            })
            .flat_map(|region| {
                let region_end = region.source_start + region.text.len();
                let start = if region.block == range.start.block() {
                    range.start.offset().max(region.source_start)
                } else {
                    region.source_start
                };
                let end = if region.block == range.end.block() {
                    range.end.offset().min(region_end)
                } else {
                    region_end
                };
                region
                    .layout
                    .range_fragments(
                        start.saturating_sub(region.source_start)
                            ..end.saturating_sub(region.source_start),
                    )
                    .into_iter()
                    .map(|fragment| offset_rect(fragment, region.origin))
                    .map(|fragment| fragment.intersection(self.bounds))
                    .filter(|fragment| !fragment.is_empty())
                    .collect::<Vec<_>>()
            })
            .collect()
    }
}
