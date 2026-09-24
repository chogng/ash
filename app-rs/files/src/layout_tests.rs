use super::{FILES_TOOLBAR_HEIGHT, FilesLayout};
use zui::ui::Rect;

#[test]
fn files_layout_resolves_toolbar_and_content() {
    let layout = FilesLayout::for_bounds(Rect::from_xywh(10.0, 20.0, 320.0, 200.0));

    assert_eq!(layout.toolbar().size.height, FILES_TOOLBAR_HEIGHT);
    assert_eq!(layout.content().origin.y, 20.0 + FILES_TOOLBAR_HEIGHT);
    assert_eq!(layout.content().size.height, 200.0 - FILES_TOOLBAR_HEIGHT);
}
