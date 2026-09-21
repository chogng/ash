use ash_secrets::SecretValue;
use livekit_api::MediaPermissions;
use livekit_api::MediaService;
use livekit_client::AudioPublication;
use livekit_client::MediaRoom;
use std::net::TcpListener;
use std::net::TcpStream;
use std::net::UdpSocket;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;
use tokio::time::timeout;

struct Server {
    child: Child,
    _directory: tempfile::TempDir,
    service: MediaService,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Server {
    fn start() -> Self {
        let executable = std::env::var_os("ASH_TEST_LIVEKIT_SERVER")
            .expect("set ASH_TEST_LIVEKIT_SERVER to the verified LiveKit executable");
        let directory = tempfile::tempdir().unwrap();
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let udp = UdpSocket::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let secret = "ash-test-livekit-secret-thirty-two-bytes";
        let config = directory.path().join("livekit.yaml");
        std::fs::write(&config, format!("port: {port}\nbind_addresses: [127.0.0.1]\nrtc:\n  udp_port: {udp}\n  tcp_port: 0\n  node_ip: 127.0.0.1\n  use_external_ip: false\nkeys:\n  ash-test: {secret}\nlogging:\n  level: error\n")).unwrap();
        let child = Command::new(executable)
            .arg("--config")
            .arg(&config)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let service = MediaService::new(
            &format!("ws://127.0.0.1:{port}"),
            &format!("http://127.0.0.1:{port}"),
            "ash-test".into(),
            SecretValue::new(secret.as_bytes().to_vec()),
        )
        .unwrap();
        let mut server = Self {
            child,
            _directory: directory,
            service,
        };
        let start = Instant::now();
        loop {
            assert!(
                server.child.try_wait().unwrap().is_none(),
                "LiveKit exited before listening"
            );
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "LiveKit startup timed out"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        server
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires the pinned LiveKit Server executable"]
async fn real_room_transmits_audio_both_ways_and_enforces_listener_permissions() {
    let server = Server::start();
    server.service.create_room("audio-test").await.unwrap();
    let permissions = MediaPermissions {
        microphone: true,
        subscribe: true,
        screen: false,
    };
    let a_token = server
        .service
        .issue_join("audio-test", "alice", permissions)
        .unwrap();
    let b_token = server
        .service
        .issue_join("audio-test", "bob", permissions)
        .unwrap();
    let listener = server
        .service
        .issue_join(
            "audio-test",
            "listener",
            MediaPermissions {
                subscribe: true,
                ..Default::default()
            },
        )
        .unwrap();
    let mut alice = MediaRoom::connect(
        &a_token.server_url,
        a_token.token(),
        AudioPublication::Microphone,
    )
    .await
    .unwrap();
    let mut bob = MediaRoom::connect(
        &b_token.server_url,
        b_token.token(),
        AudioPublication::Agent,
    )
    .await
    .unwrap();
    let stats: livekit_client::SessionStats = alice.stats().await.unwrap();
    assert!(!stats.publisher_stats.is_empty() || !stats.subscriber_stats.is_empty());
    let observer = MediaRoom::connect(
        &listener.server_url,
        listener.token(),
        AudioPublication::SubscribeOnly,
    )
    .await
    .unwrap();
    assert!(observer.send_audio(&[0; 480]).await.is_err());
    assert!(alice.send_audio(&[0; 1]).await.is_err());
    let mut a_heard = 0;
    let mut b_heard = 0;
    let mut tick = tokio::time::interval(Duration::from_millis(10));
    for frame in 0..500 {
        tick.tick().await;
        let tone = |frequency: f64| -> Vec<i16> {
            (0..480)
                .map(|i| {
                    (((frame * 480 + i) as f64 * frequency * std::f64::consts::TAU / 48000.).sin()
                        * 6000.) as i16
                })
                .collect()
        };
        alice.send_audio(&tone(440.)).await.unwrap();
        bob.send_audio(&tone(880.)).await.unwrap();
        let (a, b) = tokio::join!(
            timeout(Duration::from_millis(2), alice.next_audio()),
            timeout(Duration::from_millis(2), bob.next_audio())
        );
        if let Ok(Some(audio)) = a {
            assert_eq!(audio.participant_id, "bob");
            if audio
                .samples
                .iter()
                .any(|sample| sample.unsigned_abs() > 500)
            {
                a_heard += 1;
            }
        }
        if let Ok(Some(audio)) = b {
            assert_eq!(audio.participant_id, "alice");
            if audio
                .samples
                .iter()
                .any(|sample| sample.unsigned_abs() > 500)
            {
                b_heard += 1;
            }
        }
        if a_heard >= 20 && b_heard >= 20 {
            break;
        }
    }
    assert!(
        a_heard >= 20,
        "Alice did not receive sustained decoded Bob audio: {a_heard}"
    );
    assert!(
        b_heard >= 20,
        "Bob did not receive sustained decoded Alice audio: {b_heard}"
    );
    alice.mute().unwrap();
    alice.unmute().unwrap();
    alice.close().await.unwrap();
    bob.close().await.unwrap();
    observer.close().await.unwrap();
    server.service.delete_room("audio-test").await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires the pinned LiveKit Server executable"]
async fn three_speakers_keep_their_sources_and_muting_stops_only_one_source() {
    let server = Server::start();
    server.service.create_room("three-speakers").await.unwrap();
    let permissions = MediaPermissions {
        microphone: true,
        subscribe: true,
        screen: false,
    };
    let names = ["alice", "bob", "carol"];
    let frequencies = [440., 880., 1320.];
    let mut rooms = Vec::new();
    for name in names {
        let ticket = server
            .service
            .issue_join("three-speakers", name, permissions)
            .unwrap();
        rooms.push(
            MediaRoom::connect(
                &ticket.server_url,
                ticket.token(),
                AudioPublication::Microphone,
            )
            .await
            .unwrap(),
        );
    }
    let mut heard = [[0; 3]; 3];
    let mut after_mute = [[0; 3]; 3];
    let mut clock = tokio::time::interval(Duration::from_millis(10));
    for packet in 0..350 {
        clock.tick().await;
        if packet == 200 {
            rooms[0].mute().unwrap();
        }
        for (index, room) in rooms.iter().enumerate() {
            let samples: Vec<i16> = (0..480)
                .map(|i| {
                    (((packet * 480 + i) as f64 * frequencies[index] * std::f64::consts::TAU
                        / 48_000.)
                        .sin()
                        * 6000.) as i16
                })
                .collect();
            room.send_audio(&samples).await.unwrap();
        }
        for (index, room) in rooms.iter_mut().enumerate() {
            // Drain more than one source each tick, including control events through next_audio.
            for _ in 0..3 {
                if let Ok(Some(frame)) = timeout(Duration::from_millis(1), room.next_audio()).await
                {
                    let source = names
                        .iter()
                        .position(|name| *name == frame.participant_id)
                        .unwrap();
                    assert_ne!(source, index);
                    if tone_energy(&frame.samples, frequencies[source]) > 500. {
                        if packet < 200 {
                            heard[index][source] += 1;
                        }
                        if packet > 250 {
                            after_mute[index][source] += 1;
                        }
                    }
                }
            }
        }
    }
    for listener in 0..3 {
        for source in 0..3 {
            if listener == source {
                continue;
            }
            assert!(
                heard[listener][source] >= 20,
                "missing tone {source} at {listener}: {heard:?}"
            );
            if source == 0 {
                assert_eq!(
                    after_mute[listener][source], 0,
                    "muted source remained audible"
                );
            } else {
                assert!(
                    after_mute[listener][source] >= 10,
                    "muting Alice interrupted another source: {after_mute:?}"
                );
            }
        }
    }
    for room in rooms {
        room.close().await.unwrap();
    }
    server.service.delete_room("three-speakers").await.unwrap();
}

fn tone_energy(samples: &[i16], frequency: f64) -> f64 {
    let (mut real, mut imaginary) = (0., 0.);
    for (index, sample) in samples.iter().enumerate() {
        let phase = index as f64 * frequency * std::f64::consts::TAU / 48_000.;
        real += f64::from(*sample) * phase.cos();
        imaginary += f64::from(*sample) * phase.sin();
    }
    real.hypot(imaginary) / samples.len() as f64
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires the pinned LiveKit Server executable"]
async fn screen_share_transmits_decoded_frames_and_republishes_after_stop() {
    let server = Server::start();
    server.service.create_room("screen-test").await.unwrap();
    let publisher = server
        .service
        .issue_join(
            "screen-test",
            "presenter",
            MediaPermissions {
                screen: true,
                subscribe: true,
                microphone: false,
            },
        )
        .unwrap();
    let listener = server
        .service
        .issue_join(
            "screen-test",
            "viewer",
            MediaPermissions {
                screen: false,
                subscribe: true,
                microphone: false,
            },
        )
        .unwrap();
    let mut presenter = MediaRoom::connect(
        &publisher.server_url,
        publisher.token(),
        AudioPublication::SubscribeOnly,
    )
    .await
    .unwrap();
    let mut viewer = MediaRoom::connect(
        &listener.server_url,
        listener.token(),
        AudioPublication::SubscribeOnly,
    )
    .await
    .unwrap();
    let source = screen_capture::mock::MockCaptureSource::new("display", 320, 240);
    let mut previous_track = String::new();
    for _ in 0..2 {
        presenter.start_screen_share(&source, 15).await.unwrap();
        assert!(presenter.is_screen_sharing());
        let track = timeout(Duration::from_secs(15), async {
            let mut received = 0;
            loop {
                if let Some(livekit_client::MediaEvent::Video(frame)) = viewer.next_event().await {
                    assert_eq!(frame.participant_id, "presenter");
                    assert_eq!(
                        (frame.width, frame.height, frame.rgba.len()),
                        (320, 240, 320 * 240 * 4)
                    );
                    received += 1;
                    if received == 3 {
                        break frame.track_id;
                    }
                }
            }
        })
        .await
        .expect("no decoded screen frames");
        assert_ne!(track, previous_track);
        presenter.stop_screen_share().await.unwrap();
        assert!(!presenter.is_screen_sharing());
        timeout(Duration::from_secs(5), async {
            loop {
                if let Some(livekit_client::MediaEvent::TrackRemoved { track_id }) =
                    viewer.next_event().await
                {
                    if track_id == track {
                        break;
                    }
                }
            }
        })
        .await
        .expect("screen track was not removed");
        assert!(
            timeout(Duration::from_millis(250), async {
                loop {
                    if let Some(livekit_client::MediaEvent::Video(_)) = viewer.next_event().await {
                        break;
                    }
                }
            })
            .await
            .is_err(),
            "video survived unpublication"
        );
        previous_track = track;
    }
    presenter.close().await.unwrap();
    viewer.close().await.unwrap();
    server.service.delete_room("screen-test").await.unwrap();
}
