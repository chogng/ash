use super::workbench_window_icon;

#[test]
fn window_uses_bundled_ash_artwork() {
    let icon = workbench_window_icon();

    assert_eq!((icon.width(), icon.height()), (512, 512));
    assert!(icon.rgba().chunks_exact(4).any(|pixel| pixel[3] == 255));
}
