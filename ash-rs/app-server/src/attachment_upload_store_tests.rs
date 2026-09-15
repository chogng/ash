use ash_protocol::ImageDetail;
use ash_protocol::ImageMediaType;
use std::time::Duration;
use std::time::Instant;

use super::AttachmentUploadContent;
use super::AttachmentUploadError;
use super::AttachmentUploadStore;
use super::MAX_ATTACHMENT_UPLOADS_PER_CONNECTION;

#[test]
fn uploads_are_sequential_connection_owned_and_exact_length() {
    let mut uploads = AttachmentUploadStore::default();
    let upload_id = uploads
        .start(
            7,
            AttachmentUploadContent::Image {
                media_type: ImageMediaType::Png,
                detail: ImageDetail::Auto,
            },
            4,
        )
        .unwrap();

    assert_eq!(
        uploads.write(8, &upload_id, 0, b"ab").unwrap_err(),
        AttachmentUploadError::NotOwner
    );
    assert_eq!(uploads.write(7, &upload_id, 0, b"ab").unwrap(), 2);
    assert_eq!(
        uploads.write(7, &upload_id, 0, b"cd").unwrap_err(),
        AttachmentUploadError::InvalidChunk
    );
    assert_eq!(uploads.write(7, &upload_id, 2, b"cd").unwrap(), 4);
    assert_eq!(uploads.finish(7, &upload_id).unwrap().bytes, b"abcd");
}

#[test]
fn closing_an_owner_discards_partial_uploads() {
    let mut uploads = AttachmentUploadStore::default();
    let upload_id = uploads
        .start(
            7,
            AttachmentUploadContent::Image {
                media_type: ImageMediaType::Png,
                detail: ImageDetail::Auto,
            },
            4,
        )
        .unwrap();
    uploads.release_owner(7);

    assert_eq!(
        uploads.finish(7, &upload_id).unwrap_err(),
        AttachmentUploadError::NotFound
    );
}

#[test]
fn one_connection_cannot_create_unbounded_upload_sessions() {
    let mut uploads = AttachmentUploadStore::default();
    for _ in 0..MAX_ATTACHMENT_UPLOADS_PER_CONNECTION {
        uploads
            .start(
                7,
                AttachmentUploadContent::Image {
                    media_type: ImageMediaType::Png,
                    detail: ImageDetail::Auto,
                },
                16 * 1024 * 1024,
            )
            .unwrap();
    }
    assert!(
        uploads
            .uploads
            .values()
            .all(|upload| upload.bytes.capacity() == 0)
    );

    assert_eq!(
        uploads
            .start(
                7,
                AttachmentUploadContent::Image {
                    media_type: ImageMediaType::Png,
                    detail: ImageDetail::Auto
                },
                1
            )
            .unwrap_err(),
        AttachmentUploadError::ResourceLimit
    );
}

#[test]
fn idle_uploads_expire_before_the_next_operation() {
    let mut uploads = AttachmentUploadStore::default();
    let upload_id = uploads
        .start(
            7,
            AttachmentUploadContent::Image {
                media_type: ImageMediaType::Png,
                detail: ImageDetail::Auto,
            },
            1,
        )
        .unwrap();
    uploads.uploads.get_mut(&upload_id).unwrap().last_activity =
        Instant::now() - Duration::from_secs(11 * 60);

    assert_eq!(
        uploads.finish(7, &upload_id).unwrap_err(),
        AttachmentUploadError::NotFound
    );
}
