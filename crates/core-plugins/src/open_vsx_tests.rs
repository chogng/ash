use super::*;
use crate::PluginPackageService;
use ash_http_client::HttpClientError;
use ash_http_client::HttpHeader;
use ash_http_client::HttpResponse;
use std::collections::BTreeMap;
use std::io::Cursor;
use std::io::Write;

#[derive(Default)]
struct FixtureHttp {
    responses: Mutex<BTreeMap<String, HttpResponse>>,
    requests: Mutex<Vec<String>>,
}

impl HttpClient for FixtureHttp {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        assert!(request.rejects_redirects());
        self.requests.lock().unwrap().push(request.url().into());
        self.responses
            .lock()
            .unwrap()
            .get(request.url())
            .cloned()
            .ok_or_else(|| {
                HttpClientError::Transport(format!("unexpected fixture URL: {}", request.url()))
            })
    }
}

fn vsix(version: &str, extra: Option<&str>) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let manifest = serde_json::json!({
        "name":"sample", "publisher":"publisher", "version":version,
        "main":"./out/main.js", "browser":"./out/browser.js",
        "contributes":{"languages":[{"id":"sample","extensions":[".sample"]}],
            "snippets":[{"language":"sample","path":"./snippets/sample.json"}]}
    });
    for (name, bytes) in [
        ("extension/package.json", manifest.to_string().into_bytes()),
        (
            "extension/snippets/sample.json",
            br#"{"sample":{"prefix":"sample","body":"value"}}"#.to_vec(),
        ),
        (
            "extension/out/main.js",
            b"throw new Error('must never run');".to_vec(),
        ),
        (
            "extension/out/browser.js",
            b"throw new Error('must never run');".to_vec(),
        ),
        ("extension.vsixmanifest", b"<PackageManifest />".to_vec()),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    if let Some(path) = extra {
        zip.start_file(path, options).unwrap();
        zip.write_all(b"outside").unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn client(http: Arc<FixtureHttp>) -> Arc<OpenVsxClient> {
    Arc::new(OpenVsxClient {
        config: OpenVsxConfig::new(
            Url::parse("https://registry.example/api/").unwrap(),
            vec![Url::parse("https://cdn.example/").unwrap()],
        )
        .unwrap(),
        http,
        resolved: Mutex::new(None),
    })
}

fn release(http: &FixtureHttp, version: &str, bytes: Vec<u8>) {
    let mut responses = http.responses.lock().unwrap();
    let metadata = serde_json::json!({
        "namespace":"publisher", "name":"sample", "version":version,
        "displayName":"Sample extension", "description":"Fixture", "license":"MIT",
        "targetPlatform":"universal", "preRelease":false, "downloadable":true, "verified":true,
        "files":{"download":format!("https://registry.example/api/publisher/sample/{version}/file/package.vsix"),
            "sha256":format!("https://registry.example/api/publisher/sample/{version}/file/package.sha256")}
    });
    for selected in [version, "latest"] {
        responses.insert(
            format!("https://registry.example/api/publisher/sample/universal/{selected}"),
            HttpResponse::new(200, Vec::new(), metadata.to_string().into_bytes()),
        );
    }
    responses.insert(
        format!("https://registry.example/api/publisher/sample/{version}/file/package.sha256"),
        HttpResponse::new(
            200,
            Vec::new(),
            format!("{:x}", Sha256::digest(&bytes)).into_bytes(),
        ),
    );
    responses.insert(
        format!("https://registry.example/api/publisher/sample/{version}/file/package.vsix"),
        HttpResponse::new(
            302,
            vec![HttpHeader::new(
                "location",
                format!("https://cdn.example/sample-{version}.vsix"),
            )],
            Vec::new(),
        ),
    );
    responses.insert(
        format!("https://cdn.example/sample-{version}.vsix"),
        HttpResponse::new(200, Vec::new(), bytes),
    );
}

#[test]
fn search_uses_open_vsx_without_downloading_packages_and_preserves_named_source() {
    let http = Arc::new(FixtureHttp::default());
    let search = "https://registry.example/api/-/search?query=sample+language&size=50&targetPlatform=universal";
    http.responses.lock().unwrap().insert(search.into(), HttpResponse::new(200, Vec::new(), br#"{"extensions":[{"namespace":"publisher","name":"sample","version":"1.0.0","displayName":"Sample","description":"Fixture"}]}"#.to_vec()));
    let providers = crate::PluginProviders::new([(
        ash_plugin::MarketplaceName::new("open-vsx").unwrap(),
        client(Arc::clone(&http)) as Arc<dyn PluginProvider>,
    )])
    .unwrap();
    let results = providers
        .search(SearchPackagesRequest {
            query: "sample language".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        results.packages,
        vec![PackageSummary {
            id: "publisher.sample@open-vsx".into(),
            version: "1.0.0".into(),
            package_type: PACKAGE_TYPE.into(),
            display_name: "Sample".into(),
            description: "Fixture".into()
        }]
    );
    assert_eq!(*http.requests.lock().unwrap(), vec![search]);
    assert!(
        providers
            .search(SearchPackagesRequest {
                capability_kind: Some(CapabilityKind::Skill),
                ..Default::default()
            })
            .unwrap()
            .packages
            .is_empty()
    );
}

#[test]
fn gallery_reads_verified_resources_without_installing_or_activating_the_package() {
    let http = Arc::new(FixtureHttp::default());
    release(&http, "1.0.0", vsix("1.0.0", None));
    let root = tempfile::tempdir().unwrap();
    let manager = crate::PluginsManager::open(
        root.path(),
        crate::PluginProviders::new([(
            ash_plugin::MarketplaceName::new("custom-source").unwrap(),
            client(Arc::clone(&http)) as Arc<dyn PluginProvider>,
        )])
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        manager.extension_gallery_resource_url_template().unwrap(),
        Some(
            "https://registry.example/api/{publisher}/{name}/universal/{version}/file/{path}"
                .into()
        )
    );
    let manifest = manager
        .read_extension_gallery_resource("publisher", "sample", "1.0.0", "package.json")
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&manifest).unwrap()["version"],
        "1.0.0"
    );
    assert_eq!(
        manager
            .read_extension_gallery_resource("publisher", "sample", "1.0.0", "snippets/sample.json")
            .unwrap(),
        br#"{"sample":{"prefix":"sample","body":"value"}}"#
    );
    assert!(
        manager
            .list_installed(crate::ListInstalledRequest {})
            .unwrap()
            .is_empty()
    );
    assert!(
        manager
            .local_capability_sources(CapabilityKind::EditorExtension)
            .unwrap()
            .is_empty()
    );
    let requests = http.requests.lock().unwrap().len();
    for path in [
        "../package.json",
        "/package.json",
        "a/../package.json",
        "a\\file",
        "a:stream",
        "a//file",
    ] {
        assert!(
            manager
                .read_extension_gallery_resource("publisher", "sample", "1.0.0", path)
                .is_err(),
            "{path}"
        );
    }
    assert_eq!(http.requests.lock().unwrap().len(), requests);
    assert!(
        manager
            .read_extension_gallery_resource("publisher", "sample", "1.0.0", "missing.json")
            .is_err()
    );
}

#[test]
fn install_update_reopen_and_uninstall_use_the_existing_manager_without_running_scripts() {
    let http = Arc::new(FixtureHttp::default());
    release(&http, "1.0.0", vsix("1.0.0", None));
    let client = client(Arc::clone(&http));
    let root = tempfile::tempdir().unwrap();
    let providers = || {
        crate::PluginProviders::new([(
            ash_plugin::MarketplaceName::new("open-vsx").unwrap(),
            Arc::clone(&client) as Arc<dyn PluginProvider>,
        )])
        .unwrap()
    };
    let manager = crate::PluginsManager::open(root.path(), providers()).unwrap();
    let details = manager
        .get(GetPackageRequest {
            package_id: "publisher.sample@open-vsx".into(),
            version: Some("1.0.0".into()),
        })
        .unwrap();
    let installed = manager
        .install(crate::InstallPackageRequest {
            package_id: details.package.id.clone(),
            version: Some(details.package.version),
        })
        .unwrap();
    assert_eq!(installed.package.digest, details.package.digest);
    let sources = manager
        .local_capability_sources(CapabilityKind::EditorExtension)
        .unwrap();
    assert_eq!(sources.len(), 1);
    assert!(sources[0].host_path().join("package.json").is_file());
    assert!(sources[0].host_path().join("out/browser.js").is_file());
    assert_eq!(
        manager
            .acquire_capability(crate::AcquireCapabilityRequest {
                capability: installed.capabilities[0].reference.clone()
            })
            .unwrap_err()
            .kind(),
        crate::MarketplaceClientErrorKind::Remote(
            crate::MarketplaceErrorCode::CapabilityUnsupported
        )
    );
    // Details and installation share the exact verified payload; a second metadata/checksum read
    // still runs so a stale cache cannot hide a changed release.
    assert_eq!(
        http.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|url| url.starts_with("https://cdn.example/"))
            .count(),
        1
    );
    release(&http, "2.0.0", vsix("2.0.0", None));
    let updated = manager
        .update(crate::UpdatePackageRequest {
            installation_id: installed.installation_id,
            version: Some("2.0.0".into()),
        })
        .unwrap();
    assert_eq!(updated.package.version, "2.0.0");
    drop(manager);
    let manager = crate::PluginsManager::open(root.path(), providers()).unwrap();
    assert_eq!(
        manager
            .list_installed(crate::ListInstalledRequest {})
            .unwrap(),
        vec![updated.clone()]
    );
    manager
        .uninstall(crate::UninstallPackageRequest {
            installation_id: updated.installation_id,
            mode: crate::UninstallMode::IfUnused,
        })
        .unwrap();
    assert!(
        manager
            .local_capability_sources(CapabilityKind::EditorExtension)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn untrusted_archive_and_escape_paths_do_not_install() {
    for case in ["checksum", "identity", "traversal"] {
        let http = Arc::new(FixtureHttp::default());
        let bytes = vsix(
            if case == "identity" { "9.0.0" } else { "1.0.0" },
            if case == "traversal" {
                Some("../outside")
            } else {
                None
            },
        );
        release(&http, "1.0.0", bytes);
        if case == "checksum" {
            http.responses.lock().unwrap().insert(
                "https://registry.example/api/publisher/sample/1.0.0/file/package.sha256".into(),
                HttpResponse::new(200, Vec::new(), "0".repeat(64).into_bytes()),
            );
        }
        let error = client(http)
            .get(GetPackageRequest {
                package_id: "publisher.sample".into(),
                version: Some("1.0.0".into()),
            })
            .unwrap_err();
        assert_eq!(
            error.kind(),
            crate::MarketplaceClientErrorKind::Remote(
                crate::MarketplaceErrorCode::PackageUntrusted
            ),
            "{case}"
        );
    }
}

#[test]
fn registry_cannot_redirect_to_unapproved_hosts_or_downgrade_https() {
    for location in [
        "https://attacker.example/package.vsix",
        "http://cdn.example/package.vsix",
        "https://user:secret@cdn.example/package.vsix",
    ] {
        let http = Arc::new(FixtureHttp::default());
        release(&http, "1.0.0", vsix("1.0.0", None));
        http.responses.lock().unwrap().insert(
            "https://registry.example/api/publisher/sample/1.0.0/file/package.vsix".into(),
            HttpResponse::new(302, vec![HttpHeader::new("location", location)], Vec::new()),
        );
        assert!(
            client(Arc::clone(&http))
                .get(GetPackageRequest {
                    package_id: "publisher.sample".into(),
                    version: Some("1.0.0".into())
                })
                .is_err()
        );
        assert!(
            !http
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|url| url == location)
        );
    }
}

#[test]
fn invalid_identifiers_and_platforms_cannot_select_another_package() {
    for id in [
        "publisher.sample/../other",
        "publisher.%2e%2e",
        "publisher.sample@other",
        "publisher.sample.extra",
    ] {
        assert!(extension_name(id).is_err());
    }
    let http = Arc::new(FixtureHttp::default());
    release(&http, "1.0.0", vsix("1.0.0", None));
    let key = "https://registry.example/api/publisher/sample/universal/1.0.0";
    let mut responses = http.responses.lock().unwrap();
    let mut document: serde_json::Value = serde_json::from_slice(responses[key].body()).unwrap();
    document["targetPlatform"] = "linux-x64".into();
    responses.insert(
        key.into(),
        HttpResponse::new(200, Vec::new(), document.to_string().into_bytes()),
    );
    drop(responses);
    assert!(
        client(http)
            .get(GetPackageRequest {
                package_id: "publisher.sample".into(),
                version: Some("1.0.0".into())
            })
            .is_err()
    );
}

/// Explicit network check: normal test runs stay deterministic and never install into a user profile.
#[test]
#[ignore = "requires access to the public Open VSX registry"]
fn live_open_vsx_installs_and_removes_a_universal_vsix() {
    let client = Arc::new(
        OpenVsxClient::new(
            OpenVsxConfig::new(
                Url::parse("https://open-vsx.org/api/").unwrap(),
                vec![Url::parse("https://openvsx.eclipsecontent.org/").unwrap()],
            )
            .unwrap(),
        )
        .unwrap(),
    );
    let root = tempfile::tempdir().unwrap();
    let manager = crate::PluginsManager::open(
        root.path(),
        crate::PluginProviders::new([(
            ash_plugin::MarketplaceName::new("open-vsx").unwrap(),
            client as Arc<dyn PluginProvider>,
        )])
        .unwrap(),
    )
    .unwrap();
    let results = manager
        .search(SearchPackagesRequest {
            query: "git-base".into(),
            capability_kind: Some(CapabilityKind::EditorExtension),
            ..Default::default()
        })
        .unwrap();
    assert!(
        results
            .packages
            .iter()
            .any(|entry| entry.id == "vscode.git-base@open-vsx")
    );
    let details = manager
        .get(GetPackageRequest {
            package_id: "vscode.git-base@open-vsx".into(),
            version: Some("1.95.3".into()),
        })
        .unwrap();
    let installed = manager
        .install(crate::InstallPackageRequest {
            package_id: details.package.id,
            version: Some(details.package.version),
        })
        .unwrap();
    assert_eq!(installed.package.digest, details.package.digest);
    let sources = manager
        .local_capability_sources(CapabilityKind::EditorExtension)
        .unwrap();
    assert_eq!(sources.len(), 1);
    assert!(sources[0].host_path().join("package.json").is_file());
    manager
        .uninstall(crate::UninstallPackageRequest {
            installation_id: installed.installation_id,
            mode: crate::UninstallMode::IfUnused,
        })
        .unwrap();
    assert!(
        manager
            .local_capability_sources(CapabilityKind::EditorExtension)
            .unwrap()
            .is_empty()
    );
}
