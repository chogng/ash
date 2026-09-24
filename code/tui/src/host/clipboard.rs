//! Native system-clipboard text output and image input for the terminal host.

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct ClipboardImage {
    pub(crate) png: Vec<u8>,
    pub(crate) fingerprint: ClipboardImageFingerprint,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

/// Identifies decoded image content for in-process clipboard tip deduplication.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ClipboardImageFingerprint(pub(crate) u64);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ClipboardImageAvailability {
    Available(ClipboardImageFingerprint),
    Unavailable,
}

#[cfg(not(target_os = "android"))]
pub(crate) fn write_text(text: &str) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("clipboard unavailable: {error}"))?;
    clipboard
        .set_text(text)
        .map_err(|error| format!("could not write clipboard text: {error}"))
}

#[cfg(target_os = "android")]
pub(crate) fn write_text(_text: &str) -> Result<(), String> {
    Err("clipboard text output is unsupported on Android".into())
}

#[cfg(not(target_os = "android"))]
pub(crate) fn read_image() -> Result<ClipboardImage, String> {
    encode_dynamic_image(read_dynamic_image()?)
}

#[cfg(not(target_os = "android"))]
pub(crate) fn image_availability() -> ClipboardImageAvailability {
    match read_dynamic_image() {
        Ok(image) => ClipboardImageAvailability::Available(image_fingerprint(&image)),
        Err(_) => ClipboardImageAvailability::Unavailable,
    }
}

#[cfg(not(target_os = "android"))]
fn read_dynamic_image() -> Result<image::DynamicImage, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("clipboard unavailable: {error}"))?;

    if let Some(image) = clipboard
        .get()
        .file_list()
        .unwrap_or_default()
        .into_iter()
        .find_map(|path| image::open(path).ok())
    {
        return Ok(image);
    }

    let image = clipboard
        .get_image()
        .map_err(|error| format!("no image on clipboard: {error}"))?;
    let width =
        u32::try_from(image.width).map_err(|_| "clipboard image width is too large".to_owned())?;
    let height = u32::try_from(image.height)
        .map_err(|_| "clipboard image height is too large".to_owned())?;
    let rgba = image.bytes.into_owned();
    let expected_length = image
        .width
        .checked_mul(image.height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "clipboard image dimensions overflow".to_owned())?;
    if rgba.len() != expected_length {
        return Err("clipboard image contains an invalid RGBA buffer".into());
    }
    let rgba = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| "clipboard image contains an invalid RGBA buffer".to_owned())?;

    Ok(image::DynamicImage::ImageRgba8(rgba))
}

#[cfg(target_os = "android")]
pub(crate) fn read_image() -> Result<ClipboardImage, String> {
    Err("clipboard image paste is unsupported on Android".into())
}

#[cfg(target_os = "android")]
pub(crate) fn image_availability() -> ClipboardImageAvailability {
    ClipboardImageAvailability::Unavailable
}

#[cfg(not(target_os = "android"))]
fn encode_dynamic_image(image: image::DynamicImage) -> Result<ClipboardImage, String> {
    let fingerprint = image_fingerprint(&image);
    let width = image.width();
    let height = image.height();
    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|error| format!("could not encode clipboard image as PNG: {error}"))?;
    Ok(ClipboardImage {
        png,
        fingerprint,
        width,
        height,
    })
}

#[cfg(not(target_os = "android"))]
fn image_fingerprint(image: &image::DynamicImage) -> ClipboardImageFingerprint {
    use std::hash::DefaultHasher;
    use std::hash::Hash;
    use std::hash::Hasher;

    let mut hasher = DefaultHasher::new();
    image.width().hash(&mut hasher);
    image.height().hash(&mut hasher);
    image.to_rgba8().as_raw().hash(&mut hasher);
    ClipboardImageFingerprint(hasher.finish())
}

#[cfg(test)]
#[path = "clipboard_tests.rs"]
mod tests;
