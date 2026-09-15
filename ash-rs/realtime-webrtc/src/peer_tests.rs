use super::*;

async fn pair(network: Network, channel: bool) -> (VoicePeer, VoicePeer) {
    let mut left = VoicePeer::new(PeerConfig {
        network,
        data_channel: if channel {
            DataChannel::Initiate("ash-test".into())
        } else {
            DataChannel::Disabled
        },
    })
    .await
    .unwrap();
    let mut right = VoicePeer::new(PeerConfig {
        network,
        data_channel: if channel {
            DataChannel::Accept("ash-test".into())
        } else {
            DataChannel::Disabled
        },
    })
    .await
    .unwrap();
    let offer = left.offer().await.unwrap();
    assert!(!offer.contains("oai-events"));
    let answer = right.answer(&offer).await.unwrap();
    left.accept_answer(&answer).await.unwrap();
    let (a, b) = tokio::join!(left.connected(), right.connected());
    a.unwrap();
    b.unwrap();
    (left, right)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn audio_only_connection_sends_real_opus_without_application_channel() {
    timeout(Duration::from_secs(25), async {
        let (mut left, mut right) = pair(Network::Udp, false).await;
        let send = async {
            for step in 0..15 {
                let pcm: Vec<i16> = (0..960)
                    .map(|i| (((step * 960 + i) as f32 * 0.06).sin() * 12_000.0) as i16)
                    .collect();
                left.send_audio(&pcm).await.unwrap();
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        let receive = async {
            let mut packets = 0;
            while packets < 5 {
                if let PeerEvent::Audio(pcm) = right.next_event().await.unwrap() {
                    assert_eq!(pcm.len(), 960);
                    assert!(pcm.iter().any(|s| s.unsigned_abs() > 1000));
                    packets += 1;
                }
            }
        };
        tokio::join!(send, receive);
        left.close().await.unwrap();
        right.close().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tcp_transports_caller_named_channel_messages_both_ways() {
    timeout(Duration::from_secs(25), async {
        let (mut left, mut right) = pair(Network::Tcp, true).await;
        assert!(matches!(
            left.next_event().await.unwrap(),
            PeerEvent::DataChannelOpened
        ));
        assert!(matches!(
            right.next_event().await.unwrap(),
            PeerEvent::DataChannelOpened
        ));
        left.send_text("hello").await.unwrap();
        match right.next_event().await.unwrap() {
            PeerEvent::Data { bytes, text } => {
                assert!(text);
                assert_eq!(bytes, b"hello");
            }
            _ => panic!("data expected"),
        }
        right.send_text("response").await.unwrap();
        match left.next_event().await.unwrap() {
            PeerEvent::Data { bytes, .. } => assert_eq!(bytes, b"response"),
            _ => panic!("data expected"),
        }
        left.close().await.unwrap();
        right.close().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn invalid_sdp_and_audio_fail_before_negotiation() {
    let mut peer = VoicePeer::new(PeerConfig {
        network: Network::Udp,
        data_channel: DataChannel::Disabled,
    })
    .await
    .unwrap();
    assert!(matches!(
        peer.accept_answer("secret-invalid-sdp").await,
        Err(TransportError::InvalidInput)
    ));
    assert!(matches!(
        peer.send_audio(&[0; 1]).await,
        Err(TransportError::InvalidInput)
    ));
    peer.close().await.unwrap();
}

#[tokio::test]
async fn dropping_peer_releases_owned_tasks_and_handler() {
    let peer = VoicePeer::new(PeerConfig {
        network: Network::Udp,
        data_channel: DataChannel::Disabled,
    })
    .await
    .unwrap();
    let resources = Arc::downgrade(&peer.resources);
    drop(peer);
    timeout(Duration::from_secs(3), async {
        while resources.upgrade().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
