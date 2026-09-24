use super::{
    ComposerPanelLayout, interaction_content_size, interaction_list_bounds,
    interaction_preferred_height, interaction_selection_scroll_command,
};
use ash_ui_components::ScrollCommand;
use zui::ui::{Rect, Size};

#[test]
fn interaction_expands_chat_input_upward_and_preserves_fixed_rows() {
    let main = Rect::from_xywh(0.0, 0.0, 800.0, 600.0);
    let closed = ComposerPanelLayout::for_main(main, 44.0, 0.0);
    let open = ComposerPanelLayout::for_main(main, 44.0, 200.0);

    assert_eq!(closed.panel().bottom(), main.bottom());
    assert_eq!(open.panel().bottom(), main.bottom());
    assert!(open.panel().origin.y < closed.panel().origin.y);
    assert_eq!(open.key_hint_bar(), closed.key_hint_bar());
    assert_eq!(open.editor(), closed.editor());
    assert_eq!(open.toolbar(), closed.toolbar());
    assert!(open.output().size.height < closed.output().size.height);
}

#[test]
fn fixed_rows_place_key_hints_above_editor_and_toolbar_at_the_bottom() {
    let main = Rect::from_xywh(0.0, 0.0, 800.0, 600.0);
    let layout = ComposerPanelLayout::for_main(main, 44.0, 0.0);

    assert!(layout.key_hint_bar().bottom() < layout.editor().origin.y);
    assert_eq!(
        layout.hint_editor_separator().bottom(),
        layout.editor().origin.y
    );
    assert_eq!(
        layout.hint_editor_separator().size.width,
        layout.panel().size.width
    );
    assert!(layout.editor().bottom() < layout.toolbar().origin.y);
    assert!(layout.toolbar().bottom() < layout.panel().bottom());
    assert_eq!(layout.content().origin.x, layout.panel().origin.x + 24.0);
    assert_eq!(layout.content().origin.y, layout.key_hint_bar().origin.y);
    assert_eq!(layout.content().bottom(), layout.toolbar().bottom());
    for child in [layout.key_hint_bar(), layout.editor(), layout.toolbar()] {
        assert_eq!(child.origin.x, layout.content().origin.x);
        assert_eq!(child.size.width, layout.content().size.width);
    }
}

#[test]
fn interaction_height_keeps_a_minimum_output_surface() {
    let main = Rect::from_xywh(0.0, 0.0, 800.0, 180.0);
    let layout = ComposerPanelLayout::for_main(main, 44.0, 500.0);

    assert!(layout.output().size.height >= 40.0);
    assert!(layout.interaction().is_some());
}

#[test]
fn interaction_geometry_uses_the_same_header_and_row_metrics() {
    assert_eq!(interaction_preferred_height(0), 64.0);
    assert_eq!(interaction_preferred_height(10), 30.0 + 8.0 * 34.0);

    let bounds = Rect::from_xywh(10.0, 20.0, 400.0, 200.0);
    let viewport = interaction_list_bounds(bounds);
    assert_eq!(viewport.origin.x, 11.0);
    assert_eq!(viewport.origin.y, 50.0);
    assert_eq!(viewport.size, Size::new(398.0, 169.0));
}

#[test]
fn interaction_scroll_geometry_matches_fixed_item_extent() {
    let viewport = Rect::from_xywh(0.0, 0.0, 320.0, 68.0);
    assert_eq!(
        interaction_content_size(viewport, 3),
        Size::new(320.0, 102.0)
    );
    assert_eq!(
        interaction_selection_scroll_command(1, 3, 320.0),
        Some(ScrollCommand::EnsureVisible(Rect::from_xywh(
            0.0, 34.0, 320.0, 34.0
        )))
    );
    assert_eq!(interaction_selection_scroll_command(3, 3, 320.0), None);
}
