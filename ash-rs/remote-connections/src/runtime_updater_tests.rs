use std::collections::BTreeMap;
use std::fs;
use std::fs::File;
use std::path::Path;
use std::sync::Mutex;

use ash_http_client::HttpBodySink;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientError;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use ash_remote::RemoteArchitecture;
use ash_remote::RemoteLinuxLibc;
use ash_remote::RemotePlatform;
use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tar::Builder;
use tar::EntryType;
use tar::Header;
use tempfile::TempDir;

use crate::RemoteRuntimeCatalogRelease;
use crate::RemoteRuntimeCatalogUpdater;
use crate::RemoteRuntimeDownloadCache;
use crate::RemoteRuntimeDownloadDisposition;
use crate::RemoteRuntimeDownloadProgress;

const CATALOG_URL: &str = "https://downloads.example/releases/0.1.0/catalog.json";
const ARTIFACT_URL: &str =
    "https://downloads.example/releases/0.1.0/artifacts/ash-x86_64-unknown-linux-gnu.tar.gz";
const TARGET: RemotePlatform =
    RemotePlatform::linux(RemoteArchitecture::X86_64, RemoteLinuxLibc::Gnu);

#[test]
fn release_and_cache_reject_ambiguous_or_untrusted_locations() {
    let digest = "a".repeat(64);
    for url in [
        "http://downloads.example/catalog.json",
        "https://user@downloads.example/catalog.json",
        "https://downloads.example/catalog.json?channel=stable",
        "https://downloads.example/not-catalog.json",
    ] {
        assert!(RemoteRuntimeCatalogRelease::new(url, &digest).is_err());
    }
    assert!(RemoteRuntimeCatalogRelease::new(CATALOG_URL, "A".repeat(64)).is_err());
    assert!(RemoteRuntimeDownloadCache::new("relative/cache").is_err());
    let filesystem_root = if cfg!(windows) {
        Path::new("C:\\")
    } else {
        Path::new("/")
    };
    assert!(RemoteRuntimeDownloadCache::new(filesystem_root).is_err());
}

#[test]
fn updater_downloads_validates_and_reuses_one_content_addressed_artifact() {
    let directory = TempDir::new().unwrap();
    let archive = package_archive(directory.path());
    let archive_bytes = fs::read(&archive.path).unwrap();
    let catalog_bytes = catalog_bytes(&archive);
    let catalog_digest = sha256(&catalog_bytes);
    let client = FixtureHttpClient::new([
        (CATALOG_URL, catalog_bytes),
        (ARTIFACT_URL, archive_bytes.clone()),
    ]);
    let updater = RemoteRuntimeCatalogUpdater::new(
        RemoteRuntimeCatalogRelease::new(CATALOG_URL, &catalog_digest).unwrap(),
        RemoteRuntimeDownloadCache::new(directory.path().join("cache")).unwrap(),
    );
    let mut progress = Vec::new();

    let downloaded = updater
        .fetch_for_with_client(TARGET, &client, |event| progress.push(event))
        .unwrap();

    assert_eq!(fs::read(downloaded.archive()).unwrap(), archive_bytes);
    assert_eq!(client.requests(), vec![CATALOG_URL, ARTIFACT_URL]);
    assert_eq!(
        progress.first(),
        Some(&RemoteRuntimeDownloadProgress::DownloadingCatalog)
    );
    assert!(
        progress.contains(&RemoteRuntimeDownloadProgress::DownloadingArtifact {
            transferred_bytes: 0,
            total_bytes: archive.archive_size,
        })
    );
    assert_eq!(
        progress.last(),
        Some(&RemoteRuntimeDownloadProgress::Complete {
            disposition: RemoteRuntimeDownloadDisposition::Downloaded,
        })
    );

    progress.clear();
    let reused = updater
        .fetch_for_with_client(TARGET, &client, |event| progress.push(event))
        .unwrap();
    assert_eq!(reused, downloaded);
    assert_eq!(client.requests(), vec![CATALOG_URL, ARTIFACT_URL]);
    assert_eq!(
        progress,
        vec![
            RemoteRuntimeDownloadProgress::ValidatingArtifact,
            RemoteRuntimeDownloadProgress::Complete {
                disposition: RemoteRuntimeDownloadDisposition::Reused,
            },
        ]
    );
}

#[test]
fn updater_replaces_a_tampered_cache_entry_but_never_publishes_bad_downloads() {
    let directory = TempDir::new().unwrap();
    let archive = package_archive(directory.path());
    let archive_bytes = fs::read(&archive.path).unwrap();
    let catalog_bytes = catalog_bytes(&archive);
    let catalog_digest = sha256(&catalog_bytes);
    let client = FixtureHttpClient::new([
        (CATALOG_URL, catalog_bytes.clone()),
        (ARTIFACT_URL, archive_bytes.clone()),
    ]);
    let updater = RemoteRuntimeCatalogUpdater::new(
        RemoteRuntimeCatalogRelease::new(CATALOG_URL, &catalog_digest).unwrap(),
        RemoteRuntimeDownloadCache::new(directory.path().join("cache")).unwrap(),
    );
    let downloaded = updater
        .fetch_for_with_client(TARGET, &client, |_| {})
        .unwrap();
    fs::write(downloaded.archive(), vec![b'x'; archive_bytes.len()]).unwrap();

    updater
        .fetch_for_with_client(TARGET, &client, |_| {})
        .unwrap();

    assert_eq!(fs::read(downloaded.archive()).unwrap(), archive_bytes);
    assert_eq!(
        client.requests(),
        vec![CATALOG_URL, ARTIFACT_URL, ARTIFACT_URL]
    );

    let bad_directory = TempDir::new().unwrap();
    let bad_client = FixtureHttpClient::new([
        (CATALOG_URL, catalog_bytes),
        (ARTIFACT_URL, b"not the authenticated archive".to_vec()),
    ]);
    let bad_updater = RemoteRuntimeCatalogUpdater::new(
        RemoteRuntimeCatalogRelease::new(CATALOG_URL, &catalog_digest).unwrap(),
        RemoteRuntimeDownloadCache::new(bad_directory.path().join("cache")).unwrap(),
    );
    assert!(
        bad_updater
            .fetch_for_with_client(TARGET, &bad_client, |_| {})
            .is_err()
    );
    let published = bad_directory
        .path()
        .join("cache")
        .join("remote-runtime-catalogs")
        .join(catalog_digest)
        .join("artifacts")
        .join("ash-x86_64-unknown-linux-gnu.tar.gz");
    assert!(!published.exists());
}

#[cfg(unix)]
#[test]
fn updater_rejects_linked_cache_directories_before_publishing() {
    use std::os::unix::fs::symlink;

    let directory = TempDir::new().unwrap();
    let archive = package_archive(directory.path());
    let catalog_bytes = catalog_bytes(&archive);
    let catalog_digest = sha256(&catalog_bytes);
    let cache = directory.path().join("cache");
    let generation = cache.join("remote-runtime-catalogs").join(&catalog_digest);
    fs::create_dir_all(&generation).unwrap();
    let outside = directory.path().join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, generation.join("artifacts")).unwrap();
    let client = FixtureHttpClient::new([
        (CATALOG_URL, catalog_bytes),
        (ARTIFACT_URL, fs::read(&archive.path).unwrap()),
    ]);
    let updater = RemoteRuntimeCatalogUpdater::new(
        RemoteRuntimeCatalogRelease::new(CATALOG_URL, &catalog_digest).unwrap(),
        RemoteRuntimeDownloadCache::new(cache).unwrap(),
    );

    let error = updater
        .fetch_for_with_client(TARGET, &client, |_| {})
        .unwrap_err();

    assert!(error.to_string().contains("linked or non-directory"));
    assert!(fs::read_dir(outside).unwrap().next().is_none());
}

struct FixtureHttpClient {
    bodies: BTreeMap<String, Vec<u8>>,
    requests: Mutex<Vec<String>>,
}

impl FixtureHttpClient {
    fn new<const N: usize>(bodies: [(&str, Vec<u8>); N]) -> Self {
        Self {
            bodies: bodies
                .into_iter()
                .map(|(url, body)| (url.to_owned(), body))
                .collect(),
            requests: Mutex::new(Vec::new()),
        }
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }

    fn response(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        self.requests.lock().unwrap().push(request.url().into());
        let body = self
            .bodies
            .get(request.url())
            .ok_or_else(|| HttpClientError::Transport("fixture URL was not registered".into()))?;
        Ok(HttpResponse::new(200, Vec::new(), body.clone()))
    }
}

impl HttpClient for FixtureHttpClient {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        self.response(request)
    }

    fn execute_streaming(
        &self,
        request: &HttpRequest,
        sink: &mut dyn HttpBodySink,
    ) -> Result<HttpResponse, HttpClientError> {
        let response = self.response(request)?;
        for chunk in response.body().chunks(7) {
            sink.emit(chunk)?;
        }
        Ok(HttpResponse::new(response.status(), Vec::new(), Vec::new()))
    }
}

struct PackageArchive {
    path: std::path::PathBuf,
    archive_size: u64,
    unpacked_size: u64,
    sha256: String,
}

fn package_archive(root: &Path) -> PackageArchive {
    let path = root.join("source.tar.gz");
    let encoder = GzEncoder::new(File::create(&path).unwrap(), Compression::default());
    let mut builder = Builder::new(encoder);
    let metadata = serde_json::to_vec(&json!({
        "layoutVersion": 2,
        "version": "0.1.0",
        "target": TARGET.target_triple(),
        "entrypoint": "bin/ash-app-server",
        "pathDir": "ash-path",
        "resourcesDir": "ash-resources",
        "javascriptRuntime": { "kind": "packagedNode" },
        "components": {},
    }))
    .unwrap();
    let mut unpacked_size = append_file(&mut builder, "ash-package.json", &metadata, 0o644);
    unpacked_size += append_file(&mut builder, "bin/ash-remote-server", b"ash", 0o755);
    unpacked_size += append_file(&mut builder, "bin/ash-app-server-daemon", b"daemon", 0o755);
    unpacked_size += append_file(&mut builder, "bin/ash-app-server", b"daemon", 0o755);
    unpacked_size += append_file(&mut builder, "ash-path/rg", b"rg", 0o755);
    unpacked_size += append_file(&mut builder, "ash-resources/node/bin/node", b"node", 0o755);
    builder.into_inner().unwrap().finish().unwrap();
    let bytes = fs::read(&path).unwrap();
    PackageArchive {
        path,
        archive_size: bytes.len() as u64,
        unpacked_size,
        sha256: sha256(&bytes),
    }
}

fn append_file(builder: &mut Builder<GzEncoder<File>>, path: &str, bytes: &[u8], mode: u32) -> u64 {
    let mut header = Header::new_gnu();
    header.set_entry_type(EntryType::Regular);
    header.set_size(bytes.len() as u64);
    header.set_mode(mode);
    header.set_cksum();
    builder.append_data(&mut header, path, bytes).unwrap();
    bytes.len() as u64
}

fn catalog_bytes(archive: &PackageArchive) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "formatVersion": 1,
        "artifacts": [{
            "version": "0.1.0",
            "target": TARGET.target_triple(),
            "archive": "artifacts/ash-x86_64-unknown-linux-gnu.tar.gz",
            "archiveSize": archive.archive_size,
            "unpackedSize": archive.unpacked_size,
            "sha256": archive.sha256,
        }],
    }))
    .unwrap()
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
