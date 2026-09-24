//! Internal side-by-side pane geometry.

use zui::ui::Rect;

use super::DIVIDER_WIDTH;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct DiffEditorLayout {
    pub(super) original: Rect,
    pub(super) modified: Rect,
    pub(super) divider: Rect,
}

pub(super) fn build_layout(bounds: Rect) -> DiffEditorLayout {
    let pane_width = ((bounds.size.width - DIVIDER_WIDTH).max(0.0) * 0.5).floor();
    let original = Rect::from_xywh(
        bounds.origin.x,
        bounds.origin.y,
        pane_width,
        bounds.size.height.max(0.0),
    );
    let divider = Rect::from_xywh(
        original.right(),
        bounds.origin.y,
        DIVIDER_WIDTH.min((bounds.right() - original.right()).max(0.0)),
        bounds.size.height.max(0.0),
    );
    let modified = Rect::from_xywh(
        divider.right(),
        bounds.origin.y,
        (bounds.right() - divider.right()).max(0.0),
        bounds.size.height.max(0.0),
    );
    DiffEditorLayout {
        original,
        modified,
        divider,
    }
}
