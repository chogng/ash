use super::*;
use ash_http_client::HttpClientError;
use ash_http_client::HttpResponse;
use serde_json::json;
use sha2::Digest;
use std::collections::BTreeMap;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

struct Download {
    bytes: Vec<u8>,
    calls: AtomicUsize,
}
impl HttpClient for Download {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        assert_eq!(request.url(), "https://example.test/livekit.tar.gz");
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(HttpResponse::new(200, Vec::new(), self.bytes.clone()))
    }
}
fn target() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64-pc-windows-msvc"
    } else {
        "x86_64-pc-windows-msvc"
    }
}
fn package(root: &Path, contents: &[u8]) -> Release {
    capability_package(root, contents, "livekit")
}
fn capability_package(root: &Path, contents: &[u8], kind: &str) -> Release {
    std::fs::create_dir_all(root.join("bin")).unwrap();
    let name = format!(
        "bin/{}{}",
        if kind == "media" {
            "ash-livekit-client"
        } else {
            "livekit-server"
        },
        std::env::consts::EXE_SUFFIX
    );
    std::fs::write(root.join(&name), contents).unwrap();
    let files = BTreeMap::from([(name, format!("{:x}", sha2::Sha256::digest(contents)))]);
    let mut metadata = json!({"layoutVersion":2,"version":"0.1.0","target":target(),"buildProfile":"ci-test","javascriptRuntime":{"kind":kind},"protocol":{"major":1,"schemaHash":format!("sha256:{}", "a".repeat(64))}});
    metadata.sort_all_objects();
    let mut hash = sha2::Sha256::new();
    hash.update(b"ash-package-build-v2\0");
    hash.update(serde_json::to_vec(&metadata).unwrap());
    hash.update(b"\0");
    for (name, digest) in &files {
        hash.update(name);
        hash.update(b"\0");
        hash.update(digest);
        hash.update(b"\0");
    }
    let build_id = format!("sha256:{:x}", hash.finalize());
    metadata["files"] = serde_json::to_value(files).unwrap();
    metadata["buildId"] = json!(build_id);
    std::fs::write(
        root.join("ash-package.json"),
        serde_json::to_vec(&metadata).unwrap(),
    )
    .unwrap();
    Release {
        schema_version: 1,
        target: target().into(),
        build_id,
        source: Source::Directory { path: root.into() },
    }
}
fn archive(root: &Path) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut tar = tar::Builder::new(encoder);
    tar.append_path_with_name(root.join("ash-package.json"), "ash-package.json")
        .unwrap();
    for entry in std::fs::read_dir(root.join("bin")).unwrap() {
        let entry = entry.unwrap();
        tar.append_path_with_name(entry.path(), Path::new("bin").join(entry.file_name()))
            .unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap()
}
#[test]
fn downloads_only_on_demand_reuses_selection_and_rejects_corrupt_update() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let release = package(&source, b"server generation one");
    let bytes = archive(&source);
    let http = Download {
        bytes: bytes.clone(),
        calls: AtomicUsize::new(0),
    };
    let manifest = root.path().join("release.json");
    std::fs::write(&manifest, serde_json::to_vec(&json!({"schemaVersion":1,"target":release.target,"buildId":release.build_id,"source":{"kind":"archive","url":"https://example.test/livekit.tar.gz","size":bytes.len(),"sha256":format!("{:x}", sha2::Sha256::digest(&bytes))}})).unwrap()).unwrap();
    let mut release = read_release(&manifest).unwrap();
    let home = root.path().join("profile");
    assert!(!home.exists());
    let first = install(&home, Some(&release), &http, "livekit").unwrap();
    assert_eq!(
        std::fs::read(
            first
                .join("bin")
                .join(format!("livekit-server{}", std::env::consts::EXE_SUFFIX))
        )
        .unwrap(),
        b"server generation one"
    );
    assert_eq!(
        install(&home, Some(&release), &http, "livekit").unwrap(),
        first
    );
    assert_eq!(http.calls.load(Ordering::SeqCst), 1);
    let previous = PackageStore::open(home.join("capabilities/livekit"))
        .unwrap()
        .current()
        .unwrap()
        .unwrap()
        .package_root;
    release.build_id = format!("sha256:{}", "b".repeat(64));
    if let Source::Archive { sha256, .. } = &mut release.source {
        *sha256 = "0".repeat(64);
    }
    assert!(matches!(
        install(&home, Some(&release), &http, "livekit"),
        Err(CapabilityInstallError::Invalid)
    ));
    assert_eq!(
        PackageStore::open(home.join("capabilities/livekit"))
            .unwrap()
            .current()
            .unwrap()
            .unwrap()
            .package_root,
        previous
    );
}
#[test]
fn offline_install_keeps_source_and_validates_the_exact_package_generation() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let mut release = package(&source, b"offline server");
    let http = Download {
        bytes: Vec::new(),
        calls: AtomicUsize::new(0),
    };
    let home = root.path().join("profile");
    let executable = install_capability(
        &home,
        "livekit",
        CapabilitySource::Directory(&source),
        &http,
    )
    .unwrap();
    assert!(source.exists());
    assert!(
        executable.starts_with(
            home.join("capabilities/livekit/packages")
                .canonicalize()
                .unwrap()
        )
    );
    assert_eq!(http.calls.load(Ordering::SeqCst), 0);
    release.build_id = "wrong-generation".into();
    assert!(matches!(
        install(&home, Some(&release), &http, "livekit"),
        Err(CapabilityInstallError::Invalid)
    ));
}

#[test]
fn rejects_untrusted_transport_and_oversized_download_before_fetching() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let mut release = package(&source, b"server");
    let http = Download {
        bytes: Vec::new(),
        calls: AtomicUsize::new(0),
    };
    for (url, size) in [
        ("http://example.test/server", 1),
        ("https://user:secret@example.test/server", 1),
        ("https://example.test/server", MAX_ARCHIVE_BYTES + 1),
    ] {
        release.source = Source::Archive {
            url: url.into(),
            sha256: "0".repeat(64),
            size,
        };
        assert!(matches!(
            install(
                &root.path().join("profile"),
                Some(&release),
                &http,
                "livekit"
            ),
            Err(CapabilityInstallError::Invalid)
        ));
    }
    assert_eq!(http.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn media_download_is_separate_from_hosting_and_serialized_across_requests() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let mut release = capability_package(&source, b"media provider", "media");
    let bytes = archive(&source);
    release.source = Source::Archive {
        url: "https://example.test/livekit.tar.gz".into(),
        sha256: format!("{:x}", sha2::Sha256::digest(&bytes)),
        size: bytes.len() as u64,
    };
    let http = Download {
        bytes,
        calls: AtomicUsize::new(0),
    };
    let home = root.path().join("profile");
    assert!(!home.exists());
    std::thread::scope(|scope| {
        let tasks: Vec<_> = (0..4)
            .map(|_| scope.spawn(|| install(&home, Some(&release), &http, "media").unwrap()))
            .collect();
        let results: Vec<_> = tasks.into_iter().map(|task| task.join().unwrap()).collect();
        assert!(results.iter().all(|path| path == &results[0]));
    });
    assert_eq!(http.calls.load(Ordering::SeqCst), 1);
    assert!(!home.join("capabilities/livekit").exists());
    assert!(
        PackageStore::open(home.join("capabilities/media"))
            .unwrap()
            .current()
            .unwrap()
            .is_some()
    );
}

#[test]
fn wrong_capability_and_target_do_not_publish_or_touch_hosting() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let mut release = package(&source, b"server");
    let http = Download {
        bytes: Vec::new(),
        calls: AtomicUsize::new(0),
    };
    let home = root.path().join("profile");
    assert!(matches!(
        install(&home, Some(&release), &http, "media"),
        Err(CapabilityInstallError::Invalid)
    ));
    let media_source = root.path().join("media");
    release = capability_package(&media_source, b"media", "media");
    release.target = "wrong-target".into();
    assert!(matches!(
        install(&home, Some(&release), &http, "media"),
        Err(CapabilityInstallError::Invalid)
    ));
    assert!(
        PackageStore::open(home.join("capabilities/media"))
            .unwrap()
            .current()
            .unwrap()
            .is_none()
    );
    assert!(!home.join("capabilities/livekit").exists());
    assert_eq!(http.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn public_installer_rejects_store_path_escape_and_wrong_offline_kind_before_installing() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    package(&source, b"server");
    let home = root.path().join("profile");
    let http = Download {
        bytes: Vec::new(),
        calls: AtomicUsize::new(0),
    };
    for kind in [
        "",
        "../livekit",
        "/livekit",
        "livekit/other",
        "livekit\\other",
    ] {
        assert!(matches!(
            install_capability(&home, kind, CapabilitySource::Directory(&source), &http),
            Err(CapabilityInstallError::Invalid)
        ));
    }
    assert!(matches!(
        install_capability(&home, "media", CapabilitySource::Directory(&source), &http),
        Err(CapabilityInstallError::Invalid)
    ));
    assert!(matches!(
        install_capability(
            &home,
            "livekit",
            CapabilitySource::Directory(Path::new("relative")),
            &http
        ),
        Err(CapabilityInstallError::Unavailable)
    ));
    assert!(!home.exists());
    assert_eq!(http.calls.load(Ordering::SeqCst), 0);
}
