use std::fmt;

use super::Element;
use super::ElementLength;
use crate::ui::foundation::Edges;
use crate::ui::foundation::Rect;

/// Style field whose authored value failed validation before layout.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ElementStyleProperty {
    Bounds,
    Width,
    Height,
    ContentSize,
    Padding,
    Gap,
    CornerRadii,
    Border,
    Shadow,
}

impl ElementStyleProperty {
    const fn name(self) -> &'static str {
        match self {
            Self::Bounds => "bounds",
            Self::Width => "width",
            Self::Height => "height",
            Self::ContentSize => "content_size",
            Self::Padding => "padding",
            Self::Gap => "gap",
            Self::CornerRadii => "corner_radii",
            Self::Border => "border",
            Self::Shadow => "shadow",
        }
    }
}

/// Reason an authored style value cannot enter layout or paint.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ElementStyleErrorKind {
    NonFinite,
    Negative,
}

impl ElementStyleErrorKind {
    const fn description(self) -> &'static str {
        match self {
            Self::NonFinite => "must contain only finite logical-pixel values",
            Self::Negative => "must contain only non-negative logical-pixel values",
        }
    }
}

/// Invalid authored node style detected before any scene output is written.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ElementStyleError {
    path: Vec<&'static str>,
    property: ElementStyleProperty,
    kind: ElementStyleErrorKind,
    source_file: &'static str,
    source_line: u32,
}

impl ElementStyleError {
    pub fn path(&self) -> &[&'static str] {
        &self.path
    }

    pub const fn property(&self) -> ElementStyleProperty {
        self.property
    }

    pub const fn kind(&self) -> ElementStyleErrorKind {
        self.kind
    }

    pub const fn source_file(&self) -> &'static str {
        self.source_file
    }

    pub const fn source_line(&self) -> u32 {
        self.source_line
    }
}

impl fmt::Display for ElementStyleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}.{} {} (authored at {}:{})",
            self.path.join("/"),
            self.property.name(),
            self.kind.description(),
            self.source_file,
            self.source_line,
        )
    }
}

impl std::error::Error for ElementStyleError {}

pub(super) fn validate_element(root: &Element, bounds: Rect) -> Result<(), ElementStyleError> {
    let mut path = vec![root.name];
    if !rect_is_finite(bounds) {
        return Err(error(
            &path,
            root,
            ElementStyleProperty::Bounds,
            ElementStyleErrorKind::NonFinite,
        ));
    }
    if bounds.size.width < 0.0 || bounds.size.height < 0.0 {
        return Err(error(
            &path,
            root,
            ElementStyleProperty::Bounds,
            ElementStyleErrorKind::Negative,
        ));
    }
    validate_node(root, &mut path)
}

fn validate_node(element: &Element, path: &mut Vec<&'static str>) -> Result<(), ElementStyleError> {
    validate_style(element, path)?;
    if let Some(content_size) = element.content_size {
        validate_values(
            path,
            element,
            ElementStyleProperty::ContentSize,
            [content_size.width, content_size.height],
            NonNegative::Required,
        )?;
    }
    for child in &element.children {
        path.push(child.name);
        let result = validate_node(child, path);
        path.pop();
        result?;
    }
    Ok(())
}

fn validate_style(element: &Element, path: &[&'static str]) -> Result<(), ElementStyleError> {
    let style = element.style;
    validate_length(path, element, ElementStyleProperty::Width, style.width)?;
    validate_length(path, element, ElementStyleProperty::Height, style.height)?;
    if let Some(padding) = style.padding {
        validate_edges(path, element, ElementStyleProperty::Padding, padding)?;
    }
    if let Some(gap) = style.gap {
        validate_values(
            path,
            element,
            ElementStyleProperty::Gap,
            [gap],
            NonNegative::Required,
        )?;
    }
    if let Some(radii) = style.corner_radii {
        validate_values(
            path,
            element,
            ElementStyleProperty::CornerRadii,
            [
                radii.top_left,
                radii.top_right,
                radii.bottom_right,
                radii.bottom_left,
            ],
            NonNegative::Required,
        )?;
    }
    if let Some(border) = style.border {
        validate_edges(path, element, ElementStyleProperty::Border, border.widths())?;
    }
    if let Some(shadow) = style.shadow {
        validate_values(
            path,
            element,
            ElementStyleProperty::Shadow,
            [shadow.offset().x, shadow.offset().y, shadow.spread_radius()],
            NonNegative::Allowed,
        )?;
        validate_values(
            path,
            element,
            ElementStyleProperty::Shadow,
            [shadow.blur_radius()],
            NonNegative::Required,
        )?;
    }
    Ok(())
}

fn validate_length(
    path: &[&'static str],
    element: &Element,
    property: ElementStyleProperty,
    length: ElementLength,
) -> Result<(), ElementStyleError> {
    if let ElementLength::Pixels(value) = length {
        validate_values(path, element, property, [value], NonNegative::Required)?;
    }
    Ok(())
}

fn validate_edges(
    path: &[&'static str],
    element: &Element,
    property: ElementStyleProperty,
    edges: Edges,
) -> Result<(), ElementStyleError> {
    validate_values(
        path,
        element,
        property,
        [edges.top, edges.right, edges.bottom, edges.left],
        NonNegative::Required,
    )
}

#[derive(Clone, Copy)]
enum NonNegative {
    Allowed,
    Required,
}

fn validate_values<const N: usize>(
    path: &[&'static str],
    element: &Element,
    property: ElementStyleProperty,
    values: [f32; N],
    non_negative: NonNegative,
) -> Result<(), ElementStyleError> {
    if values.iter().any(|value| !value.is_finite()) {
        return Err(error(
            path,
            element,
            property,
            ElementStyleErrorKind::NonFinite,
        ));
    }
    if matches!(non_negative, NonNegative::Required) && values.iter().any(|value| *value < 0.0) {
        return Err(error(
            path,
            element,
            property,
            ElementStyleErrorKind::Negative,
        ));
    }
    Ok(())
}

fn rect_is_finite(bounds: Rect) -> bool {
    bounds.origin.x.is_finite()
        && bounds.origin.y.is_finite()
        && bounds.size.width.is_finite()
        && bounds.size.height.is_finite()
}

fn error(
    path: &[&'static str],
    element: &Element,
    property: ElementStyleProperty,
    kind: ElementStyleErrorKind,
) -> ElementStyleError {
    ElementStyleError {
        path: path.to_vec(),
        property,
        kind,
        source_file: element.source_file,
        source_line: element.source_line,
    }
}
