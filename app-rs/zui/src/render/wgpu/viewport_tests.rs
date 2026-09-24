use super::{SurfaceExtent, Viewport};

#[test]
fn zero_sized_viewport_has_no_presentable_surface() {
    let viewport = Viewport::new(0, 800, 2.0);

    assert_eq!(viewport.surface_extent(), None);
}

#[test]
fn resize_restores_presentable_surface_extent() {
    let mut viewport = Viewport::new(0, 0, 1.0);

    viewport.resize(1440, 900);

    assert_eq!(
        viewport.surface_extent(),
        Some(SurfaceExtent {
            width: 1440,
            height: 900
        })
    );
}

#[test]
fn scale_factor_changes_without_rewriting_physical_extent() {
    let mut viewport = Viewport::new(1200, 800, 1.0);

    viewport.set_scale_factor(2.0);

    assert_eq!(viewport.scale_factor(), 2.0);
    assert_eq!(
        viewport.surface_extent(),
        Some(SurfaceExtent {
            width: 1200,
            height: 800
        })
    );
}
