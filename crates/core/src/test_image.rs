pub(crate) fn one_pixel_png_data_url() -> String {
    let image = image::RgbaImage::from_pixel(1, 1, image::Rgba([10, 20, 30, 255]));
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .expect("encode test PNG");
    ash_utils_image::data_url_from_bytes("image/png", &encoded.into_inner())
}
