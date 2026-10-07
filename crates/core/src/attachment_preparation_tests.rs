use std::sync::Arc;

use super::*;
use ash_attachments::Attachments;
use ash_protocol::ContentPart;
use ash_protocol::ImageDetail;

#[test]
fn replaces_valid_data_urls_with_durable_references() {
    let attachments = Arc::new(Attachments::in_memory());
    let mut content = vec![ContentPart::ImageUrl {
        url: crate::test_image::one_pixel_png_data_url(),
        detail: ImageDetail::Auto,
    }];

    prepare_tool_content(&mut content, &attachments).unwrap();

    assert!(matches!(content[0], ContentPart::ImageAttachment { .. }));
}

#[test]
fn rejects_invalid_tool_media_without_turning_it_into_text() {
    let attachments = Arc::new(Attachments::in_memory());
    for media in [
        ContentPart::ImageUrl {
            url: "data:image/png;base64,AA==".into(),
            detail: ImageDetail::High,
        },
        ContentPart::AudioUrl {
            url: "data:audio/wav;base64,AA==".into(),
        },
        ContentPart::ImageUrl {
            url: "https://example.test/image.png".into(),
            detail: ImageDetail::Auto,
        },
    ] {
        let mut content = vec![
            ContentPart::Text("before".into()),
            media,
            ContentPart::Text("after".into()),
        ];
        let original = content.clone();
        assert!(prepare_tool_content(&mut content, &attachments).is_err());
        assert_eq!(content, original);
    }
}
