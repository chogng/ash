use super::AlignItems;
use super::ComputedElement;
use super::Element;
use super::ElementDirection;
use super::ElementLength;
use super::JustifyContent;
use crate::ui::foundation::Edges;
use crate::ui::foundation::Rect;
use crate::ui::foundation::Size;

pub(super) fn compute_element(element: &Element, bounds: Rect) -> ComputedElement {
    let padding = resolved_padding(element.style.padding, bounds);
    let content_bounds = inset_bounds(bounds, padding);
    let gap = element.style.gap.unwrap_or(0.0).max(0.0);
    let child_count = element.children.len();
    let total_gap = gap * child_count.saturating_sub(1) as f32;
    let (available_main, available_cross) = match element.style.direction {
        ElementDirection::Horizontal => (content_bounds.size.width, content_bounds.size.height),
        ElementDirection::Vertical => (content_bounds.size.height, content_bounds.size.width),
    };
    let main_extents = element
        .children
        .iter()
        .map(|child| resolved_length(element.style.direction, child, true))
        .collect::<Vec<_>>();
    let fixed_main = main_extents.iter().flatten().sum::<f32>();
    let fill_count = element
        .children
        .iter()
        .zip(&main_extents)
        .filter(|(child, extent)| {
            main_length(element.style.direction, child) == ElementLength::Fill && extent.is_none()
        })
        .count();
    let fill_extent = if fill_count == 0 {
        0.0
    } else {
        ((available_main - fixed_main - total_gap).max(0.0)) / fill_count as f32
    };
    let occupied_main = fixed_main + fill_extent * fill_count as f32 + total_gap;
    let free_main = (available_main - occupied_main).max(0.0);
    let mut resolved_gap = gap;
    let mut offset = match element.style.justify_content {
        JustifyContent::Start | JustifyContent::SpaceBetween => 0.0,
        JustifyContent::Center => free_main * 0.5,
        JustifyContent::End => free_main,
    };
    if element.style.justify_content == JustifyContent::SpaceBetween && child_count > 1 {
        resolved_gap += free_main / (child_count - 1) as f32;
    }
    let mut children = Vec::with_capacity(child_count);
    let mut gap_regions = Vec::with_capacity(child_count.saturating_sub(1));
    for (index, child) in element.children.iter().enumerate() {
        let main_extent = main_extents[index].unwrap_or(fill_extent);
        let cross_extent = resolved_length(element.style.direction, child, false)
            .unwrap_or(available_cross)
            .min(available_cross.max(0.0));
        let cross_offset = match element.style.align_items {
            AlignItems::Start => 0.0,
            AlignItems::Center => (available_cross - cross_extent).max(0.0) * 0.5,
            AlignItems::End => (available_cross - cross_extent).max(0.0),
        };
        let resolved_child_bounds = child_bounds(
            element.style.direction,
            content_bounds,
            offset,
            cross_offset,
            main_extent,
            cross_extent,
        );
        children.push(compute_element(child, resolved_child_bounds));
        offset += main_extent;
        if index + 1 < child_count {
            let gap_bounds = child_bounds(
                element.style.direction,
                content_bounds,
                offset,
                0.0,
                resolved_gap,
                available_cross,
            );
            if !gap_bounds.is_empty() {
                gap_regions.push(gap_bounds);
            }
            offset += resolved_gap;
        }
    }
    ComputedElement {
        name: element.name,
        bounds,
        style: element.style,
        resolved_padding: padding,
        gap_regions,
        children,
        identity: None,
        inspection_label: None,
        source_file: element.source_file,
        source_line: element.source_line,
    }
}

fn main_length(direction: ElementDirection, element: &Element) -> ElementLength {
    match direction {
        ElementDirection::Horizontal => element.style.width,
        ElementDirection::Vertical => element.style.height,
    }
}

fn cross_length(direction: ElementDirection, element: &Element) -> ElementLength {
    match direction {
        ElementDirection::Horizontal => element.style.height,
        ElementDirection::Vertical => element.style.width,
    }
}

fn resolved_length(direction: ElementDirection, element: &Element, main_axis: bool) -> Option<f32> {
    let length = if main_axis {
        main_length(direction, element)
    } else {
        cross_length(direction, element)
    };
    match length {
        ElementLength::Fill => None,
        ElementLength::Pixels(value) => Some(value.max(0.0)),
        ElementLength::Content => {
            let size = natural_size(element);
            Some(match (direction, main_axis) {
                (ElementDirection::Horizontal, true) | (ElementDirection::Vertical, false) => {
                    size.width
                }
                (ElementDirection::Vertical, true) | (ElementDirection::Horizontal, false) => {
                    size.height
                }
            })
        }
    }
}

fn natural_size(element: &Element) -> Size {
    let padding = element.style.padding.unwrap_or(Edges::uniform(0.0));
    let horizontal_padding = padding.left.max(0.0) + padding.right.max(0.0);
    let vertical_padding = padding.top.max(0.0) + padding.bottom.max(0.0);
    let gap = element.style.gap.unwrap_or(0.0).max(0.0);
    let child_gap = gap * element.children.len().saturating_sub(1) as f32;
    let child_sizes = element
        .children
        .iter()
        .map(natural_outer_size)
        .collect::<Vec<_>>();
    let children_size = match element.style.direction {
        ElementDirection::Horizontal => Size::new(
            child_sizes.iter().map(|size| size.width).sum::<f32>() + child_gap,
            child_sizes
                .iter()
                .map(|size| size.height)
                .fold(0.0, f32::max),
        ),
        ElementDirection::Vertical => Size::new(
            child_sizes
                .iter()
                .map(|size| size.width)
                .fold(0.0, f32::max),
            child_sizes.iter().map(|size| size.height).sum::<f32>() + child_gap,
        ),
    };
    let content = element.content_size.unwrap_or(Size::new(0.0, 0.0));
    Size::new(
        children_size.width.max(content.width) + horizontal_padding,
        children_size.height.max(content.height) + vertical_padding,
    )
}

fn natural_outer_size(element: &Element) -> Size {
    let natural = natural_size(element);
    Size::new(
        match element.style.width {
            ElementLength::Fill | ElementLength::Content => natural.width,
            ElementLength::Pixels(width) => width.max(0.0),
        },
        match element.style.height {
            ElementLength::Fill | ElementLength::Content => natural.height,
            ElementLength::Pixels(height) => height.max(0.0),
        },
    )
}

fn child_bounds(
    direction: ElementDirection,
    parent: Rect,
    offset: f32,
    cross_offset: f32,
    main_extent: f32,
    cross_extent: f32,
) -> Rect {
    match direction {
        ElementDirection::Horizontal => Rect::from_xywh(
            parent.origin.x + offset,
            parent.origin.y + cross_offset,
            main_extent.min((parent.size.width - offset).max(0.0)),
            cross_extent,
        ),
        ElementDirection::Vertical => Rect::from_xywh(
            parent.origin.x + cross_offset,
            parent.origin.y + offset,
            cross_extent,
            main_extent.min((parent.size.height - offset).max(0.0)),
        ),
    }
}

fn resolved_padding(padding: Option<Edges>, bounds: Rect) -> Edges {
    let padding = padding.unwrap_or(Edges::uniform(0.0));
    let top = padding.top.max(0.0).min(bounds.size.height.max(0.0));
    let bottom = padding
        .bottom
        .max(0.0)
        .min((bounds.size.height - top).max(0.0));
    let left = padding.left.max(0.0).min(bounds.size.width.max(0.0));
    let right = padding
        .right
        .max(0.0)
        .min((bounds.size.width - left).max(0.0));
    Edges::new(top, right, bottom, left)
}

fn inset_bounds(bounds: Rect, padding: Edges) -> Rect {
    Rect::from_xywh(
        bounds.origin.x + padding.left,
        bounds.origin.y + padding.top,
        (bounds.size.width - padding.left - padding.right).max(0.0),
        (bounds.size.height - padding.top - padding.bottom).max(0.0),
    )
}
