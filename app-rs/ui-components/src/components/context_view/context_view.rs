use crate::{
    BoxShadow, Color, Component, ComponentContext, ComponentElement, ComputedElement, CornerRadii,
    Edges, Element, Point, Rect, Size, UiScene,
};

/// Axis on which a [`ContextView`] is placed beside its anchor.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum ContextViewAnchorAxis {
    /// Places the view below or above the anchor and aligns horizontal edges.
    #[default]
    Vertical,
    /// Places the view right or left of the anchor and aligns vertical edges.
    Horizontal,
}

/// Requested side of an anchor along the selected [`ContextViewAnchorAxis`].
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum ContextViewAnchorPosition {
    /// Prefers below on the vertical axis or right on the horizontal axis.
    #[default]
    After,
    /// Prefers above on the vertical axis or left on the horizontal axis.
    Before,
}

/// Requested cross-axis edge shared by a context view and its anchor.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum ContextViewAnchorAlignment {
    /// Aligns left edges on the vertical axis or top edges on the horizontal axis.
    #[default]
    Start,
    /// Aligns right edges on the vertical axis or bottom edges on the horizontal axis.
    End,
}

/// Anchor placement preferences for a [`ContextView`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContextViewPlacement {
    axis: ContextViewAnchorAxis,
    position: ContextViewAnchorPosition,
    alignment: ContextViewAnchorAlignment,
    gap: f32,
    viewport_margin: f32,
}

impl ContextViewPlacement {
    pub const fn new() -> Self {
        Self {
            axis: ContextViewAnchorAxis::Vertical,
            position: ContextViewAnchorPosition::After,
            alignment: ContextViewAnchorAlignment::Start,
            gap: 0.0,
            viewport_margin: 4.0,
        }
    }

    pub const fn with_axis(mut self, axis: ContextViewAnchorAxis) -> Self {
        self.axis = axis;
        self
    }

    pub const fn with_position(mut self, position: ContextViewAnchorPosition) -> Self {
        self.position = position;
        self
    }

    pub const fn with_alignment(mut self, alignment: ContextViewAnchorAlignment) -> Self {
        self.alignment = alignment;
        self
    }

    pub const fn with_gap(mut self, gap: f32) -> Self {
        self.gap = gap;
        self
    }

    pub const fn with_viewport_margin(mut self, viewport_margin: f32) -> Self {
        self.viewport_margin = viewport_margin;
        self
    }
}

impl Default for ContextViewPlacement {
    fn default() -> Self {
        Self::new()
    }
}

/// Shared floating-surface chrome and content insets for a [`ContextView`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContextViewStyle {
    background: Color,
    corner_radii: CornerRadii,
    padding: Edges,
    shadow: Option<BoxShadow>,
}

impl ContextViewStyle {
    pub const fn new(background: Color) -> Self {
        Self {
            background,
            corner_radii: CornerRadii::uniform(0.0),
            padding: Edges::uniform(0.0),
            shadow: None,
        }
    }

    pub const fn with_corner_radii(mut self, corner_radii: CornerRadii) -> Self {
        self.corner_radii = corner_radii;
        self
    }

    pub const fn with_padding(mut self, padding: Edges) -> Self {
        self.padding = padding;
        self
    }

    pub const fn with_shadow(mut self, shadow: BoxShadow) -> Self {
        self.shadow = Some(shadow);
        self
    }
}

/// Resolved geometry and actual anchor orientation for a [`ContextView`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContextViewLayout {
    bounds: Rect,
    content_bounds: Rect,
    anchor_position: ContextViewAnchorPosition,
    anchor_alignment: ContextViewAnchorAlignment,
}

impl ContextViewLayout {
    pub const fn bounds(self) -> Rect {
        self.bounds
    }

    pub const fn content_bounds(self) -> Rect {
        self.content_bounds
    }

    pub const fn anchor_position(self) -> ContextViewAnchorPosition {
        self.anchor_position
    }

    pub const fn anchor_alignment(self) -> ContextViewAnchorAlignment {
        self.anchor_alignment
    }
}

/// An anchored floating surface that hosts arbitrary scene content in its own overlay layer.
///
/// The context view owns placement, viewport flipping and clamping, shell paint, and content
/// clipping. The product host owns visibility, input routing, dismissal, focus restoration, and
/// the interaction semantics of the hosted hover view, picker, or menu.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContextView {
    layout: ContextViewLayout,
    style: ContextViewStyle,
}

impl ContextView {
    pub fn new(
        viewport: Rect,
        anchor: Rect,
        desired_content_size: Size,
        placement: ContextViewPlacement,
        style: ContextViewStyle,
    ) -> Self {
        let available_viewport = inset_viewport(viewport, placement.viewport_margin.max(0.0));
        let horizontal_insets =
            non_negative(style.padding.left) + non_negative(style.padding.right);
        let vertical_insets = non_negative(style.padding.top) + non_negative(style.padding.bottom);
        let view_size = Size::new(
            (non_negative(desired_content_size.width) + horizontal_insets)
                .min(non_negative(available_viewport.size.width)),
            (non_negative(desired_content_size.height) + vertical_insets)
                .min(non_negative(available_viewport.size.height)),
        );
        let resolved = place_view(available_viewport, view_size, anchor, placement);
        let bounds = Rect::new(resolved.origin, view_size);
        let content_bounds = inset_rect(
            bounds,
            Edges::new(
                non_negative(style.padding.top),
                non_negative(style.padding.right),
                non_negative(style.padding.bottom),
                non_negative(style.padding.left),
            ),
        );
        Self {
            layout: ContextViewLayout {
                bounds,
                content_bounds,
                anchor_position: resolved.position,
                anchor_alignment: resolved.alignment,
            },
            style,
        }
    }

    pub const fn layout(&self) -> ContextViewLayout {
        self.layout
    }

    pub const fn bounds(&self) -> Rect {
        self.layout.bounds
    }

    pub const fn content_bounds(&self) -> Rect {
        self.layout.content_bounds
    }

    /// Paints the shell and hosted content together in a new topmost scene layer.
    pub fn draw<R>(
        &self,
        scene: &mut UiScene,
        draw_content: impl FnOnce(&mut UiScene, Rect) -> R,
    ) -> R {
        scene.with_element(self.overlay_element(), |scene, _element| {
            scene.with_clip(self.content_bounds(), |scene| {
                draw_content(scene, self.content_bounds())
            })
        })
    }

    /// Composes hosted content through the shared inspection and interaction context.
    pub fn draw_components<R>(
        &self,
        context: &mut ComponentContext<'_, '_>,
        draw_content: impl FnOnce(&mut ComponentContext<'_, '_>, Rect) -> R,
    ) -> R {
        context.with_element(self.overlay_element(), |context, _element| {
            context.with_clip(self.content_bounds(), |context| {
                draw_content(context, self.content_bounds())
            })
        })
    }

    /// Composes hosted content through the shared context without clipping overflow effects.
    pub fn draw_components_overflow<R>(
        &self,
        context: &mut ComponentContext<'_, '_>,
        draw_content: impl FnOnce(&mut ComponentContext<'_, '_>, Rect) -> R,
    ) -> R {
        context.with_element(self.overlay_element(), |context, _element| {
            draw_content(context, self.content_bounds())
        })
    }

    /// Paints the shell and hosted content in a new topmost layer without clipping content.
    ///
    /// This is intended for component-owned visual effects such as shadows that extend beyond the
    /// resolved content bounds. Hit testing and semantic bounds should still use the resolved
    /// layout rather than the overflow paint.
    pub fn draw_overflow<R>(
        &self,
        scene: &mut UiScene,
        draw_content: impl FnOnce(&mut UiScene, Rect) -> R,
    ) -> R {
        scene.with_element(self.overlay_element(), |scene, _element| {
            draw_content(scene, self.content_bounds())
        })
    }

    fn element_definition(&self) -> Element {
        let element = zui::ui! {
            leaf("ContextView") {
                style {
                    padding: self.style.padding;
                    background: self.style.background;
                    radii: self.style.corner_radii;
                }
            }
        };
        match self.style.shadow {
            Some(shadow) => element.shadow(shadow),
            None => element,
        }
    }

    fn overlay_element(&self) -> ComponentElement {
        self.element_definition().in_overlay(self.bounds())
    }
}

impl Component for ContextView {
    fn element(&self) -> ComponentElement {
        self.overlay_element()
    }

    fn paint_element(&self, _scene: &mut UiScene, _element: &ComputedElement) {}

    fn paint(&self, scene: &mut UiScene) {
        scene.with_element(self.overlay_element(), |_scene, _element| {});
    }
}

#[derive(Clone, Copy)]
struct ResolvedPlacement {
    origin: Point,
    position: ContextViewAnchorPosition,
    alignment: ContextViewAnchorAlignment,
}

fn place_view(
    viewport: Rect,
    view: Size,
    anchor: Rect,
    placement: ContextViewPlacement,
) -> ResolvedPlacement {
    let gap = placement.gap.max(0.0);
    let (primary, cross) = match placement.axis {
        ContextViewAnchorAxis::Vertical => (
            place_beside(
                viewport.origin.y,
                viewport.size.height,
                view.height,
                anchor.origin.y,
                anchor.size.height,
                placement.position,
                gap,
            ),
            align_with_anchor(
                viewport.origin.x,
                viewport.size.width,
                view.width,
                anchor.origin.x,
                anchor.size.width,
                placement.alignment,
            ),
        ),
        ContextViewAnchorAxis::Horizontal => (
            place_beside(
                viewport.origin.x,
                viewport.size.width,
                view.width,
                anchor.origin.x,
                anchor.size.width,
                placement.position,
                gap,
            ),
            align_with_anchor(
                viewport.origin.y,
                viewport.size.height,
                view.height,
                anchor.origin.y,
                anchor.size.height,
                placement.alignment,
            ),
        ),
    };
    let origin = match placement.axis {
        ContextViewAnchorAxis::Vertical => Point::new(cross.offset, primary.offset),
        ContextViewAnchorAxis::Horizontal => Point::new(primary.offset, cross.offset),
    };
    ResolvedPlacement {
        origin,
        position: primary.position,
        alignment: cross.alignment,
    }
}

#[derive(Clone, Copy)]
struct PrimaryPlacement {
    offset: f32,
    position: ContextViewAnchorPosition,
}

fn place_beside(
    viewport_start: f32,
    viewport_size: f32,
    view_size: f32,
    anchor_start: f32,
    anchor_size: f32,
    requested: ContextViewAnchorPosition,
    gap: f32,
) -> PrimaryPlacement {
    let viewport_end = viewport_start + viewport_size;
    let after = anchor_start + anchor_size + gap;
    let before = anchor_start - gap - view_size;
    let fits_after = after + view_size <= viewport_end;
    let fits_before = before >= viewport_start;
    match requested {
        ContextViewAnchorPosition::After if fits_after => PrimaryPlacement {
            offset: after,
            position: ContextViewAnchorPosition::After,
        },
        ContextViewAnchorPosition::After if fits_before => PrimaryPlacement {
            offset: before,
            position: ContextViewAnchorPosition::Before,
        },
        ContextViewAnchorPosition::Before if fits_before => PrimaryPlacement {
            offset: before,
            position: ContextViewAnchorPosition::Before,
        },
        ContextViewAnchorPosition::Before if fits_after => PrimaryPlacement {
            offset: after,
            position: ContextViewAnchorPosition::After,
        },
        _ => {
            let space_after = (viewport_end - after).max(0.0);
            let space_before = (anchor_start - gap - viewport_start).max(0.0);
            let position = if space_after >= space_before {
                ContextViewAnchorPosition::After
            } else {
                ContextViewAnchorPosition::Before
            };
            let desired = match position {
                ContextViewAnchorPosition::After => after,
                ContextViewAnchorPosition::Before => before,
            };
            PrimaryPlacement {
                offset: clamp_to_viewport(desired, view_size, viewport_start, viewport_end),
                position,
            }
        }
    }
}

#[derive(Clone, Copy)]
struct CrossPlacement {
    offset: f32,
    alignment: ContextViewAnchorAlignment,
}

fn align_with_anchor(
    viewport_start: f32,
    viewport_size: f32,
    view_size: f32,
    anchor_start: f32,
    anchor_size: f32,
    requested: ContextViewAnchorAlignment,
) -> CrossPlacement {
    let viewport_end = viewport_start + viewport_size;
    let start_aligned = anchor_start;
    let end_aligned = anchor_start + anchor_size - view_size;
    let start_fits = start_aligned >= viewport_start && start_aligned + view_size <= viewport_end;
    let end_fits = end_aligned >= viewport_start && end_aligned + view_size <= viewport_end;
    match requested {
        ContextViewAnchorAlignment::Start if start_fits => CrossPlacement {
            offset: start_aligned,
            alignment: ContextViewAnchorAlignment::Start,
        },
        ContextViewAnchorAlignment::Start if end_fits => CrossPlacement {
            offset: end_aligned,
            alignment: ContextViewAnchorAlignment::End,
        },
        ContextViewAnchorAlignment::End if end_fits => CrossPlacement {
            offset: end_aligned,
            alignment: ContextViewAnchorAlignment::End,
        },
        ContextViewAnchorAlignment::End if start_fits => CrossPlacement {
            offset: start_aligned,
            alignment: ContextViewAnchorAlignment::Start,
        },
        _ => {
            let desired = match requested {
                ContextViewAnchorAlignment::Start => start_aligned,
                ContextViewAnchorAlignment::End => end_aligned,
            };
            CrossPlacement {
                offset: clamp_to_viewport(desired, view_size, viewport_start, viewport_end),
                alignment: requested,
            }
        }
    }
}

fn clamp_to_viewport(offset: f32, size: f32, viewport_start: f32, viewport_end: f32) -> f32 {
    offset
        .max(viewport_start)
        .min((viewport_end - size).max(viewport_start))
}

fn inset_viewport(viewport: Rect, margin: f32) -> Rect {
    let horizontal_margin = margin.min(non_negative(viewport.size.width) * 0.5);
    let vertical_margin = margin.min(non_negative(viewport.size.height) * 0.5);
    Rect::from_xywh(
        viewport.origin.x + horizontal_margin,
        viewport.origin.y + vertical_margin,
        (viewport.size.width - horizontal_margin * 2.0).max(0.0),
        (viewport.size.height - vertical_margin * 2.0).max(0.0),
    )
}

fn inset_rect(rect: Rect, insets: Edges) -> Rect {
    Rect::from_xywh(
        rect.origin.x + insets.left,
        rect.origin.y + insets.top,
        (rect.size.width - insets.left - insets.right).max(0.0),
        (rect.size.height - insets.top - insets.bottom).max(0.0),
    )
}

fn non_negative(value: f32) -> f32 {
    value.max(0.0)
}

#[cfg(test)]
#[path = "context_view_tests.rs"]
mod tests;
