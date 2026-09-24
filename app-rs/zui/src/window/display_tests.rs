use super::Display;
use super::DisplayEvent;
use super::DisplayId;
use super::DisplayMetricChanges;
use super::DisplayMode;
use super::DisplayRotation;
use super::DisplaySnapshot;
use crate::window::PhysicalBounds;
use crate::window::PhysicalExtent;
use crate::window::PhysicalPosition;

fn display(id: &str, scale_factor: f64) -> Display {
    display_at(id, -1920.0, 0.0, 1920, 1080, scale_factor)
}

fn display_at(id: &str, x: f64, y: f64, width: u32, height: u32, scale_factor: f64) -> Display {
    Display::new(
        DisplayId::from_raw(id),
        Some(id.to_owned()),
        PhysicalBounds::new(
            PhysicalPosition::new(x, y),
            PhysicalExtent::new(width, height),
        ),
        scale_factor,
    )
    .with_refresh_rate(Some(60_000))
    .with_video_modes(vec![DisplayMode::new(
        PhysicalExtent::new(1920, 1080),
        32,
        60_000,
    )])
}

#[test]
fn display_snapshot_resolves_primary_and_current_by_stable_identity() {
    let primary = display("primary", 2.0);
    let secondary = display("secondary", 1.0);
    let snapshot = DisplaySnapshot::new(
        vec![primary, secondary],
        Some(DisplayId::from_raw("primary")),
        Some(DisplayId::from_raw("secondary")),
    );

    assert_eq!(snapshot.primary().unwrap().id().as_str(), "primary");
    assert_eq!(snapshot.current().unwrap().id().as_str(), "secondary");
    assert_eq!(snapshot.displays()[0].video_modes()[0].bit_depth(), 32);
}

#[test]
fn display_snapshot_rejects_stale_identities_and_normalizes_scale() {
    let snapshot = DisplaySnapshot::new(
        vec![display("connected", f64::NAN)],
        Some(DisplayId::from_raw("removed")),
        None,
    );

    assert!(snapshot.primary().is_none());
    assert_eq!(snapshot.displays()[0].scale_factor(), 1.0);
}

#[test]
fn display_retains_optional_platform_work_area() {
    let work_area = PhysicalBounds::new(
        PhysicalPosition::new(0.0, 24.0),
        PhysicalExtent::new(1920, 1056),
    );
    let display = display_at("primary", 0.0, 0.0, 1920, 1080, 1.0)
        .with_work_area(work_area)
        .with_rotation(DisplayRotation::Degrees90)
        .with_internal(true);

    assert_eq!(display.work_area(), Some(work_area));
    assert_eq!(display.rotation(), Some(DisplayRotation::Degrees90));
    assert_eq!(display.rotation().unwrap().degrees(), 90);
    assert_eq!(display.is_internal(), Some(true));
}

#[cfg(target_os = "macos")]
#[test]
fn display_rotation_normalizes_platform_degrees() {
    assert_eq!(
        DisplayRotation::from_degrees(-90.0),
        Some(DisplayRotation::Degrees270)
    );
    assert_eq!(DisplayRotation::from_degrees(45.0), None);
    assert_eq!(DisplayRotation::from_degrees(f64::NAN), None);
}

#[test]
fn display_snapshot_finds_by_identity_and_nearest_point() {
    let left = display_at("left", -1200.0, 0.0, 1000, 800, 1.0);
    let right = display_at("right", 200.0, 0.0, 1000, 800, 1.0);
    let snapshot = DisplaySnapshot::new(vec![left, right], None, None);

    assert_eq!(
        snapshot
            .display(&DisplayId::from_raw("right"))
            .unwrap()
            .id()
            .as_str(),
        "right"
    );
    assert_eq!(
        snapshot
            .display_nearest_point(PhysicalPosition::new(-1_000.0, 100.0))
            .unwrap()
            .id()
            .as_str(),
        "left"
    );
    assert_eq!(
        snapshot
            .display_nearest_point(PhysicalPosition::new(1_800.0, 100.0))
            .unwrap()
            .id()
            .as_str(),
        "right"
    );
    assert_eq!(
        snapshot
            .display_nearest_point(PhysicalPosition::new(0.0, 100.0))
            .unwrap()
            .id()
            .as_str(),
        "left",
        "equidistant ties should preserve topology order"
    );
}

#[test]
fn display_snapshot_matches_largest_rectangle_overlap_then_nearest_center() {
    let left = display_at("left", -1000.0, 0.0, 1000, 800, 1.0);
    let right = display_at("right", 0.0, 0.0, 1000, 800, 1.0);
    let snapshot = DisplaySnapshot::new(vec![left, right], None, None);
    let overlapping = PhysicalBounds::new(
        PhysicalPosition::new(-200.0, 100.0),
        PhysicalExtent::new(700, 300),
    );
    let outside = PhysicalBounds::new(
        PhysicalPosition::new(1_500.0, 100.0),
        PhysicalExtent::new(200, 200),
    );

    assert_eq!(
        snapshot
            .display_matching(overlapping)
            .unwrap()
            .id()
            .as_str(),
        "right"
    );
    assert_eq!(
        snapshot.display_matching(outside).unwrap().id().as_str(),
        "right"
    );
}

#[test]
fn display_spatial_queries_reject_non_finite_coordinates() {
    let snapshot = DisplaySnapshot::new(vec![display("primary", 1.0)], None, None);
    let invalid_bounds = PhysicalBounds::new(
        PhysicalPosition::new(f64::INFINITY, 0.0),
        PhysicalExtent::new(100, 100),
    );

    assert!(
        snapshot
            .display_nearest_point(PhysicalPosition::new(f64::NAN, 0.0))
            .is_none()
    );
    assert!(snapshot.display_matching(invalid_bounds).is_none());
}

#[test]
fn display_snapshot_changes_are_grouped_and_identity_sorted() {
    let previous = DisplaySnapshot::new(
        vec![display("z-removed", 1.0), display("b-removed", 1.0)],
        None,
        None,
    );
    let current = DisplaySnapshot::new(
        vec![display("c-added", 1.0), display("a-added", 1.0)],
        None,
        None,
    );

    let changes = current.changes_since(&previous);
    let labels = changes
        .iter()
        .map(|event| match event {
            DisplayEvent::Added(display) => format!("added:{}", display.id().as_str()),
            DisplayEvent::Removed(display) => format!("removed:{}", display.id().as_str()),
            DisplayEvent::MetricsChanged { display, .. } => {
                format!("changed:{}", display.id().as_str())
            }
        })
        .collect::<Vec<_>>();

    assert_eq!(
        labels,
        [
            "removed:b-removed",
            "removed:z-removed",
            "added:a-added",
            "added:c-added",
        ]
    );
}

#[test]
fn display_snapshot_reports_every_changed_metric() {
    let previous_display =
        display_at("stable", 0.0, 0.0, 1920, 1080, 1.0).with_work_area(PhysicalBounds::new(
            PhysicalPosition::new(0.0, 20.0),
            PhysicalExtent::new(1920, 1060),
        ));
    let current_display = Display::new(
        DisplayId::from_raw("stable"),
        Some("renamed".to_owned()),
        PhysicalBounds::new(
            PhysicalPosition::new(10.0, 10.0),
            PhysicalExtent::new(2560, 1440),
        ),
        2.0,
    )
    .with_work_area(PhysicalBounds::new(
        PhysicalPosition::new(10.0, 40.0),
        PhysicalExtent::new(2560, 1410),
    ))
    .with_rotation(DisplayRotation::Degrees180)
    .with_internal(false)
    .with_refresh_rate(Some(120_000))
    .with_video_modes(vec![DisplayMode::new(
        PhysicalExtent::new(2560, 1440),
        30,
        120_000,
    )]);
    let previous = DisplaySnapshot::new(
        vec![previous_display],
        Some(DisplayId::from_raw("stable")),
        None,
    );
    let current = DisplaySnapshot::new(vec![current_display], None, None);

    let changes = current.changes_since(&previous);
    let changed = changes[0].changed().unwrap();

    assert_eq!(changes.len(), 1);
    assert!(changed.contains(DisplayMetricChanges::BOUNDS));
    assert!(changed.contains(DisplayMetricChanges::WORK_AREA));
    assert!(changed.contains(DisplayMetricChanges::ROTATION));
    assert!(changed.contains(DisplayMetricChanges::INTERNAL));
    assert!(changed.contains(DisplayMetricChanges::SCALE_FACTOR));
    assert!(changed.contains(DisplayMetricChanges::REFRESH_RATE));
    assert!(changed.contains(DisplayMetricChanges::VIDEO_MODES));
    assert!(changed.contains(DisplayMetricChanges::NAME));
    assert!(changed.contains(DisplayMetricChanges::PRIMARY));
}

#[test]
fn primary_display_transition_marks_both_retained_displays() {
    let displays = vec![display("b", 1.0), display("a", 1.0)];
    let previous = DisplaySnapshot::new(displays.clone(), Some(DisplayId::from_raw("a")), None);
    let current = DisplaySnapshot::new(displays, Some(DisplayId::from_raw("b")), None);

    let changes = current.changes_since(&previous);

    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0].display().id().as_str(), "a");
    assert_eq!(changes[1].display().id().as_str(), "b");
    assert_eq!(changes[0].changed(), Some(DisplayMetricChanges::PRIMARY));
    assert_eq!(changes[1].changed(), Some(DisplayMetricChanges::PRIMARY));
}
