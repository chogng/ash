use crate::MediaError;
use livekit_protocol as proto;
use livekit_signaling::SignalClient;
use livekit_signaling::SignalEvent;
use livekit_signaling::SignalOptions;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodec;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodecParameters;
use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use webrtc::media_stream::track_remote::TrackRemote;
use webrtc::peer_connection::MediaEngine;
use webrtc::peer_connection::PeerConnection;
use webrtc::peer_connection::PeerConnectionBuilder;
use webrtc::peer_connection::PeerConnectionEventHandler;
use webrtc::peer_connection::RTCConfigurationBuilder;
use webrtc::peer_connection::RTCIceCandidateInit;
use webrtc::peer_connection::RTCIceServer;
use webrtc::peer_connection::RTCPeerConnectionIceEvent;
use webrtc::peer_connection::RTCPeerConnectionState;
use webrtc::peer_connection::RTCSessionDescription;

pub(crate) enum RtcEvent {
    Signal(proto::signal_response::Message),
    Track(Arc<dyn TrackRemote>),
    State(proto::SignalTarget, RTCPeerConnectionState),
    Closed,
}

struct Events {
    signal: Arc<SignalClient>,
    target: proto::SignalTarget,
    events: mpsc::Sender<RtcEvent>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Events {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        let Ok(candidate) = event.candidate.to_json() else {
            return;
        };
        let Ok(candidate_init) = serde_json::to_string(&candidate) else {
            return;
        };
        self.signal
            .send(proto::signal_request::Message::Trickle(
                proto::TrickleRequest {
                    candidate_init,
                    target: self.target as i32,
                    r#final: false,
                },
            ))
            .await;
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let _ = self.events.send(RtcEvent::State(self.target, state)).await;
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        let _ = self.events.send(RtcEvent::Track(track)).await;
    }
}

pub(crate) struct RtcTransport {
    pub(crate) signal: Arc<SignalClient>,
    pub(crate) publisher: Arc<dyn PeerConnection>,
    pub(crate) subscriber: Arc<dyn PeerConnection>,
    worker: JoinHandle<()>,
    mute: mpsc::Sender<proto::MuteTrackRequest>,
    mute_worker: JoinHandle<()>,
}

impl RtcTransport {
    pub(crate) async fn connect(
        url: &str,
        token: &str,
    ) -> Result<(Self, proto::JoinResponse, mpsc::Receiver<RtcEvent>), MediaError> {
        let (signal, join, mut signal_events) =
            SignalClient::connect(url, token, SignalOptions::default(), None)
                .await
                .map_err(|_| MediaError::Connection)?;
        let signal = Arc::new(signal);
        let (events_tx, events_rx) = mpsc::channel(128);
        let servers = join
            .ice_servers
            .iter()
            .map(|server| RTCIceServer {
                urls: server.urls.clone(),
                username: server.username.clone(),
                credential: server.credential.clone(),
                ..Default::default()
            })
            .collect();
        let config = RTCConfigurationBuilder::default()
            .with_ice_servers(servers)
            .build();
        let mut media = MediaEngine::default();
        media
            .register_codec(
                RTCRtpCodecParameters {
                    rtp_codec: RTCRtpCodec {
                        mime_type: "audio/opus".into(),
                        clock_rate: 48_000,
                        channels: 2,
                        sdp_fmtp_line: "minptime=10;useinbandfec=1".into(),
                        ..Default::default()
                    },
                    payload_type: 111,
                },
                RtpCodecKind::Audio,
            )
            .map_err(|_| MediaError::Connection)?;
        media
            .register_codec(
                RTCRtpCodecParameters {
                    rtp_codec: RTCRtpCodec {
                        mime_type: "video/VP8".into(),
                        clock_rate: 90_000,
                        ..Default::default()
                    },
                    payload_type: 96,
                },
                RtpCodecKind::Video,
            )
            .map_err(|_| MediaError::Connection)?;
        let publisher = match peer(
            signal.clone(),
            proto::SignalTarget::Publisher,
            events_tx.clone(),
            config.clone(),
            media.clone(),
        )
        .await
        {
            Ok(peer) => peer,
            Err(error) => {
                signal.close().await;
                return Err(error);
            }
        };
        let subscriber = match peer(
            signal.clone(),
            proto::SignalTarget::Subscriber,
            events_tx.clone(),
            config,
            media,
        )
        .await
        {
            Ok(peer) => peer,
            Err(error) => {
                signal.close().await;
                let _ = publisher.close().await;
                return Err(error);
            }
        };
        let publisher_peer = publisher.clone();
        let subscriber_peer = subscriber.clone();
        let worker_signal = signal.clone();
        let worker = tokio::spawn(async move {
            while let Some(event) = signal_events.recv().await {
                let result = match event {
                    SignalEvent::Message(message) => {
                        handle_signal(
                            &worker_signal,
                            &publisher_peer,
                            &subscriber_peer,
                            *message,
                            &events_tx,
                        )
                        .await
                    }
                    SignalEvent::Close(_) => {
                        let _ = events_tx.send(RtcEvent::Closed).await;
                        break;
                    }
                };
                if result.is_err() {
                    let _ = events_tx.send(RtcEvent::Closed).await;
                    break;
                }
            }
        });
        let (mute, mut requests) = mpsc::channel(64);
        let mute_signal = signal.clone();
        let mute_worker = tokio::spawn(async move {
            while let Some(request) = requests.recv().await {
                mute_signal
                    .send(proto::signal_request::Message::Mute(request))
                    .await;
            }
        });
        Ok((
            Self {
                signal,
                publisher,
                subscriber,
                worker,
                mute,
                mute_worker,
            },
            join,
            events_rx,
        ))
    }

    pub(crate) async fn negotiate_publisher(&self) -> Result<(), MediaError> {
        let offer = self
            .publisher
            .create_offer(None)
            .await
            .map_err(|_| MediaError::Publication)?;
        self.publisher
            .set_local_description(offer.clone())
            .await
            .map_err(|_| MediaError::Publication)?;
        self.signal
            .send(proto::signal_request::Message::Offer(
                proto::SessionDescription {
                    r#type: "offer".into(),
                    sdp: offer.sdp,
                    ..Default::default()
                },
            ))
            .await;
        Ok(())
    }

    pub(crate) fn send_mute(&self, sid: &str, muted: bool) -> Result<(), MediaError> {
        self.mute
            .try_send(proto::MuteTrackRequest {
                sid: sid.to_owned(),
                muted,
                ..Default::default()
            })
            .map_err(|_| MediaError::Consumer)
    }

    pub(crate) async fn close(&self) -> Result<(), MediaError> {
        self.mute_worker.abort();
        // Signal an intentional departure so other participants are notified immediately.
        let _ = timeout(
            Duration::from_secs(2),
            self.signal
                .send(proto::signal_request::Message::Leave(proto::LeaveRequest {
                    reason: proto::DisconnectReason::ClientInitiated as i32,
                    ..Default::default()
                })),
        )
        .await;
        self.worker.abort();
        let publisher = self.publisher.close().await;
        let subscriber = self.subscriber.close().await;
        self.signal.close().await;
        publisher.map_err(|_| MediaError::Connection)?;
        subscriber.map_err(|_| MediaError::Connection)
    }
}

impl Drop for RtcTransport {
    fn drop(&mut self) {
        self.worker.abort();
        self.mute_worker.abort();
    }
}

async fn peer(
    signal: Arc<SignalClient>,
    target: proto::SignalTarget,
    events: mpsc::Sender<RtcEvent>,
    config: webrtc::peer_connection::RTCConfiguration,
    media: MediaEngine,
) -> Result<Arc<dyn PeerConnection>, MediaError> {
    let peer: Arc<dyn PeerConnection> = Arc::new(
        PeerConnectionBuilder::new()
            .with_configuration(config)
            .with_media_engine(media)
            .with_handler(Arc::new(Events {
                signal,
                target,
                events,
            }))
            .with_udp_addrs(vec!["0.0.0.0:0", "[::]:0"])
            .with_tcp_addrs(vec!["0.0.0.0:0", "[::]:0"])
            .build()
            .await
            .map_err(|_| MediaError::Connection)?,
    );
    Ok(peer)
}

async fn handle_signal(
    signal: &SignalClient,
    publisher: &Arc<dyn PeerConnection>,
    subscriber: &Arc<dyn PeerConnection>,
    message: proto::signal_response::Message,
    events: &mpsc::Sender<RtcEvent>,
) -> Result<(), MediaError> {
    match message {
        proto::signal_response::Message::Offer(offer) => {
            let description =
                RTCSessionDescription::offer(offer.sdp).map_err(|_| MediaError::Connection)?;
            let candidates = embedded_candidates(&description)?;
            subscriber
                .set_remote_description(description)
                .await
                .map_err(|_| MediaError::Connection)?;
            for candidate in candidates {
                subscriber
                    .add_ice_candidate(candidate)
                    .await
                    .map_err(|_| MediaError::Connection)?;
            }
            let answer = subscriber
                .create_answer(None)
                .await
                .map_err(|_| MediaError::Connection)?;
            subscriber
                .set_local_description(answer.clone())
                .await
                .map_err(|_| MediaError::Connection)?;
            signal
                .send(proto::signal_request::Message::Answer(
                    proto::SessionDescription {
                        r#type: "answer".into(),
                        sdp: answer.sdp,
                        ..Default::default()
                    },
                ))
                .await;
        }
        proto::signal_response::Message::Answer(answer) => {
            let description =
                RTCSessionDescription::answer(answer.sdp).map_err(|_| MediaError::Connection)?;
            let candidates = embedded_candidates(&description)?;
            publisher
                .set_remote_description(description)
                .await
                .map_err(|_| MediaError::Connection)?;
            for candidate in candidates {
                publisher
                    .add_ice_candidate(candidate)
                    .await
                    .map_err(|_| MediaError::Connection)?;
            }
        }
        proto::signal_response::Message::Trickle(trickle) => {
            let candidate = serde_json::from_str::<RTCIceCandidateInit>(&trickle.candidate_init)
                .map_err(|_| MediaError::Connection)?;
            let target = if trickle.target() == proto::SignalTarget::Publisher {
                publisher
            } else {
                subscriber
            };
            target
                .add_ice_candidate(candidate)
                .await
                .map_err(|_| MediaError::Connection)?;
        }
        other => {
            events
                .send(RtcEvent::Signal(other))
                .await
                .map_err(|_| MediaError::Consumer)?;
        }
    }
    Ok(())
}

fn embedded_candidates(
    description: &RTCSessionDescription,
) -> Result<Vec<RTCIceCandidateInit>, MediaError> {
    let parsed = description
        .unmarshal()
        .map_err(|_| MediaError::Connection)?;
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for media in parsed.media_descriptions {
        let mid = media
            .attributes
            .iter()
            .find(|attribute| attribute.key == "mid")
            .and_then(|attribute| attribute.value.clone());
        for attribute in media.attributes {
            if attribute.key != "candidate" {
                continue;
            }
            let Some(value) = attribute.value else {
                continue;
            };
            if candidates.len() >= 128 {
                return Err(MediaError::Connection);
            }
            if seen.insert((mid.clone(), value.clone())) {
                candidates.push(RTCIceCandidateInit {
                    candidate: format!("candidate:{value}"),
                    sdp_mid: mid.clone(),
                    ..Default::default()
                });
            }
        }
    }
    Ok(candidates)
}
