//! Internal CodeEditor geometry.

use zui::ui::Rect;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct CodeEditorLayout {
    pub(super) header: Rect,
    pub(super) body: Rect,
    pub(super) gutter: Rect,
    pub(super) content: Rect,
}

pub(super) fn build_layout(
    bounds: Rect,
    requested_gutter_width: f32,
    requested_header_height: f32,
) -> CodeEditorLayout {
    let header_height = requested_header_height.min(bounds.size.height.max(0.0));
    let header = Rect::from_xywh(
        bounds.origin.x,
        bounds.origin.y,
        bounds.size.width,
        header_height,
    );
    let body = Rect::from_xywh(
        bounds.origin.x,
        header.bottom(),
        bounds.size.width,
        (bounds.bottom() - header.bottom()).max(0.0),
    );
    let gutter_width = requested_gutter_width.min(body.size.width.max(0.0));
    let gutter = Rect::from_xywh(body.origin.x, body.origin.y, gutter_width, body.size.height);
    let content = Rect::from_xywh(
        gutter.right(),
        body.origin.y,
        (body.right() - gutter.right()).max(0.0),
        body.size.height,
    );
    CodeEditorLayout {
        header,
        body,
        gutter,
        content,
    }
}
