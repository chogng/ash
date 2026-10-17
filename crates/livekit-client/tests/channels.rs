use ash_http_client::HttpClient;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::ProxyPolicy;
use ash_http_client::UreqHttpClient;
use call::CallClient;
use call::CallError;
use call::LocalDeployment;
use call::MediaJoin;
use call::MemberCredential;
use livekit_client::AudioPublication;
use livekit_client::MediaEvent;
use livekit_client::MediaRoom;
use serde_json::Value;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;

/// This exercises the deployed HTTP authority and separate media worker processes.
/// Generated PCM replaces the physical devices, but signaling, SFU, RTP and Opus are real.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires ASH_TEST_LIVEKIT_SERVER, ASH_TEST_COLLABORATION_SERVER and ASH_LIVEKIT_CLIENT_PATH"]
async fn channel_members_exchange_audio_and_revoke_live_and_cached_access() {
    let directory = tempfile::tempdir().unwrap();
    let deployment = LocalDeployment::start(
        &call::ServicePaths {
            media: executable("ASH_TEST_LIVEKIT_SERVER"),
            collaboration: executable("ASH_TEST_COLLABORATION_SERVER"),
        },
        &directory.path().join("channels.sqlite3"),
    )
    .unwrap();
    let http = Arc::new(
        UreqHttpClient::with_config(
            HttpClientConfig::default().with_proxy_policy(ProxyPolicy::Direct),
        )
        .unwrap(),
    );
    let request = |path: &str, credential: &str, body: Value, status| {
        let response = http
            .execute(
                &HttpRequest::new(
                    HttpMethod::Post,
                    format!("{}{path}", deployment.url()),
                    vec![
                        HttpHeader::new("Authorization", format!("Bearer {credential}")),
                        HttpHeader::new("Content-Type", "application/json"),
                    ],
                    serde_json::to_vec(&body).unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(response.status(), status, "{path}");
        serde_json::from_slice::<Value>(response.body()).unwrap()
    };
    let owner_key = MemberCredential::generate();
    let peer_key = MemberCredential::generate();
    let space = request(
        "/v1/channels/create",
        deployment.administrator(),
        json!({"name":"Live audio", "memberName":"Alice", "credential":owner_key.expose()}),
        200,
    );
    let space = request(
        "/v1/channels/edit",
        owner_key.expose(),
        json!({"spaceId":space["id"], "revision":space["revision"], "change":{"type":"create", "name":"engineering"}}),
        200,
    );
    let space = request(
        "/v1/channels/invite",
        owner_key.expose(),
        json!({"params":{"spaceId":space["id"], "revision":space["revision"], "name":"Bob", "role":"editor"}, "credential":peer_key.expose()}),
        200,
    );
    let resource = json!({"spaceId":space["id"], "channelId":space["channels"][0]["id"]});
    let owner_access = request(
        "/v1/channels/call",
        owner_key.expose(),
        resource.clone(),
        200,
    );
    let peer_access = request(
        "/v1/channels/call",
        peer_key.expose(),
        resource.clone(),
        200,
    );
    assert_eq!(owner_access["resourceId"], peer_access["resourceId"]);
    let client = |access: &Value| {
        CallClient::new(
            deployment.url(),
            MemberCredential::parse(access["credential"].as_str().unwrap().into()).unwrap(),
            http.clone(),
        )
        .unwrap()
    };
    let owner = client(&owner_access);
    let peer = client(&peer_access);
    let first_owner = owner.join("alice-desktop").unwrap();
    let first_peer = peer.join("bob-desktop").unwrap();
    assert_eq!(first_owner.call, first_peer.call);
    assert_eq!(
        first_owner.call.channel_id.as_deref(),
        resource["channelId"].as_str()
    );
    assert!(first_owner.microphone && first_peer.microphone);
    let mut alice = connect(&first_owner, AudioPublication::Microphone).await;
    let mut bob = connect(&first_peer, AudioPublication::Microphone).await;
    exchange(&mut alice, &mut bob, &first_owner, &first_peer, 480).await;
    eprintln!(
        "channel: two independent clients joined; decoded 440/880 Hz audio in both directions"
    );
    if let Some(device_host) = std::env::var_os("ASH_TEST_VOICE_HOST") {
        physical_audio(
            &mut alice,
            &mut bob,
            &first_owner,
            &first_peer,
            device_host.into(),
        )
        .await;
    }

    alice.mute().unwrap();
    let mut clock = tokio::time::interval(Duration::from_millis(10));
    let mut heard_bob = 0;
    for frame in 0..150 {
        clock.tick().await;
        alice.send_audio(&tone(frame, 440.)).await.unwrap();
        bob.send_audio(&tone(frame, 880.)).await.unwrap();
        if let Ok(Some(audio)) = timeout(Duration::from_millis(2), alice.next_audio()).await {
            if energy(&audio.samples, 880.) > 500. {
                heard_bob += 1;
            }
        }
        if let Ok(Some(audio)) = timeout(Duration::from_millis(2), bob.next_audio()).await {
            if frame > 75 {
                assert!(
                    energy(&audio.samples, 440.) < 100.,
                    "muted Alice remained audible"
                );
            }
        }
    }
    assert!(heard_bob >= 20, "muting Alice interrupted Bob");
    alice.unmute().unwrap();
    exchange(&mut alice, &mut bob, &first_owner, &first_peer, 960).await;
    eprintln!("channel: mute stops only the muted source; unmute restores decoded audio");

    let peer_member = space["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|member| member["name"] == "Bob")
        .unwrap()["id"]
        .clone();
    let space = request(
        "/v1/channels/edit",
        owner_key.expose(),
        json!({"spaceId":space["id"], "revision":space["revision"], "change":{"type":"setRole", "memberId":peer_member, "role":"viewer"}}),
        200,
    );
    // Do not read/join to trigger reconciliation: the server's background recovery
    // must tear down both old media connections even if the revoked peer is idle.
    tokio::join!(disconnected(&mut alice), disconnected(&mut bob));
    alice.close().await.unwrap();
    bob.close().await.unwrap();
    let second_owner = owner.join("alice-desktop").unwrap();
    let second_peer = peer.join("bob-desktop").unwrap();
    assert!(second_owner.call.media_epoch > first_owner.call.media_epoch);
    assert_ne!(second_owner.call.media_room, first_peer.call.media_room);
    assert!(!second_peer.microphone);
    assert_eq!(second_peer.member.role, call::CallRole::Listener);
    assert!(
        MediaRoom::connect(
            &executable("ASH_LIVEKIT_CLIENT_PATH"),
            &second_peer.server_url,
            &second_peer.participant_token,
            AudioPublication::Microphone,
        )
        .await
        .is_err(),
        "LiveKit allowed a listener to publish a microphone track"
    );
    let mut alice = connect(&second_owner, AudioPublication::Microphone).await;
    let mut bob = connect(&second_peer, AudioPublication::SubscribeOnly).await;
    assert!(bob.send_audio(&tone(0, 880.)).await.is_err());
    hear(&alice, &mut bob, &second_owner.participant_id).await;
    // Self-hosted LiveKit may let an old JWT recreate its old empty room. The
    // security property is that it cannot receive or inject current-room audio.
    stale_is_isolated(&first_peer, &mut alice, &mut bob).await;
    eprintln!(
        "channel: viewer still hears audio; publishing denied; cached speaker ticket isolated"
    );

    request(
        "/v1/channels/edit",
        owner_key.expose(),
        json!({"spaceId":space["id"], "revision":space["revision"], "change":{"type":"removeMember", "memberId":peer_member}}),
        200,
    );
    tokio::join!(disconnected(&mut alice), disconnected(&mut bob));
    alice.close().await.unwrap();
    bob.close().await.unwrap();
    assert!(matches!(peer.join("bob-desktop"), Err(CallError::Denied)));
    assert!(matches!(peer.read(), Err(CallError::Denied)));
    request("/v1/channels/call", peer_key.expose(), resource, 403);
    let third_owner = owner.join("alice-desktop").unwrap();
    assert!(third_owner.call.media_epoch > second_owner.call.media_epoch);
    let alice = connect(&third_owner, AudioPublication::Microphone).await;
    let mut stale = connect(&second_peer, AudioPublication::SubscribeOnly).await;
    let mut clock = tokio::time::interval(Duration::from_millis(10));
    for frame in 0..100 {
        clock.tick().await;
        alice.send_audio(&tone(frame, 440.)).await.unwrap();
        assert!(
            timeout(Duration::from_millis(2), stale.next_audio())
                .await
                .is_err(),
            "removed member received current-room audio with a cached listener ticket"
        );
    }
    stale.close().await.unwrap();
    alice.close().await.unwrap();
    let ended = owner.end("end", owner.read().unwrap().revision).unwrap();
    assert_eq!(ended.media_state, call::MediaState::Closed);
    eprintln!(
        "channel: removal disconnects live clients, denies new grants and isolates cached listener ticket; call ended"
    );
}

fn executable(key: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(key).unwrap_or_else(|| panic!("set {key}")))
        .canonicalize()
        .unwrap()
}

async fn connect(grant: &MediaJoin, publication: AudioPublication) -> MediaRoom {
    timeout(
        Duration::from_secs(20),
        MediaRoom::connect(
            &executable("ASH_LIVEKIT_CLIENT_PATH"),
            &grant.server_url,
            &grant.participant_token,
            publication,
        ),
    )
    .await
    .expect("media join timed out")
    .unwrap()
}

async fn disconnected(room: &mut MediaRoom) {
    timeout(Duration::from_secs(10), async {
        loop {
            match room.next_event().await {
                Some(MediaEvent::Disconnected) | None => break,
                _ => {}
            }
        }
    })
    .await
    .expect("permission change did not disconnect old media");
}

async fn exchange(
    alice: &mut MediaRoom,
    bob: &mut MediaRoom,
    a: &MediaJoin,
    b: &MediaJoin,
    samples: usize,
) {
    let mut heard = [0, 0];
    let mut clock = tokio::time::interval(Duration::from_millis((samples / 48) as u64));
    for frame in 0..500 {
        clock.tick().await;
        let mut a_tone = tone(frame * (samples / 480), 440.);
        let mut b_tone = tone(frame * (samples / 480), 880.);
        if samples == 960 {
            a_tone.extend(tone(frame * 2 + 1, 440.));
            b_tone.extend(tone(frame * 2 + 1, 880.));
        }
        alice.send_audio(&a_tone).await.unwrap();
        bob.send_audio(&b_tone).await.unwrap();
        let (received_a, received_b) = tokio::join!(
            timeout(Duration::from_millis(2), alice.next_audio()),
            timeout(Duration::from_millis(2), bob.next_audio()),
        );
        for (index, received, source, frequency) in [
            (0, received_a, &b.participant_id, 880.),
            (1, received_b, &a.participant_id, 440.),
        ] {
            if let Ok(Some(audio)) = received {
                assert_eq!(&audio.participant_id, source);
                if energy(&audio.samples, frequency) > 500. {
                    heard[index] += 1;
                }
            }
        }
        if heard.iter().all(|count| *count >= 20) {
            return;
        }
    }
    panic!("missing sustained decoded audio: {heard:?}");
}

async fn hear(source: &MediaRoom, listener: &mut MediaRoom, participant: &str) {
    let mut heard = 0;
    let mut clock = tokio::time::interval(Duration::from_millis(10));
    for frame in 0..500 {
        clock.tick().await;
        source.send_audio(&tone(frame, 440.)).await.unwrap();
        if let Ok(Some(audio)) = timeout(Duration::from_millis(2), listener.next_audio()).await {
            assert_eq!(audio.participant_id, participant);
            if energy(&audio.samples, 440.) > 500. {
                heard += 1;
            }
        }
        if heard >= 20 {
            return;
        }
    }
    panic!("listener did not receive sustained decoded audio: {heard}");
}

async fn stale_is_isolated(grant: &MediaJoin, alice: &mut MediaRoom, bob: &mut MediaRoom) {
    let mut stale = connect(grant, AudioPublication::Microphone).await;
    let mut clock = tokio::time::interval(Duration::from_millis(10));
    for frame in 0..100 {
        clock.tick().await;
        alice.send_audio(&tone(frame, 440.)).await.unwrap();
        stale.send_audio(&tone(frame, 1320.)).await.unwrap();
        assert!(
            timeout(Duration::from_millis(2), stale.next_audio())
                .await
                .is_err(),
            "cached speaker ticket heard the current room"
        );
        assert!(
            timeout(Duration::from_millis(2), alice.next_audio())
                .await
                .is_err(),
            "cached speaker injected audio into the current room"
        );
        if let Ok(Some(audio)) = timeout(Duration::from_millis(2), bob.next_audio()).await {
            assert_ne!(audio.participant_id, grant.participant_id);
        }
    }
    stale.close().await.unwrap();
}

fn tone(frame: usize, frequency: f64) -> Vec<i16> {
    (0..480)
        .map(|i| {
            (((frame * 480 + i) as f64 * frequency * std::f64::consts::TAU / 48_000.).sin() * 6000.)
                as i16
        })
        .collect()
}

fn energy(samples: &[i16], frequency: f64) -> f64 {
    let (mut real, mut imaginary) = (0., 0.);
    for (index, sample) in samples.iter().enumerate() {
        let phase = index as f64 * frequency * std::f64::consts::TAU / 48_000.;
        real += f64::from(*sample) * phase.cos();
        imaginary += f64::from(*sample) * phase.sin();
    }
    real.hypot(imaginary) / samples.len() as f64
}

/// Explicit opt-in only: opens the default microphone and output device. Samples
/// stay in memory; only frame counts are logged. Speak while the return tone plays.
async fn physical_audio(
    alice: &mut MediaRoom,
    bob: &mut MediaRoom,
    a: &MediaJoin,
    b: &MediaJoin,
    executable: PathBuf,
) {
    let mut devices = voice_host::AudioHost::spawn(&executable).await.unwrap();
    devices
        .start(voice_host::AudioConfig {
            rate: voice_host::SampleRate::Hz48000,
            direction: voice_host::Direction::Duplex,
            processing: voice_host::Processing::Speech,
        })
        .await
        .unwrap();
    eprintln!(
        "physical audio: microphone open; speak for several seconds while the peer's return tone plays"
    );
    let mut mixer = livekit_client::AudioMixer::default();
    let mut captured = 0;
    let mut received = 0;
    let mut returned = 0;
    for frame in 0..3000 {
        let audio = timeout(Duration::from_secs(2), devices.next_capture())
            .await
            .unwrap()
            .unwrap();
        if rms(&audio.samples) > 100. {
            captured += 1;
        }
        alice.send_audio(&audio.samples).await.unwrap();
        let mut reply = tone(frame * 2, 880.);
        reply.extend(tone(frame * 2 + 1, 880.));
        bob.send_audio(&reply).await.unwrap();
        for _ in 0..3 {
            if let Ok(Some(audio)) = timeout(Duration::from_millis(1), bob.next_audio()).await {
                assert_eq!(audio.participant_id, a.participant_id);
                if rms(&audio.samples) > 100. {
                    received += 1;
                }
            }
            if let Ok(Some(audio)) = timeout(Duration::from_millis(1), alice.next_audio()).await {
                assert_eq!(audio.participant_id, b.participant_id);

                if energy(&audio.samples, 880.) > 500. {
                    returned += 1;
                }
                mixer.push(audio).unwrap();
            }
        }
        let playback = mixer.render(960, std::time::Instant::now()).unwrap();
        devices.play(&playback).await.unwrap();
        if frame >= 250 && captured >= 20 && received >= 20 && returned >= 20 {
            break;
        }
    }
    devices.stop().await.unwrap();
    devices.close().await.unwrap();
    eprintln!(
        "physical audio: microphone frames={captured}, decoded at peer={received}, return tone frames played={returned}"
    );
    assert!(captured >= 20, "no sustained microphone input: {captured}");
    assert!(
        received >= 20,
        "peer did not decode microphone audio: {received}"
    );
    assert!(
        returned >= 20,
        "no decoded return tone submitted to the physical output: {returned}"
    );
}

fn rms(samples: &[i16]) -> f64 {
    (samples
        .iter()
        .map(|sample| f64::from(*sample).powi(2))
        .sum::<f64>()
        / samples.len() as f64)
        .sqrt()
}
