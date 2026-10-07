use crate::GeneratedImage;
use crate::artifact::Artifacts;
use base64::Engine;
use protocol::SessionId;
use protocol::ThreadId;
fn image() -> GeneratedImage {
    let image = image::RgbaImage::from_pixel(1, 1, image::Rgba([10, 20, 30, 255]));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    GeneratedImage {
        mime_type: "image/png".into(),
        base64: base64::engine::general_purpose::STANDARD.encode(bytes.into_inner()),
        revised_prompt: "one pixel".into(),
    }
}
#[test]
fn image_artifacts_are_atomic_reusable_and_thread_scoped() {
    let root = tempfile::tempdir().unwrap();
    let artifacts = Artifacts::open(root.path()).unwrap();
    let session = SessionId::new("s").unwrap();
    let thread = ThreadId::new("t").unwrap();
    let generated = image();
    let path = artifacts
        .save(
            &session,
            &thread,
            &generated,
            &async_utils::CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(
        artifacts
            .save(
                &session,
                &thread,
                &generated,
                &async_utils::CancellationSource::new().token()
            )
            .unwrap(),
        path
    );
    assert!(
        artifacts
            .read(&session, &thread, path.to_str().unwrap())
            .unwrap()
            .starts_with("data:image/png;base64,")
    );
    assert!(
        artifacts
            .read(
                &session,
                &ThreadId::new("other").unwrap(),
                path.to_str().unwrap()
            )
            .is_err()
    );
    assert!(artifacts.read(&session, &thread, "../outside.png").is_err());
}
#[test]
fn malformed_backend_output_does_not_publish_an_artifact() {
    let root = tempfile::tempdir().unwrap();
    let artifacts = Artifacts::open(root.path()).unwrap();
    let mut generated = image();
    generated.base64 =
        base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\ninvalid");
    assert!(
        artifacts
            .save(
                &SessionId::new("s").unwrap(),
                &ThreadId::new("t").unwrap(),
                &generated,
                &async_utils::CancellationSource::new().token()
            )
            .is_err()
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}
