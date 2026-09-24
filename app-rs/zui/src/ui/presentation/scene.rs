use super::ClipRect;
use super::ComponentElement;
use super::ComputedElement;
use super::InspectionFrame;
use super::InspectionNode;
use super::InspectionNodeId;
use super::PaintIcon;
use super::PaintImage;
use super::PaintRect;
use crate::ui::foundation::Color;
use crate::ui::foundation::Point;
use crate::ui::foundation::Rect;
use crate::ui::foundation::Size;
use crate::ui::text::TextSpan;
use crate::ui::text::TextStyle;
#[path = "scene/batching.rs"]
mod batching;
#[path = "scene/elements.rs"]
mod elements;
#[path = "scene/fragments.rs"]
mod fragments;

pub use batching::SceneBatch;
use batching::{ScenePrimitive, batches};
use fragments::SceneFragment;
pub use fragments::SceneFragmentError;

/// Retained boundary used to discard scene work appended after a stable presentation prefix.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneCheckpoint {
    rect_count: usize,
    icon_count: usize,
    image_count: usize,
    text_count: usize,
    clip_count: usize,
    layer_primitive_counts: Vec<usize>,
    layer_count: usize,
    inspection_count: usize,
    active_clip: Option<Rect>,
    active_rounded_clip_depth: u32,
    active_layer: usize,
    active_inspection_parent: Option<InspectionNodeId>,
    fragment_count: usize,
}

/// Horizontal overflow behavior for one shaped [`TextBlock`].
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TextBlockWrap {
    /// Wrap at word or glyph boundaries when text exceeds the block width.
    #[default]
    WordOrGlyph,
    /// Keep every source line unwrapped and rely on the scene clip for overflow.
    None,
}

/// A shaped-on-demand block of text placed in logical UI coordinates.
#[derive(Clone, Debug, PartialEq)]
pub struct TextBlock {
    text: String,
    spans: Vec<TextSpan>,
    origin: Point,
    bounds: Size,
    style: TextStyle,
    wrap: TextBlockWrap,
    text_centered: bool,
    clip_bounds: Option<Rect>,
}

impl TextBlock {
    pub fn new(text: impl Into<String>, origin: Point, bounds: Size, style: TextStyle) -> Self {
        Self {
            text: text.into(),
            spans: Vec::new(),
            origin,
            bounds,
            style,
            wrap: TextBlockWrap::WordOrGlyph,
            text_centered: false,
            clip_bounds: None,
        }
    }

    /// Creates one paragraph from differently styled spans.
    ///
    /// `style` supplies the paragraph's default metrics and fallback attributes. Individual spans
    /// may override font metrics, family, weight, style, and color.
    pub fn from_spans(
        spans: impl IntoIterator<Item = TextSpan>,
        origin: Point,
        bounds: Size,
        style: TextStyle,
    ) -> Self {
        let spans = spans.into_iter().collect::<Vec<_>>();
        let text = spans.iter().map(TextSpan::text).collect::<String>();
        Self {
            text,
            spans,
            origin,
            bounds,
            style,
            wrap: TextBlockWrap::WordOrGlyph,
            text_centered: false,
            clip_bounds: None,
        }
    }

    pub const fn with_wrap(mut self, wrap: TextBlockWrap) -> Self {
        self.wrap = wrap;
        self
    }

    pub const fn with_centered_text(mut self) -> Self {
        self.text_centered = true;
        self
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn spans(&self) -> &[TextSpan] {
        &self.spans
    }

    pub fn origin(&self) -> Point {
        self.origin
    }

    pub fn bounds(&self) -> Size {
        self.bounds
    }

    pub fn style(&self) -> &TextStyle {
        &self.style
    }

    pub const fn wrap(&self) -> TextBlockWrap {
        self.wrap
    }

    pub const fn is_text_centered(&self) -> bool {
        self.text_centered
    }

    /// Returns the resolved scene clip consumed by renderer backends.
    pub const fn clip_bounds(&self) -> Option<Rect> {
        self.clip_bounds
    }

    fn apply_clip(&mut self, clip_bounds: Rect) {
        self.clip_bounds = Some(match self.clip_bounds {
            Some(current) => current.intersection(clip_bounds),
            None => clip_bounds,
        });
    }
}

/// One immutable frame of native UI drawing input.
#[derive(Clone, Debug, PartialEq)]
pub struct UiScene {
    background: Color,
    rects: Vec<PaintRect>,
    rect_layers: Vec<usize>,
    icons: Vec<PaintIcon>,
    icon_layers: Vec<usize>,
    images: Vec<PaintImage>,
    image_layers: Vec<usize>,
    text_blocks: Vec<TextBlock>,
    text_layers: Vec<usize>,
    clips: Vec<ClipRect>,
    layer_primitives: Vec<Vec<ScenePrimitive>>,
    active_clip: Option<Rect>,
    active_rounded_clip_depth: u32,
    active_layer: usize,
    layer_count: usize,
    inspection: InspectionFrame,
    active_inspection_parent: Option<InspectionNodeId>,
    fragments: Vec<SceneFragment>,
}

impl UiScene {
    pub fn new(background: Color) -> Self {
        Self {
            background,
            rects: Vec::new(),
            rect_layers: Vec::new(),
            icons: Vec::new(),
            icon_layers: Vec::new(),
            images: Vec::new(),
            image_layers: Vec::new(),
            text_blocks: Vec::new(),
            text_layers: Vec::new(),
            clips: Vec::new(),
            layer_primitives: vec![Vec::new()],
            active_clip: None,
            active_rounded_clip_depth: 0,
            active_layer: 0,
            layer_count: 1,
            inspection: InspectionFrame::default(),
            active_inspection_parent: None,
            fragments: Vec::new(),
        }
    }

    /// Records a stable scene prefix that can later be restored with [`UiScene::restore`].
    ///
    /// Product hosts use checkpoints as retained presentation boundaries: append a volatile
    /// fragment, present it, then restore the prefix before rebuilding only that fragment. A
    /// checkpoint belongs to the scene that produced it and must not be applied to another scene.
    pub fn checkpoint(&self) -> SceneCheckpoint {
        SceneCheckpoint {
            rect_count: self.rects.len(),
            icon_count: self.icons.len(),
            image_count: self.images.len(),
            text_count: self.text_blocks.len(),
            clip_count: self.clips.len(),
            layer_primitive_counts: self.layer_primitives.iter().map(Vec::len).collect(),
            layer_count: self.layer_count,
            inspection_count: self.inspection.len(),
            active_clip: self.active_clip,
            active_rounded_clip_depth: self.active_rounded_clip_depth,
            active_layer: self.active_layer,
            active_inspection_parent: self.active_inspection_parent,
            fragment_count: self.fragments.len(),
        }
    }

    /// Discards all primitives, layers, and inspection nodes appended after `checkpoint`.
    pub fn restore(&mut self, checkpoint: &SceneCheckpoint) {
        assert!(
            checkpoint.rect_count <= self.rects.len()
                && checkpoint.icon_count <= self.icons.len()
                && checkpoint.image_count <= self.images.len()
                && checkpoint.text_count <= self.text_blocks.len()
                && checkpoint.clip_count <= self.clips.len()
                && checkpoint.layer_count <= self.layer_count
                && checkpoint.layer_primitive_counts.len() <= self.layer_primitives.len()
                && checkpoint.inspection_count <= self.inspection.len()
                && checkpoint.fragment_count <= self.fragments.len(),
            "Scene checkpoint must describe a prefix of its originating scene"
        );
        self.rects.truncate(checkpoint.rect_count);
        self.rect_layers.truncate(checkpoint.rect_count);
        self.icons.truncate(checkpoint.icon_count);
        self.icon_layers.truncate(checkpoint.icon_count);
        self.images.truncate(checkpoint.image_count);
        self.image_layers.truncate(checkpoint.image_count);
        self.text_blocks.truncate(checkpoint.text_count);
        self.text_layers.truncate(checkpoint.text_count);
        self.clips.truncate(checkpoint.clip_count);
        self.layer_primitives
            .truncate(checkpoint.layer_primitive_counts.len());
        for (primitives, &count) in self
            .layer_primitives
            .iter_mut()
            .zip(&checkpoint.layer_primitive_counts)
        {
            assert!(
                count <= primitives.len(),
                "Scene checkpoint layer must describe a primitive prefix"
            );
            primitives.truncate(count);
        }
        self.layer_count = checkpoint.layer_count;
        self.inspection.truncate(checkpoint.inspection_count);
        self.active_clip = checkpoint.active_clip;
        self.active_rounded_clip_depth = checkpoint.active_rounded_clip_depth;
        self.active_layer = checkpoint.active_layer;
        self.active_inspection_parent = checkpoint.active_inspection_parent;
        self.fragments.truncate(checkpoint.fragment_count);
    }

    pub fn draw_rect(&mut self, mut rect: PaintRect) {
        if let Some(clip_bounds) = self.active_clip {
            if clip_bounds.is_empty()
                || (rect.shadow().is_none() && rect.bounds().intersection(clip_bounds).is_empty())
            {
                return;
            }
            rect.apply_clip(clip_bounds);
        }
        let index = self.rects.len();
        self.rects.push(rect);
        self.rect_layers.push(self.active_layer);
        self.layer_primitives[self.active_layer]
            .push(ScenePrimitive::rect(index, self.active_rounded_clip_depth));
    }

    pub fn draw_icon(&mut self, mut icon: PaintIcon) {
        if let Some(clip_bounds) = self.active_clip {
            if icon.bounds().intersection(clip_bounds).is_empty() {
                return;
            }
            icon.apply_clip(clip_bounds);
        }
        let index = self.icons.len();
        self.icons.push(icon);
        self.icon_layers.push(self.active_layer);
        self.layer_primitives[self.active_layer]
            .push(ScenePrimitive::icon(index, self.active_rounded_clip_depth));
    }

    pub fn draw_image(&mut self, mut image: PaintImage) {
        if let Some(clip_bounds) = self.active_clip {
            if image.bounds().intersection(clip_bounds).is_empty() {
                return;
            }
            image.apply_clip(clip_bounds);
        }
        let index = self.images.len();
        self.images.push(image);
        self.image_layers.push(self.active_layer);
        self.layer_primitives[self.active_layer]
            .push(ScenePrimitive::image(index, self.active_rounded_clip_depth));
    }

    pub fn draw_text(&mut self, mut block: TextBlock) {
        if let Some(clip_bounds) = self.active_clip {
            let bounds = Rect::new(block.origin(), block.bounds());
            if bounds.intersection(clip_bounds).is_empty() {
                return;
            }
            block.apply_clip(clip_bounds);
        }
        let index = self.text_blocks.len();
        self.text_blocks.push(block);
        self.text_layers.push(self.active_layer);
        self.layer_primitives[self.active_layer]
            .push(ScenePrimitive::text(index, self.active_rounded_clip_depth));
    }

    /// Resolves a declarative element once and shares it with inspection and custom composition.
    ///
    /// Components with content closures should use this entry point instead of manually creating
    /// an [`InspectionNode`]. The closure receives the same immutable computed geometry registered
    /// in the current inspection hierarchy.
    #[track_caller]
    pub fn with_element<R>(
        &mut self,
        element: ComponentElement,
        draw: impl FnOnce(&mut Self, &ComputedElement) -> R,
    ) -> R {
        if element.is_overlay() {
            return self.with_overlay(|scene| scene.with_current_layer_element(element, draw));
        }
        self.with_current_layer_element(element, draw)
    }

    #[track_caller]
    fn with_inspection_node<R>(
        &mut self,
        node: InspectionNode,
        draw: impl FnOnce(&mut Self) -> R,
    ) -> R {
        let location = std::panic::Location::caller();
        let id = self.inspection.register(
            node,
            self.active_inspection_parent,
            self.active_layer,
            location.file(),
            location.line(),
        );
        let previous_parent = self.active_inspection_parent;
        self.active_inspection_parent = Some(id);
        let result = draw(self);
        self.active_inspection_parent = previous_parent;
        result
    }

    pub fn with_clip<R>(&mut self, clip_bounds: Rect, draw: impl FnOnce(&mut Self) -> R) -> R {
        let previous_clip = self.active_clip;
        self.active_clip = Some(match previous_clip {
            Some(current) => current.intersection(clip_bounds),
            None => clip_bounds,
        });
        let result = draw(self);
        self.active_clip = previous_clip;
        result
    }

    /// Draws into a new layer composited above every previously created scene layer.
    ///
    /// The new layer does not inherit the caller's active clip, allowing anchored views to escape
    /// their host component. Nested overlays receive their own later layer. After the closure
    /// returns, drawing resumes with the caller's layer and clip.
    pub fn with_overlay<R>(&mut self, draw: impl FnOnce(&mut Self) -> R) -> R {
        let previous_layer = self.active_layer;
        let previous_clip = self.active_clip;
        let previous_rounded_clip_depth = self.active_rounded_clip_depth;
        self.active_layer = self.layer_count;
        self.active_clip = None;
        self.active_rounded_clip_depth = 0;
        self.layer_count += 1;
        self.layer_primitives.push(Vec::new());
        let result = draw(self);
        self.active_layer = previous_layer;
        self.active_clip = previous_clip;
        self.active_rounded_clip_depth = previous_rounded_clip_depth;
        result
    }

    pub fn background(&self) -> Color {
        self.background
    }

    pub fn rects(&self) -> &[PaintRect] {
        &self.rects
    }

    pub fn icons(&self) -> &[PaintIcon] {
        &self.icons
    }

    pub fn images(&self) -> &[PaintImage] {
        &self.images
    }

    pub fn text_blocks(&self) -> &[TextBlock] {
        &self.text_blocks
    }

    pub fn clips(&self) -> &[ClipRect] {
        &self.clips
    }

    pub const fn inspection(&self) -> &InspectionFrame {
        &self.inspection
    }

    /// Returns the number of ordered composition layers in this frame.
    pub const fn layer_count(&self) -> usize {
        self.layer_count
    }

    /// Iterates consecutive primitive batches in exact back-to-front paint order.
    ///
    /// The iterator visits lower composition layers first and preserves insertion order inside
    /// each layer. It does not allocate and lets a renderer switch pipelines only at real batch
    /// boundaries instead of repeatedly scanning every primitive for every layer.
    pub fn batches(&self) -> impl Iterator<Item = SceneBatch> + '_ {
        batches(&self.layer_primitives)
    }

    /// Returns the composition layer parallel to each rectangle primitive.
    pub fn rect_layers(&self) -> &[usize] {
        &self.rect_layers
    }

    /// Returns the composition layer parallel to each icon primitive.
    pub fn icon_layers(&self) -> &[usize] {
        &self.icon_layers
    }

    /// Returns the composition layer parallel to each image primitive.
    pub fn image_layers(&self) -> &[usize] {
        &self.image_layers
    }

    /// Returns the composition layer parallel to each text primitive.
    pub fn text_layers(&self) -> &[usize] {
        &self.text_layers
    }
}

#[cfg(test)]
#[path = "scene_tests.rs"]
mod tests;
