use super::{ATLAS_PADDING, ATLAS_SIZE, ShelfAllocator, rasterize_icon, validate_paint_icon};
use crate::ui::foundation::{Color, Icon, IconDefinition, IconId, IconRendering, Rect};
use crate::ui::presentation::PaintIcon;

use super::UiRenderError;
use crate::devtools::assets;

const TEST_ICON: Icon = Icon::new(
    IconId::new("circle"),
    IconDefinition::symbolic(
        br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>"#,
    ),
);

const TEST_MULTICOLOR_ICON: Icon = Icon::new(
    IconId::new("multicolor"),
    IconDefinition::multicolor(
        br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="5" cy="8" r="4" fill="#000000"/><rect x="9" y="4" width="4" height="8" fill="#c7c7c7"/></svg>"##,
    ),
);

#[test]
fn rasterizes_svg_as_alpha_mask_at_requested_physical_size() {
    let raster = rasterize_icon(TEST_ICON, 32, 24).unwrap();

    assert_eq!(raster.mask.len(), 32 * 24);
    assert_eq!(raster.color.len(), 32 * 24 * 4);
    assert_eq!(raster.mask[0], 0);
    assert!(raster.mask.contains(&255));
    assert!(raster.color.iter().all(|channel| *channel == 0));
}

#[test]
fn shelf_allocator_keeps_padding_between_regions() {
    let mut allocator = ShelfAllocator::new();
    let first = allocator.allocate(16, 16).unwrap();
    let second = allocator.allocate(24, 16).unwrap();

    assert_eq!(first.x, ATLAS_PADDING);
    assert_eq!(first.y, ATLAS_PADDING);
    assert_eq!(second.x, first.x + first.width + ATLAS_PADDING);
    assert_eq!(second.y, first.y);
}

#[test]
fn shelf_allocator_rejects_icon_larger_than_atlas() {
    let mut allocator = ShelfAllocator::new();

    assert!(allocator.allocate(ATLAS_SIZE, 16).is_none());
}

#[test]
fn rejects_negative_icon_bounds() {
    let icon = PaintIcon::new(
        TEST_ICON,
        Rect::from_xywh(0.0, 0.0, -16.0, 16.0),
        Color::WHITE,
    );

    assert!(matches!(
        validate_paint_icon(2, icon),
        Err(UiRenderError::InvalidPaintIcon {
            index: 2,
            reason: "bounds must not be negative",
        })
    ));
}

#[test]
fn reports_invalid_svg_with_icon_name() {
    let icon = Icon::new(IconId::new("broken"), IconDefinition::symbolic(b"<svg"));

    assert!(matches!(
        rasterize_icon(icon, 16, 16),
        Err(UiRenderError::InvalidSvgIcon { name: "broken", .. })
    ));
}

#[test]
fn separates_multicolor_artwork_into_symbolic_mask_and_fixed_color_pixels() {
    assert_eq!(
        TEST_MULTICOLOR_ICON.definition().rendering(),
        IconRendering::Multicolor
    );

    let raster = rasterize_icon(TEST_MULTICOLOR_ICON, 16, 16).unwrap();

    assert!(raster.mask.contains(&255));
    assert!(
        raster
            .color
            .chunks_exact(4)
            .any(|pixel| pixel == [199, 199, 199, 255])
    );
}

#[test]
fn built_in_devtools_icons_rasterize_as_symbolic_assets() {
    for icon in [
        assets::PICK,
        assets::CLOSE,
        assets::ANCESTOR,
        assets::EXPANDED,
    ] {
        let raster = rasterize_icon(icon, 16, 16).expect("built-in DevTools SVG should parse");

        assert!(
            raster.mask.iter().any(|alpha| *alpha > 0),
            "built-in DevTools icon {} should contain visible coverage",
            icon.id().as_str()
        );
        assert!(raster.color.iter().all(|channel| *channel == 0));
    }
}
