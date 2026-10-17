use super::*;
use ash_glm::GlmProvider;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use serde_json::json;
use std::collections::BTreeMap;

#[test]
fn unavailable_keyring_does_not_block_credential_free_connections() {
    let root = tempfile::tempdir().unwrap();
    let secrets = Arc::new(ash_secrets::UnavailableSecretStore);
    let client = Arc::new(AshClient::new(Arc::new(UreqHttpClient::new().unwrap())));
    let kimi = KimiOAuth::with_client(secrets.clone(), client.clone());
    let xai = supergrok::SuperGrokOAuth::with_client(
        secrets.clone(),
        client.clone(),
        root.path().join("xai.lock"),
    );
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        client,
        secrets,
    )
    .with_kimi_oauth(kimi)
    .with_supergrok_oauth(xai);

    let custom: ModelProviderConfig = serde_json::from_value(json!({
        "connection":"custom-optional", "provider":"custom-optional",
        "baseUrl":"https://optional.example.test/v1",
        "custom":{"name":"Optional key", "protocol":"responses", "model":"fixture", "contextWindow":272000}
    })).unwrap();
    let selected = runtime
        .preferred_connections(&BTreeMap::from([(
            custom.connection.clone(),
            custom.clone(),
        )]))
        .unwrap();
    assert_eq!(
        selected[&ProviderId::new("ollama").unwrap()]
            .connection
            .as_str(),
        "ollama"
    );
    assert!(!selected.contains_key(&ProviderId::new("openai").unwrap()));
    assert!(!selected.contains_key(&ProviderId::new("kimi").unwrap()));
    assert!(!selected.contains_key(&ProviderId::new("xai").unwrap()));
    assert!(!selected.contains_key(&custom.provider));
    assert!(matches!(
        runtime.build_model(
            &custom,
            &ModelRef::new(custom.provider.clone(), ModelId::new("fixture").unwrap()),
        ),
        Err(ModelProviderError::Credential(_))
    ));
    // Discovery may skip an unreadable account; selecting it still reports the error.
    for (connection, provider, model) in [
        ("openai", "openai", "gpt-5.6"),
        ("kimi-subscription", "kimi", "kimi-k2.6"),
        ("xai-subscription", "xai", "grok-4.5"),
    ] {
        let config = ModelProviderConfig::for_connection(
            ash_protocol::ModelConnectionId::new(connection).unwrap(),
        );
        let model = ModelRef::new(
            ProviderId::new(provider).unwrap(),
            ModelId::new(model).unwrap(),
        );
        assert!(matches!(
            runtime
                .build_model(&config, &model)
                .and_then(|model| model.invoke(&ModelRequest::text("hello"))),
            Err(ModelProviderError::Credential(_))
        ));
    }
}

#[test]
fn unreadable_subscription_does_not_block_its_ready_api_connection() {
    let root = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let client = Arc::new(AshClient::new(Arc::new(UreqHttpClient::new().unwrap())));
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        client.clone(),
        secrets.clone(),
    )
    .with_kimi_oauth(KimiOAuth::with_client(secrets.clone(), client.clone()))
    .with_supergrok_oauth(supergrok::SuperGrokOAuth::with_client(
        secrets.clone(),
        client,
        root.path().join("xai.lock"),
    ));
    let credentials =
        ProviderCredentialService::new(ProviderConfigRegistry::builtin(), secrets.clone());
    for provider in ["kimi", "xai"] {
        credentials
            .set_api_key(
                &ash_protocol::ModelConnectionId::new(provider).unwrap(),
                b"api-key".to_vec(),
            )
            .unwrap();
        secrets
            .store(
                &SecretKey::new(format!("provider/{provider}/current/oauth")).unwrap(),
                &SecretValue::new(b"invalid credential".to_vec()),
            )
            .unwrap();
    }
    let selected = runtime.preferred_connections(&BTreeMap::new()).unwrap();
    for provider in ["kimi", "xai"] {
        assert_eq!(
            selected[&ProviderId::new(provider).unwrap()]
                .connection
                .as_str(),
            provider
        );
    }
}

#[test]
fn unreadable_api_key_does_not_block_another_ready_connection() {
    struct PartlyUnavailable(MemorySecretStore);
    impl SecretStore for PartlyUnavailable {
        fn load(
            &self,
            key: &SecretKey,
        ) -> Result<Option<SecretValue>, ash_secrets::SecretStoreError> {
            if key
                == &crate::provider_api_key_secret_key(
                    &ash_protocol::ModelConnectionId::new("openai").unwrap(),
                )
            {
                return Err(ash_secrets::SecretStoreError::new(
                    ash_secrets::SecretStoreErrorKind::BackendFailure,
                    "unreadable fixture credential",
                ));
            }
            self.0.load(key)
        }

        fn store(
            &self,
            key: &SecretKey,
            value: &SecretValue,
        ) -> Result<(), ash_secrets::SecretStoreError> {
            self.0.store(key, value)
        }

        fn delete(
            &self,
            key: &SecretKey,
        ) -> Result<ash_secrets::DeleteSecretOutcome, ash_secrets::SecretStoreError> {
            self.0.delete(key)
        }
    }
    let secrets = Arc::new(PartlyUnavailable(MemorySecretStore::default()));
    let credentials =
        ProviderCredentialService::new(ProviderConfigRegistry::builtin(), secrets.clone());
    credentials
        .set_api_key(
            &ash_protocol::ModelConnectionId::new("anthropic").unwrap(),
            b"api-key".to_vec(),
        )
        .unwrap();
    let runtime = ModelProviderRuntime::with_secrets(ProviderConfigRegistry::builtin(), secrets);
    let selected = runtime.preferred_connections(&BTreeMap::new()).unwrap();
    assert!(selected.contains_key(&ProviderId::new("anthropic").unwrap()));
    assert!(!selected.contains_key(&ProviderId::new("openai").unwrap()));
    assert!(credentials.catalog().is_err());
}

#[test]
fn glm_connection_priority_follows_ready_credentials() {
    let secrets = Arc::new(MemorySecretStore::default());
    let client = Arc::new(AshClient::new(Arc::new(UreqHttpClient::new().unwrap())));
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        client.clone(),
        secrets.clone(),
    )
    .with_glm_accounts([
        GlmOAuth::with_client(GlmProvider::BigModel, secrets.clone(), client.clone()),
        GlmOAuth::with_client(GlmProvider::Zai, secrets.clone(), client),
    ]);
    let credentials =
        ProviderCredentialService::new(ProviderConfigRegistry::builtin(), secrets.clone());
    for id in ["bigmodel", "zai"] {
        credentials
            .set_api_key(
                &ash_protocol::ModelConnectionId::new(id).unwrap(),
                b"api-key".to_vec(),
            )
            .unwrap();
    }
    let selected = || {
        let selected = runtime.preferred_connections(&BTreeMap::new()).unwrap();
        selected[&ProviderId::new("glm").unwrap()]
            .connection
            .to_string()
    };
    assert_eq!(selected(), "bigmodel");
    let store_plan = |provider: &str| {
        secrets
            .store(
                &SecretKey::new(format!("provider/{provider}/current/oauth")).unwrap(),
                &SecretValue::new(
                    serde_json::to_vec(&json!({
                        "account_id": provider,
                        "email": null,
                        "display_name": null,
                        "model_key": "plan-key",
                        "revision": 1,
                    }))
                    .unwrap(),
                ),
            )
            .unwrap();
    };
    store_plan("zai");
    assert_eq!(selected(), "zai-coding-plan");
    store_plan("bigmodel");
    assert_eq!(selected(), "bigmodel-coding-plan");
    secrets
        .delete(&SecretKey::new("provider/bigmodel/current/oauth").unwrap())
        .unwrap();
    assert_eq!(selected(), "zai-coding-plan");
    secrets
        .delete(&SecretKey::new("provider/zai/current/oauth").unwrap())
        .unwrap();
    assert_eq!(selected(), "bigmodel");
}

#[test]
fn unreadable_glm_login_does_not_block_other_connections() {
    let secrets = Arc::new(MemorySecretStore::default());
    let client = Arc::new(AshClient::new(Arc::new(UreqHttpClient::new().unwrap())));
    let bigmodel = GlmOAuth::with_client(GlmProvider::BigModel, secrets.clone(), client.clone());
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        client.clone(),
        secrets.clone(),
    )
    .with_glm_accounts([
        bigmodel.clone(),
        GlmOAuth::with_client(GlmProvider::Zai, secrets.clone(), client),
    ]);
    secrets
        .store(
            &SecretKey::new("provider/bigmodel/current/oauth").unwrap(),
            &SecretValue::new(b"invalid credential".to_vec()),
        )
        .unwrap();
    assert!(bigmodel.api_target().is_err());
    assert!(
        !runtime
            .preferred_connections(&BTreeMap::new())
            .unwrap()
            .contains_key(&ProviderId::new("glm").unwrap())
    );

    ProviderCredentialService::new(ProviderConfigRegistry::builtin(), secrets)
        .set_api_key(
            &ash_protocol::ModelConnectionId::new("bigmodel").unwrap(),
            b"api-key".to_vec(),
        )
        .unwrap();
    let selected = runtime.preferred_connections(&BTreeMap::new()).unwrap();
    assert_eq!(
        selected[&ProviderId::new("glm").unwrap()]
            .connection
            .as_str(),
        "bigmodel"
    );
}

#[test]
fn glm_request_rejects_an_account_switch_between_identity_and_target_reads() {
    let secrets = Arc::new(MemorySecretStore::default());
    let key = SecretKey::new("provider/zai/current/oauth").unwrap();
    let save = |account: &str, model_key: &str| {
        secrets
            .store(
                &key,
                &SecretValue::new(
                    serde_json::to_vec(&json!({
                        "account_id": account,
                        "email": null,
                        "display_name": null,
                        "model_key": model_key,
                        "revision": 1,
                    }))
                    .unwrap(),
                ),
            )
            .unwrap();
    };
    save("account-a", "key-a");
    let auth = GlmOAuth::with_client(
        GlmProvider::Zai,
        secrets.clone(),
        Arc::new(AshClient::new(Arc::new(UreqHttpClient::new().unwrap()))),
    );
    let target = ProviderTarget::Glm(auth);
    let bound = target.identity().unwrap();
    save("account-b", "key-b");
    let resolved = target.resolve().unwrap();
    assert!(resolved.ensure_account(&bound).is_err());
    assert_eq!(resolved.api_target().headers()[0].value(), "Bearer key-b");
}
