use super::extension_catalog_error;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_external_ext::packages::ExtensionPackagesError;

#[test]
fn renderer_admission_is_projected_from_the_catalog_proof_and_omitted_after_revocation() {
    use ash_external_ext::packages::ExtensionDescriptor;
    use ash_external_ext::packages::ExtensionRendererClient;
    use ash_external_ext::packages::ExtensionSourceKind;
    let digest = format!("sha256:{}", "a".repeat(64));
    let mut descriptor = ExtensionDescriptor {
        id: "ash.academic".into(),
        name: "academic".into(),
        publisher: "ash".into(),
        version: "1.0.0".into(),
        display_name: "Academy".into(),
        source_kind: ExtensionSourceKind::Registry,
        extension_location: std::env::temp_dir(),
        manifest_json: r#"{"rendererClient":{"runtimeId":"untrusted"}}"#.into(),
        manifest_sha256: digest.clone(),
        package_sha256: digest.clone(),
        renderer_client: Some(ExtensionRendererClient {
            runtime_id: "ash.academic".into(),
            api_version: 1,
            entry: "dist/editor.js".into(),
            digest: digest.clone(),
            style: "dist/editor.css".into(),
            style_digest: digest.clone(),
            source_digest: digest,
        }),
    };
    let admitted = serde_json::to_value(super::extension_descriptor(descriptor.clone())).unwrap();
    assert_eq!(admitted["rendererClient"]["runtimeId"], "ash.academic");
    assert_eq!(admitted["rendererClient"]["apiVersion"], 1);
    assert_eq!(admitted["packageSha256"], descriptor.package_sha256);
    let wire: ash_app_server_protocol::protocol::extensions::ExtensionDto =
        serde_json::from_value(admitted).unwrap();
    assert_eq!(wire.renderer_client.unwrap().runtime_id, "ash.academic");
    descriptor.renderer_client = None;
    let revoked = serde_json::to_value(super::extension_descriptor(descriptor)).unwrap();
    assert!(revoked.get("rendererClient").is_none());
}

#[test]
fn an_unconfigured_gallery_is_reported_without_exposing_a_resource() {
    use crate::local::ProviderModelService;
    use crate::server::AppServer;
    use ash_core::InMemoryThreadStore;
    use ash_core::ThreadController;
    use ash_model_provider::EchoModel;
    use std::sync::Arc;
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
        ash_app_server_diff::compute,
    );
    assert_eq!(
        server
            .extension_processor()
            .extension_gallery(&serde_json::json!({}))
            .unwrap(),
        serde_json::json!({"resourceUrlTemplate": null})
    );
    let connection = server.connection();
    let error = server.extension_processor().extension_gallery_resource_open(&connection, &serde_json::json!({
                "resourceUrlTemplate": "https://registry.example/api/{publisher}/{name}/universal/{version}/file/{path}", "publisher": "publisher", "name": "sample", "version": "1.0.0", "path": "package.json"
    })).unwrap_err();
    assert_eq!(error.message, AppServerErrorName::PluginsUnavailable);
    let invalid = server.extension_processor().extension_gallery_resource_open(&connection, &serde_json::json!({
                "resourceUrlTemplate": "https://registry.example/api/{publisher}/{name}/universal/{version}/file/{path}", "publisher": "publisher", "name": "sample", "version": "1.0.0", "path": "package.json", "hostPath": "/outside"
    })).unwrap_err();
    assert_eq!(invalid.message, AppServerErrorName::InvalidParams);
}

#[test]
fn a_changed_gallery_is_rejected_before_provider_io() {
    use crate::local::ProviderModelService;
    use crate::server::AppServer;
    use ash_core::InMemoryThreadStore;
    use ash_core::ThreadController;
    use ash_model_provider::EchoModel;
    use std::sync::Arc;
    let root = tempfile::tempdir().unwrap();
    let manager = ash_core_plugins::ExtensionPackageManager::open(
        root.path(),
        ash_core_plugins::ExtensionSources::new([(
            ash_utils_plugins::ExtensionSourceId::new("configured-source").unwrap(),
            Arc::new(GalleryWithoutIo) as Arc<dyn ash_core_plugins::ExtensionSource>,
        )])
        .unwrap(),
    )
    .unwrap();
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
        ash_app_server_diff::compute,
    )
    .with_plugins_manager(Arc::new(manager));
    let template =
        "https://registry.example/api/{publisher}/{name}/universal/{version}/file/{path}";
    assert_eq!(
        server
            .extension_processor()
            .extension_gallery(&serde_json::json!({}))
            .unwrap(),
        serde_json::json!({"resourceUrlTemplate": template})
    );
    let mut connection = server.connection();
    let initialize = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{}}});
    let initialized: serde_json::Value =
        serde_json::from_str(&server.handle_json(&mut connection, &initialize.to_string()))
            .unwrap();
    assert_eq!(
        initialized["result"]["capabilities"]["contracts"]["extensionGalleryResources"]["version"],
        1
    );
    let request = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"extensions/gallery/resource/open","params": {
        "resourceUrlTemplate": "https://previous.example/api/{publisher}/{name}/universal/{version}/file/{path}",
        "publisher":"publisher","name":"sample","version":"1.0.0","path":"package.json"
    }});
    let response: serde_json::Value =
        serde_json::from_str(&server.handle_json(&mut connection, &request.to_string())).unwrap();
    assert_eq!(response["error"]["message"], "InvalidParams");
}

struct GalleryWithoutIo;

impl ash_core_plugins::ExtensionSource for GalleryWithoutIo {
    fn extension_gallery_resource_url_template(&self) -> Option<String> {
        Some(
            "https://registry.example/api/{publisher}/{name}/universal/{version}/file/{path}"
                .into(),
        )
    }
    fn search(
        &self,
        _: ash_core_plugins::SearchPackagesRequest,
    ) -> Result<ash_core_plugins::SearchPackagesResult, ash_core_plugins::ExtensionsClientError>
    {
        panic!("Gallery resolution must not search packages");
    }
    fn get(
        &self,
        _: ash_core_plugins::GetPackageRequest,
    ) -> Result<ash_core_plugins::PackageDetails, ash_core_plugins::ExtensionsClientError> {
        panic!("A stale gallery must not resolve packages");
    }
    fn download(
        &self,
        _: ash_core_plugins::DownloadPackageRequest,
    ) -> Result<
        Box<dyn ash_core_plugins::ExtensionPackagePayload>,
        ash_core_plugins::ExtensionsClientError,
    > {
        panic!("A stale gallery must not download packages");
    }
}

#[test]
fn stale_extension_generations_have_a_distinct_rpc_error() {
    let error = extension_catalog_error(ExtensionPackagesError::GenerationConflict);

    assert_eq!(error.code, -32040);
    assert_eq!(
        error.message,
        AppServerErrorName::ExtensionGenerationConflict
    );
}

#[test]
fn extension_catalog_exposes_its_authorized_package_location_and_execution_platform() {
    use crate::local::ProviderModelService;
    use crate::server::AppServer;
    use ash_core::InMemoryThreadStore;
    use ash_core::ThreadController;
    use ash_external_ext::packages::ExtensionRoot;
    use ash_model_provider::EchoModel;
    use std::sync::Arc;
    let root = tempfile::tempdir().unwrap();
    let package = root.path().join("package with spaces");
    std::fs::create_dir(&package).unwrap();
    std::fs::write(package.join("package.json"), r#"{"name":"debugger","publisher":"test","version":"1.0.0","contributes":{"debuggers":[{"type":"test","program":"adapter.js","runtime":"node"}]}}"#).unwrap();
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
        ash_app_server_diff::compute,
    )
    .with_extension_roots(vec![ExtensionRoot::user(root.path())]);
    let catalog = server
        .extension_processor()
        .extension_list(&serde_json::json!({"reload":"refresh"}))
        .unwrap();
    let extension = &catalog["extensions"][0];
    let location = url::Url::parse(extension["extensionLocation"].as_str().unwrap()).unwrap();
    assert_eq!(
        location.to_file_path().unwrap(),
        std::fs::canonicalize(&package).unwrap()
    );
    let expected_os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        value => value,
    };
    assert!(
        extension["targetPlatform"]
            .as_str()
            .unwrap()
            .starts_with(&format!("{expected_os}-"))
    );
    let wire: ash_app_server_protocol::protocol::extensions::ExtensionListResult =
        serde_json::from_value(catalog).unwrap();
    assert_eq!(wire.extensions[0].id, "test.debugger");
}

#[test]
fn extension_catalog_serves_built_in_language_pack_resources_from_the_rust_snapshot() {
    use crate::local::ProviderModelService;
    use crate::server::AppServer;
    use ash_core::InMemoryThreadStore;
    use ash_core::ThreadController;
    use ash_external_ext::packages::ExtensionRoot;
    use ash_model_provider::EchoModel;
    use base64::Engine;
    use std::sync::Arc;

    let root = tempfile::tempdir().unwrap();
    let package = root.path().join("language-pack-zh-cn");
    std::fs::create_dir_all(package.join("localization")).unwrap();
    std::fs::write(
        package.join("package.json"),
        include_str!("../../../../extensions/language-pack-zh-cn/package.json"),
    )
    .unwrap();
    let chinese = r#"{"locale":"zh-CN","bundles":{"ash":{"example":"示例"}}}"#;
    std::fs::write(package.join("localization/package.json"), chinese).unwrap();
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
        ash_app_server_diff::compute,
    )
    .with_extension_roots(vec![ExtensionRoot::built_in(root.path())]);
    let catalog = server
        .extension_processor()
        .extension_list(&serde_json::json!({"reload":"refresh"}))
        .unwrap();
    assert_eq!(catalog["extensions"][0]["id"], "ash.language-pack-zh-cn");
    assert_eq!(catalog["extensions"][0]["sourceKind"], "builtIn");
    assert_eq!(catalog["diagnostics"], serde_json::json!([]));
    let connection = server.connection();
    let opened = server.extension_processor().extension_resource_open(&connection, &serde_json::json!({
        "generation": catalog["generation"], "extensionId": "ash.language-pack-zh-cn", "path": "localization/package.json",
    })).unwrap();
    // Published bytes remain frozen even if a development build updates the file in place.
    std::fs::write(package.join("localization/package.json"), "{}").unwrap();
    let chunk = server
        .resources_processor()
        .resource_read(
            &connection,
            &serde_json::json!({
                "resourceId": opened["resource"]["resourceId"], "offset": 0, "maxBytes": 262144,
            }),
        )
        .unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(chunk["dataBase64"].as_str().unwrap())
            .unwrap(),
        chinese.as_bytes()
    );
    let other_connection = server.connection();
    assert!(
        server
            .resources_processor()
            .resource_read(
                &other_connection,
                &serde_json::json!({
                    "resourceId": opened["resource"]["resourceId"], "offset": 0, "maxBytes": 262144,
                })
            )
            .is_err()
    );
}
