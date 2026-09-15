//! Model-provider instantiation, transport configuration, and API adaptation.

mod auth;
mod catalog;
mod diagnostics;
mod error;
mod lazy_client;
mod provider;
mod providers;
mod semantic_models;
mod semantic_runtime;

pub use ash_api::ApiError;
pub use ash_api::ApiProtocol;
pub use ash_model_tokenizer::HttpTokenizerAssetDownloader;
pub use ash_model_tokenizer::HuggingFaceTokenizerAssetDiscoverer;
pub use ash_model_tokenizer::LocalTokenCount;
pub use ash_model_tokenizer::LocalTokenizationOutcome;
pub use ash_model_tokenizer::LocalTokenizerBinding;
pub use ash_model_tokenizer::LocalTokenizerError;
pub use ash_model_tokenizer::LocalTokenizerRegistry;
pub use ash_model_tokenizer::LocalTokenizerService;
pub use ash_model_tokenizer::ManagedLocalTokenizerService;
pub use ash_model_tokenizer::MemoryTokenizerCapacity;
pub use ash_model_tokenizer::PinnedTokenizerAsset;
pub use ash_model_tokenizer::RemoteTokenizerAsset;
pub use ash_model_tokenizer::TokenizerAssetCatalog;
pub use ash_model_tokenizer::TokenizerAssetDownloader;
pub use ash_model_tokenizer::TokenizerAssetManifest;
pub use ash_model_tokenizer::TokenizerPreparationStatus;
pub use ash_protocol::CapabilitySupport;
pub use ash_protocol::ContextWindow;
pub use ash_protocol::Model;
pub use ash_protocol::ModelCapabilities;
pub use ash_protocol::ModelId;
pub use ash_protocol::ModelOutputTransport;
pub use ash_protocol::ModelRef;
pub use ash_protocol::ProviderId;
pub use catalog::ModelCatalogBinding;
pub use error::ModelProviderError;
pub use provider::EchoModel;
pub use provider::ModelEventSink;
pub use provider::ModelInvoker;
pub use provider::ModelProvider;
pub use provider::ModelProviderRuntime;
pub use provider::ModelRuntimeRequest;
pub use provider::Provider;
pub use provider::UnavailableModel;
pub use semantic_models::EmbeddingInvoker;
pub use semantic_models::EmbeddingRequest;
pub use semantic_models::EmbeddingResponse;
pub use semantic_models::EmbeddingRuntimeIdentity;
pub use semantic_models::EmbeddingRuntimeRequest;
pub use semantic_models::EmbeddingVector;
pub use semantic_models::RerankInvoker;
pub use semantic_models::RerankRequest;
pub use semantic_models::RerankResponse;
pub use semantic_models::RerankRuntimeRequest;
pub use semantic_models::SemanticModelProvider;
pub use semantic_models::SemanticRuntimeLocation;

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "auth_tests.rs"]
mod auth_tests;

#[cfg(test)]
#[path = "semantic_model_tests.rs"]
mod semantic_model_tests;
pub use auth::ProviderCredentialError;
pub use auth::ProviderCredentialService;
pub use auth::ProviderCredentialStatus;
pub use auth::provider_api_key_secret_key;

pub use provider::ResponsesModelSession;
