use std::sync::Arc;

use ash_model_provider_config::ApiKeyPolicy;
use ash_model_provider_config::ProviderConfigRegistry;
use ash_model_provider_config::ProviderId;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;

use crate::ProviderCredentialError;
use crate::ProviderCredentialService;
use crate::provider_api_key_secret_key;

#[test]
fn catalog_reports_every_builtin_without_exposing_values() {
    let secrets = Arc::new(MemorySecretStore::default());
    let openai = provider("openai");
    secrets
        .store(
            &provider_api_key_secret_key(&openai),
            &SecretValue::new(b"secret-openai-key".to_vec()),
        )
        .unwrap();
    let service = ProviderCredentialService::new(ProviderConfigRegistry::builtin(), secrets);

    let catalog = service.catalog().unwrap();

    assert_eq!(catalog.len(), 14);
    assert!(catalog.iter().any(|entry| {
        entry.provider == openai
            && entry.api_key_policy == ApiKeyPolicy::Required
            && entry.api_key_configured
    }));
    assert!(catalog.iter().any(|entry| {
        entry.provider == provider("ollama")
            && entry.api_key_policy == ApiKeyPolicy::Unsupported
            && !entry.api_key_configured
    }));
}

#[test]
fn stored_keys_resolve_through_each_declared_header_shape() {
    let secrets = Arc::new(MemorySecretStore::default());
    let service =
        ProviderCredentialService::new(ProviderConfigRegistry::builtin(), secrets.clone());

    for (provider, header, value) in [
        ("openai", "Authorization", "Bearer openai-key"),
        ("anthropic", "x-api-key", "anthropic-key"),
        ("google", "Authorization", "Bearer google-key"),
    ] {
        service
            .set_api_key(
                &provider_id(provider),
                format!("{provider}-key").into_bytes(),
            )
            .unwrap();
        assert_eq!(
            service.request_headers(&provider_id(provider)).unwrap(),
            vec![ash_http_client::HttpHeader::new(header, value)]
        );
    }

    assert_eq!(
        secrets
            .load(&provider_api_key_secret_key(&provider("openai")))
            .unwrap()
            .unwrap()
            .expose(),
        b"openai-key"
    );
}

#[test]
fn mutation_rejects_unsupported_and_invalid_keys() {
    let service = ProviderCredentialService::new(
        ProviderConfigRegistry::builtin(),
        Arc::new(MemorySecretStore::default()),
    );

    assert!(matches!(
        service.set_api_key(&provider("ollama"), b"key".to_vec()),
        Err(ProviderCredentialError::ApiKeyUnsupported)
    ));
    assert!(matches!(
        service.set_api_key(&provider("openai"), b"bad\nkey".to_vec()),
        Err(ProviderCredentialError::InvalidApiKey)
    ));
}

fn provider(value: &str) -> ProviderId {
    provider_id(value)
}

fn provider_id(value: &str) -> ProviderId {
    ProviderId::new(value).unwrap()
}
