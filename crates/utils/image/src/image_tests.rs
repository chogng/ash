use std::io::Cursor;
use std::path::Path;

use image::ColorType;
use image::Delay;
use image::DynamicImage;
use image::Frame;
use image::ImageBuffer;
use image::ImageDecoder;
use image::ImageEncoder;
use image::ImageFormat;
use image::ImageReader;
use image::Rgba;
use image::RgbaImage;
use image::codecs::gif::GifEncoder;
use image::codecs::png::PngEncoder;
use image::metadata::Orientation;
use pretty_assertions::assert_eq;

use super::*;

const TEST_RGB_ICC_PROFILE: &[u8] = b"0123456789abcdefRGB ";
const ROTATE_90_EXIF: &[u8] = &[
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00,
    0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

fn image_bytes(image: &RgbaImage, format: ImageFormat) -> Vec<u8> {
    let mut encoded = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.clone())
        .write_to(&mut encoded, format)
        .expect("encode image fixture");
    encoded.into_inner()
}

fn policy(mode: PromptImageMode) -> PromptImagePolicy {
    PromptImagePolicy::for_mode(mode)
}

#[test]
fn preserves_supported_source_bytes_when_no_transform_is_needed() {
    for (format, mime) in [
        (ImageFormat::Png, "image/png"),
        (ImageFormat::Jpeg, "image/jpeg"),
        (ImageFormat::WebP, "image/webp"),
    ] {
        let source = ImageBuffer::from_pixel(64, 32, Rgba([10, 20, 30, 255]));
        let original = image_bytes(&source, format);

        let encoded = load_for_prompt_bytes(
            Path::new("fixture"),
            original.clone(),
            policy(PromptImageMode::ResizeToFit),
        )
        .expect("prepare image");

        assert_eq!((encoded.width, encoded.height), (64, 32));
        assert_eq!(encoded.mime, mime);
        assert_eq!(encoded.source_frames, 1);
        assert_eq!(encoded.bytes.as_ref(), original);
    }
}

#[test]
fn downscales_large_images_and_preserves_the_source_encoding() {
    let source = ImageBuffer::from_pixel(4096, 2048, Rgba([200, 10, 10, 255]));
    let original = image_bytes(&source, ImageFormat::Png);

    let encoded = load_for_prompt_bytes(
        Path::new("fixture"),
        original,
        policy(PromptImageMode::ResizeToFit),
    )
    .expect("prepare image");

    assert_eq!((encoded.source_width, encoded.source_height), (4096, 2048));
    assert_eq!((encoded.width, encoded.height), (2048, 1024));
    assert_eq!(encoded.mime, "image/png");
    assert_eq!(
        image::guess_format(&encoded.bytes).unwrap(),
        ImageFormat::Png
    );
}

#[test]
fn resize_with_limits_respects_dimension_and_patch_budgets() {
    let source = ImageBuffer::from_pixel(2048, 2048, Rgba([200, 10, 10, 255]));
    let original = image_bytes(&source, ImageFormat::Png);
    let mode = PromptImageMode::ResizeWithLimits(PromptImageResizeLimits {
        max_dimension: 2048,
        max_patches: 2_500,
    });

    let encoded =
        load_for_prompt_bytes(Path::new("fixture"), original, policy(mode)).expect("prepare image");

    assert_eq!((encoded.width, encoded.height), (1600, 1600));
}

#[test]
fn original_mode_preserves_pixels_but_not_safety_bypasses() {
    let source = ImageBuffer::from_pixel(3000, 2, Rgba([180, 30, 30, 255]));
    let original = image_bytes(&source, ImageFormat::Png);
    let mut original_policy = policy(PromptImageMode::Original);
    original_policy.safety_limits.max_dimension = 4096;

    let encoded = load_for_prompt_bytes(Path::new("fixture"), original.clone(), original_policy)
        .expect("prepare original image");
    assert_eq!((encoded.width, encoded.height), (3000, 2));
    assert_eq!(encoded.bytes.as_ref(), original);

    original_policy.safety_limits.max_dimension = 2048;
    assert!(matches!(
        load_for_prompt_bytes(Path::new("fixture"), original, original_policy),
        Err(ImageProcessingError::DimensionsExceeded { .. })
    ));
}

#[test]
fn data_urls_are_decoded_and_mime_checked() {
    let source = ImageBuffer::from_pixel(8, 4, Rgba([1, 2, 3, 255]));
    let bytes = image_bytes(&source, ImageFormat::Png);
    let url = data_url_from_bytes("image/png", &bytes)
        .replacen("data:", "DATA:", 1)
        .replacen(";base64,", ";BASE64,", 1);

    let encoded = load_data_url_for_prompt(&url, policy(PromptImageMode::ResizeToFit))
        .expect("prepare data URL");
    assert_eq!(encoded.bytes.as_ref(), bytes);

    let mismatched = data_url_from_bytes("image/jpeg", &bytes);
    assert!(matches!(
        load_data_url_for_prompt(&mismatched, policy(PromptImageMode::ResizeToFit)),
        Err(ImageProcessingError::MimeMismatch { .. })
    ));
}

#[test]
fn rejects_malformed_and_resource_exhausting_inputs() {
    for url in [
        "image/png;base64,AAAA",
        "data:image/png;base64",
        "data:image/png,AAAA",
        "data:image/png;base64,not base64",
    ] {
        assert!(load_data_url_for_prompt(url, policy(PromptImageMode::ResizeToFit)).is_err());
    }

    let source = ImageBuffer::from_pixel(16, 16, Rgba([1, 2, 3, 255]));
    let bytes = image_bytes(&source, ImageFormat::Png);
    let mut limited = policy(PromptImageMode::Original);
    limited.safety_limits.max_pixels = 100;
    assert!(matches!(
        load_for_prompt_bytes(Path::new("fixture"), bytes.clone(), limited),
        Err(ImageProcessingError::PixelLimitExceeded { .. })
    ));

    limited = policy(PromptImageMode::Original);
    limited.safety_limits.max_decoded_bytes = 100;
    assert!(matches!(
        load_for_prompt_bytes(Path::new("fixture"), bytes.clone(), limited),
        Err(ImageProcessingError::DecodedBytesExceeded { .. })
    ));

    limited = policy(PromptImageMode::Original);
    limited.metadata_policy = ImageMetadataPolicy::Strip;
    limited.safety_limits.max_output_bytes = 1;
    assert!(matches!(
        load_for_prompt_bytes(Path::new("fixture"), bytes, limited),
        Err(ImageProcessingError::OutputTooLarge { .. })
    ));
}

#[test]
fn animated_gif_policy_is_explicit_and_first_frame_is_normalized_to_png() {
    let mut gif = Vec::new();
    {
        let mut encoder = GifEncoder::new(&mut gif);
        for color in [[255, 0, 0, 255], [0, 255, 0, 255]] {
            let frame = Frame::from_parts(
                RgbaImage::from_pixel(4, 2, Rgba(color)),
                0,
                0,
                Delay::from_numer_denom_ms(100, 1),
            );
            encoder.encode_frame(frame).expect("encode GIF frame");
        }
    }

    let mut reject = policy(PromptImageMode::Original);
    reject.animation_policy = ImageAnimationPolicy::Reject;
    assert!(matches!(
        load_for_prompt_bytes(Path::new("animated.gif"), gif.clone(), reject),
        Err(ImageProcessingError::AnimatedImageUnsupported)
    ));

    let mut one_frame_limit = policy(PromptImageMode::Original);
    one_frame_limit.safety_limits.max_frames = 1;
    assert!(matches!(
        load_for_prompt_bytes(Path::new("animated.gif"), gif.clone(), one_frame_limit),
        Err(ImageProcessingError::FrameLimitExceeded { .. })
    ));

    let encoded = load_for_prompt_bytes(
        Path::new("animated.gif"),
        gif,
        policy(PromptImageMode::Original),
    )
    .expect("normalize first frame");
    assert_eq!(encoded.source_frames, 2);
    assert_eq!(encoded.mime, "image/png");
    assert_eq!(
        image::guess_format(&encoded.bytes).unwrap(),
        ImageFormat::Png
    );
}

#[test]
fn resizing_preserves_rgb_icc_and_exif_orientation() {
    let source = ImageBuffer::from_pixel(2050, 2, Rgba([200, 10, 10, 255]));
    let mut original = Vec::new();
    let mut encoder = PngEncoder::new(&mut original);
    encoder
        .set_icc_profile(TEST_RGB_ICC_PROFILE.to_vec())
        .unwrap();
    encoder.set_exif_metadata(ROTATE_90_EXIF.to_vec()).unwrap();
    encoder
        .write_image(
            source.as_raw(),
            source.width(),
            source.height(),
            ColorType::Rgba8.into(),
        )
        .unwrap();

    let encoded = load_for_prompt_bytes(
        Path::new("metadata.png"),
        original,
        policy(PromptImageMode::ResizeToFit),
    )
    .expect("resize metadata image");
    let mut decoder = ImageReader::with_format(Cursor::new(&encoded.bytes), ImageFormat::Png)
        .into_decoder()
        .unwrap();

    assert_eq!(decoder.dimensions(), (2048, 2));
    assert_eq!(decoder.orientation().unwrap(), Orientation::Rotate90);
    assert_eq!(
        decoder.icc_profile().unwrap(),
        Some(TEST_RGB_ICC_PROFILE.to_vec())
    );
    assert_eq!(
        decoder.exif_metadata().unwrap(),
        Some(ROTATE_90_EXIF.to_vec())
    );
}

#[test]
fn stripping_metadata_forces_reencoding() {
    let source = ImageBuffer::from_pixel(8, 4, Rgba([1, 2, 3, 255]));
    let mut original = Vec::new();
    let mut encoder = PngEncoder::new(&mut original);
    encoder
        .set_icc_profile(TEST_RGB_ICC_PROFILE.to_vec())
        .unwrap();
    encoder.set_exif_metadata(ROTATE_90_EXIF.to_vec()).unwrap();
    encoder
        .write_image(
            source.as_raw(),
            source.width(),
            source.height(),
            ColorType::Rgba8.into(),
        )
        .unwrap();
    let mut strip = policy(PromptImageMode::Original);
    strip.metadata_policy = ImageMetadataPolicy::Strip;

    let encoded = load_for_prompt_bytes(Path::new("fixture"), original.clone(), strip)
        .expect("strip metadata");

    assert_eq!(encoded.mime, "image/png");
    assert_ne!(encoded.bytes.as_ref(), original);
    let mut decoder = ImageReader::with_format(Cursor::new(&encoded.bytes), ImageFormat::Png)
        .into_decoder()
        .unwrap();
    assert_eq!(decoder.dimensions(), (8, 4));
    assert_eq!(decoder.icc_profile().unwrap(), None);
    assert_eq!(decoder.exif_metadata().unwrap(), None);
}
