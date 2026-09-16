#[path = "support/server.rs"]
mod server;

use ash_api::LiveConfig;
use ash_api::LiveSession;
use ash_api::WebSocketSessionConfig;
use ash_async_utils::CancellationSource;
use ash_client::ResolvedApiTarget;
use ash_http_client::HttpClientConfig;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::ProxyPolicy;
use ash_websocket_client::WebSocketConnector;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures::SinkExt;
use futures::StreamExt;
use livekit_api::MediaPermissions;
use livekit_client::AudioPublication;
use livekit_client::MediaRoom;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use voice_agent::AgentCommand;
use voice_agent::AgentEvent;
use voice_agent::VoiceAgent;

/// Uses real SFU/libwebrtc media and a deterministic local implementation of the Live wire contract.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires the pinned LiveKit Server executable"]
async fn agent_receives_human_audio_publishes_reply_and_delegates_without_executing() {
    let server = server::Server::start();
    server.service.create_room("bridge-test").await.unwrap();
    let permissions = MediaPermissions {
        microphone: true,
        subscribe: true,
        screen: false,
    };
    let alice_ticket = server
        .service
        .issue_join("bridge-test", "alice", permissions)
        .unwrap();
    let agent_ticket = server
        .service
        .issue_join("bridge-test", "assistant", permissions)
        .unwrap();
    let mut alice = MediaRoom::connect(
        &alice_ticket.server_url,
        alice_ticket.token(),
        AudioPublication::Microphone,
    )
    .await
    .unwrap();
    let room = MediaRoom::connect(
        &agent_ticket.server_url,
        agent_ticket.token(),
        AudioPublication::Agent,
    )
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = ResolvedApiTarget::new(
        format!("http://{}/v1", listener.local_addr().unwrap()),
        vec![],
    );
    let model = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let start: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(start["type"], "session.start");
        socket
            .send(Message::Text(
                json!({"type":"session.started","session":{"id":"model","model":"gpt-live-1"}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let mut heard = false;
        let mut commentary = false;
        while let Some(message) = socket.next().await {
            let message = message.unwrap();
            if message.is_close() {
                break;
            }
            let event: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            match event["type"].as_str().unwrap() {
                "session.input_audio.append" => {
                    let bytes = STANDARD.decode(event["audio"].as_str().unwrap()).unwrap();
                    assert_eq!(bytes.len(), 480);
                    if !heard
                        && bytes
                            .chunks_exact(2)
                            .any(|s| i16::from_le_bytes([s[0], s[1]]).unsigned_abs() > 1000)
                    {
                        heard = true;
                        let audio: Vec<u8> = (0..12_000)
                            .flat_map(|i| {
                                ((i as f64 * 880. * std::f64::consts::TAU / 24_000.)
                                    .sin()
                                    .mul_add(6000., 0.) as i16)
                                    .to_le_bytes()
                            })
                            .collect();
                        for value in [
                            json!({"type":"session.output_audio.delta","delta":STANDARD.encode(audio)}),
                            json!({"type":"session.input_transcript.delta","delta":"run tests","start_ms":0,"end_ms":100}),
                            json!({"type":"session.delegation.created","delegation":{"id":"task","target":"client"},"offset_ms":100}),
                        ] {
                            socket
                                .send(Message::Text(value.to_string().into()))
                                .await
                                .unwrap();
                        }
                    }
                }
                "session.commentary.append" => {
                    assert_eq!(event["delegation_id"], "task");
                    assert_eq!(event["content"], "Awaiting requester approval");
                    commentary = true;
                }
                "session.close" => {
                    assert!(heard && commentary);
                    socket.send(Message::Text(json!({"type":"session.closed","session":{"id":"model"},"reason":"close_requested","usage":{"seconds":3.0}}).to_string().into())).await.unwrap();
                }
                other => panic!("unexpected command {other}"),
            }
        }
    });
    let cancellation = CancellationSource::new();
    let connector = WebSocketConnector::new(
        OutboundNetworkSnapshot::new(
            HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
        )
        .unwrap(),
    );
    let live = LiveSession::connect(
        &connector,
        &target,
        "gpt-live-1",
        &LiveConfig {
            voice: "marin".into(),
            instructions: String::new(),
        },
        WebSocketSessionConfig::default(),
        &cancellation.token(),
    )
    .await
    .unwrap();
    let agent = VoiceAgent::new(
        room,
        live,
        BTreeMap::from([("alice".into(), "member-alice".into())]),
    )
    .unwrap();
    let (commands, input) = mpsc::channel(8);
    let (output, mut events) = mpsc::channel(32);
    let token = cancellation.token();
    let worker = tokio::spawn(async move { agent.run(input, output, &token).await });
    let mut heard = 0;
    let mut delegated = false;
    let mut clock = tokio::time::interval(Duration::from_millis(10));
    for packet in 0..800 {
        clock.tick().await;
        let samples: Vec<i16> = (0..480)
            .map(|i| {
                (((packet * 480 + i) as f64 * 440. * std::f64::consts::TAU / 48_000.).sin() * 6000.)
                    as i16
            })
            .collect();
        alice.send_audio(&samples).await.unwrap();
        if let Ok(Some(audio)) = timeout(Duration::from_millis(2), alice.next_audio()).await {
            assert_eq!(audio.participant_id, "assistant");
            if audio.samples.iter().any(|s| s.unsigned_abs() > 500) {
                heard += 1;
            }
        }
        while let Ok(event) = events.try_recv() {
            if let AgentEvent::DelegationProposed {
                id,
                transcript,
                eligible_members,
            } = event
            {
                assert_eq!(transcript, "run tests");
                assert_eq!(eligible_members, vec!["member-alice"]);
                commands
                    .send(AgentCommand::Commentary {
                        delegation_id: id,
                        text: "Awaiting requester approval".into(),
                    })
                    .await
                    .unwrap();
                delegated = true;
            }
        }
        if heard >= 10 && delegated {
            break;
        }
        assert!(!worker.is_finished(), "agent stopped before bridging audio");
    }
    assert!(
        heard >= 10 && delegated,
        "heard={heard}, delegated={delegated}"
    );
    commands.send(AgentCommand::Stop).await.unwrap();
    timeout(Duration::from_secs(20), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    timeout(Duration::from_secs(5), model)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        events.recv().await,
        Some(AgentEvent::Closed { seconds: 3.0, .. })
    ));
    alice.close().await.unwrap();
}
