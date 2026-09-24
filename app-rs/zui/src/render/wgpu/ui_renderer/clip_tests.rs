use super::UiViewport;
use super::prepare_instances;
use crate::ui::foundation::Color;
use crate::ui::foundation::CornerRadii;
use crate::ui::foundation::Rect;
use crate::ui::presentation::UiScene;

#[test]
fn prepares_rounded_clip_geometry_in_physical_pixels() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.with_clip(Rect::from_xywh(6.0, 8.0, 80.0, 50.0), |scene| {
        scene.with_rounded_clip(
            Rect::from_xywh(10.0, 12.0, 60.0, 40.0),
            CornerRadii::new(10.0, 8.0, 6.0, 4.0),
            |_| {},
        );
    });

    let instances = prepare_instances(&scene, UiViewport::new(200, 120, 2.0)).unwrap();

    assert_eq!(instances.len(), 1);
    assert_eq!(instances[0].bounds, [20.0, 24.0, 120.0, 80.0]);
    assert_eq!(instances[0].corner_radii, [20.0, 16.0, 12.0, 8.0]);
    assert_eq!(instances[0].clip_bounds, [12.0, 16.0, 160.0, 100.0]);
}
