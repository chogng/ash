//! Explicit real-account protocol verification. Ordinary tests never open a paid session.

use ash_chatgpt::ChatGptAuthManagement;
use ash_chatgpt::ChatGptOAuth;
use ash_client::AshClient;
use ash_client::ClientRequest;
use ash_client::OperationClient;
use ash_client::RetryPolicy;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpHeader;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::UreqHttpClient;
use ash_secrets::MemorySecretStore;
use ash_websocket_client::WebSocketConnection;
use ash_websocket_client::WebSocketConnector;
use ash_websocket_client::WebSocketMessage;
use ash_websocket_client::WebSocketRequest;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

enum EventTransport {
    DataChannel,
    Sideband,
}

enum CallRoute {
    Codex,
    Desktop,
}

#[tokio::test]
#[ignore = "Creates one subscription voice session; requires caller-owned synthetic audio peer, no microphone or auth writes"]
async fn subscription_voice_transcribes_delegates_and_closes() {
    let events = match std::env::var("ASH_TEST_VOICE_EVENTS").as_deref() {
        Ok("dataChannel") => EventTransport::DataChannel,
        Ok("sideband") => EventTransport::Sideband,
        _ => panic!("select dataChannel or sideband"),
    };
    let route = match std::env::var("ASH_TEST_VOICE_ROUTE").as_deref() {
        Ok("codex") => CallRoute::Codex,
        Ok("desktop") => CallRoute::Desktop,
        _ => panic!("select codex or desktop route"),
    };
    let directory =
        std::env::var_os("ASH_TEST_VOICE_DIRECTORY").expect("peer directory is required");
    let directory = Path::new(&directory);
    let offer = std::fs::read_to_string(directory.join("offer.sdp")).expect("audio offer required");
    assert!(
        offer.len() <= 128 * 1024 && offer.starts_with("v=0\r\n") && offer.contains("m=audio ")
    );
    let home = ash_chatgpt::codex_home().unwrap();
    let auth_before = sha2::Sha256::digest(std::fs::read(home.join("auth.json")).unwrap());
    let client = Arc::new(AshClient::new(Arc::new(UreqHttpClient::new().unwrap())));
    let auth = ChatGptOAuth::with_client(
        home.clone(),
        Arc::new(MemorySecretStore::default()),
        client.clone(),
        ChatGptAuthManagement::Codex,
    );
    let target = auth
        .api_target()
        .expect("valid read-only Codex login required")
        .into_api_target();
    let mut headers = target.headers().to_vec();
    headers.push(HttpHeader::new("openai-alpha", "quicksilver=v2"));
    // Match Codex's per-thread correlation without impersonating its client identity.
    let session_id = std::env::var("ASH_TEST_VOICE_SESSION_ID").expect("peer session ID required");
    assert!(
        session_id.len() == 36
            && session_id.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
    );
    for name in [
        "session-id",
        "thread-id",
        "x-session-id",
        "voice-session-id",
    ] {
        headers.push(HttpHeader::new(name, session_id.clone()));
    }
    let mut create_headers = headers.clone();
    create_headers.push(HttpHeader::new("Content-Type", "application/json"));
    let base_url = match route {
        CallRoute::Codex => target.base_url(),
        // Installed Codex's client-owned call uses /wham, unlike the Rust provider route.
        CallRoute::Desktop => "https://chatgpt.com/backend-api/wham",
    };
    let request = ClientRequest::post(
        format!("{base_url}/realtime/calls?intent=quicksilver&architecture=avas"),
        create_headers,
        serde_json::to_vec(&json!({"sdp":offer,"session":{
            "model":"gpt-live-1-codex",
            "instructions":"This is a synthetic voice protocol test. Respond briefly in English. When the caller asks for the coding assistant, delegate the request to the client. Never execute tools yourself.",
            "audio":{"output":{"voice":"marin"}},"delegation":{"type":"client","ack_filler":false}
        }})).unwrap(),
        RetryPolicy::never(),
    ).unwrap();
    let response = client.execute(&request).expect("call transport failed");
    assert!(
        response.is_success(),
        "voice creation HTTP {}",
        response.status()
    );
    let location = response
        .headers()
        .iter()
        .find(|header| header.name().eq_ignore_ascii_case("location"))
        .expect("call location required")
        .value();
    let call_id = location
        .split('?')
        .next()
        .unwrap()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap();
    assert!(
        (8..=128).contains(&call_id.len())
            && call_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')),
        "invalid call identity"
    );
    let answer = std::str::from_utf8(response.body()).unwrap();
    assert!(answer.starts_with("v=0\r\n") && answer.contains("m=audio "));
    // Publish complete files by rename: the peer must never consume a partial SDP.
    std::fs::write(directory.join("answer.pending"), answer).unwrap();
    std::fs::rename(
        directory.join("answer.pending"),
        directory.join("answer.sdp"),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        while !directory.join("peer.ready").exists() {
            assert!(
                !directory.join("peer.failed").exists(),
                "caller media peer failed"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("media peer did not connect");
    match events {
        EventTransport::DataChannel => {
            tokio::time::timeout(Duration::from_secs(60), async {
                while !directory.join("report.json").exists() {
                    assert!(
                        !directory.join("peer.failed").exists(),
                        "caller event transport failed"
                    );
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .expect("data channel verification timed out");
            let report: Value =
                serde_json::from_slice(&std::fs::read(directory.join("report.json")).unwrap())
                    .unwrap();
            assert_eq!(
                auth_before,
                sha2::Sha256::digest(std::fs::read(home.join("auth.json")).unwrap()),
                "Codex auth changed during the probe"
            );
            if let Some(code) = report["error"].as_str() {
                assert!(
                    code.len() <= 100
                        && code.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                );
                panic!("subscription voice session rejected: {code}");
            }
            for field in [
                "inputDone",
                "outputDone",
                "delegated",
                "delegationContentValid",
                "outputAudioReceived",
                "closeSent",
                "sessionClosed",
            ] {
                assert_eq!(report[field], true, "data channel did not confirm {field}");
            }
            return;
        }
        EventTransport::Sideband => {}
    }
    let connector =
        WebSocketConnector::new(OutboundNetworkSnapshot::new(HttpClientConfig::new()).unwrap());
    let request =
        WebSocketRequest::new(format!("wss://api.openai.com/v1/live/{call_id}"), headers).unwrap();
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(15), connector.connect(request))
        .await
        .unwrap()
        .expect("subscription sideband handshake failed");
    println!("Subscription sideband attached.");
    std::fs::write(directory.join("sideband.ready"), []).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(50), exercise(&mut socket)).await;
    let auth_after = sha2::Sha256::digest(std::fs::read(home.join("auth.json")).unwrap());
    assert_eq!(
        auth_before, auth_after,
        "Codex auth changed during the probe"
    );
    result.expect("sideband verification timed out");
}

async fn exercise(socket: &mut WebSocketConnection) {
    let mut input_done = false;
    let mut output_done = false;
    let mut delegated = false;
    let mut closing = false;
    loop {
        let value = receive(socket).await;
        let kind = value["type"].as_str().expect("event type required");
        assert!(
            kind.len() < 100
                && kind
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
        );
        println!("Sideband event: {kind}");
        match kind {
            "error" => panic!(
                "sideband returned an error event; raw provider content is intentionally omitted"
            ),
            "turn.done" => {
                let role = value["turn"]["role"].as_str().unwrap();
                let text = value["turn"]["transcript"].as_str().unwrap();
                if role == "user" {
                    input_done = !text.trim().is_empty();
                }
                if role == "assistant" {
                    output_done = !text.trim().is_empty();
                }
            }
            "delegation.created" => {
                assert_eq!(value["item"]["target"], "client");
                let id = value["item"]["id"].as_str().unwrap();
                assert!(!id.is_empty() && id.len() <= 256);
                delegated = true;
                let result = json!({
                    "type": "delegation.context.append",
                    "delegation_item_id": id,
                    "channel": "commentary",
                    "content": [{
                        "type": "input_text",
                        "text": "The synthetic task finished. No commands were run and no files were edited."
                    }]
                });
                socket
                    .send(WebSocketMessage::Text(result.to_string()))
                    .await
                    .unwrap();
            }
            "session.closed" => {
                assert!(
                    input_done && output_done && delegated && closing,
                    "session closed before required protocol facts"
                );
                return;
            }
            _ => {}
        }
        if input_done && output_done && delegated && !closing {
            socket
                .send(WebSocketMessage::Text(
                    json!({"type":"session.close"}).to_string(),
                ))
                .await
                .unwrap();
            closing = true;
        }
    }
}

async fn receive(socket: &mut WebSocketConnection) -> Value {
    loop {
        match socket
            .receive()
            .await
            .expect("sideband transport closed before finalization")
        {
            WebSocketMessage::Text(text) => {
                assert!(text.len() <= 1024 * 1024, "sideband event exceeds bound");
                return serde_json::from_str(&text).expect("sideband JSON required");
            }
            WebSocketMessage::Ping(bytes) => {
                socket.send(WebSocketMessage::Pong(bytes)).await.unwrap();
            }
            WebSocketMessage::Close(_) => panic!("sideband closed before finalization"),
            _ => {}
        }
    }
}
