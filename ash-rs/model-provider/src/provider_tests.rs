use super::*;
use ash_glm::GlmProvider;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use serde_json::json;
use std::collections::BTreeMap;

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
    assert_eq!(resolved.api_target().headers[0].value(), "Bearer key-b");
}
