use resvg::tiny_skia::{Pixmap, Transform};
use resvg::usvg;

use crate::ui::foundation::{Icon, IconRendering, Rect};
use crate::ui::presentation::PaintIcon;

use super::super::UiRenderError;

pub(super) fn validate_paint_icon(index: usize, icon: PaintIcon) -> Result<(), UiRenderError> {
    let bounds = icon.bounds();
    let values = [
        bounds.origin.x,
        bounds.origin.y,
        bounds.size.width,
        bounds.size.height,
    ];
    if values.into_iter().any(|value| !value.is_finite()) {
        return Err(UiRenderError::InvalidPaintIcon {
            index,
            reason: "coordinates must be finite",
        });
    }
    if bounds.size.width < 0.0 || bounds.size.height < 0.0 {
        return Err(UiRenderError::InvalidPaintIcon {
            index,
            reason: "bounds must not be negative",
        });
    }
    if let Some(clip) = icon.clip_bounds() {
        let values = [
            clip.origin.x,
            clip.origin.y,
            clip.size.width,
            clip.size.height,
        ];
        if values.into_iter().any(|value| !value.is_finite()) {
            return Err(UiRenderError::InvalidPaintIcon {
                index,
                reason: "clip bounds must be finite",
            });
        }
        if clip.size.width < 0.0 || clip.size.height < 0.0 {
            return Err(UiRenderError::InvalidPaintIcon {
                index,
                reason: "clip bounds must not be negative",
            });
        }
    }
    Ok(())
}

pub(super) struct RasterizedIcon {
    pub(super) mask: Vec<u8>,
    pub(super) color: Vec<u8>,
}

pub(super) fn rasterize_icon(
    icon: Icon,
    width: u32,
    height: u32,
) -> Result<RasterizedIcon, UiRenderError> {
    let tree = usvg::Tree::from_data(icon.definition().svg(), &usvg::Options::default()).map_err(
        |error| UiRenderError::InvalidSvgIcon {
            name: icon.id().as_str(),
            reason: error.to_string(),
        },
    )?;
    let mut pixmap = Pixmap::new(width, height).ok_or(UiRenderError::IconRasterTooLarge {
        name: icon.id().as_str(),
        width,
        height,
    })?;
    let source_size = tree.size();
    let scale = (width as f32 / source_size.width()).min(height as f32 / source_size.height());
    let offset_x = (width as f32 - source_size.width() * scale) * 0.5;
    let offset_y = (height as f32 - source_size.height() * scale) * 0.5;
    let transform = Transform::from_row(scale, 0.0, 0.0, scale, offset_x, offset_y);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    let mut mask = Vec::with_capacity((width * height) as usize);
    let mut color = Vec::with_capacity((width * height * 4) as usize);
    for pixel in pixmap.pixels() {
        let pixel = pixel.demultiply();
        let is_symbolic = icon.definition().rendering() == IconRendering::Symbolic
            || (pixel.red() == 0 && pixel.green() == 0 && pixel.blue() == 0);
        mask.push(if is_symbolic { pixel.alpha() } else { 0 });
        if is_symbolic {
            color.extend_from_slice(&[0, 0, 0, 0]);
        } else {
            color.extend_from_slice(&[pixel.red(), pixel.green(), pixel.blue(), pixel.alpha()]);
        }
    }
    Ok(RasterizedIcon { mask, color })
}

pub(super) fn scaled_rect(rect: Rect, scale_factor: f32) -> [f32; 4] {
    [
        rect.origin.x * scale_factor,
        rect.origin.y * scale_factor,
        rect.size.width * scale_factor,
        rect.size.height * scale_factor,
    ]
}
