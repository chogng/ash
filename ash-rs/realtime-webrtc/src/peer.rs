use crate::TransportError;
use crate::playout::Playout;
use futures::future::BoxFuture;
use rtc::rtp::header::Header;
use rtc::rtp::packet::Packet;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodec;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodecParameters;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodingParameters;
use rtc::rtp_transceiver::rtp_sender::RTCRtpEncodingParameters;
use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use webrtc::data_channel::DataChannel as Channel;
use webrtc::data_channel::DataChannelEvent;
use webrtc::media_stream::MediaStreamTrack;
use webrtc::media_stream::track_local::static_rtp::TrackLocalStaticRTP;
use webrtc::media_stream::track_remote::TrackRemote;
use webrtc::media_stream::track_remote::TrackRemoteEvent;
use webrtc::peer_connection::MediaEngine;
use webrtc::peer_connection::PeerConnection;
use webrtc::peer_connection::PeerConnectionBuilder;
use webrtc::peer_connection::PeerConnectionEventHandler;
use webrtc::peer_connection::RTCIceCandidateInit;
use webrtc::peer_connection::RTCIceGatheringState;
use webrtc::peer_connection::RTCPeerConnectionState;
use webrtc::peer_connection::RTCSessionDescription;
use webrtc::peer_connection::SettingEngine;

const WAIT: Duration = Duration::from_secs(15);

enum Description {
    Offer,
    Answer,
}

#[derive(Clone, Debug)]
pub enum DataChannel {
    Disabled,
    Initiate(String),
    Accept(String),
}

#[derive(Clone, Copy, Debug)]
pub enum Network {
    Udp,
    Tcp,
    UdpAndTcp,
}

#[derive(Clone, Debug)]
pub struct PeerConfig {
    pub network: Network,
    pub data_channel: DataChannel,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionState {
    Connecting,
    Connected,
    Disconnected,
    Failed,
    Closed,
}

#[derive(Debug)]
pub enum PeerEvent {
    Audio(Vec<i16>),
    Data { bytes: Vec<u8>, text: bool },
    DataChannelOpened,
}

struct Resources {
    state: watch::Sender<ConnectionState>,
    gathered: watch::Sender<bool>,
    events: mpsc::Sender<PeerEvent>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    closing: AtomicBool,
    track_attached: AtomicBool,
    channel: Mutex<Option<Arc<dyn Channel>>>,
    channel_config: DataChannel,
}

impl Resources {
    fn emit(&self, event: PeerEvent) {
        if self.events.try_send(event).is_err() {
            self.state.send_replace(ConnectionState::Failed);
        }
    }

    fn spawn(&self, future: impl Future<Output = ()> + Send + 'static) {
        let mut tasks = self.tasks.lock().unwrap();
        if !self.closing.load(Ordering::Acquire) {
            tasks.push(tokio::spawn(future));
        }
    }

    fn attach_channel(self: &Arc<Self>, channel: Arc<dyn Channel>) -> bool {
        let mut slot = self.channel.lock().unwrap();
        if slot.is_some() || self.closing.load(Ordering::Acquire) {
            return false;
        }
        *slot = Some(channel.clone());
        drop(slot);
        let resources = self.clone();
        self.spawn(async move {
            while let Some(event) = channel.poll().await {
                match event {
                    DataChannelEvent::OnOpen => resources.emit(PeerEvent::DataChannelOpened),
                    DataChannelEvent::OnMessage(message) => {
                        if message.data.len() > 16 * 1024 {
                            resources.state.send_replace(ConnectionState::Failed);
                            break;
                        }
                        resources.emit(PeerEvent::Data {
                            bytes: message.data.to_vec(),
                            text: message.is_string,
                        });
                    }
                    DataChannelEvent::OnError
                    | DataChannelEvent::OnClose
                    | DataChannelEvent::OnClosing => break,
                    _ => {}
                }
            }
        });
        true
    }

    fn cancel(&self) {
        let mut tasks = self.tasks.lock().unwrap();
        self.closing.store(true, Ordering::Release);
        for task in tasks.drain(..) {
            task.abort();
        }
        self.channel.lock().unwrap().take();
    }
}

// The transport library owns callbacks; callbacks must not retain the session owner.
struct Handler(Weak<Resources>);

impl PeerConnectionEventHandler for Handler {
    fn on_connection_state_change<'a, 'f>(
        &'a self,
        state: RTCPeerConnectionState,
    ) -> BoxFuture<'f, ()>
    where
        'a: 'f,
        Self: 'f,
    {
        Box::pin(async move {
            let Some(resources) = self.0.upgrade() else {
                return;
            };
            let state = match state {
                RTCPeerConnectionState::Connected => ConnectionState::Connected,
                RTCPeerConnectionState::Disconnected => ConnectionState::Disconnected,
                RTCPeerConnectionState::Failed => ConnectionState::Failed,
                RTCPeerConnectionState::Closed => ConnectionState::Closed,
                _ => ConnectionState::Connecting,
            };
            resources.state.send_replace(state);
        })
    }
    fn on_ice_gathering_state_change<'a, 'f>(
        &'a self,
        state: RTCIceGatheringState,
    ) -> BoxFuture<'f, ()>
    where
        'a: 'f,
        Self: 'f,
    {
        Box::pin(async move {
            let Some(resources) = self.0.upgrade() else {
                return;
            };
            if state == RTCIceGatheringState::Complete {
                resources.gathered.send_replace(true);
            }
        })
    }
    fn on_data_channel<'a, 'f>(&'a self, channel: Arc<dyn Channel>) -> BoxFuture<'f, ()>
    where
        'a: 'f,
        Self: 'f,
    {
        Box::pin(async move {
            let Some(resources) = self.0.upgrade() else {
                let _ = channel.close().await;
                return;
            };
            let permitted = match &resources.channel_config {
                DataChannel::Accept(label) => {
                    channel.label().await.is_ok_and(|actual| actual == *label)
                }
                _ => false,
            };
            if !permitted || !resources.attach_channel(channel.clone()) {
                let _ = channel.close().await;
            }
        })
    }
    fn on_track<'a, 'f>(&'a self, track: Arc<dyn TrackRemote>) -> BoxFuture<'f, ()>
    where
        'a: 'f,
        Self: 'f,
    {
        Box::pin(async move {
            let Some(resources) = self.0.upgrade() else {
                return;
            };
            if resources.track_attached.swap(true, Ordering::AcqRel) {
                resources.state.send_replace(ConnectionState::Failed);
                return;
            }
            let owner = resources.clone();
            resources.spawn(async move {
                if receive_audio(track, owner.clone()).await.is_err() {
                    owner.state.send_replace(ConnectionState::Failed);
                }
            });
        })
    }
}

async fn receive_audio(
    track: Arc<dyn TrackRemote>,
    resources: Arc<Resources>,
) -> Result<(), TransportError> {
    let mut playout = Playout::new()?;
    let mut clock = tokio::time::interval(Duration::from_millis(20));
    clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            event = track.poll() => match event {
                Some(TrackRemoteEvent::OnRtpPacket(packet)) => playout.insert(packet.header.sequence_number, &packet.payload)?,
                None | Some(TrackRemoteEvent::OnError | TrackRemoteEvent::OnEnding | TrackRemoteEvent::OnEnded) => break,
                _ => {},
            },
            _ = clock.tick() => if let Some(pcm) = playout.tick()? { resources.emit(PeerEvent::Audio(pcm)); },
        }
    }
    Ok(())
}

/// One owned WebRTC connection. SDP/authentication exchange is performed by the caller.
pub struct VoicePeer {
    connection: Option<Arc<dyn PeerConnection>>,
    resources: Arc<Resources>,
    events: mpsc::Receiver<PeerEvent>,
    state: watch::Receiver<ConnectionState>,
    track: Arc<TrackLocalStaticRTP>,
    encoder: opus::Encoder,
    ssrc: u32,
    sequence: u16,
    timestamp: u32,
}

impl VoicePeer {
    pub async fn new(config: PeerConfig) -> Result<Self, TransportError> {
        if let DataChannel::Initiate(label) | DataChannel::Accept(label) = &config.data_channel {
            if label.is_empty() || label.len() > 128 {
                return Err(TransportError::InvalidInput);
            }
        }
        let (state_tx, state) = watch::channel(ConnectionState::Connecting);
        let (gathered, _) = watch::channel(false);
        let (events_tx, events) = mpsc::channel(32);
        let resources = Arc::new(Resources {
            state: state_tx,
            gathered,
            events: events_tx,
            tasks: Mutex::new(Vec::new()),
            closing: AtomicBool::new(false),
            track_attached: AtomicBool::new(false),
            channel: Mutex::new(None),
            channel_config: config.data_channel.clone(),
        });
        let codec = RTCRtpCodec {
            mime_type: "audio/opus".into(),
            clock_rate: 48_000,
            channels: 2,
            sdp_fmtp_line: "minptime=10;useinbandfec=1".into(),
            rtcp_feedback: Vec::new(),
        };
        let mut media = MediaEngine::default();
        media
            .register_codec(
                RTCRtpCodecParameters {
                    rtp_codec: codec.clone(),
                    payload_type: 111,
                },
                RtpCodecKind::Audio,
            )
            .map_err(|_| TransportError::Connection)?;
        let ssrc = rand::random::<u32>();
        let track = Arc::new(TrackLocalStaticRTP::new(MediaStreamTrack::new(
            "audio".into(),
            format!("{ssrc}"),
            "microphone".into(),
            RtpCodecKind::Audio,
            vec![RTCRtpEncodingParameters {
                codec,
                active: true,
                rtp_coding_parameters: RTCRtpCodingParameters {
                    ssrc: Some(ssrc),
                    ..Default::default()
                },
                ..Default::default()
            }],
        )));
        let mut settings = SettingEngine::default();
        settings.set_ice_connection_attempts(Some(Duration::from_millis(200)), Some(75));
        let builder = PeerConnectionBuilder::new()
            .with_media_engine(media)
            .with_setting_engine(settings)
            .with_handler(Arc::new(Handler(Arc::downgrade(&resources))))
            .with_data_channel_send_buffer_limit(32 * 1024)
            .with_sctp_receive_buffer_size(32 * 1024);
        let builder = match config.network {
            Network::Udp => builder.with_udp_addrs(vec!["0.0.0.0:0"]),
            Network::Tcp => builder.with_tcp_addrs(vec!["0.0.0.0:0"]),
            Network::UdpAndTcp => builder
                .with_udp_addrs(vec!["0.0.0.0:0", "[::]:0"])
                .with_tcp_addrs(vec!["0.0.0.0:0", "[::]:0"]),
        };
        let connection: Arc<dyn PeerConnection> = Arc::new(
            builder
                .build()
                .await
                .map_err(|_| TransportError::Connection)?,
        );
        let peer = Self {
            connection: Some(connection.clone()),
            resources,
            events,
            state,
            track,
            encoder: opus::Encoder::new(48_000, opus::Channels::Mono, opus::Application::Voip)
                .map_err(|_| TransportError::Codec)?,
            ssrc,
            sequence: rand::random(),
            timestamp: rand::random(),
        };
        connection
            .add_track(peer.track.clone())
            .await
            .map_err(|_| TransportError::Connection)?;
        if let DataChannel::Initiate(label) = config.data_channel {
            let channel = connection
                .create_data_channel(&label, None)
                .await
                .map_err(|_| TransportError::Connection)?;
            peer.resources.attach_channel(channel);
        }
        // Terminal queue/codec failures also close sockets when the consumer stops polling.
        let mut failure = peer.state.clone();
        peer.resources.spawn(async move {
            if failure
                .wait_for(|state| *state == ConnectionState::Failed)
                .await
                .is_ok()
            {
                let _ = timeout(Duration::from_secs(2), connection.close()).await;
            }
        });
        Ok(peer)
    }

    fn connection(&self) -> Result<&Arc<dyn PeerConnection>, TransportError> {
        self.connection.as_ref().ok_or(TransportError::Connection)
    }

    pub fn state(&self) -> ConnectionState {
        *self.state.borrow()
    }

    pub async fn offer(&mut self) -> Result<String, TransportError> {
        let description = self
            .connection()?
            .create_offer(None)
            .await
            .map_err(|_| TransportError::Connection)?;
        self.local(description).await
    }

    pub async fn answer(&mut self, offer: &str) -> Result<String, TransportError> {
        self.remote(offer, Description::Offer).await?;
        let description = self
            .connection()?
            .create_answer(None)
            .await
            .map_err(|_| TransportError::Connection)?;
        self.local(description).await
    }

    pub async fn accept_answer(&mut self, answer: &str) -> Result<(), TransportError> {
        self.remote(answer, Description::Answer).await
    }

    async fn local(&self, description: RTCSessionDescription) -> Result<String, TransportError> {
        let connection = self.connection()?;
        timeout(WAIT, async {
            connection
                .set_local_description(description)
                .await
                .map_err(|_| TransportError::Connection)?;
            self.resources
                .gathered
                .subscribe()
                .wait_for(|ready| *ready)
                .await
                .map_err(|_| TransportError::Connection)?;
            connection
                .local_description()
                .await
                .map(|s| s.sdp)
                .ok_or(TransportError::Connection)
        })
        .await
        .map_err(|_| TransportError::Timeout)?
    }

    async fn remote(&self, sdp: &str, kind: Description) -> Result<(), TransportError> {
        if sdp.is_empty() || sdp.len() > 64 * 1024 {
            return Err(TransportError::InvalidInput);
        }
        let description = match kind {
            Description::Offer => RTCSessionDescription::offer(sdp.to_owned()),
            Description::Answer => RTCSessionDescription::answer(sdp.to_owned()),
        }
        .map_err(|_| TransportError::InvalidInput)?;
        let document = description
            .unmarshal()
            .map_err(|_| TransportError::InvalidInput)?;
        let mut candidates = Vec::new();
        for attribute in document
            .media_descriptions
            .iter()
            .flat_map(|media| &media.attributes)
            .filter(|a| a.key == "candidate")
        {
            if candidates.len() == 32 {
                return Err(TransportError::InvalidInput);
            }
            let value = attribute
                .value
                .clone()
                .ok_or(TransportError::InvalidInput)?;
            rtc::ice::candidate::unmarshal_candidate(&value)
                .map_err(|_| TransportError::InvalidInput)?;
            candidates.push(value);
        }
        let connection = self.connection()?;
        timeout(WAIT, async {
            connection
                .set_remote_description(description)
                .await
                .map_err(|_| TransportError::Connection)?;
            for candidate in candidates {
                connection
                    .add_ice_candidate(RTCIceCandidateInit {
                        candidate: format!("candidate:{candidate}"),
                        ..Default::default()
                    })
                    .await
                    .map_err(|_| TransportError::Connection)?;
            }
            Ok(())
        })
        .await
        .map_err(|_| TransportError::Timeout)?
    }

    /// Readiness follows the peer connection, independently of an optional application channel.
    pub async fn connected(&mut self) -> Result<(), TransportError> {
        timeout(
            WAIT,
            self.state.wait_for(|s| {
                matches!(
                    s,
                    ConnectionState::Connected | ConnectionState::Failed | ConnectionState::Closed
                )
            }),
        )
        .await
        .map_err(|_| TransportError::Timeout)?
        .map_err(|_| TransportError::Connection)?;
        if self.state() != ConnectionState::Connected {
            return Err(TransportError::Connection);
        }
        Ok(())
    }

    pub async fn send_audio(&mut self, pcm: &[i16]) -> Result<(), TransportError> {
        if pcm.len() != 960 {
            return Err(TransportError::InvalidInput);
        }
        if self.state() != ConnectionState::Connected {
            return Err(TransportError::Connection);
        }
        let mut data = vec![0; 1275];
        let len = self
            .encoder
            .encode(pcm, &mut data)
            .map_err(|_| TransportError::Codec)?;
        data.truncate(len);
        let packet = Packet {
            header: Header {
                version: 2,
                payload_type: 111,
                sequence_number: self.sequence,
                timestamp: self.timestamp,
                ssrc: self.ssrc,
                ..Default::default()
            },
            payload: data.into(),
        };
        self.sequence = self.sequence.wrapping_add(1);
        self.timestamp = self.timestamp.wrapping_add(960);
        timeout(
            Duration::from_millis(200),
            self.track.write_rtp_with_extensions(packet, &[]),
        )
        .await
        .map_err(|_| TransportError::Timeout)?
        .map_err(|_| TransportError::Connection)
    }

    pub async fn send_text(&self, text: &str) -> Result<(), TransportError> {
        if text.len() > 16 * 1024 {
            return Err(TransportError::InvalidInput);
        }
        let channel = self
            .resources
            .channel
            .lock()
            .unwrap()
            .clone()
            .ok_or(TransportError::Connection)?;
        timeout(Duration::from_secs(2), channel.send_text(text))
            .await
            .map_err(|_| TransportError::Timeout)?
            .map_err(|_| TransportError::Connection)
    }

    pub async fn next_event(&mut self) -> Result<PeerEvent, TransportError> {
        tokio::select! {
            biased;
            _ = self.state.wait_for(|s| matches!(s, ConnectionState::Failed | ConnectionState::Closed)) => Err(TransportError::Connection),
            event = self.events.recv() => event.ok_or(TransportError::Connection),
        }
    }

    pub async fn close(mut self) -> Result<(), TransportError> {
        self.resources.cancel();
        if let Some(connection) = self.connection.take() {
            timeout(Duration::from_secs(2), connection.close())
                .await
                .map_err(|_| TransportError::Timeout)?
                .map_err(|_| TransportError::Connection)?;
        }
        Ok(())
    }
}

impl Drop for VoicePeer {
    fn drop(&mut self) {
        self.resources.cancel();
        if let Some(connection) = self.connection.take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = timeout(Duration::from_secs(2), connection.close()).await;
                });
            }
        }
    }
}

#[cfg(test)]
#[path = "peer_tests.rs"]
mod tests;
