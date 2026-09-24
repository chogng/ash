use crate::ui::foundation::Rect;

const LAYOUT_EPSILON: f32 = 0.001;

/// Axis along which a [`SplitViewLayout`] arranges its visible panes.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum SplitViewOrientation {
    #[default]
    Horizontal,
    Vertical,
}

/// Order in which a pane absorbs changes to the available primary-axis size.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum SplitViewLayoutPriority {
    Low,
    #[default]
    Normal,
    High,
}

#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
enum SplitViewPaneVisibility {
    #[default]
    Visible,
    Hidden,
}

/// Caller-owned pane sizing input for one immutable [`SplitViewLayout`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SplitViewPane {
    preferred_size: f32,
    minimum_size: f32,
    maximum_size: f32,
    priority: SplitViewLayoutPriority,
    visibility: SplitViewPaneVisibility,
}

impl SplitViewPane {
    pub fn new(preferred_size: f32, minimum_size: f32, maximum_size: f32) -> Self {
        assert_non_negative_finite(preferred_size, "preferred size");
        assert_non_negative_finite(minimum_size, "minimum size");
        assert!(
            !maximum_size.is_nan() && maximum_size >= minimum_size,
            "SplitView pane maximum size must be at least its minimum size"
        );
        Self {
            preferred_size,
            minimum_size,
            maximum_size,
            priority: SplitViewLayoutPriority::Normal,
            visibility: SplitViewPaneVisibility::Visible,
        }
    }

    pub const fn with_priority(mut self, priority: SplitViewLayoutPriority) -> Self {
        self.priority = priority;
        self
    }

    pub const fn hidden(mut self) -> Self {
        self.visibility = SplitViewPaneVisibility::Hidden;
        self
    }

    fn is_visible(self) -> bool {
        self.visibility == SplitViewPaneVisibility::Visible
    }

    fn is_resizable(self) -> bool {
        self.minimum_size < self.maximum_size
    }
}

/// Resolved separator geometry between two visible, resizable panes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SplitViewSashLayout {
    previous_index: usize,
    next_index: usize,
    track_bounds: Rect,
    resize: SplitViewResizeSnapshot,
}

impl SplitViewSashLayout {
    pub const fn previous_index(self) -> usize {
        self.previous_index
    }

    pub const fn next_index(self) -> usize {
        self.next_index
    }

    /// Returns a zero-width vertical or zero-height horizontal separator track.
    pub const fn track_bounds(self) -> Rect {
        self.track_bounds
    }

    pub const fn resize_snapshot(self) -> SplitViewResizeSnapshot {
        self.resize
    }
}

/// Drag-start sizes and constraints for one adjacent pane pair.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SplitViewResizeSnapshot {
    previous_index: usize,
    next_index: usize,
    previous_size: f32,
    next_size: f32,
    minimum_delta: f32,
    maximum_delta: f32,
}

impl SplitViewResizeSnapshot {
    /// Resolves movement from the drag-start coordinate without accumulating rounding drift.
    pub fn resize(self, delta: f32) -> SplitViewResize {
        assert!(delta.is_finite(), "SplitView resize delta must be finite");
        let constrained = delta.clamp(self.minimum_delta, self.maximum_delta);
        SplitViewResize {
            previous_index: self.previous_index,
            next_index: self.next_index,
            previous_size: self.previous_size + constrained,
            next_size: self.next_size - constrained,
        }
    }
}

/// Adjacent pane sizes produced from a constrained Sash drag.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SplitViewResize {
    previous_index: usize,
    next_index: usize,
    previous_size: f32,
    next_size: f32,
}

impl SplitViewResize {
    pub const fn previous_index(self) -> usize {
        self.previous_index
    }

    pub const fn next_index(self) -> usize {
        self.next_index
    }

    pub const fn previous_size(self) -> f32 {
        self.previous_size
    }

    pub const fn next_size(self) -> f32 {
        self.next_size
    }
}

/// Immutable single-axis pane and Sash geometry for one frame.
///
/// The caller retains preferred sizes and visibility across frames. Layout clamps those inputs,
/// distributes container-size changes by priority, and exposes drag snapshots that the caller may
/// retain only for the duration of one pointer gesture.
#[derive(Clone, Debug, PartialEq)]
pub struct SplitViewLayout {
    orientation: SplitViewOrientation,
    pane_bounds: Vec<Rect>,
    pane_sizes: Vec<f32>,
    sashes: Vec<SplitViewSashLayout>,
}

impl SplitViewLayout {
    pub fn new(bounds: Rect, orientation: SplitViewOrientation, panes: &[SplitViewPane]) -> Self {
        assert_layout_bounds(bounds);
        let mut sizes = panes
            .iter()
            .map(|pane| {
                if pane.is_visible() {
                    pane.preferred_size
                        .clamp(pane.minimum_size, pane.maximum_size)
                } else {
                    0.0
                }
            })
            .collect::<Vec<_>>();
        fit_sizes(primary_size(bounds, orientation), panes, &mut sizes);
        let pane_bounds = resolve_pane_bounds(bounds, orientation, panes, &sizes);
        let sashes = resolve_sashes(bounds, orientation, panes, &sizes);
        Self {
            orientation,
            pane_bounds,
            pane_sizes: sizes,
            sashes,
        }
    }

    pub const fn orientation(&self) -> SplitViewOrientation {
        self.orientation
    }

    pub fn pane_bounds(&self, index: usize) -> Option<Rect> {
        self.pane_bounds.get(index).copied()
    }

    pub fn pane_size(&self, index: usize) -> Option<f32> {
        self.pane_sizes.get(index).copied()
    }

    pub fn sashes(&self) -> &[SplitViewSashLayout] {
        &self.sashes
    }

    pub fn sash(&self, index: usize) -> Option<SplitViewSashLayout> {
        self.sashes.get(index).copied()
    }
}

fn fit_sizes(target: f32, panes: &[SplitViewPane], sizes: &mut [f32]) {
    let mut delta = target
        - panes
            .iter()
            .zip(sizes.iter())
            .filter(|(pane, _)| pane.is_visible())
            .map(|(_, size)| *size)
            .sum::<f32>();
    for priority in [
        SplitViewLayoutPriority::High,
        SplitViewLayoutPriority::Normal,
        SplitViewLayoutPriority::Low,
    ] {
        delta = distribute_delta(panes, sizes, priority, delta);
        if delta.abs() <= LAYOUT_EPSILON {
            break;
        }
    }
}

fn distribute_delta(
    panes: &[SplitViewPane],
    sizes: &mut [f32],
    priority: SplitViewLayoutPriority,
    mut delta: f32,
) -> f32 {
    loop {
        let candidates = panes
            .iter()
            .enumerate()
            .filter_map(|(index, pane)| {
                (pane.is_visible()
                    && pane.priority == priority
                    && if delta > 0.0 {
                        sizes[index] < pane.maximum_size
                    } else {
                        sizes[index] > pane.minimum_size
                    })
                .then_some(index)
            })
            .collect::<Vec<_>>();
        if candidates.is_empty() || delta.abs() <= LAYOUT_EPSILON {
            return delta;
        }
        let share = delta / candidates.len() as f32;
        let mut applied = 0.0;
        for index in candidates {
            let pane = panes[index];
            let next = (sizes[index] + share).clamp(pane.minimum_size, pane.maximum_size);
            applied += next - sizes[index];
            sizes[index] = next;
        }
        if applied.abs() <= LAYOUT_EPSILON {
            return delta;
        }
        delta -= applied;
    }
}

fn resolve_pane_bounds(
    bounds: Rect,
    orientation: SplitViewOrientation,
    panes: &[SplitViewPane],
    sizes: &[f32],
) -> Vec<Rect> {
    let mut offset = 0.0;
    panes
        .iter()
        .enumerate()
        .map(|(index, pane)| {
            if !pane.is_visible() {
                return zero_rect_at(bounds, orientation, offset);
            }
            let pane_bounds = rect_at(bounds, orientation, offset, sizes[index]);
            offset += sizes[index];
            pane_bounds
        })
        .collect()
}

fn resolve_sashes(
    bounds: Rect,
    orientation: SplitViewOrientation,
    panes: &[SplitViewPane],
    sizes: &[f32],
) -> Vec<SplitViewSashLayout> {
    let visible = panes
        .iter()
        .enumerate()
        .filter(|(_, pane)| pane.is_visible())
        .collect::<Vec<_>>();
    let mut sashes = Vec::new();
    for pair in visible.windows(2) {
        let (previous_index, previous) = pair[0];
        let (next_index, next) = pair[1];
        if !previous.is_resizable() || !next.is_resizable() {
            continue;
        }
        let previous_size = sizes[previous_index];
        let next_size = sizes[next_index];
        let position = panes
            .iter()
            .enumerate()
            .take(previous_index + 1)
            .filter(|(_, pane)| pane.is_visible())
            .map(|(index, _)| sizes[index])
            .sum::<f32>();
        sashes.push(SplitViewSashLayout {
            previous_index,
            next_index,
            track_bounds: zero_rect_at(bounds, orientation, position),
            resize: SplitViewResizeSnapshot {
                previous_index,
                next_index,
                previous_size,
                next_size,
                minimum_delta: (previous.minimum_size - previous_size)
                    .max(next_size - next.maximum_size),
                maximum_delta: (previous.maximum_size - previous_size)
                    .min(next_size - next.minimum_size),
            },
        });
    }
    sashes
}

fn rect_at(bounds: Rect, orientation: SplitViewOrientation, offset: f32, size: f32) -> Rect {
    match orientation {
        SplitViewOrientation::Horizontal => Rect::from_xywh(
            bounds.origin.x + offset,
            bounds.origin.y,
            size,
            bounds.size.height,
        ),
        SplitViewOrientation::Vertical => Rect::from_xywh(
            bounds.origin.x,
            bounds.origin.y + offset,
            bounds.size.width,
            size,
        ),
    }
}

fn zero_rect_at(bounds: Rect, orientation: SplitViewOrientation, offset: f32) -> Rect {
    rect_at(bounds, orientation, offset, 0.0)
}

fn primary_size(bounds: Rect, orientation: SplitViewOrientation) -> f32 {
    match orientation {
        SplitViewOrientation::Horizontal => bounds.size.width,
        SplitViewOrientation::Vertical => bounds.size.height,
    }
}

fn assert_layout_bounds(bounds: Rect) {
    assert!(
        bounds.origin.x.is_finite() && bounds.origin.y.is_finite(),
        "SplitView bounds origin must be finite"
    );
    assert!(
        bounds.size.width.is_finite()
            && bounds.size.width >= 0.0
            && bounds.size.height.is_finite()
            && bounds.size.height >= 0.0,
        "SplitView bounds dimensions must be non-negative and finite"
    );
}

fn assert_non_negative_finite(value: f32, name: &str) {
    assert!(
        value.is_finite() && value >= 0.0,
        "SplitView pane {name} must be non-negative and finite"
    );
}

#[cfg(test)]
#[path = "split_view_tests.rs"]
mod tests;
