//! JSON-RPC application boundary between product clients and Ash's domain components.

mod attachment_upload_store;
mod browser_host;
mod browser_tool;
mod codebase_retrieval_context;
mod codebase_retrieval_tool;
mod debug_service;
mod dir_grants;
mod dynamic_tools;
mod execution_environments;
mod extension_tools;
mod git_service;
mod local;
mod local_tools;
mod marketplace_editor_extensions;
mod mcp_runtime;
mod model_catalog;
mod model_provider_error;
mod network_policy;
mod product_services;
mod resource_store;
mod server;
mod tool_composition;
mod tool_executor_adapter;
mod tool_search_embedding;
mod tool_search_models;
mod trace;

pub use ash_extensions::ExtensionRoot;
pub use ash_extensions::ExtensionRootKind;
pub use ash_slash_commands::SlashCommandCatalog;
pub use ash_slash_commands::SlashCommandCatalogError;
pub use dynamic_tools::DynamicToolCompositionError;
pub use guardian_v2::ProviderReviewModel;
pub use guardian_v2::ReviewModelResolutionError;
pub use guardian_v2::ReviewModelResolver;
pub use local::BuiltInSkillRoot;
pub use local::LocalAppServerOptions;
pub use local::LocalCodebaseProviders;
pub use local::LocalConnectorRuntime;
pub use local::LocalDirConfigOptions;
pub use local::LocalProfileRuntime;
pub use local::OpenAppServerError;
pub use local::SessionStateMode;
pub use local::open_local_app_server;
pub use local::open_local_app_server_with_cloud_providers;
pub use local::open_local_app_server_with_codebase_providers;
pub use marketplace_editor_extensions::MarketplaceEditorExtensionAdmission;
pub use marketplace_editor_extensions::MarketplaceEditorExtensionAdmissionLease;
pub use marketplace_editor_extensions::MarketplaceEditorExtensionBinding;
pub use product_services::LocalProductServicesConfig;
pub use server::AppServer;
pub use server::CodebaseModels;
pub use server::ConnectionNotifications;
pub use server::ConnectionState;

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "protocol_schema_tests.rs"]
mod protocol_schema_tests;

mod product_discovery;
mod startup;
pub use product_discovery::load_discovered_product_services;
pub use startup::run;

mod managed;

mod image_references;
mod time_context;
