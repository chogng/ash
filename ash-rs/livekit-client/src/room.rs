use crate::MediaError;
use crate::codec;
use crate::rtc::RtcEvent;
use crate::rtc::RtcTransport;
use bytes::Bytes;
use livekit_protocol as proto;
use opus_rs::Application;
use opus_rs::OpusDecoder;
use opus_rs::OpusEncoder;
use rtc::media::Sample;
use rtc::media_stream::MediaStreamTrack;
use rtc::rtp::codec::vp8::Vp8Packet;
use rtc::rtp::packetizer::Depacketizer;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodec;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodingParameters;
use rtc::rtp_transceiver::rtp_sender::RTCRtpEncodingParameters;
use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
use rtc::statistics::StatsSelector;
use screen_capture::ScreenCaptureSource;
use screen_capture::ScreenCaptureStream;
use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_remote::TrackRemote;
use webrtc::media_stream::track_remote::TrackRemoteEvent;
use webrtc::rtp_transceiver::RtpSender;

const DEADLINE: Duration = Duration::from_secs(10);
const MAX_AGE: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AudioPublication {
    Microphone,
    Agent,
    SubscribeOnly,
}

/// Decoded mono PCM at 48 kHz, with its authenticated transport source preserved.
#[derive(Debug)]
pub struct AudioFrame {
    pub participant_id: String,
    pub track_id: String,
    pub received_at: Instant,
    pub samples: Vec<i16>,
}

/// Decoded RGBA video, independently bounded from audio and control events.
#[derive(Debug)]
pub struct ScreenFrame {
    pub participant_id: String,
    pub track_id: String,
    pub received_at: Instant,
    pub width: u32,
    pub height: u32,
    pub rotation: u16,
    pub rgba: Vec<u8>,
}

/// Counts the connection reports returned for the room's publishing and subscribing paths.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MediaStats {
    pub publisher_reports: usize,
    pub subscriber_reports: usize,
}

#[derive(Debug)]
pub enum MediaEvent {
    Connected {
        participant_ids: Vec<String>,
    },
    Audio(AudioFrame),
    Video(ScreenFrame),
    ScreenAdded {
        participant_id: String,
        track_id: String,
    },
    ScreenStopped {
        error: Option<String>,
    },
    ParticipantJoined {
        participant_id: String,
    },
    ParticipantLeft {
        participant_id: String,
    },
    TrackAdded {
        participant_id: String,
        track_id: String,
    },
    TrackRemoved {
        track_id: String,
    },
    TrackMuted {
        track_id: String,
    },
    TrackUnmuted {
        track_id: String,
    },
    Reconnecting,
    Reconnected,
    Disconnected,
}

type Publications = Arc<Mutex<HashMap<String, oneshot::Sender<proto::TrackInfo>>>>;

struct Publication {
    track: Arc<TrackLocalStaticSample>,
    sender: Arc<dyn RtpSender>,
    sid: String,
    ssrc: u32,
    payload_type: u8,
}

fn published_track_event(participant_id: &str, track: &proto::TrackInfo) -> Option<MediaEvent> {
    if track.r#type() == proto::TrackType::Audio {
        Some(MediaEvent::TrackAdded {
            participant_id: participant_id.to_owned(),
            track_id: track.sid.clone(),
        })
    } else if track.r#type() == proto::TrackType::Video
        && track.source() == proto::TrackSource::ScreenShare
    {
        Some(MediaEvent::ScreenAdded {
            participant_id: participant_id.to_owned(),
            track_id: track.sid.clone(),
        })
    } else {
        None
    }
}

/// Owns signaling, two WebRTC connections, and bounded decoded media streams.
pub struct MediaRoom {
    rtc: Arc<RtcTransport>,
    publication: Option<Publication>,
    encoder: Option<tokio::sync::Mutex<OpusEncoder>>,
    muted_local: AtomicBool,
    events: mpsc::Receiver<MediaEvent>,
    audio: mpsc::Receiver<AudioFrame>,
    video: mpsc::Receiver<ScreenFrame>,
    video_tracks: HashMap<String, String>,
    muted: HashSet<String>,
    pending: Publications,
    stop: Option<oneshot::Sender<()>>,
    worker: Option<JoinHandle<Result<(), MediaError>>>,
    screen_publication: Option<Publication>,
    screen_stream: Option<Box<dyn ScreenCaptureStream>>,
    screen_worker: Option<JoinHandle<Result<(), MediaError>>>,
}

impl MediaRoom {
    pub async fn stats(&self) -> Result<MediaStats, MediaError> {
        let publisher = timeout(
            DEADLINE,
            self.rtc
                .publisher
                .get_stats(Instant::now(), StatsSelector::None),
        )
        .await
        .map_err(|_| MediaError::Timeout)?;
        let subscriber = timeout(
            DEADLINE,
            self.rtc
                .subscriber
                .get_stats(Instant::now(), StatsSelector::None),
        )
        .await
        .map_err(|_| MediaError::Timeout)?;
        Ok(MediaStats {
            publisher_reports: publisher.len(),
            subscriber_reports: subscriber.len(),
        })
    }

    pub async fn connect(
        server_url: &str,
        token: &str,
        publish: AudioPublication,
    ) -> Result<Self, MediaError> {
        crate::validate_url(server_url)?;
        crate::transport::install()?;
        let (rtc, join, receiver) = timeout(DEADLINE, RtcTransport::connect(server_url, token))
            .await
            .map_err(|_| MediaError::Timeout)??;
        let rtc = Arc::new(rtc);
        let (event_tx, events) = mpsc::channel(64);
        let (audio_tx, audio) = mpsc::channel(128);
        let (video_tx, video) = mpsc::channel(2);
        let (stop, stopped) = oneshot::channel();
        let pending: Publications = Arc::new(Mutex::new(HashMap::new()));
        let participant_ids = join
            .other_participants
            .iter()
            .map(|p| p.identity.clone())
            .collect();
        event_tx
            .try_send(MediaEvent::Connected { participant_ids })
            .map_err(|_| MediaError::Consumer)?;
        let worker = tokio::spawn(receive(
            rtc.clone(),
            join,
            receiver,
            event_tx,
            audio_tx,
            video_tx,
            pending.clone(),
            stopped,
        ));
        let mut room = Self {
            rtc,
            publication: None,
            encoder: None,
            muted_local: AtomicBool::new(false),
            events,
            audio,
            video,
            video_tracks: HashMap::new(),
            muted: HashSet::new(),
            pending,
            stop: Some(stop),
            worker: Some(worker),
            screen_publication: None,
            screen_stream: None,
            screen_worker: None,
        };
        if publish != AudioPublication::SubscribeOnly {
            let name = if publish == AudioPublication::Agent {
                "agent"
            } else {
                "microphone"
            };
            let publication = room
                .publish(
                    name,
                    RtpCodecKind::Audio,
                    proto::TrackSource::Microphone,
                    0,
                    0,
                )
                .await?;
            room.encoder = Some(tokio::sync::Mutex::new(
                OpusEncoder::new(48_000, 1, Application::Voip)
                    .map_err(|_| MediaError::Publication)?,
            ));
            room.publication = Some(publication);
        }
        Ok(room)
    }

    async fn publish(
        &self,
        name: &str,
        kind: RtpCodecKind,
        source: proto::TrackSource,
        width: u32,
        height: u32,
    ) -> Result<Publication, MediaError> {
        let cid = format!("ash-{}", rand::random::<u64>());
        let (codec, payload_type) = if kind == RtpCodecKind::Audio {
            (
                RTCRtpCodec {
                    mime_type: "audio/opus".into(),
                    clock_rate: 48_000,
                    channels: 2,
                    sdp_fmtp_line: "minptime=10;useinbandfec=1".into(),
                    ..Default::default()
                },
                111,
            )
        } else {
            (
                RTCRtpCodec {
                    mime_type: "video/VP8".into(),
                    clock_rate: 90_000,
                    ..Default::default()
                },
                96,
            )
        };
        let ssrc = rand::random::<u32>();
        let track = Arc::new(
            TrackLocalStaticSample::new(MediaStreamTrack::new(
                cid.clone(),
                cid.clone(),
                name.into(),
                kind,
                vec![RTCRtpEncodingParameters {
                    rtp_coding_parameters: RTCRtpCodingParameters {
                        ssrc: Some(ssrc),
                        ..Default::default()
                    },
                    codec,
                    ..Default::default()
                }],
            ))
            .map_err(|_| MediaError::Publication)?,
        );
        let (response, published) = oneshot::channel();
        self.pending.lock().unwrap().insert(cid.clone(), response);
        self.rtc
            .signal
            .send(proto::signal_request::Message::AddTrack(
                proto::AddTrackRequest {
                    cid: cid.clone(),
                    name: name.into(),
                    r#type: if kind == RtpCodecKind::Audio {
                        proto::TrackType::Audio as i32
                    } else {
                        proto::TrackType::Video as i32
                    },
                    source: source as i32,
                    width,
                    height,
                    disable_red: true,
                    ..Default::default()
                },
            ))
            .await;
        let info = match timeout(DEADLINE, published).await {
            Ok(Ok(info)) => info,
            Ok(Err(_)) => return Err(MediaError::Publication),
            Err(_) => {
                self.pending.lock().unwrap().remove(&cid);
                return Err(MediaError::Timeout);
            }
        };
        let sender = self
            .rtc
            .publisher
            .add_track(track.clone())
            .await
            .map_err(|_| MediaError::Publication)?;
        self.rtc.negotiate_publisher().await?;
        Ok(Publication {
            track,
            sender,
            sid: info.sid,
            ssrc,
            payload_type,
        })
    }

    pub async fn send_audio(&self, samples: &[i16]) -> Result<(), MediaError> {
        if !matches!(samples.len(), 480 | 960) {
            return Err(MediaError::AudioFrame);
        }
        let publication = self.publication.as_ref().ok_or(MediaError::Publication)?;
        if self.muted_local.load(Ordering::Relaxed) {
            return Ok(());
        }
        let encoder = self.encoder.as_ref().ok_or(MediaError::Publication)?;
        let mut encoded = [0u8; 4000];
        let len = encoder
            .lock()
            .await
            .encode_i16(samples, samples.len(), &mut encoded)
            .map_err(|_| MediaError::Publication)?;
        timeout(
            Duration::from_millis(200),
            publication.track.write_sample(
                publication.ssrc,
                publication.payload_type,
                &Sample {
                    data: Bytes::copy_from_slice(&encoded[..len]),
                    duration: Duration::from_millis((samples.len() / 48) as u64),
                    ..Default::default()
                },
                &[],
            ),
        )
        .await
        .map_err(|_| MediaError::Timeout)?
        .map_err(|_| MediaError::Publication)
    }

    pub fn mute(&self) -> Result<(), MediaError> {
        let publication = self.publication.as_ref().ok_or(MediaError::Publication)?;
        self.rtc.send_mute(&publication.sid, true)?;
        self.muted_local.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn unmute(&self) -> Result<(), MediaError> {
        let publication = self.publication.as_ref().ok_or(MediaError::Publication)?;
        self.rtc.send_mute(&publication.sid, false)?;
        self.muted_local.store(false, Ordering::Relaxed);
        Ok(())
    }

    pub async fn next_event(&mut self) -> Option<MediaEvent> {
        loop {
            if self
                .screen_stream
                .as_ref()
                .is_some_and(|stream| !stream.is_active())
                || self
                    .screen_worker
                    .as_ref()
                    .is_some_and(JoinHandle::is_finished)
            {
                let capture_error = self
                    .screen_stream
                    .as_ref()
                    .and_then(|stream| stream.error());
                let worker_error = match self
                    .screen_worker
                    .as_ref()
                    .is_some_and(JoinHandle::is_finished)
                {
                    true => self
                        .screen_worker
                        .take()
                        .unwrap()
                        .await
                        .ok()
                        .and_then(Result::err)
                        .map(|err| err.to_string()),
                    false => None,
                };
                let stop_error = self
                    .stop_screen_share()
                    .await
                    .err()
                    .map(|err| err.to_string());
                let error = capture_error.or(worker_error).or(stop_error);
                return Some(MediaEvent::ScreenStopped { error });
            }
            tokio::select! {
                biased;
                event = self.events.recv() => {
                    let event = event?;
                    match &event {
                        MediaEvent::ScreenAdded { track_id, participant_id } => { self.video_tracks.insert(track_id.clone(), participant_id.clone()); }
                        MediaEvent::ParticipantLeft { participant_id } => { self.video_tracks.retain(|_, owner| owner != participant_id); }
                        MediaEvent::TrackRemoved { track_id } => { self.video_tracks.remove(track_id); self.muted.remove(track_id); }
                        MediaEvent::TrackMuted { track_id } => { self.muted.insert(track_id.clone()); }
                        MediaEvent::TrackUnmuted { track_id } => { self.muted.remove(track_id); }
                        _ => {}
                    }
                    if matches!(event, MediaEvent::Reconnecting | MediaEvent::Disconnected | MediaEvent::TrackRemoved { .. } | MediaEvent::ParticipantLeft { .. } | MediaEvent::TrackMuted { .. } | MediaEvent::TrackUnmuted { .. }) {
                        // Control changes invalidate queued media from the previous topology.
                        while self.audio.try_recv().is_ok() {}
                        while self.video.try_recv().is_ok() {}
                    }
                    return Some(event);
                }
                frame = self.audio.recv() => {
                    let frame = frame?;
                    if frame.received_at.elapsed() <= MAX_AGE && !self.muted.contains(&frame.track_id) {
                        return Some(MediaEvent::Audio(frame));
                    }
                }
                frame = self.video.recv() => {
                    let frame = frame?;
                    if frame.received_at.elapsed() <= MAX_AGE && self.video_tracks.contains_key(&frame.track_id) && !self.muted.contains(&frame.track_id) {
                        return Some(MediaEvent::Video(frame));
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(50)), if self.screen_stream.is_some() => {}
            }
        }
    }

    pub async fn next_audio(&mut self) -> Option<AudioFrame> {
        loop {
            if let MediaEvent::Audio(frame) = self.next_event().await? {
                return Some(frame);
            }
        }
    }

    pub async fn start_screen_share(
        &mut self,
        source: &dyn ScreenCaptureSource,
        fps: u32,
    ) -> Result<(), MediaError> {
        if self.screen_stream.is_some() {
            self.stop_screen_share().await?;
        }
        let info = source.info();
        let (tx, mut rx) = mpsc::channel(2);
        let mut stream = source
            .start_stream(
                fps,
                Box::new(move |frame| {
                    if let Some(planes) = codec::capture_planes(&frame) {
                        let _ = tx.try_send(planes);
                    }
                }),
            )
            .map_err(|err| MediaError::Capture(err.to_string()))?;
        let publication = match self
            .publish(
                "screen-share",
                RtpCodecKind::Video,
                proto::TrackSource::ScreenShare,
                info.width,
                info.height,
            )
            .await
        {
            Ok(publication) => publication,
            Err(error) => {
                stream.stop();
                return Err(error);
            }
        };
        let track = publication.track.clone();
        let ssrc = publication.ssrc;
        let payload_type = publication.payload_type;
        let worker = tokio::spawn(async move {
            let mut encoder = codec::VideoEncoder::new(fps);
            while let Some(frame) = rx.recv().await {
                let encoded = encoder.encode(&frame)?;
                let sample = Sample {
                    data: Bytes::from(encoded),
                    duration: Duration::from_secs_f64(1.0 / f64::from(fps.max(1))),
                    ..Default::default()
                };
                track
                    .write_sample(ssrc, payload_type, &sample, &[])
                    .await
                    .map_err(|_| MediaError::ScreenShare)?;
            }
            Ok(())
        });
        self.screen_publication = Some(publication);
        self.screen_stream = Some(stream);
        self.screen_worker = Some(worker);
        Ok(())
    }

    pub async fn stop_screen_share(&mut self) -> Result<(), MediaError> {
        if let Some(mut stream) = self.screen_stream.take() {
            stream.stop();
        }
        if let Some(worker) = self.screen_worker.take() {
            worker.abort();
            let _ = worker.await;
        }
        if let Some(publication) = self.screen_publication.take() {
            self.rtc
                .publisher
                .remove_track(&publication.sender)
                .await
                .map_err(|_| MediaError::ScreenShare)?;
            self.rtc
                .negotiate_publisher()
                .await
                .map_err(|_| MediaError::ScreenShare)?;
        }
        Ok(())
    }

    pub fn is_screen_sharing(&self) -> bool {
        self.screen_stream
            .as_ref()
            .is_some_and(|stream| stream.is_active())
    }

    pub async fn close(mut self) -> Result<(), MediaError> {
        let screen_result = self.stop_screen_share().await;
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let worker_result = match self.worker.take() {
            Some(worker) => worker.await.map_err(|_| MediaError::Connection)?,
            None => Ok(()),
        };
        screen_result?;
        worker_result
    }
}

impl Drop for MediaRoom {
    fn drop(&mut self) {
        if let Some(mut stream) = self.screen_stream.take() {
            stream.stop();
        }
        if let Some(worker) = self.screen_worker.take() {
            worker.abort();
        }
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

async fn receive(
    rtc: Arc<RtcTransport>,
    join: proto::JoinResponse,
    mut receiver: mpsc::Receiver<RtcEvent>,
    events: mpsc::Sender<MediaEvent>,
    audio: mpsc::Sender<AudioFrame>,
    video: mpsc::Sender<ScreenFrame>,
    pending: Publications,
    mut stop: oneshot::Receiver<()>,
) -> Result<(), MediaError> {
    let mut participants: HashMap<String, proto::ParticipantInfo> = join
        .other_participants
        .into_iter()
        .map(|p| (p.sid.clone(), p))
        .collect();
    let mut tracks: HashMap<String, JoinHandle<()>> = HashMap::new();
    let mut waiting_tracks: Vec<Arc<dyn TrackRemote>> = Vec::new();
    let mut ready_tracks = VecDeque::new();
    let mut disconnected = HashSet::new();
    let mut disconnect_deadline = None;
    let result = 'receive: {
        for participant in participants.values() {
            for track in &participant.tracks {
                if let Some(event) = published_track_event(&participant.identity, track) {
                    if events.try_send(event).is_err() {
                        break 'receive Err(MediaError::Consumer);
                    }
                }
                if track.muted
                    && events
                        .try_send(MediaEvent::TrackMuted {
                            track_id: track.sid.clone(),
                        })
                        .is_err()
                {
                    break 'receive Err(MediaError::Consumer);
                }
            }
        }
        loop {
            let event = if let Some(track) = ready_tracks.pop_front() {
                RtcEvent::Track(track)
            } else {
                tokio::select! {
                    biased;
                    _ = &mut stop => break Ok(()),
                    _ = events.closed() => break Ok(()),
                    _ = async {
                        match disconnect_deadline {
                            Some(deadline) => tokio::time::sleep_until(deadline).await,
                            None => std::future::pending::<()>().await,
                        }
                    } => {
                        let _ = events.try_send(MediaEvent::Disconnected);
                        break Ok(());
                    },
                    event = receiver.recv() => match event { Some(event) => event, None => break Ok(()) },
                }
            };
            let notification = match event {
                RtcEvent::Signal(proto::signal_response::Message::TrackPublished(response)) => {
                    if let Some(info) = response.track {
                        if let Some(sender) = pending.lock().unwrap().remove(&response.cid) {
                            let _ = sender.send(info);
                        }
                    }
                    None
                }
                RtcEvent::Signal(proto::signal_response::Message::Update(update)) => {
                    for p in update.participants {
                        let old = participants.insert(p.sid.clone(), p.clone());
                        if p.state() == proto::participant_info::State::Disconnected {
                            participants.remove(&p.sid);
                            if let Some(old) = old {
                                for track in old.tracks {
                                    if let Some(task) = tracks.remove(&track.sid) {
                                        task.abort();
                                    }
                                    if events
                                        .try_send(MediaEvent::TrackRemoved {
                                            track_id: track.sid,
                                        })
                                        .is_err()
                                    {
                                        break 'receive Err(MediaError::Consumer);
                                    }
                                }
                                if events
                                    .try_send(MediaEvent::ParticipantLeft {
                                        participant_id: old.identity,
                                    })
                                    .is_err()
                                {
                                    break 'receive Err(MediaError::Consumer);
                                }
                            }
                        } else if old.is_none() {
                            if events
                                .try_send(MediaEvent::ParticipantJoined {
                                    participant_id: p.identity.clone(),
                                })
                                .is_err()
                            {
                                break 'receive Err(MediaError::Consumer);
                            }
                            for track in &p.tracks {
                                if let Some(event) = published_track_event(&p.identity, track) {
                                    if events.try_send(event).is_err() {
                                        break 'receive Err(MediaError::Consumer);
                                    }
                                }
                                if track.muted
                                    && events
                                        .try_send(MediaEvent::TrackMuted {
                                            track_id: track.sid.clone(),
                                        })
                                        .is_err()
                                {
                                    break 'receive Err(MediaError::Consumer);
                                }
                            }
                        } else if let Some(old) = old {
                            let previous: HashMap<_, _> =
                                old.tracks.into_iter().map(|t| (t.sid.clone(), t)).collect();
                            let current: HashSet<_> =
                                p.tracks.iter().map(|t| t.sid.as_str()).collect();
                            for (sid, track) in &previous {
                                if !current.contains(sid.as_str()) {
                                    if let Some(task) = tracks.remove(sid) {
                                        task.abort();
                                    }
                                    if events
                                        .try_send(MediaEvent::TrackRemoved {
                                            track_id: sid.clone(),
                                        })
                                        .is_err()
                                    {
                                        break 'receive Err(MediaError::Consumer);
                                    }
                                } else if let Some(next) = p.tracks.iter().find(|t| t.sid == *sid) {
                                    if track.muted != next.muted {
                                        let event = if next.muted {
                                            MediaEvent::TrackMuted {
                                                track_id: sid.clone(),
                                            }
                                        } else {
                                            MediaEvent::TrackUnmuted {
                                                track_id: sid.clone(),
                                            }
                                        };
                                        if events.try_send(event).is_err() {
                                            break 'receive Err(MediaError::Consumer);
                                        }
                                    }
                                }
                            }
                            for track in &p.tracks {
                                if !previous.contains_key(&track.sid) {
                                    if let Some(event) = published_track_event(&p.identity, track) {
                                        if events.try_send(event).is_err() {
                                            break 'receive Err(MediaError::Consumer);
                                        }
                                    }
                                    if track.muted
                                        && events
                                            .try_send(MediaEvent::TrackMuted {
                                                track_id: track.sid.clone(),
                                            })
                                            .is_err()
                                    {
                                        break 'receive Err(MediaError::Consumer);
                                    }
                                }
                            }
                        }
                    }
                    // The remote SDP can announce a track before its participant update arrives.
                    let mut still_waiting = Vec::new();
                    for track in waiting_tracks.drain(..) {
                        let stream_id = track.stream_id().await;
                        let ready = stream_id.split_once('|').is_some_and(
                            |(participant_sid, track_sid)| {
                                participants
                                    .get(participant_sid)
                                    .is_some_and(|participant| {
                                        participant.tracks.iter().any(|info| info.sid == track_sid)
                                    })
                            },
                        );
                        if ready {
                            ready_tracks.push_back(track);
                        } else {
                            still_waiting.push(track);
                        }
                    }
                    waiting_tracks = still_waiting;
                    None
                }
                RtcEvent::Signal(proto::signal_response::Message::Mute(mute)) => {
                    Some(if mute.muted {
                        MediaEvent::TrackMuted { track_id: mute.sid }
                    } else {
                        MediaEvent::TrackUnmuted { track_id: mute.sid }
                    })
                }
                RtcEvent::Signal(proto::signal_response::Message::TrackUnpublished(
                    unpublished,
                )) => {
                    if let Some(task) = tracks.remove(&unpublished.track_sid) {
                        task.abort();
                    }
                    Some(MediaEvent::TrackRemoved {
                        track_id: unpublished.track_sid,
                    })
                }
                RtcEvent::Signal(proto::signal_response::Message::Leave(_)) | RtcEvent::Closed => {
                    let _ = events.try_send(MediaEvent::Disconnected);
                    break Ok(());
                }
                RtcEvent::Track(track) => {
                    let stream_id = track.stream_id().await;
                    let Some((participant_sid, track_sid)) = stream_id.split_once('|') else {
                        continue;
                    };
                    let Some((participant, info)) =
                        participants.get(participant_sid).and_then(|participant| {
                            participant
                                .tracks
                                .iter()
                                .find(|info| info.sid == track_sid)
                                .map(|info| (participant, info))
                        })
                    else {
                        if waiting_tracks.len() >= 64 {
                            break Err(MediaError::Consumer);
                        }
                        waiting_tracks.push(track);
                        continue;
                    };
                    let participant_id = participant.identity.clone();
                    let track_id = track_sid.to_owned();
                    if let Some(old) = tracks.remove(&track_id) {
                        old.abort();
                    }
                    if tracks.len() >= 64 {
                        break Err(MediaError::Consumer);
                    }
                    if info.r#type() == proto::TrackType::Audio {
                        let tx = audio.clone();
                        let id = track_id.clone();
                        tracks.insert(
                            track_id.clone(),
                            tokio::spawn(async move {
                                receive_audio(track, participant_id, id, tx).await;
                            }),
                        );
                        None
                    } else if info.r#type() == proto::TrackType::Video
                        && info.source() == proto::TrackSource::ScreenShare
                    {
                        let tx = video.clone();
                        let id = track_id.clone();
                        let orientation = orientation_extension(&rtc).await;
                        tracks.insert(
                            track_id.clone(),
                            tokio::spawn(async move {
                                receive_video(track, participant_id, id, tx, orientation).await;
                            }),
                        );
                        None
                    } else {
                        None
                    }
                }
                RtcEvent::State(_, webrtc::peer_connection::RTCPeerConnectionState::Failed) => {
                    break Err(MediaError::Connection);
                }
                RtcEvent::State(
                    target,
                    webrtc::peer_connection::RTCPeerConnectionState::Disconnected,
                ) => {
                    let first = disconnected.is_empty();
                    disconnected.insert(target);
                    if first {
                        disconnect_deadline =
                            Some(tokio::time::Instant::now() + Duration::from_secs(5));
                        Some(MediaEvent::Reconnecting)
                    } else {
                        None
                    }
                }
                RtcEvent::State(
                    target,
                    webrtc::peer_connection::RTCPeerConnectionState::Connected,
                ) => {
                    if disconnected.remove(&target) && disconnected.is_empty() {
                        disconnect_deadline = None;
                        Some(MediaEvent::Reconnected)
                    } else {
                        None
                    }
                }
                _ => None,
            };
            if notification.is_some_and(|event| events.try_send(event).is_err()) {
                break Err(MediaError::Consumer);
            }
        }
    };
    for task in tracks.into_values() {
        task.abort();
        let _ = task.await;
    }
    drop(receiver);
    pending.lock().unwrap().clear();
    let close = timeout(DEADLINE, rtc.close())
        .await
        .map_err(|_| MediaError::Timeout)?;
    close?;
    result
}

async fn receive_audio(
    track: Arc<dyn TrackRemote>,
    participant_id: String,
    track_id: String,
    tx: mpsc::Sender<AudioFrame>,
) {
    let mut decoder = None;
    let mut channels = 0;
    while let Some(event) = track.poll().await {
        let TrackRemoteEvent::OnRtpPacket(packet) = event else {
            continue;
        };
        let Some(&toc) = packet.payload.first() else {
            continue;
        };
        let packet_channels = if toc & 0x04 == 0 { 1 } else { 2 };
        if channels != packet_channels {
            decoder = OpusDecoder::new(48_000, packet_channels).ok();
            channels = packet_channels;
        }
        let Some(decoder) = decoder.as_mut() else {
            break;
        };
        let mut pcm = [0f32; 11_520];
        let Ok(len) = decoder.decode(&packet.payload, 5760, &mut pcm) else {
            continue;
        };
        let samples = pcm[..len * channels]
            .chunks_exact(channels)
            .map(|frame| (frame.iter().sum::<f32>() / channels as f32).clamp(-1.0, 1.0))
            .map(|sample| (sample * 32767.0).round() as i16)
            .collect();
        if let Err(mpsc::error::TrySendError::Closed(_)) = tx.try_send(AudioFrame {
            participant_id: participant_id.clone(),
            track_id: track_id.clone(),
            received_at: Instant::now(),
            samples,
        }) {
            break;
        }
    }
}

async fn orientation_extension(rtc: &RtcTransport) -> Option<u8> {
    let description = rtc.subscriber.remote_description().await?;
    let session = description.unmarshal().ok()?;
    session
        .media_descriptions
        .into_iter()
        .filter(|media| media.media_name.media == "video")
        .flat_map(|media| media.attributes)
        .filter(|attribute| attribute.key == "extmap")
        .filter_map(|attribute| attribute.value)
        .find_map(|value| {
            let (id, uri) = value.split_once(' ')?;
            (uri.trim() == "urn:3gpp:video-orientation")
                .then(|| id.split('/').next()?.parse::<u8>().ok())
                .flatten()
        })
}

async fn receive_video(
    track: Arc<dyn TrackRemote>,
    participant_id: String,
    track_id: String,
    tx: mpsc::Sender<ScreenFrame>,
    orientation: Option<u8>,
) {
    let mut decoder = codec::VideoDecoder::new();
    let mut encoded = Vec::new();
    let mut timestamp = None;
    let mut previous_sequence = None;
    while let Some(event) = track.poll().await {
        let TrackRemoteEvent::OnRtpPacket(packet) = event else {
            continue;
        };
        if timestamp != Some(packet.header.timestamp)
            || previous_sequence
                .is_some_and(|seq: u16| seq.wrapping_add(1) != packet.header.sequence_number)
        {
            encoded.clear();
        }
        timestamp = Some(packet.header.timestamp);
        previous_sequence = Some(packet.header.sequence_number);
        let Ok(payload) = Vp8Packet::default().depacketize(&packet.payload) else {
            encoded.clear();
            continue;
        };
        if encoded.len() + payload.len() > 4_000_000 {
            encoded.clear();
            continue;
        }
        encoded.extend_from_slice(&payload);
        if !packet.header.marker {
            continue;
        }
        let Some(planes) = decoder.decode(&encoded) else {
            encoded.clear();
            continue;
        };
        encoded.clear();
        let rotation = orientation
            .and_then(|id| packet.header.get_extension(id))
            .and_then(|bytes| bytes.first().copied())
            .map(|value| u16::from(value & 0x03) * 90)
            .unwrap_or(0);
        if let Err(mpsc::error::TrySendError::Closed(_)) = tx.try_send(ScreenFrame {
            participant_id: participant_id.clone(),
            track_id: track_id.clone(),
            received_at: Instant::now(),
            width: planes.width,
            height: planes.height,
            rotation,
            rgba: codec::rgba(&planes),
        }) {
            break;
        }
    }
}
