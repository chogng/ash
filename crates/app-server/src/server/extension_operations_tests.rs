use super::extension_catalog_error;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use extension_catalog::ExtensionCatalogError;

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
    );
    assert_eq!(
        server.extension_gallery(&serde_json::json!({})).unwrap(),
        serde_json::json!({"resourceUrlTemplate": null})
    );
    let connection = server.connection();
    let error = server.extension_gallery_resource_open(&connection, &serde_json::json!({
                "resourceUrlTemplate": "https://registry.example/api/{publisher}/{name}/universal/{version}/file/{path}", "publisher": "publisher", "name": "sample", "version": "1.0.0", "path": "package.json"
    })).unwrap_err();
    assert_eq!(error.message, AppServerErrorName::PluginsUnavailable);
    let invalid = server.extension_gallery_resource_open(&connection, &serde_json::json!({
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
    let manager = ash_core_plugins::PluginsManager::open(
        root.path(),
        ash_core_plugins::PluginProviders::new([(
            ash_plugin::MarketplaceName::new("configured-source").unwrap(),
            Arc::new(GalleryWithoutIo) as Arc<dyn ash_core_plugins::PluginProvider>,
        )])
        .unwrap(),
    )
    .unwrap();
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_plugins_manager(Arc::new(manager));
    let template =
        "https://registry.example/api/{publisher}/{name}/universal/{version}/file/{path}";
    assert_eq!(
        server.extension_gallery(&serde_json::json!({})).unwrap(),
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

impl ash_core_plugins::PluginProvider for GalleryWithoutIo {
    fn extension_gallery_resource_url_template(&self) -> Option<String> {
        Some(
            "https://registry.example/api/{publisher}/{name}/universal/{version}/file/{path}"
                .into(),
        )
    }
    fn search(
        &self,
        _: ash_core_plugins::SearchPackagesRequest,
    ) -> Result<ash_core_plugins::SearchPackagesResult, ash_core_plugins::MarketplaceClientError>
    {
        panic!("Gallery resolution must not search packages");
    }
    fn get(
        &self,
        _: ash_core_plugins::GetPackageRequest,
    ) -> Result<ash_core_plugins::PackageDetails, ash_core_plugins::MarketplaceClientError> {
        panic!("A stale gallery must not resolve packages");
    }
    fn download(
        &self,
        _: ash_core_plugins::DownloadPackageRequest,
    ) -> Result<
        Box<dyn ash_core_plugins::PluginPackagePayload>,
        ash_core_plugins::MarketplaceClientError,
    > {
        panic!("A stale gallery must not download packages");
    }
}

#[test]
fn stale_extension_generations_have_a_distinct_rpc_error() {
    let error = extension_catalog_error(ExtensionCatalogError::GenerationConflict);

    assert_eq!(error.code, -32040);
    assert_eq!(
        error.message,
        AppServerErrorName::ExtensionGenerationConflict
    );
}
