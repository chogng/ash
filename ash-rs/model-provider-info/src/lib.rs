//! Model metadata, base instructions, and connection declarations shared without request clients.

mod config;
mod connection;
mod definition;
mod error;
mod input_token_count;
mod model_catalog;
mod providers;
mod registry;
mod static_model_spec;
mod voice;
pub use voice::ResolvedVoiceModel;
pub use voice::VoiceModelCatalog;
pub use voice::VoiceModelConfig;
pub use voice::VoiceModelDefinition;

pub use ash_protocol::Model;
pub use ash_protocol::ModelId;
pub use ash_protocol::ModelOutputTransport;
pub use ash_protocol::ProviderId;
pub use config::CustomProviderConfig;
pub use config::CustomProviderProtocol;
pub use config::ModelContextConfig;
pub use config::ModelProviderConfig;
pub use config::NormalizedModelProviderConfig;
pub use config::ProviderAccessMode;
pub use definition::ApiKeyHeader;
pub use definition::ApiKeyPolicy;
pub use definition::ApiProfile;
pub use definition::ApprovalReviewModelDefault;
pub use definition::BaseUrlNormalization;
pub use definition::EndpointPolicy;
pub use definition::ModelCatalogPolicy;
pub use definition::ProviderAdapter;
pub use definition::ProviderDefaults;
pub use definition::ProviderDefinition;
pub use definition::WebSocketApiProfile;
pub use error::ProviderConfigError;
pub use input_token_count::InputTokenCountDefinition;
pub use input_token_count::InputTokenCountModelPolicy;
pub use input_token_count::InputTokenCountProfile;
pub use input_token_count::InputTokenCountTarget;
pub use input_token_count::NormalizedInputTokenCountConfig;
pub use model_catalog::STATIC_MODEL_CATALOG;
pub use model_catalog::find_static_model;
pub use model_catalog::model_catalog_schema;
pub use providers::bigmodel::BIGMODEL_CODING_PLAN_BASE_URL;
pub use providers::zai::ZAI_CODING_PLAN_BASE_URL;
pub use registry::ProviderConfigRegistry;
pub use registry::RegistryMergePolicy;
pub use static_model_spec::ModelInstructions;
pub use static_model_spec::StaticModelSpec;

use schemars::{Schema, schema_for};

pub fn model_provider_config_schema() -> Schema {
    schema_for!(ModelProviderConfig)
}

pub fn provider_definition_schema() -> Schema {
    schema_for!(ProviderDefinition)
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;

pub use definition::LiveApiProfile;
pub use definition::RealtimeApiProfile;
pub use definition::TranscriptionApiProfile;

pub use ash_protocol::ModelConnectionId;
pub use connection::ModelConnectionDefinition;
pub use connection::ModelConnectionRuntime;
pub use connection::builtin_connections;
pub use connection::connection_priority;
pub use connection::connection_provider;

pub use connection::legacy_model_providers;
