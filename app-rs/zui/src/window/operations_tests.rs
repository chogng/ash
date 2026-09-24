use super::centered_axis;

#[test]
fn centered_axis_handles_negative_origins_and_oversized_windows() {
    assert_eq!(centered_axis(-1920, 1920, 1280), -1600);
    assert_eq!(centered_axis(0, 800, 1200), -200);
}
