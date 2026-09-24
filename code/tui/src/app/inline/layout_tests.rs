use super::manager_areas;
use super::session_areas;
use ratatui::layout::Rect;

#[test]
fn command_panels_use_available_height_and_keep_hints_visible() {
    for height in 0..40 {
        let area = Rect::new(3, 5, 80, height);
        let layout = super::command_panel_areas(area, 100, 2);
        assert_eq!(layout.composer.height, height.saturating_sub(2));
        assert_eq!(layout.transcript.height, 0);
        assert_eq!(layout.bottom.bottom(), area.bottom());
        assert_eq!(layout.composer.bottom(), layout.bottom.y);
        assert_eq!(layout.top_tip.height, 0);
    }
    let layout = super::command_panel_areas(Rect::new(0, 0, 80, 40), 8, 2);
    assert_eq!(layout.composer.height, 8);
    assert_eq!(layout.transcript.height, 30);
}

#[test]
fn session_layout_bounds_queue_and_preserves_transcript() {
    let areas = session_areas(
        Rect::new(0, 0, 80, 20),
        1,
        1,
        12,
        0,
        3,
        2,
        4,
        0,
        super::MIN_TRANSCRIPT_ROWS,
    );

    assert_eq!(areas.transcript.height, 4);
    assert_eq!(areas.goal.height, 0);
    assert_eq!(areas.plan.height, 0);
    assert_eq!(areas.queue.height, 5);
    assert_eq!(areas.top_tip.height, 1);
    assert_eq!(areas.composer.height, 3);
    assert_eq!(areas.bottom.height, 2);
    assert_eq!(areas.agent_thread_switcher.height, 4);
}

#[test]
fn session_layout_uses_zero_height_for_absent_rows() {
    let areas = session_areas(
        Rect::new(0, 0, 80, 20),
        0,
        0,
        0,
        0,
        3,
        1,
        0,
        0,
        super::MIN_TRANSCRIPT_ROWS,
    );

    assert_eq!(areas.queue.height, 0);
    assert_eq!(areas.top_tip.y, areas.transcript.height);
    assert_eq!(areas.composer.y, areas.top_tip.y + areas.top_tip.height);
}

#[test]
fn session_layout_places_goal_plan_and_queue_above_input() {
    let areas = session_areas(
        Rect::new(0, 0, 80, 20),
        1,
        1,
        2,
        0,
        3,
        1,
        2,
        0,
        super::MIN_TRANSCRIPT_ROWS,
    );

    assert_eq!(areas.goal.y, areas.transcript.height);
    assert_eq!(areas.plan.y, areas.goal.y + areas.goal.height);
    assert_eq!(areas.queue.y, areas.plan.y + areas.plan.height);
    assert_eq!(areas.top_tip.y, areas.queue.y + areas.queue.height);
    assert_eq!(areas.composer.y, areas.top_tip.y + areas.top_tip.height);
    assert_eq!(areas.bottom.y, areas.composer.y + areas.composer.height);
    assert_eq!(
        areas.agent_thread_switcher.y,
        areas.bottom.y + areas.bottom.height + 1
    );
}

#[test]
fn session_layout_does_not_reserve_an_agent_thread_gap_without_both_surfaces() {
    let without_switcher = session_areas(
        Rect::new(0, 0, 80, 20),
        0,
        0,
        0,
        0,
        3,
        1,
        0,
        0,
        super::MIN_TRANSCRIPT_ROWS,
    );
    let without_bottom = session_areas(
        Rect::new(0, 0, 80, 20),
        0,
        0,
        0,
        0,
        3,
        0,
        2,
        0,
        super::MIN_TRANSCRIPT_ROWS,
    );

    assert_eq!(
        without_switcher.agent_thread_switcher.y,
        without_switcher.bottom.y + without_switcher.bottom.height
    );
    assert_eq!(
        without_bottom.agent_thread_switcher.y,
        without_bottom.bottom.y + without_bottom.bottom.height
    );
}

#[test]
fn session_layout_places_query_above_the_fixed_top_tip_row() {
    let areas = session_areas(
        Rect::new(0, 0, 80, 20),
        0,
        0,
        0,
        1,
        3,
        1,
        0,
        0,
        super::MIN_TRANSCRIPT_ROWS,
    );

    assert_eq!(areas.request.height, 1);
    assert_eq!(areas.top_tip.y, areas.request.y + areas.request.height);
    assert_eq!(areas.top_tip.height, 1);
    assert_eq!(areas.composer.y, areas.top_tip.y + areas.top_tip.height);
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

#[test]
fn status_indicator_layout_stays_bounded_on_short_terminals() {
    for height in 0..40 {
        let area = Rect::new(3, 5, 40, height);
        let areas = session_areas(area, 0, 0, 0, 0, 3, 2, 0, 1, super::MIN_TRANSCRIPT_ROWS);
        assert!(areas.status_indicator.bottom() <= area.bottom());
        assert!(areas.status_indicator.y >= area.y);
        assert_eq!(areas.status_indicator.bottom(), areas.top_tip.y);
        assert!(areas.status_indicator.height <= 1);
        assert_eq!(areas.top_tip.bottom(), areas.composer.y);
    }
}
