use zui::ui::{Point, Rect};

use super::*;

#[test]
fn language_popovers_clamp_to_the_editor_and_compact_markdown_fences() {
    let editor = Rect::from_xywh(10.0, 20.0, 420.0, 260.0);
    let bounds = popover_bounds(editor, Point::new(425.0, 275.0), 96.0);

    assert!(bounds.origin.x >= editor.origin.x);
    assert!(bounds.origin.y >= editor.origin.y);
    assert!(bounds.right() <= editor.right());
    assert!(bounds.bottom() <= editor.bottom());
    assert_eq!(
        compact_text("```rust\nfn main()\n\nDocumentation\n```"),
        "fn main()\nDocumentation"
    );
    assert_eq!(completion_window_start(20, 0), 0);
    assert_eq!(completion_window_start(20, 7), 0);
    assert_eq!(completion_window_start(20, 8), 1);
    assert_eq!(completion_window_start(20, 19), 12);
}
