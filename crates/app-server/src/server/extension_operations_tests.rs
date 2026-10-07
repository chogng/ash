use super::extension_catalog_error;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use extension_catalog::ExtensionCatalogError;

#[test]
fn stale_extension_generations_have_a_distinct_rpc_error() {
    let error = extension_catalog_error(ExtensionCatalogError::GenerationConflict);

    assert_eq!(error.code, -32040);
    assert_eq!(
        error.message,
        AppServerErrorName::ExtensionGenerationConflict
    );
}
