use super::{CornerRadii, Point, Rect, Size};

#[test]
fn rect_intersection_returns_overlap() {
    let left = Rect::from_xywh(10.0, 20.0, 100.0, 80.0);
    let right = Rect::from_xywh(80.0, 5.0, 50.0, 40.0);

    assert_eq!(
        left.intersection(right),
        Rect::new(Point::new(80.0, 20.0), Size::new(30.0, 25.0))
    );
}

#[test]
fn rect_intersection_collapses_disjoint_bounds() {
    let first = Rect::from_xywh(0.0, 0.0, 10.0, 10.0);
    let second = Rect::from_xywh(20.0, 20.0, 5.0, 5.0);

    assert!(first.intersection(second).is_empty());
}

#[test]
fn rect_contains_points_using_half_open_edges() {
    let rect = Rect::from_xywh(10.0, 20.0, 30.0, 40.0);

    assert!(rect.contains(Point::new(10.0, 20.0)));
    assert!(rect.contains(Point::new(39.9, 59.9)));
    assert!(!rect.contains(Point::new(40.0, 60.0)));
    assert!(!rect.contains(Point::new(9.9, 20.0)));
}

#[test]
fn corner_radii_are_clamped_to_half_the_shortest_dimension() {
    let radii = CornerRadii::new(40.0, 30.0, 20.0, 10.0);

    assert_eq!(
        radii.clamped_for(Size::new(100.0, 40.0)),
        CornerRadii::new(20.0, 20.0, 20.0, 10.0)
    );
}
