use super::*;
use ash_http_client::HttpResponse;
use std::io::Cursor;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use zip::write::SimpleFileOptions;

struct DownloadFixture {
    bytes: Vec<u8>,
    calls: AtomicUsize,
    cancellation: Option<CancellationSource>,
}

impl HttpClient for DownloadFixture {
    fn execute(&self, _: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        panic!("artifacts must stream")
    }
    fn execute_streaming_with_cancellation(
        &self,
        request: &HttpRequest,
        _: &CancellationToken,
        sink: &mut dyn HttpBodySink,
    ) -> Result<HttpResponse, HttpClientError> {
        assert!(request.url().starts_with("https://github.com/"));
        self.calls.fetch_add(1, Ordering::SeqCst);
        for chunk in self.bytes.chunks(64) {
            if let Some(source) = &self.cancellation {
                source.cancel();
            }
            sink.emit(chunk)?;
        }
        Ok(HttpResponse::new(200, Vec::new(), Vec::new()))
    }
}

fn fixture(extra: Option<&str>) -> (Artifact, DownloadFixture) {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let artifact = Artifact::current().unwrap();
    for (name, bytes) in [
        (artifact.executable(), "adapter"),
        (artifact.library(), "library"),
        ("extension/adapter/scripts/test.py", "script"),
    ] {
        archive
            .start_file(name, SimpleFileOptions::default().unix_permissions(0o755))
            .unwrap();
        archive.write_all(bytes.as_bytes()).unwrap();
    }
    if let Some(name) = extra {
        archive
            .start_file(name, SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"invalid").unwrap();
    }
    let bytes = archive.finish().unwrap().into_inner();
    (
        Artifact {
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            ..artifact
        },
        DownloadFixture {
            bytes,
            calls: AtomicUsize::new(0),
            cancellation: None,
        },
    )
}

#[test]
fn verified_complete_runtime_is_cached_and_repaired_without_network() {
    let root = tempfile::tempdir().unwrap();
    let source = CancellationSource::new();
    let (artifact, http) = fixture(None);
    let executable =
        prepare_runtime(root.path(), &artifact, &http, &source.token(), &|_| {}).unwrap();
    assert!(executable.is_file());
    assert_eq!(http.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        prepare_runtime(root.path(), &artifact, &http, &source.token(), &|_| {}).unwrap(),
        executable
    );
    let directory = root.path().join(&artifact.version).join(&artifact.platform);
    // Same-length damage to the LLDB library must not pass its installed identity check.
    fs::write(directory.join(artifact.library()), b"damaged").unwrap();
    prepare_runtime(root.path(), &artifact, &http, &source.token(), &|_| {}).unwrap();
    assert_eq!(
        fs::read(directory.join(artifact.library())).unwrap(),
        b"library"
    );
    assert_eq!(http.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn checksum_failure_and_cancel_never_publish_a_partial_installation() {
    let root = tempfile::tempdir().unwrap();
    let source = CancellationSource::new();
    let (mut artifact, mut http) = fixture(None);
    let digest = artifact.sha256.clone();
    artifact.sha256 = "0".repeat(64);
    assert!(matches!(
        prepare_runtime(root.path(), &artifact, &http, &source.token(), &|_| {}),
        Err(InstallError::Integrity)
    ));
    let directory = root.path().join(&artifact.version).join(&artifact.platform);
    assert!(!directory.exists());
    artifact.sha256 = digest;
    http.cancellation = Some(source.clone());
    assert!(matches!(
        prepare_runtime(root.path(), &artifact, &http, &source.token(), &|_| {}),
        Err(InstallError::Cancelled)
    ));
    assert!(!directory.exists());
    http.cancellation = None;
    assert!(
        prepare_runtime(
            root.path(),
            &artifact,
            &http,
            &CancellationSource::new().token(),
            &|_| {}
        )
        .is_ok()
    );
}

#[test]
fn traversal_entries_are_rejected_before_publication() {
    let root = tempfile::tempdir().unwrap();
    let (artifact, http) = fixture(Some("../escape"));
    assert!(
        prepare_runtime(
            root.path(),
            &artifact,
            &http,
            &CancellationSource::new().token(),
            &|_| {}
        )
        .is_err()
    );
    assert!(
        !root
            .path()
            .join(&artifact.version)
            .join(&artifact.platform)
            .exists()
    );
    assert!(!root.path().join("escape").exists());
}

#[test]
fn two_windows_share_one_installed_runtime() {
    let root = tempfile::tempdir().unwrap();
    let (artifact, http) = fixture(None);
    std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            prepare_runtime(
                root.path(),
                &artifact,
                &http,
                &CancellationSource::new().token(),
                &|_| {},
            )
        });
        let second = scope.spawn(|| {
            prepare_runtime(
                root.path(),
                &artifact,
                &http,
                &CancellationSource::new().token(),
                &|_| {},
            )
        });
        assert_eq!(
            first.join().unwrap().unwrap(),
            second.join().unwrap().unwrap()
        );
    });
    assert_eq!(http.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn manifest_pins_exactly_the_supported_platform_archives() {
    let manifest: Manifest = serde_json::from_str(include_str!("../runtime.json")).unwrap();
    assert_eq!(manifest.version, "1.12.3");
    assert_eq!(manifest.artifacts.len(), 5);
    for hash in manifest.artifacts.values() {
        assert_eq!(hash.sha256.len(), 64);
        assert!(hash.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}

#[test]
fn cancelling_one_window_does_not_cancel_another_windows_installation() {
    let root = tempfile::tempdir().unwrap();
    let (artifact, http) = fixture(None);
    let version = root.path().join(&artifact.version);
    fs::create_dir(&version).unwrap();
    let lock = File::create(version.join(format!("{}.lock", artifact.platform))).unwrap();
    fs2::FileExt::lock_exclusive(&lock).unwrap();
    let barrier = std::sync::Barrier::new(3);
    let first = CancellationSource::new();
    let second = CancellationSource::new();
    std::thread::scope(|scope| {
        let first_result = scope.spawn(|| {
            prepare_runtime(root.path(), &artifact, &http, &first.token(), &|phase| {
                if matches!(phase, Progress::Waiting) {
                    barrier.wait();
                }
            })
        });
        let second_result = scope.spawn(|| {
            prepare_runtime(root.path(), &artifact, &http, &second.token(), &|phase| {
                if matches!(phase, Progress::Waiting) {
                    barrier.wait();
                }
            })
        });
        barrier.wait();
        first.cancel();
        drop(lock);
        assert!(matches!(
            first_result.join().unwrap(),
            Err(InstallError::Cancelled)
        ));
        assert!(second_result.join().unwrap().unwrap().is_file());
    });
    assert_eq!(http.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn redirects_cannot_select_an_unapproved_download_host() {
    struct Redirect;
    impl HttpClient for Redirect {
        fn execute(&self, _: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
            unreachable!()
        }
        fn execute_streaming_with_cancellation(
            &self,
            _: &HttpRequest,
            _: &CancellationToken,
            _: &mut dyn HttpBodySink,
        ) -> Result<HttpResponse, HttpClientError> {
            Ok(HttpResponse::new(
                302,
                vec![HttpHeader::new("Location", "http://127.0.0.1/private")],
                Vec::new(),
            ))
        }
    }
    let root = tempfile::tempdir().unwrap();
    let (artifact, _) = fixture(None);
    let error = prepare_runtime(
        root.path(),
        &artifact,
        &Redirect,
        &CancellationSource::new().token(),
        &|_| {},
    )
    .unwrap_err();
    assert!(
        matches!(error, InstallError::Failed(message) if message.contains("redirected outside"))
    );
    assert!(
        !root
            .path()
            .join(&artifact.version)
            .join(&artifact.platform)
            .exists()
    );
}
