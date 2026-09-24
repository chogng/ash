use std::ops::Range;

use super::ClipRect;
use super::UiScene;
use crate::ui::foundation::CornerRadii;
use crate::ui::foundation::Rect;

/// One consecutive batch of same-kind primitives in resolved scene paint order.
///
/// Backends should consume batches in iterator order. Ranges index the corresponding primitive
/// slice on [`super::UiScene`]; adjacent calls of the same kind are coalesced, while a change of
/// kind or composition layer starts a new batch so visual stacking remains exact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SceneBatch {
    ClipStart {
        layer: usize,
        index: usize,
        depth: u32,
    },
    ClipEnd {
        layer: usize,
        index: usize,
        depth: u32,
    },
    Rects {
        layer: usize,
        range: Range<usize>,
        clip_depth: u32,
    },
    Icons {
        layer: usize,
        range: Range<usize>,
        clip_depth: u32,
    },
    Images {
        layer: usize,
        range: Range<usize>,
        clip_depth: u32,
    },
    Text {
        layer: usize,
        range: Range<usize>,
        clip_depth: u32,
    },
}

impl SceneBatch {
    /// Returns the ordered composition layer containing this batch.
    pub const fn layer(&self) -> usize {
        match self {
            Self::ClipStart { layer, .. }
            | Self::ClipEnd { layer, .. }
            | Self::Rects { layer, .. }
            | Self::Icons { layer, .. }
            | Self::Images { layer, .. }
            | Self::Text { layer, .. } => *layer,
        }
    }

    /// Returns the primitive range in the batch's corresponding scene slice.
    pub fn range(&self) -> Range<usize> {
        match self {
            Self::ClipStart { index, .. } | Self::ClipEnd { index, .. } => *index..*index + 1,
            Self::Rects { range, .. }
            | Self::Icons { range, .. }
            | Self::Images { range, .. }
            | Self::Text { range, .. } => range.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ScenePrimitive {
    kind: ScenePrimitiveKind,
    index: usize,
    clip_depth: u32,
}

impl ScenePrimitive {
    pub(super) const fn rect(index: usize, clip_depth: u32) -> Self {
        Self::new(ScenePrimitiveKind::Rect, index, clip_depth)
    }

    pub(super) const fn icon(index: usize, clip_depth: u32) -> Self {
        Self::new(ScenePrimitiveKind::Icon, index, clip_depth)
    }

    pub(super) const fn image(index: usize, clip_depth: u32) -> Self {
        Self::new(ScenePrimitiveKind::Image, index, clip_depth)
    }

    pub(super) const fn text(index: usize, clip_depth: u32) -> Self {
        Self::new(ScenePrimitiveKind::Text, index, clip_depth)
    }

    pub(super) const fn clip_start(index: usize, depth: u32) -> Self {
        Self::new(ScenePrimitiveKind::ClipStart, index, depth)
    }

    pub(super) const fn clip_end(index: usize, depth: u32) -> Self {
        Self::new(ScenePrimitiveKind::ClipEnd, index, depth)
    }

    const fn new(kind: ScenePrimitiveKind, index: usize, clip_depth: u32) -> Self {
        Self {
            kind,
            index,
            clip_depth,
        }
    }

    const fn kind(self) -> ScenePrimitiveKind {
        self.kind
    }

    const fn index(self) -> usize {
        self.index
    }

    const fn clip_depth(self) -> u32 {
        self.clip_depth
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ScenePrimitiveKind {
    ClipStart,
    ClipEnd,
    Rect,
    Icon,
    Image,
    Text,
}

pub(super) fn batches(
    layer_primitives: &[Vec<ScenePrimitive>],
) -> impl Iterator<Item = SceneBatch> + '_ {
    let mut layer = 0;
    let mut offset = 0;
    std::iter::from_fn(move || {
        loop {
            let operations = layer_primitives.get(layer)?;
            let Some(first) = operations.get(offset).copied() else {
                layer += 1;
                offset = 0;
                continue;
            };
            let kind = first.kind();
            let start = first.index();
            let clip_depth = first.clip_depth();
            if matches!(
                kind,
                ScenePrimitiveKind::ClipStart | ScenePrimitiveKind::ClipEnd
            ) {
                offset += 1;
                return Some(match kind {
                    ScenePrimitiveKind::ClipStart => SceneBatch::ClipStart {
                        layer,
                        index: start,
                        depth: clip_depth,
                    },
                    ScenePrimitiveKind::ClipEnd => SceneBatch::ClipEnd {
                        layer,
                        index: start,
                        depth: clip_depth,
                    },
                    _ => unreachable!(),
                });
            }
            let mut previous_index = start;
            offset += 1;
            while operations.get(offset).is_some_and(|operation| {
                operation.kind() == kind
                    && operation.clip_depth() == clip_depth
                    && operation.index() == previous_index + 1
            }) {
                previous_index += 1;
                offset += 1;
            }
            let range = start..previous_index + 1;
            return Some(match kind {
                ScenePrimitiveKind::Rect => SceneBatch::Rects {
                    layer,
                    range,
                    clip_depth,
                },
                ScenePrimitiveKind::Icon => SceneBatch::Icons {
                    layer,
                    range,
                    clip_depth,
                },
                ScenePrimitiveKind::Image => SceneBatch::Images {
                    layer,
                    range,
                    clip_depth,
                },
                ScenePrimitiveKind::Text => SceneBatch::Text {
                    layer,
                    range,
                    clip_depth,
                },
                ScenePrimitiveKind::ClipStart | ScenePrimitiveKind::ClipEnd => unreachable!(),
            });
        }
    })
}

impl UiScene {
    /// Clips all composed paint to one rounded rectangle until the closure returns.
    ///
    /// Rounded clips may nest. A rectangular clip active at this boundary also constrains the
    /// clip mask, while overlays retain their existing behavior of escaping ancestor clips.
    pub fn with_rounded_clip<R>(
        &mut self,
        bounds: Rect,
        corner_radii: CornerRadii,
        draw: impl FnOnce(&mut Self) -> R,
    ) -> R {
        let mut clip = ClipRect::new(bounds, corner_radii);
        if let Some(active_clip) = self.active_clip {
            clip.apply_clip(active_clip);
        }
        let index = self.clips.len();
        self.clips.push(clip);
        let outer_depth = self.active_rounded_clip_depth;
        assert!(
            outer_depth < u8::MAX.into(),
            "rounded clip nesting exceeds the stencil capacity"
        );
        self.layer_primitives[self.active_layer]
            .push(ScenePrimitive::clip_start(index, outer_depth));
        self.active_rounded_clip_depth += 1;
        let result = draw(self);
        self.layer_primitives[self.active_layer].push(ScenePrimitive::clip_end(
            index,
            self.active_rounded_clip_depth,
        ));
        self.active_rounded_clip_depth = outer_depth;
        result
    }
}
