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

fn executable_release(bytes: &[u8], format: ExecutableArchive) -> ExecutableRelease {
    ExecutableRelease {
        version: "2026-10-12".into(),
        target: target().into(),
        url: "https://example.test/livekit.tar.gz".into(),
        sha256: format!("{:x}", sha2::Sha256::digest(bytes)),
        size: bytes.len() as u64,
        format,
    }
}

#[test]
fn executable_download_is_verified_atomic_and_reused_across_concurrent_callers() {
    use std::io::Write;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(b"verified executable").unwrap();
    let bytes = encoder.finish().unwrap();
    let release = executable_release(&bytes, ExecutableArchive::Gzip);
    let http = Download {
        bytes,
        calls: AtomicUsize::new(0),
    };
    let home = tempfile::tempdir().unwrap();
    let downloads = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..3)
            .map(|_| {
                scope.spawn(|| {
                    install_executable(
                        home.path(),
                        "rust-analyzer",
                        "rust-analyzer",
                        &release,
                        &http,
                        || {
                            assert_eq!(http.calls.load(Ordering::SeqCst), 0);
                            downloads.fetch_add(1, Ordering::SeqCst);
                        },
                    )
                    .unwrap()
                })
            })
            .collect();
        for handle in handles {
            let installed = handle.join().unwrap();
            assert_eq!(
                std::fs::read(installed.path).unwrap(),
                b"verified executable"
            );
        }
    });
    assert_eq!(http.calls.load(Ordering::SeqCst), 1);
    assert_eq!(downloads.load(Ordering::SeqCst), 1);
    install_executable(
        home.path(),
        "rust-analyzer",
        "rust-analyzer",
        &release,
        &http,
        || panic!("cache reuse must not report a download"),
    )
    .unwrap();
    let store = PackageStore::open(home.path().join("capabilities/rust-analyzer")).unwrap();
    let previous = store.current().unwrap().unwrap().package_root;
    let mut corrupt = release.clone();
    corrupt.sha256 = "a".repeat(64);
    assert!(matches!(
        install_executable(
            home.path(),
            "rust-analyzer",
            "rust-analyzer",
            &corrupt,
            &http,
            || {
                downloads.fetch_add(1, Ordering::SeqCst);
            },
        ),
        Err(CapabilityInstallError::Invalid)
    ));
    assert_eq!(store.current().unwrap().unwrap().package_root, previous);
    assert_eq!(downloads.load(Ordering::SeqCst), 2);
    // Mutating a cached executable must fail validation, even when the release binding matches.
    std::fs::write(
        previous
            .join("bin")
            .join(format!("rust-analyzer{}", std::env::consts::EXE_SUFFIX)),
        b"tampered",
    )
    .unwrap();
    assert!(
        install_executable(
            home.path(),
            "rust-analyzer",
            "rust-analyzer",
            &release,
            &http,
            || panic!("cache validation failure must not report a download"),
        )
        .is_err()
    );
}

#[test]
fn executable_zip_accepts_only_the_expected_regular_entry() {
    use std::io::Write;
    let home = tempfile::tempdir().unwrap();
    for name in [
        format!("rust-analyzer{}", std::env::consts::EXE_SUFFIX),
        "../escape".into(),
    ] {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file(&name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"verified executable").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let release = executable_release(&bytes, ExecutableArchive::Zip);
        let http = Download {
            bytes,
            calls: AtomicUsize::new(0),
        };
        let result = install_executable(
            home.path(),
            "rust-analyzer",
            "rust-analyzer",
            &release,
            &http,
            || {},
        );
        assert_eq!(result.is_ok(), !name.contains(".."));
    }
    assert!(!home.path().join("escape").exists());
}

#[test]
fn executable_zip_installs_the_binary_without_companion_debug_symbols() {
    use std::io::Write;
    let home = tempfile::tempdir().unwrap();
    let name = format!("rust-analyzer{}", std::env::consts::EXE_SUFFIX);
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    // The official Windows release includes a PDB. Only the named executable is installed,
    // regardless of archive order; companion entries never become filesystem paths.
    for (entry, contents) in [
        ("rust_analyzer.pdb", b"debug symbols".as_slice()),
        (name.as_str(), b"verified executable".as_slice()),
        ("../escape", b"ignored companion".as_slice()),
    ] {
        zip.start_file(entry, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(contents).unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    let release = executable_release(&bytes, ExecutableArchive::Zip);
    let http = Download {
        bytes,
        calls: AtomicUsize::new(0),
    };
    let installed = install_executable(
        home.path(),
        "rust-analyzer",
        "rust-analyzer",
        &release,
        &http,
        || {},
    )
    .unwrap();
    assert_eq!(
        std::fs::read(&installed.path).unwrap(),
        b"verified executable"
    );
    assert_eq!(
        std::fs::read_dir(installed.path.parent().unwrap())
            .unwrap()
            .count(),
        1
    );
    assert!(!home.path().join("escape").exists());
}

#[test]
fn executable_zip_rejects_a_symlink_in_place_of_the_binary() {
    let home = tempfile::tempdir().unwrap();
    let name = format!("rust-analyzer{}", std::env::consts::EXE_SUFFIX);
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.add_symlink(&name, "other", zip::write::SimpleFileOptions::default())
        .unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    let release = executable_release(&bytes, ExecutableArchive::Zip);
    let http = Download {
        bytes,
        calls: AtomicUsize::new(0),
    };
    assert!(matches!(
        install_executable(
            home.path(),
            "rust-analyzer",
            "rust-analyzer",
            &release,
            &http,
            || {},
        ),
        Err(CapabilityInstallError::Invalid)
    ));
    assert!(
        PackageStore::open(home.path().join("capabilities/rust-analyzer"))
            .unwrap()
            .current()
            .unwrap()
            .is_none()
    );
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
