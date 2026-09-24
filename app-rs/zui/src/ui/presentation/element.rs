use std::panic::Location;

use super::paint::{Border, BoxShadow};
use crate::ui::foundation::Edges;
use crate::ui::foundation::ElementId;
use crate::ui::foundation::Rect;
use crate::ui::foundation::Size;
use crate::ui::foundation::{Color, CornerRadii};

mod layout;
mod style;
mod validation;

use layout::compute_element;
pub use style::AlignItems;
pub use style::ElementDirection;
pub use style::ElementLength;
pub use style::ElementOverflow;
pub use style::ElementStyle;
pub use style::JustifyContent;
pub use validation::ElementStyleError;
pub use validation::ElementStyleErrorKind;
pub use validation::ElementStyleProperty;
use validation::validate_element;

/// Declarative UI node consumed by zui layout before paint and inspection.
///
/// Components describe box metrics and child flow with this type. The framework resolves the
/// tree into [`ComputedElement`] geometry; components should use that result for paint and hit
/// testing instead of separately interpreting the authored style.
#[derive(Clone, Debug, PartialEq)]
pub struct Element {
    name: &'static str,
    style: ElementStyle,
    children: Vec<Element>,
    content_size: Option<Size>,
    source_file: &'static str,
    source_line: u32,
}

impl Element {
    #[track_caller]
    pub fn leaf(name: &'static str) -> Self {
        Self::styled(name, ElementStyle::leaf())
    }

    #[track_caller]
    pub fn row(name: &'static str) -> Self {
        Self::styled(name, ElementStyle::row())
    }

    #[track_caller]
    pub fn column(name: &'static str) -> Self {
        Self::styled(name, ElementStyle::column())
    }

    #[track_caller]
    pub fn leaf_with_style(name: &'static str, style: ElementStyle) -> Self {
        Self::styled_with_direction(name, ElementDirection::Horizontal, style)
    }

    #[track_caller]
    pub fn row_with_style(name: &'static str, style: ElementStyle) -> Self {
        Self::styled_with_direction(name, ElementDirection::Horizontal, style)
    }

    #[track_caller]
    pub fn column_with_style(name: &'static str, style: ElementStyle) -> Self {
        Self::styled_with_direction(name, ElementDirection::Vertical, style)
    }

    #[track_caller]
    fn styled_with_direction(
        name: &'static str,
        expected: ElementDirection,
        style: ElementStyle,
    ) -> Self {
        assert_eq!(
            style.direction(),
            expected,
            "{name} style direction must match its declared element direction"
        );
        Self::styled(name, style)
    }

    /// Creates a node from a reusable typed style declared by the caller.
    #[track_caller]
    pub fn styled(name: &'static str, style: ElementStyle) -> Self {
        let location = Location::caller();
        Self {
            name,
            style,
            children: Vec::new(),
            content_size: None,
            source_file: location.file(),
            source_line: location.line(),
        }
    }

    pub const fn width(mut self, width: ElementLength) -> Self {
        self.style = self.style.with_width(width);
        self
    }

    pub const fn height(mut self, height: ElementLength) -> Self {
        self.style = self.style.with_height(height);
        self
    }

    pub const fn justify_content(mut self, justify_content: JustifyContent) -> Self {
        self.style = self.style.with_justify_content(justify_content);
        self
    }

    pub const fn align_items(mut self, align_items: AlignItems) -> Self {
        self.style = self.style.with_align_items(align_items);
        self
    }

    /// Declares the natural size of content that is not represented by child elements.
    pub fn content_size(mut self, size: Size) -> Self {
        self.content_size = Some(size);
        self
    }

    pub const fn padding(mut self, padding: Edges) -> Self {
        self.style = self.style.with_padding(padding);
        self
    }

    pub const fn gap(mut self, gap: f32) -> Self {
        self.style = self.style.with_gap(gap);
        self
    }

    pub const fn corner_radii(mut self, corner_radii: CornerRadii) -> Self {
        self.style = self.style.with_corner_radii(corner_radii);
        self
    }

    pub const fn background(mut self, background: Color) -> Self {
        self.style = self.style.with_background(background);
        self
    }

    pub const fn border(mut self, border: Border) -> Self {
        self.style = self.style.with_border(border);
        self
    }

    pub const fn shadow(mut self, shadow: BoxShadow) -> Self {
        self.style = self.style.with_shadow(shadow);
        self
    }

    pub const fn overflow(mut self, overflow: ElementOverflow) -> Self {
        self.style = self.style.with_overflow(overflow);
        self
    }

    pub fn child(mut self, child: Element) -> Self {
        self.children.push(child);
        self
    }

    pub fn children(mut self, children: impl IntoIterator<Item = Element>) -> Self {
        self.children.extend(children);
        self
    }

    pub fn in_bounds(self, bounds: Rect) -> ComponentElement {
        ComponentElement {
            root: self,
            bounds,
            overlay: false,
            identity: None,
            inspection_label: None,
        }
    }

    pub fn in_overlay(self, bounds: Rect) -> ComponentElement {
        ComponentElement {
            root: self,
            bounds,
            overlay: true,
            identity: None,
            inspection_label: None,
        }
    }
}

/// Root element and the host-provided bounds in which it must be resolved.
#[derive(Clone, Debug, PartialEq)]
pub struct ComponentElement {
    root: Element,
    bounds: Rect,
    overlay: bool,
    identity: Option<ElementId>,
    inspection_label: Option<String>,
}

impl ComponentElement {
    /// Associates this component root with the stable identity used by interaction and retained
    /// presentation state.
    pub const fn with_identity(mut self, identity: ElementId) -> Self {
        self.identity = Some(identity);
        self
    }

    /// Adds semantic content shown by layout inspection tools for this component root.
    pub fn with_inspection_label(mut self, label: impl Into<String>) -> Self {
        self.inspection_label = Some(label.into());
        self
    }

    pub fn compute(&self) -> ComputedElement {
        self.try_compute()
            .unwrap_or_else(|error| panic!("invalid element style: {error}"))
    }

    /// Validates the full authored tree before resolving any layout geometry.
    pub fn try_compute(&self) -> Result<ComputedElement, ElementStyleError> {
        validate_element(&self.root, self.bounds)?;
        let mut computed = compute_element(&self.root, self.bounds);
        computed.identity = self.identity;
        computed.inspection_label = self.inspection_label.clone();
        Ok(computed)
    }

    pub(crate) const fn is_overlay(&self) -> bool {
        self.overlay
    }
}

/// Resolved box geometry shared by component paint, hit testing, and inspection.
#[derive(Clone, Debug, PartialEq)]
pub struct ComputedElement {
    name: &'static str,
    bounds: Rect,
    style: ElementStyle,
    resolved_padding: Edges,
    gap_regions: Vec<Rect>,
    children: Vec<ComputedElement>,
    identity: Option<ElementId>,
    inspection_label: Option<String>,
    source_file: &'static str,
    source_line: u32,
}

impl ComputedElement {
    pub const fn name(&self) -> &'static str {
        self.name
    }

    pub const fn bounds(&self) -> Rect {
        self.bounds
    }

    pub const fn style(&self) -> ElementStyle {
        self.style
    }

    /// Returns the padding after it has been clamped to the resolved bounds.
    pub const fn resolved_padding(&self) -> Edges {
        self.resolved_padding
    }

    pub fn gap_regions(&self) -> &[Rect] {
        &self.gap_regions
    }

    pub fn children(&self) -> &[ComputedElement] {
        &self.children
    }

    pub fn child(&self, index: usize) -> Option<&ComputedElement> {
        self.children.get(index)
    }

    /// Returns the stable identity shared with interaction and retained presentation state.
    pub const fn identity(&self) -> Option<ElementId> {
        self.identity
    }

    pub(crate) fn inspection_label(&self) -> Option<&str> {
        self.inspection_label.as_deref()
    }

    pub(crate) const fn source_file(&self) -> &'static str {
        self.source_file
    }

    pub(crate) const fn source_line(&self) -> u32 {
        self.source_line
    }
}

#[cfg(test)]
#[path = "element_tests.rs"]
mod tests;
