use super::ChatGptOAuth;
use ash_client::AshClient;
use ash_client::ClientRequest;
use ash_client::OperationClient;
use ash_client::RetryPolicy;
use ash_http_client::HttpHeader;
use ash_http_client::UreqHttpClient;
use ash_secrets::MemorySecretStore;
use sha2::Digest;
use std::sync::Arc;
use zeroize::Zeroizing;

// User-mandated subscription test budget: ONLY gpt-5.6-luna and low reasoning.
// Do not add model/effort overrides, refresh tokens, or retry with another model.
const TEST_MODEL: &str = "gpt-5.6-luna";
const TEST_EFFORT: &str = "low";

#[test]
#[ignore = "Reads real ChatGPT quota with existing Codex auth; no model call, refresh, or writes"]
fn live_codex_usage_is_read_only() {
    let home = super::codex_home().expect("Codex home must resolve");
    let before = auth_digest(&home);
    let client = Arc::new(AshClient::new(Arc::new(UreqHttpClient::new().unwrap())));
    let auth = ChatGptOAuth::with_client(
        home.clone(),
        Arc::new(MemorySecretStore::default()),
        client,
        super::ChatGptAuthManagement::Codex,
    );
    let credential = auth
        .load_credential()
        .expect("Codex auth must be readable")
        .expect("an existing Codex login is required");
    let account_id = credential
        .account_id
        .as_deref()
        .expect("ChatGPT account identity is required");
    let result = super::ChatGptAccount::new(auth).read_rate_limits(
        account_id,
        &ash_async_utils::CancellationSource::new().token(),
    );
    assert!(
        before == auth_digest(&home),
        "source auth.json changed during quota query"
    );
    let usage = result.expect("real ChatGPT quota query must succeed");
    assert!(!usage.plan.is_empty());
    assert!(!usage.limits.is_empty());
    println!("ChatGPT quota read succeeded; plan: {}", usage.plan);
    for limit in usage.limits {
        for window in [limit.primary, limit.secondary].into_iter().flatten() {
            println!(
                "Window {}s: {}% used; reset at {}",
                window.window_seconds, window.used_percent, window.resets_at
            );
        }
    }
}

#[test]
#[ignore = "Uses the user's existing Codex subscription: Luna / low only, no refresh or writes"]
fn live_codex_auth_is_read_only_and_luna_low_completes() {
    let home = super::codex_home().expect("Codex home must resolve");
    let before = auth_digest(&home);
    let client = Arc::new(AshClient::new(Arc::new(UreqHttpClient::new().unwrap())));
    let runtime = ChatGptOAuth::with_client(
        home.clone(),
        Arc::new(MemorySecretStore::default()),
        client.clone(),
        super::ChatGptAuthManagement::Codex,
    );
    let target = runtime
        .api_target()
        .expect("an unexpired Codex ChatGPT login is required; update it in Codex if expired");
    let mut headers = target.headers;
    headers.push(HttpHeader::new("Content-Type", "application/json"));
    headers.push(HttpHeader::new("Accept", "text/event-stream"));
    let body = serde_json::to_vec(&serde_json::json!({
        "model": TEST_MODEL,
        "reasoning": { "effort": TEST_EFFORT },
        "instructions": "Reply briefly. Do not use tools.",
        "input": [{"role":"user","content":[{"type":"input_text","text":"Return this exact string without punctuation or extra text: ASH_AUTH_OK"}]}],
        "store": false,
        "stream": true
    })).unwrap();
    let request = ClientRequest::post(
        format!("{}/responses", target.base_url),
        headers,
        body,
        RetryPolicy::never(),
    )
    .unwrap();
    let response = client
        .execute(&request)
        .expect("Luna / low request must complete without an automatic retry");
    // Never include response bodies, raw credentials, or authorization headers in failures.
    assert!(
        before == auth_digest(&home),
        "the source auth.json changed during read-only use"
    );
    assert!(
        response.is_success(),
        "Luna / low request returned HTTP {}",
        response.status()
    );
    let mut text = String::new();
    let mut completed = false;
    for line in response.body().split(|byte| *byte == b'\n') {
        let Some(data) = line.strip_prefix(b"data: ") else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(data) else {
            continue;
        };
        match value["type"].as_str() {
            Some("response.output_text.delta") => {
                text.push_str(value["delta"].as_str().unwrap_or_default())
            }
            Some("response.completed") => completed = true,
            _ => {}
        }
    }
    assert!(
        completed && text.trim() == "ASH_AUTH_OK",
        "Luna / low must return the exact test marker and a completed event"
    );
}

fn auth_digest(home: &std::path::Path) -> Option<[u8; 32]> {
    match std::fs::read(home.join("auth.json")) {
        Ok(bytes) => Some(sha2::Sha256::digest(&*Zeroizing::new(bytes)).into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => panic!("auth.json could not be fingerprinted"),
    }
}
