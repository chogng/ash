use super::manager_areas;
use super::session_areas;
use ratatui::layout::Rect;

#[test]
fn short_query_uses_history_space_before_clipping_its_choices() {
    let areas = session_areas(Rect::new(3, 5, 42, 12), 0, 0, 0, 6, 3, 2, 0, 4);
    assert_eq!(areas.request, Rect::new(3, 5, 42, 6));
    assert_eq!(areas.transcript.height, 0);
    assert_eq!(areas.composer.height, 3);
    assert_eq!(areas.tipline.height, 1);
    assert_eq!(areas.statusline.height, 1);
    assert_eq!(areas.hintline.height, 1);
    assert_eq!(areas.hintline.bottom(), 17);

    let short = session_areas(Rect::new(3, 5, 42, 11), 0, 0, 0, 6, 3, 2, 0, 4);
    assert_eq!(short.request.height, 6);
    assert_eq!(short.composer.height, 3);
    assert_eq!(short.tipline.height, 0);
    assert_eq!(short.statusline.height, 1);
    assert_eq!(short.hintline.height, 1);
}

#[test]
fn command_panels_use_available_height_and_keep_hints_visible() {
    for height in 0..40 {
        let area = Rect::new(3, 5, 80, height);
        let layout = super::command_panel_areas(area, 100, 2);
        assert_eq!(layout.composer.height, height.saturating_sub(2));
        assert_eq!(layout.transcript.height, 0);
        assert_eq!(layout.hintline.bottom(), area.bottom());
        assert_eq!(layout.composer.bottom(), layout.hintline.y);
        assert_eq!(layout.tipline.height, 0);
    }
    let layout = super::command_panel_areas(Rect::new(0, 0, 80, 40), 8, 2);
    assert_eq!(layout.composer.height, 8);
    assert_eq!(layout.transcript.height, 30);
}

#[test]
fn manager_layout_keeps_welcome_above_a_useful_session_list() {
    let areas = manager_areas(Rect::new(0, 2, 80, 20), 11);

    assert_eq!(areas.welcome, Rect::new(0, 2, 80, 11));
    assert_eq!(areas.sessions, Rect::new(0, 14, 80, 8));
}

#[test]
fn manager_layout_shrinks_welcome_before_the_session_list() {
    let areas = manager_areas(Rect::new(0, 0, 40, 8), 12);

    assert_eq!(areas.welcome.height, 3);
    assert_eq!(areas.sessions, Rect::new(0, 4, 40, 4));
}
