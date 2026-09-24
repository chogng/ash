use super::ClickCount;
use super::ScreenSelection;
use super::ScreenSelectionOutcome;
use super::ScreenSelectionRange;
use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Color;
use std::time::Duration;
use std::time::Instant;

#[test]
fn drag_selection_normalizes_both_directions_and_remains_visible_after_release() {
    let mut selection = ScreenSelection::default();
    let now = Instant::now();
    selection.begin(Position::new(8, 3));
    selection.drag(Position::new(2, 1));

    assert_eq!(
        selection.finish(Position::new(2, 1), now),
        Some(ScreenSelectionOutcome::Selection(
            ScreenSelectionRange::new(Position::new(8, 3), Position::new(2, 1),)
        ))
    );
    assert_eq!(
        selection.range(),
        Some(ScreenSelectionRange::new(
            Position::new(2, 1),
            Position::new(8, 3),
        ))
    );
}

#[test]
fn click_does_not_create_a_screen_selection() {
    let mut selection = ScreenSelection::default();
    let position = Position::new(4, 2);
    selection.begin(position);

    assert_eq!(
        selection.finish(position, Instant::now()),
        Some(ScreenSelectionOutcome::Click {
            position,
            count: ClickCount::Single,
        })
    );
    assert_eq!(selection.range(), None);
}

#[test]
fn nearby_clicks_cycle_through_single_double_and_triple() {
    let mut selection = ScreenSelection::default();
    let started = Instant::now();

    assert_click(
        &mut selection,
        Position::new(4, 2),
        started,
        ClickCount::Single,
    );
    assert_click(
        &mut selection,
        Position::new(5, 2),
        started + Duration::from_millis(100),
        ClickCount::Double,
    );
    selection.select(ScreenSelectionRange::new(
        Position::new(2, 2),
        Position::new(7, 2),
    ));
    assert_click(
        &mut selection,
        Position::new(4, 2),
        started + Duration::from_millis(200),
        ClickCount::Triple,
    );
    assert_click(
        &mut selection,
        Position::new(4, 2),
        started + Duration::from_millis(300),
        ClickCount::Single,
    );
}

#[test]
fn slow_click_or_drag_starts_a_new_click_sequence() {
    let mut selection = ScreenSelection::default();
    let started = Instant::now();
    assert_click(
        &mut selection,
        Position::new(4, 2),
        started,
        ClickCount::Single,
    );
    assert_click(
        &mut selection,
        Position::new(4, 2),
        started + Duration::from_millis(501),
        ClickCount::Single,
    );

    selection.begin(Position::new(4, 2));
    selection.drag(Position::new(8, 2));
    assert!(matches!(
        selection.finish(Position::new(8, 2), started + Duration::from_millis(600)),
        Some(ScreenSelectionOutcome::Selection(_))
    ));
    assert_click(
        &mut selection,
        Position::new(4, 2),
        started + Duration::from_millis(700),
        ClickCount::Single,
    );
}

#[test]
fn selection_highlight_applies_to_every_rendered_surface_cell_in_the_range() {
    let mut selection = ScreenSelection::default();
    selection.begin(Position::new(1, 0));
    selection.drag(Position::new(2, 1));
    let mut buffer = Buffer::empty(Rect::new(0, 0, 4, 2));

    selection.draw(&mut buffer, crate::render::test_context());

    let colors = buffer
        .content()
        .iter()
        .map(|cell| (cell.fg, cell.bg))
        .collect::<Vec<_>>();
    assert_eq!(
        colors,
        vec![
            (Color::Reset, Color::Reset),
            (Color::Rgb(13, 17, 23), Color::Rgb(135, 206, 235)),
            (Color::Rgb(13, 17, 23), Color::Rgb(135, 206, 235)),
            (Color::Rgb(13, 17, 23), Color::Rgb(135, 206, 235)),
            (Color::Rgb(13, 17, 23), Color::Rgb(135, 206, 235)),
            (Color::Rgb(13, 17, 23), Color::Rgb(135, 206, 235)),
            (Color::Rgb(13, 17, 23), Color::Rgb(135, 206, 235)),
            (Color::Reset, Color::Reset),
        ]
    );
}

fn assert_click(
    selection: &mut ScreenSelection,
    position: Position,
    now: Instant,
    expected: ClickCount,
) {
    selection.begin(position);
    assert_eq!(
        selection.finish(position, now),
        Some(ScreenSelectionOutcome::Click {
            position,
            count: expected,
        })
    );
}
