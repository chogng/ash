use std::io::Cursor;
use std::sync::Arc;
use std::sync::Mutex;

use ash_http_client::HttpClient;
use ash_http_client::HttpClientError;
use ash_http_client::HttpHeader;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use ash_protocol::ImageDetail;
use ash_utils_image::PromptImageMode;
use ash_utils_image::PromptImagePolicy;
use ash_utils_image::PromptImageResizeLimits;
use ash_utils_image::load_data_url_for_prompt;
use image::DynamicImage;
use image::ImageFormat;

use crate::Attachments;
use crate::FileAttachmentStore;
use crate::SafeRemoteImageFetcher;

#[test]
fn file_store_round_trips_across_service_instances() {
    let root = tempfile::tempdir().unwrap();
    let first = Attachments::new(Arc::new(FileAttachmentStore::open(root.path()).unwrap()));
    let reference = first
        .import_bytes(test_png(4, 3), ImageDetail::Auto)
        .unwrap();

    let reopened = Attachments::new(Arc::new(FileAttachmentStore::open(root.path()).unwrap()));
    let data_url = reopened.materialize_data_url(&reference).unwrap();

    assert!(data_url.starts_with("data:image/png;base64,"));
    assert_eq!(reference.width, 4);
    assert_eq!(reference.height, 3);
}

#[test]
fn duplicate_content_reuses_the_same_reference() {
    let service = Attachments::in_memory();
    let bytes = test_png(2, 2);

    let first = service
        .import_bytes(bytes.clone(), ImageDetail::Auto)
        .unwrap();
    let second = service.import_bytes(bytes, ImageDetail::Auto).unwrap();

    assert_eq!(first, second);
}

#[test]
fn audio_survives_reopen_and_rejects_forged_duration_and_corrupt_bytes() {
    let root = tempfile::tempdir().unwrap();
    let first = Attachments::new(Arc::new(FileAttachmentStore::open(root.path()).unwrap()));
    let bytes = include_bytes!("../../utils/audio/tests/fixtures/tone.wav");
    let reference = first
        .import_audio_bytes(bytes.to_vec(), ash_protocol::AudioMediaType::Wav)
        .unwrap();
    assert_eq!(reference.duration_ms, 1000);
    let original_url = first.materialize_audio_data_url(&reference).unwrap();
    drop(first);

    let reopened = Attachments::new(Arc::new(FileAttachmentStore::open(root.path()).unwrap()));
    assert_eq!(
        reopened.materialize_audio_data_url(&reference).unwrap(),
        original_url
    );
    assert_eq!(
        reopened.import_audio_data_url(&original_url).unwrap(),
        reference
    );
    let mut forged = reference.clone();
    forged.duration_ms += 1;
    assert!(reopened.verify_audio(&forged).is_err());
    let hex = reference
        .content_digest
        .as_str()
        .strip_prefix("sha256:")
        .unwrap();
    std::fs::write(
        root.path().join("sha256").join(&hex[..2]).join(hex),
        b"corrupt",
    )
    .unwrap();
    assert!(reopened.verify_audio(&reference).is_err());
}

#[test]
fn provider_materialization_downsamples_an_ephemeral_clone_and_keeps_the_stored_image() {
    let service = Attachments::in_memory();
    let reference = service
        .import_bytes(test_png(2_400, 1_200), ImageDetail::Auto)
        .unwrap();

    let data_url = service
        .materialize_data_url_with_limits(
            &reference,
            PromptImageResizeLimits {
                max_dimension: 1_000,
                max_patches: 1_000,
            },
        )
        .unwrap();
    let materialized = load_data_url_for_prompt(
        &data_url,
        PromptImagePolicy::for_mode(PromptImageMode::Original),
    )
    .unwrap();

    assert_eq!((reference.width, reference.height), (2_400, 1_200));
    assert!(materialized.width <= 1_000);
    assert!(materialized.height <= 1_000);
    assert!(service.verify(&reference).is_ok());
}

#[test]
fn forged_reference_metadata_is_rejected_on_read() {
    let service = Attachments::in_memory();
    let mut reference = service
        .import_bytes(test_png(2, 2), ImageDetail::Auto)
        .unwrap();
    reference.width = 7;

    assert!(service.materialize_data_url(&reference).is_err());
}

#[test]
fn corrupted_file_store_objects_are_rejected_on_read() {
    let root = tempfile::tempdir().unwrap();
    let service = Attachments::new(Arc::new(FileAttachmentStore::open(root.path()).unwrap()));
    let reference = service
        .import_bytes(test_png(2, 2), ImageDetail::Auto)
        .unwrap();
    let hex = reference
        .content_digest
        .as_str()
        .strip_prefix("sha256:")
        .unwrap();
    let object = root.path().join("sha256").join(&hex[..2]).join(hex);
    std::fs::write(object, b"corrupt").unwrap();

    assert!(service.materialize_data_url(&reference).is_err());
}

#[cfg(unix)]
#[test]
fn file_store_rejects_a_symlinked_digest_directory() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let service = Attachments::new(Arc::new(FileAttachmentStore::open(root.path()).unwrap()));
    let first = service
        .import_bytes(test_png(2, 2), ImageDetail::Auto)
        .unwrap();
    std::fs::remove_dir_all(root.path().join("sha256")).unwrap();
    symlink(outside.path(), root.path().join("sha256")).unwrap();

    let error = service
        .import_bytes(test_png(3, 3), ImageDetail::Auto)
        .unwrap_err();

    assert!(matches!(error, crate::AttachmentError::Corrupt));
    assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
    assert!(service.materialize_data_url(&first).is_err());
}

#[cfg(unix)]
#[test]
fn file_store_rejects_a_symlinked_attachment_object() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let service = Attachments::new(Arc::new(FileAttachmentStore::open(root.path()).unwrap()));
    let reference = service
        .import_bytes(test_png(2, 2), ImageDetail::Auto)
        .unwrap();
    let hex = reference
        .content_digest
        .as_str()
        .strip_prefix("sha256:")
        .unwrap();
    let object = root.path().join("sha256").join(&hex[..2]).join(hex);
    let outside_object = outside.path().join("object");
    std::fs::write(&outside_object, test_png(2, 2)).unwrap();
    std::fs::remove_file(&object).unwrap();
    symlink(&outside_object, &object).unwrap();

    let error = service.materialize_data_url(&reference).unwrap_err();

    assert!(matches!(error, crate::AttachmentError::Corrupt));
    assert!(outside_object.is_file());
}

#[test]
fn remote_redirects_are_revalidated_without_forwarding_credentials() {
    let client = Arc::new(ScriptedHttpClient::new(vec![
        HttpResponse::new(
            302,
            vec![HttpHeader::new(
                "location",
                "https://cdn.example.test/image.png",
            )],
            Vec::new(),
        ),
        HttpResponse::new(200, Vec::new(), test_png(1, 1)),
    ]));
    let fetcher = SafeRemoteImageFetcher::with_client(client.clone());

    let bytes = crate::RemoteImageFetcher::fetch(&fetcher, "https://example.test/start").unwrap();

    assert!(!bytes.is_empty());
    let requests = client.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1], "https://cdn.example.test/image.png");
}

#[test]
fn remote_https_redirect_cannot_downgrade_or_include_credentials() {
    let client = Arc::new(ScriptedHttpClient::new(vec![HttpResponse::new(
        302,
        vec![HttpHeader::new("location", "http://example.test/image.png")],
        Vec::new(),
    )]));
    let fetcher = SafeRemoteImageFetcher::with_client(client.clone());

    assert!(crate::RemoteImageFetcher::fetch(&fetcher, "https://example.test/start").is_err());
    assert!(
        crate::RemoteImageFetcher::fetch(&fetcher, "https://user:secret@example.test/image.png")
            .is_err()
    );
    assert_eq!(client.requests.lock().unwrap().len(), 1);
}

#[test]
fn remote_urls_reject_nonstandard_and_cross_scheme_ports() {
    let client = Arc::new(ScriptedHttpClient::new(Vec::new()));
    let fetcher = SafeRemoteImageFetcher::with_client(client.clone());

    for url in [
        "http://example.test:443/image.png",
        "https://example.test:80/image.png",
        "https://example.test:8443/image.png",
    ] {
        assert!(crate::RemoteImageFetcher::fetch(&fetcher, url).is_err());
    }
    assert!(client.requests.lock().unwrap().is_empty());
}

fn test_png(width: u32, height: u32) -> Vec<u8> {
    let image = DynamicImage::new_rgba8(width, height);
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, ImageFormat::Png).unwrap();
    bytes.into_inner()
}

struct ScriptedHttpClient {
    responses: Mutex<Vec<HttpResponse>>,
    requests: Mutex<Vec<String>>,
}

impl ScriptedHttpClient {
    fn new(mut responses: Vec<HttpResponse>) -> Self {
        responses.reverse();
        Self {
            responses: Mutex::new(responses),
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl HttpClient for ScriptedHttpClient {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        self.requests.lock().unwrap().push(request.url().to_owned());
        self.responses
            .lock()
            .unwrap()
            .pop()
            .ok_or_else(|| HttpClientError::Transport("script exhausted".into()))
    }
}
