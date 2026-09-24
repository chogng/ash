use zui::ui::Rect;

pub(crate) const ROW_HEIGHT: f32 = 36.0;

const CONTENT_INSET_X: f32 = 38.0;
const CONTENT_INSET_TOP: f32 = 32.0;
const CONTENT_INSET_BOTTOM: f32 = 28.0;
const HEADER_HEIGHT: f32 = 92.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SettingsSectionLayout {
    bounds: Rect,
}

impl SettingsSectionLayout {
    pub(crate) const fn new(bounds: Rect) -> Self {
        Self { bounds }
    }

    pub(crate) fn content(self) -> Rect {
        Rect::from_xywh(
            self.bounds.origin.x + CONTENT_INSET_X,
            self.bounds.origin.y + CONTENT_INSET_TOP,
            (self.bounds.size.width - CONTENT_INSET_X * 2.0).max(1.0),
            (self.bounds.size.height - CONTENT_INSET_TOP - CONTENT_INSET_BOTTOM).max(1.0),
        )
    }

    pub(crate) fn keybindings_list(self) -> Rect {
        let content = self.content();
        Rect::from_xywh(
            content.origin.x,
            content.origin.y + HEADER_HEIGHT,
            content.size.width,
            (content.size.height - HEADER_HEIGHT).max(1.0),
        )
    }
}
