use super::*;
use ash_glm::GlmProvider;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretKey;
use ash_secrets::SecretValue;
use serde_json::json;

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
