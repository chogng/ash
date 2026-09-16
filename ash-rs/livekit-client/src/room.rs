use crate::MediaError;
use futures::StreamExt;
use livekit::Room;
use livekit::RoomEvent;
use livekit::RoomOptions;
use livekit::options::TrackPublishOptions;
use livekit::prelude::LocalAudioTrack;
use livekit::prelude::LocalTrack;
use livekit::prelude::RemoteTrack;
use livekit::prelude::TrackSource;
use livekit::webrtc::audio_frame::AudioFrame as RtcAudioFrame;
use livekit::webrtc::audio_source::AudioSourceOptions;
use livekit::webrtc::audio_source::RtcAudioSource::Native as PcmSource;
use livekit::webrtc::audio_source::native::NativeAudioSource as PcmAudioSource;
use livekit::webrtc::audio_stream::native::NativeAudioStream as PcmAudioStream;
use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::timeout;

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

#[derive(Debug)]
pub enum MediaEvent {
    Connected {
        participant_ids: Vec<String>,
    },
    Audio(AudioFrame),
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

/// Owns a room and its bounded media streams. Dropping signals the room worker to close.
pub struct MediaRoom {
    room: Arc<Room>,
    source: Option<PcmAudioSource>,
    publication: Option<LocalAudioTrack>,
    events: mpsc::Receiver<MediaEvent>,
    audio: mpsc::Receiver<AudioFrame>,
    stop: Option<oneshot::Sender<()>>,
    worker: Option<JoinHandle<Result<(), MediaError>>>,
    muted: HashSet<String>,
}

impl MediaRoom {
    /// Captures publisher and subscriber connection statistics from the SDK.
    pub async fn stats(&self) -> Result<livekit::SessionStats, MediaError> {
        timeout(DEADLINE, self.room.get_stats())
            .await
            .map_err(|_| MediaError::Timeout)?
            .map_err(|_| MediaError::Connection)
    }

    pub async fn connect(
        server_url: &str,
        token: &str,
        publish: AudioPublication,
    ) -> Result<Self, MediaError> {
        let network = ash_http_client::OutboundNetworkSnapshot::new(
            ash_http_client::HttpClientConfig::default(),
        )
        .map_err(|_| MediaError::Connection)?;
        Self::connect_with_network(server_url, token, publish, network).await
    }

    /// Applies one network policy to signaling, reconnects and region requests.
    pub async fn connect_with_network(
        server_url: &str,
        token: &str,
        publish: AudioPublication,
        network: ash_http_client::OutboundNetworkSnapshot,
    ) -> Result<Self, MediaError> {
        crate::validate_url(server_url)?;
        let mut options = RoomOptions::default();
        options.transport = Some(crate::transport::transport(network)?);
        let (room, receiver) = timeout(DEADLINE, Room::connect(server_url, token, options))
            .await
            .map_err(|_| MediaError::Timeout)?
            .map_err(|_| MediaError::Connection)?;
        let room = Arc::new(room);
        let (event_tx, events) = mpsc::channel(64);
        let (audio_tx, audio) = mpsc::channel(128);
        let (stop, stopped) = oneshot::channel();
        // Start ownership before any cancellable publication operation.
        let worker_room = room.clone();
        let worker = tokio::spawn(async move {
            receive(worker_room, receiver, event_tx, audio_tx, stopped).await
        });
        let mut result = Self {
            room: room.clone(),
            source: None,
            publication: None,
            events,
            audio,
            stop: Some(stop),
            worker: Some(worker),
            muted: HashSet::new(),
        };
        if publish != AudioPublication::SubscribeOnly {
            // Device AEC/NS/AGC belongs to voice-host. No duplicate SDK processing.
            let source = PcmAudioSource::new(AudioSourceOptions::default(), 48_000, 1, 40);
            let track = LocalAudioTrack::create_audio_track(
                match publish {
                    AudioPublication::Agent => "agent",
                    _ => "microphone",
                },
                PcmSource(source.clone()),
            );
            timeout(
                DEADLINE,
                room.local_participant().publish_track(
                    LocalTrack::Audio(track.clone()),
                    TrackPublishOptions {
                        source: TrackSource::Microphone,
                        ..Default::default()
                    },
                ),
            )
            .await
            .map_err(|_| MediaError::Timeout)?
            .map_err(|_| MediaError::Publication)?;
            result.source = Some(source);
            result.publication = Some(track);
        }
        Ok(result)
    }

    pub async fn send_audio(&self, samples: &[i16]) -> Result<(), MediaError> {
        if !matches!(samples.len(), 480 | 960) {
            return Err(MediaError::AudioFrame);
        }
        let source = self.source.as_ref().ok_or(MediaError::Publication)?;
        let frame = RtcAudioFrame {
            data: Cow::Borrowed(samples),
            sample_rate: 48_000,
            num_channels: 1,
            samples_per_channel: samples.len() as u32,
        };
        timeout(Duration::from_millis(200), source.capture_frame(&frame))
            .await
            .map_err(|_| MediaError::Timeout)?
            .map_err(|_| MediaError::Publication)
    }

    pub fn mute(&self) -> Result<(), MediaError> {
        self.publication
            .as_ref()
            .ok_or(MediaError::Publication)?
            .mute();
        self.source
            .as_ref()
            .ok_or(MediaError::Publication)?
            .clear_buffer();
        Ok(())
    }

    pub fn unmute(&self) -> Result<(), MediaError> {
        self.source
            .as_ref()
            .ok_or(MediaError::Publication)?
            .clear_buffer();
        self.publication
            .as_ref()
            .ok_or(MediaError::Publication)?
            .unmute();
        Ok(())
    }

    pub async fn next_event(&mut self) -> Option<MediaEvent> {
        loop {
            tokio::select! {
                biased;
                event = self.events.recv() => {
                    match &event {
                        Some(MediaEvent::TrackMuted { track_id }) => { self.muted.insert(track_id.clone()); }
                        Some(MediaEvent::TrackUnmuted { track_id } | MediaEvent::TrackRemoved { track_id }) => { self.muted.remove(track_id); }
                        _ => {}
                    }
                    if matches!(event, Some(MediaEvent::Reconnecting | MediaEvent::Disconnected | MediaEvent::TrackRemoved { .. } | MediaEvent::ParticipantLeft { .. } | MediaEvent::TrackMuted { .. } | MediaEvent::TrackUnmuted { .. })) {
                        // Control changes invalidate audio already queued under the old topology.
                        while self.audio.try_recv().is_ok() {}
                    }
                    return event;
                }
                frame = self.audio.recv() => {
                    let frame = frame?;
                    if frame.received_at.elapsed() <= MAX_AGE && !self.muted.contains(&frame.track_id) { return Some(MediaEvent::Audio(frame)); }
                }
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

    pub async fn close(mut self) -> Result<(), MediaError> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        match self.worker.take() {
            Some(worker) => worker.await.map_err(|_| MediaError::Connection)?,
            None => Ok(()),
        }
    }
}

impl Drop for MediaRoom {
    fn drop(&mut self) {
        if let Some(source) = &self.source {
            source.clear_buffer();
        }
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

async fn receive(
    room: Arc<Room>,
    mut receiver: mpsc::UnboundedReceiver<RoomEvent>,
    events: mpsc::Sender<MediaEvent>,
    audio: mpsc::Sender<AudioFrame>,
    mut stop: oneshot::Receiver<()>,
) -> Result<(), MediaError> {
    let mut tracks: HashMap<String, JoinHandle<()>> = HashMap::new();
    let result = loop {
        let event = tokio::select! {
            biased;
            _ = &mut stop => break Ok(()),
            _ = events.closed() => break Ok(()),
            event = receiver.recv() => match event { Some(event) => event, None => break Ok(()) },
        };
        let notification = match event {
            RoomEvent::Connected {
                participants_with_tracks,
            } => Some(MediaEvent::Connected {
                participant_ids: participants_with_tracks
                    .into_iter()
                    .map(|(participant, _)| participant.identity().to_string())
                    .collect(),
            }),
            RoomEvent::TrackSubscribed {
                track: RemoteTrack::Audio(track),
                participant,
                ..
            } => {
                let id = track.sid().to_string();
                if let Some(old) = tracks.remove(&id) {
                    old.abort();
                }
                if tracks.len() >= 64 {
                    break Err(MediaError::Consumer);
                }
                let mut stream = PcmAudioStream::new(track.rtc_track(), 48_000, 1);
                let tx = audio.clone();
                let participant_id = participant.identity().to_string();
                let notification = MediaEvent::TrackAdded {
                    participant_id: participant_id.clone(),
                    track_id: id.clone(),
                };
                let track_id = id.clone();
                tracks.insert(
                    id,
                    tokio::spawn(async move {
                        while let Some(frame) = stream.next().await {
                            let packet = AudioFrame {
                                participant_id: participant_id.clone(),
                                track_id: track_id.clone(),
                                received_at: Instant::now(),
                                samples: frame.data.into_owned(),
                            };
                            if let Err(mpsc::error::TrySendError::Closed(_)) = tx.try_send(packet) {
                                break;
                            }
                        }
                        stream.close();
                    }),
                );
                Some(notification)
            }
            RoomEvent::TrackUnsubscribed { track, .. } => {
                let id = track.sid().to_string();
                if let Some(task) = tracks.remove(&id) {
                    task.abort();
                }
                Some(MediaEvent::TrackRemoved { track_id: id })
            }
            RoomEvent::TrackMuted { publication, .. } => Some(MediaEvent::TrackMuted {
                track_id: publication.sid().to_string(),
            }),
            RoomEvent::TrackUnmuted { publication, .. } => Some(MediaEvent::TrackUnmuted {
                track_id: publication.sid().to_string(),
            }),
            RoomEvent::ParticipantConnected(participant) => Some(MediaEvent::ParticipantJoined {
                participant_id: participant.identity().to_string(),
            }),
            RoomEvent::ParticipantDisconnected(participant) => Some(MediaEvent::ParticipantLeft {
                participant_id: participant.identity().to_string(),
            }),
            RoomEvent::Reconnecting => Some(MediaEvent::Reconnecting),
            RoomEvent::Reconnected => Some(MediaEvent::Reconnected),
            RoomEvent::Disconnected { .. } => {
                let _ = events.try_send(MediaEvent::Disconnected);
                break Ok(());
            }
            _ => None,
        };
        if notification.is_some_and(|event| events.try_send(event).is_err()) {
            break Err(MediaError::Consumer);
        }
    };
    for task in tracks.into_values() {
        task.abort();
        let _ = task.await;
    }
    timeout(DEADLINE, room.close())
        .await
        .map_err(|_| MediaError::Timeout)?
        .map_err(|_| MediaError::Connection)?;
    result
}
