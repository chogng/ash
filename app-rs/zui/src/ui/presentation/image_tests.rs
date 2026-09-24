use super::{ImageData, ImageDataError, ImageId};

#[test]
fn rgba_image_validates_dimensions_and_exact_byte_length() {
    let image = ImageData::from_rgba8(ImageId::new(3), 2, 1, vec![0; 8]).unwrap();
    assert_eq!(image.width(), 2);
    assert_eq!(image.height(), 1);
    assert_eq!(image.rgba8(), &[0; 8]);

    assert_eq!(
        ImageData::from_rgba8(ImageId::new(4), 2, 1, vec![0; 4]).unwrap_err(),
        ImageDataError::InvalidByteLength {
            actual: 4,
            expected: 8,
        }
    );
    assert_eq!(
        ImageData::from_rgba8(ImageId::new(5), 0, 1, Vec::new()).unwrap_err(),
        ImageDataError::Empty
    );
}
