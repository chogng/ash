//! Workbench Sidebar sizing and visibility tests.

use std::time::Instant;

use super::{MINIMUM_MAIN_WIDTH, TabContainerState};
use crate::Point;
use crate::ScrollAxis;
use crate::ScrollCommand;
use crate::ScrollMetrics;
use crate::Size;
use zui::ui::HoverPresence;

#[test]
fn tab_container_is_expanded_by_default_and_can_still_be_collapsed() {
    let mut tab_container = TabContainerState::default();

    assert!(tab_container.is_expanded());
    assert_eq!(tab_container.visible_width(1_000.0), Some(200.0));

    tab_container.toggle();
    assert!(!tab_container.is_expanded());
    assert_eq!(tab_container.visible_width(1_000.0), None);

    tab_container.toggle();
    assert!(tab_container.is_expanded());
}

#[test]
fn expanded_tab_container_uses_its_default_width() {
    let tab_container = TabContainerState::expanded();

    assert_eq!(tab_container.visible_width(1_000.0), Some(200.0));
}

#[test]
fn resizing_clamps_the_preferred_width_and_preserves_it_across_visibility() {
    let now = Instant::now();
    let mut tab_container = TabContainerState::expanded();

    assert!(tab_container.start_resizing(1_000.0, Point::new(200.0, 0.0), now));
    assert!(tab_container.resize_to(Point::new(360.0, 0.0)));
    assert!(tab_container.finish_resizing(HoverPresence::Outside, now));
    assert_eq!(tab_container.visible_width(1_000.0), Some(360.0));

    tab_container.toggle();
    assert_eq!(tab_container.visible_width(1_000.0), None);
    tab_container.toggle();
    assert_eq!(tab_container.visible_width(1_000.0), Some(360.0));

    assert!(tab_container.start_resizing(1_000.0, Point::new(360.0, 0.0), now));
    assert!(tab_container.resize_to(Point::new(40.0, 0.0)));
    assert_eq!(tab_container.visible_width(1_000.0), Some(160.0));
    assert!(tab_container.resize_to(Point::new(900.0, 0.0)));
    assert_eq!(tab_container.visible_width(1_000.0), Some(480.0));
}

#[test]
fn viewport_constraints_do_not_replace_the_preferred_width() {
    let now = Instant::now();
    let mut tab_container = TabContainerState::expanded();
    assert!(tab_container.start_resizing(1_000.0, Point::new(200.0, 0.0), now));
    assert!(tab_container.resize_to(Point::new(420.0, 0.0)));
    assert!(tab_container.finish_resizing(HoverPresence::Outside, now));

    assert_eq!(
        tab_container.visible_width(500.0),
        Some(500.0 - MINIMUM_MAIN_WIDTH)
    );
    assert_eq!(tab_container.visible_width(1_000.0), Some(420.0));
    assert_eq!(
        tab_container.visible_width(MINIMUM_MAIN_WIDTH + 159.0),
        None
    );

    assert!(tab_container.start_resizing(500.0, Point::new(260.0, 0.0), now));
    assert!(!tab_container.resize_to(Point::new(320.0, 0.0)));
    assert!(tab_container.finish_resizing(HoverPresence::Outside, now));
    assert_eq!(tab_container.visible_width(1_000.0), Some(420.0));
}

#[test]
fn tab_container_scroll_clamps_to_the_list_content() {
    let mut tab_container = TabContainerState::expanded();
    let metrics = ScrollMetrics::new(Size::new(200.0, 300.0), Size::new(200.0, 900.0));

    assert!(tab_container.scroll(ScrollCommand::ToEnd(ScrollAxis::Vertical), metrics));
    assert_eq!(tab_container.scroll_state().vertical_offset(), 600.0);
    assert!(!tab_container.scroll(ScrollCommand::ToEnd(ScrollAxis::Vertical), metrics));
}
