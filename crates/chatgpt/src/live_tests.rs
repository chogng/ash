use super::ChatGptOAuth;
use ash_client::AshClient;
use ash_client::ClientRequest;
use ash_client::OperationClient;
use ash_client::RetryPolicy;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
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
#[ignore = "Probes the desktop ChatGPT history routes with existing Codex auth; no refresh or writes"]
fn live_codex_chatgpt_native_history_is_read_only() {
    let version = std::env::var("ASH_TEST_CHATGPT_DESKTOP_VERSION")
        .expect("ASH_TEST_CHATGPT_DESKTOP_VERSION must match the reference desktop build");
    assert!(
        !version.is_empty()
            && version
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'.'),
        "desktop build version must be numeric"
    );
    let home = super::codex_home().expect("Codex home must resolve");
    let before = auth_digest(&home);
    let client = Arc::new(AshClient::new(Arc::new(UreqHttpClient::new().unwrap())));
    let auth = ChatGptOAuth::with_client(
        home.clone(),
        Arc::new(MemorySecretStore::default()),
        client.clone(),
        super::ChatGptAuthManagement::Codex,
    );
    let target = auth
        .api_target_for("https://chatgpt.com/backend-api")
        .expect("an unexpired Codex ChatGPT login is required")
        .into_api_target();
    let mut device_id = [0; 16];
    getrandom::getrandom(&mut device_id).expect("a test device ID must be available");
    device_id[6] = (device_id[6] & 0x0f) | 0x40;
    device_id[8] = (device_id[8] & 0x3f) | 0x80;
    let id = format!("{:032x}", u128::from_be_bytes(device_id));
    let id = format!(
        "{}-{}-{}-{}-{}",
        &id[..8],
        &id[8..12],
        &id[12..16],
        &id[16..20],
        &id[20..]
    );
    let mut headers = target.headers().to_vec();
    headers.retain(|header| {
        !header.name().eq_ignore_ascii_case("originator")
            && !header.name().eq_ignore_ascii_case("user-agent")
    });
    let platform = match std::env::consts::OS {
        "macos" => "Mac OS",
        "windows" => "Windows NT 10.0",
        "linux" => "X11; Linux",
        other => other,
    };
    let architecture = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    // These are wire headers. The desktop wrapper consumes its local auth and
    // surface attachment flags before it sends the request.
    headers.extend([
        HttpHeader::new("Originator", "Codex Desktop"),
        HttpHeader::new(
            "User-Agent",
            format!("Codex Desktop/{version} ({platform}; {architecture})"),
        ),
        HttpHeader::new("X-OpenAI-Web-Frontend", "codex_webview"),
        HttpHeader::new("X-OpenAI-Codex-Window-Type", "electron"),
        HttpHeader::new("OAI-Language", "en"),
        HttpHeader::new("oai-did", id),
    ]);
    let get = |path: &str, label: &str| {
        let request = ClientRequest::new(
            HttpMethod::Get,
            format!("{}{path}", target.base_url()),
            headers.clone(),
            Vec::new(),
            RetryPolicy::never(),
        )
        .expect("the test request must be valid")
        .without_redirects();
        let response = client.execute(&request);
        assert!(
            before == auth_digest(&home),
            "source auth.json changed during the probe"
        );
        let response = response.expect("desktop history request failed at the transport");
        println!("{label}: HTTP {}", response.status());
        assert!(response.is_success(), "{label} request failed");
        serde_json::from_slice::<serde_json::Value>(response.body())
            .expect("desktop history must return JSON")
    };
    if std::env::var_os("ASH_TEST_CHATGPT_NATIVE_CHALLENGE").is_some() {
        let challenge = get(
            "/ios/attestation_challenge",
            "Desktop send attestation challenge",
        );
        assert!(
            challenge["attestation_challenge"]
                .as_str()
                .is_some_and(|value| !value.is_empty()),
            "desktop send must return a nonempty attestation challenge"
        );
        return;
    }
    let list = get(
        "/conversations?exclude_conversation_origin=tpp&expand=false&is_archived=false&is_starred=false&limit=1&order=updated&offset=0",
        "Recent conversations",
    );
    let items = list["items"]
        .as_array()
        .expect("recent conversations must contain an items array");
    let Some(item) = items.first() else {
        println!("No recent conversations available for the detail probe");
        return;
    };
    let id = item["id"]
        .as_str()
        .expect("recent conversation must contain an ID");
    let detail = get(
        &format!(
            "/conversations/{}?num_turns=1&include_has_versions=true",
            urlencoding::encode(id)
        ),
        "Paginated conversation detail",
    );
    assert!(
        detail["messages"].is_array() && detail["page_info"].is_object(),
        "invalid paginated conversation shape"
    );
}

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
        .expect("an unexpired Codex ChatGPT login is required; update it in Codex if expired")
        .into_api_target();
    let mut headers = target.headers().to_vec();
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
        format!("{}/responses", target.base_url()),
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

/// Returns transport SDP only; this does not prove model authorization or a usable voice session.
/// The caller owns the peer and must close it after reading the answer.
#[test]
#[ignore = "Creates one real subscription voice call using caller-provided silent SDP; no auth refresh or writes"]
fn live_codex_voice_call_accepts_silent_webrtc_offer() {
    let offer_path = std::env::var_os("ASH_TEST_VOICE_OFFER")
        .expect("a caller-owned WebRTC offer file is required");
    let answer_path = std::env::var_os("ASH_TEST_VOICE_ANSWER")
        .expect("a caller-owned WebRTC answer destination is required");
    let offer = std::fs::read_to_string(offer_path).expect("WebRTC offer must be readable");
    assert!(
        offer.len() <= 128 * 1024 && offer.starts_with("v=0\r\n") && offer.contains("m=audio "),
        "a bounded audio SDP offer is required"
    );
    // Reserve the output before creating a remote call. Never overwrite a caller's file.
    let mut answer = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(answer_path)
        .expect("answer destination must be new and writable");
    let home = super::codex_home().expect("Codex home must resolve");
    let before = auth_digest(&home);
    let client = Arc::new(AshClient::new(Arc::new(UreqHttpClient::new().unwrap())));
    let auth = ChatGptOAuth::with_client(
        home.clone(),
        Arc::new(MemorySecretStore::default()),
        client.clone(),
        super::ChatGptAuthManagement::Codex,
    );
    let target = auth
        .api_target()
        .expect("an unexpired Codex login is required; refresh it in Codex if necessary")
        .into_api_target();
    let mut headers = target.headers().to_vec();
    headers.push(HttpHeader::new("Content-Type", "application/json"));
    headers.push(HttpHeader::new("openai-alpha", "quicksilver=v2"));
    let body = serde_json::to_vec(&serde_json::json!({
        "sdp": offer,
        "session": {
            "model": "gpt-live-1-codex",
            "instructions": "Silent connection test. Do not speak or delegate tasks.",
            "audio": { "output": { "voice": "marin" } },
            "delegation": { "type": "client" }
        }
    }))
    .unwrap();
    let request = ClientRequest::post(
        format!(
            "{}/realtime/calls?intent=quicksilver&architecture=avas",
            target.base_url()
        ),
        headers,
        body,
        RetryPolicy::never(),
    )
    .unwrap();
    let response = client
        .execute(&request)
        .expect("voice handshake transport must complete");
    assert!(
        before == auth_digest(&home),
        "voice handshake changed Codex auth.json"
    );
    // Do not print SDP, tokens, headers, or raw upstream errors, even on rejection.
    assert!(
        response.is_success(),
        "subscription voice call returned HTTP {}",
        response.status()
    );
    let sdp = std::str::from_utf8(response.body()).expect("voice answer must be UTF-8");
    assert!(
        sdp.starts_with("v=0\r\n") && sdp.contains("m=audio "),
        "voice answer must contain audio SDP"
    );
    use std::io::Write;
    answer
        .write_all(sdp.as_bytes())
        .expect("voice answer must be writable");
    println!("Transport SDP returned; model authorization and session events are not verified.");
}

fn auth_digest(home: &std::path::Path) -> Option<[u8; 32]> {
    match std::fs::read(home.join("auth.json")) {
        Ok(bytes) => Some(sha2::Sha256::digest(&*Zeroizing::new(bytes)).into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => panic!("auth.json could not be fingerprinted"),
    }
}

#[test]
#[ignore = "Sends caller-provided synthetic PCM to the ChatGPT dictation stream; no microphone or auth writes"]
fn live_codex_subscription_dictation_transcribes_synthetic_audio() {
    let (language, marker) = match std::env::var("ASH_TEST_DICTATION_LANGUAGE").as_deref() {
        Ok("zh") => ("zh", "语音输入"),
        Ok("en") | Err(_) => ("en", "coding assistant"),
        Ok(_) => panic!("select en or zh for the synthetic dictation probe"),
    };
    let path = std::env::var_os("ASH_TEST_DICTATION_PCM").expect("synthetic PCM required");
    let audio = std::fs::read(path).expect("synthetic PCM must be readable");
    assert!(!audio.is_empty() && audio.len() <= 2 * 1024 * 1024 && audio.len() % 2 == 0);
    let samples = audio
        .chunks_exact(2)
        .map(|sample| i16::from_le_bytes([sample[0], sample[1]]))
        .collect::<Vec<_>>();
    let home = super::codex_home().unwrap();
    let before = auth_digest(&home);
    let client = Arc::new(AshClient::new(Arc::new(UreqHttpClient::new().unwrap())));
    let auth = ChatGptOAuth::with_client(
        home.clone(),
        Arc::new(MemorySecretStore::default()),
        client,
        super::ChatGptAuthManagement::Codex,
    );
    let dictation = super::ChatGptDictation::new(auth).expect("Codex dictation admission required");
    let network =
        ash_http_client::OutboundNetworkSnapshot::new(ash_http_client::HttpClientConfig::new())
            .unwrap();
    let connector = ash_websocket_client::WebSocketConnector::new(network);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let text = runtime.block_on(async {
        let mut stream = dictation
            .connect(&connector, Some(language))
            .await
            .expect("stream must start");
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            for chunk in samples.chunks(2400) {
                stream
                    .append_pcm(chunk)
                    .await
                    .expect("stream must accept synthetic audio");
            }
            stream
                .finish_input()
                .await
                .expect("stream must accept close");
            loop {
                if let super::ChatGptDictationEvent::Finished(text) =
                    stream.receive().await.expect("valid dictation event")
                {
                    break text;
                }
            }
        })
        .await
        .expect("dictation stream must finish")
    });
    assert_eq!(before, auth_digest(&home), "Codex auth changed");
    assert!(
        text.to_ascii_lowercase().contains(marker),
        "synthetic dictation marker missing"
    );
    println!("Subscription dictation returned the synthetic speech marker; Codex auth unchanged.");
}
