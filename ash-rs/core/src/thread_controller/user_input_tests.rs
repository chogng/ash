use std::sync::Arc;

use super::*;
use ash_attachments::Attachments;

#[test]
fn normalizes_supported_image_data_to_a_durable_reference() {
    let png = crate::test_image::one_pixel_png_data_url();
    let attachments = Arc::new(Attachments::in_memory());

    let normalized = normalize_attachments(&[UserInput::Image { url: png }], &attachments).unwrap();
    assert!(matches!(
        &normalized[0],
        UserInput::ImageAttachment { attachment } if attachments.verify(attachment).is_ok()
    ));
}

#[test]
fn rejects_mismatched_image_mime_type() {
    let attachments = Arc::new(Attachments::in_memory());
    let jpeg_with_png_data =
        crate::test_image::one_pixel_png_data_url().replacen("image/png", "image/jpeg", 1);

    assert!(matches!(
        normalize_attachments(
            &[UserInput::Image {
                url: jpeg_with_png_data,
            }],
            &attachments,
        ),
        Err(CoreError::InvalidInput(_))
    ));
}

#[test]
fn rejects_bytes_that_only_imitate_a_supported_signature() {
    let attachments = Arc::new(Attachments::in_memory());
    let fake_png = ash_utils_image::data_url_from_bytes(
        "image/png",
        b"\x89PNG\r\n\x1a\nnot-a-decodable-image",
    );

    assert!(matches!(
        normalize_attachments(&[UserInput::Image { url: fake_png }], &attachments),
        Err(CoreError::InvalidInput(_))
    ));
}

#[test]
fn rejects_local_paths_at_the_core_boundary() {
    assert!(matches!(
        validate(
            &[UserInput::LocalImage {
                path: "/tmp/image.png".into(),
            }],
            &[],
        ),
        Err(CoreError::InvalidInput(_))
    ));
}

#[test]
fn accepts_automatic_skill_activation_without_a_synthetic_user_selection() {
    let activation = FrozenSkillActivation {
        id: ash_protocol::SkillId::new(
            ash_protocol::SkillSourceId::new("user:skill-source:test").unwrap(),
            ash_protocol::SkillName::new("review").unwrap(),
        ),
        content_digest: ash_protocol::ContentDigest::sha256(b"review body"),
        catalog_generation: 7,
        reason: SkillActivationReason::Automatic,
    };

    assert!(
        validate(
            &[UserInput::Text {
                text: "review this".into(),
            }],
            &[activation],
        )
        .is_ok()
    );
}
