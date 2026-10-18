//! Product assembly for the shared App Server runtime and concrete request adapters.

pub use ash_app_server_runtime::*;

/// Opens the product's shared runtime with its stateless diff adapter.
pub fn open_app_server(options: AppServerOptions) -> Result<AppServer, OpenAppServerError> {
    ash_app_server_runtime::open_app_server(options, ash_app_server_diff::compute)
}

/// Opens the product runtime with explicit cloud codebase providers.
pub fn open_app_server_with_cloud_providers(
    options: AppServerOptions,
    providers: ash_cloud_codebase::CloudCodebaseProviderRegistry,
) -> Result<AppServer, OpenAppServerError> {
    ash_app_server_runtime::open_app_server_with_cloud_providers(
        options,
        providers,
        ash_app_server_diff::compute,
    )
}

/// Opens the product runtime with explicit semantic and remote codebase providers.
pub fn open_app_server_with_codebase_providers(
    options: AppServerOptions,
    providers: CodebaseProviders,
) -> Result<AppServer, OpenAppServerError> {
    ash_app_server_runtime::open_app_server_with_codebase_providers(
        options,
        providers,
        ash_app_server_diff::compute,
    )
}

/// Runs this product's listening entrypoint with its concrete adapters.
pub fn run(arguments: impl IntoIterator<Item = String>) -> Result<(), String> {
    ash_app_server_runtime::run(arguments, ash_app_server_diff::compute)
}
