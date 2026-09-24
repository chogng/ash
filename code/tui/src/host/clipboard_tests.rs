#[cfg(not(target_os = "android"))]
use super::*;

#[cfg(not(target_os = "android"))]
#[test]
fn rgba_clipboard_pixels_are_encoded_as_png() {
    let rgba = image::RgbaImage::from_raw(2, 1, vec![255, 0, 0, 255, 0, 255, 0, 255]).unwrap();

    let encoded = encode_dynamic_image(image::DynamicImage::ImageRgba8(rgba)).unwrap();

    assert_eq!(encoded.width, 2);
    assert_eq!(encoded.height, 1);
    assert!(encoded.png.starts_with(b"\x89PNG\r\n\x1a\n"));
    let decoded = image::load_from_memory(&encoded.png).unwrap().into_rgba8();
    assert_eq!(decoded.dimensions(), (2, 1));
    assert_eq!(decoded.into_raw(), vec![255, 0, 0, 255, 0, 255, 0, 255]);
    assert_eq!(
        encoded.fingerprint,
        image_fingerprint(&image::load_from_memory(&encoded.png).unwrap())
    );
}

#[cfg(not(target_os = "android"))]
#[test]
fn clipboard_fingerprint_compares_pixels_and_dimensions_in_a_common_color_format() {
    let rgba = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(2, 1, vec![255, 0, 0, 255, 0, 255, 0, 255]).unwrap(),
    );
    let rgb = image::DynamicImage::ImageRgb8(rgba.to_rgb8());
    let reshaped = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(1, 2, rgba.to_rgba8().into_raw()).unwrap(),
    );
    let changed = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(2, 1, vec![255, 0, 0, 255, 0, 254, 0, 255]).unwrap(),
    );

    assert_eq!(image_fingerprint(&rgba), image_fingerprint(&rgb));
    assert_ne!(image_fingerprint(&rgba), image_fingerprint(&reshaped));
    assert_ne!(image_fingerprint(&rgba), image_fingerprint(&changed));
}
