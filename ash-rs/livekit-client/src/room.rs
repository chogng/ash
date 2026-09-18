use crate::MediaError;
use futures::StreamExt;
use livekit::Room;
use livekit::RoomEvent;
use livekit::RoomOptions;
use livekit::options::TrackPublishOptions;
use livekit::prelude::LocalAudioTrack;
use livekit::prelude::LocalTrack;
use livekit::prelude::LocalVideoTrack;
use livekit::prelude::RemoteTrack;
use livekit::prelude::TrackSource;
use livekit::webrtc::audio_frame::AudioFrame as RtcAudioFrame;
use livekit::webrtc::audio_source::AudioSourceOptions;
use livekit::webrtc::audio_source::RtcAudioSource::Native as PcmSource;
use livekit::webrtc::audio_source::native::NativeAudioSource as PcmAudioSource;
use livekit::webrtc::audio_stream::native::NativeAudioStream as PcmAudioStream;
use livekit::webrtc::prelude::I420Buffer;
use livekit::webrtc::prelude::RtcVideoSource;
use livekit::webrtc::prelude::VideoFrame;
use livekit::webrtc::prelude::VideoResolution;
use livekit::webrtc::prelude::VideoRotation;
use livekit::webrtc::video_source::native::NativeVideoSource;
use screen_capture::CapturedFrame;
use screen_capture::ScreenCaptureSource;
use screen_capture::ScreenCaptureStream;
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
    screen_source: Option<NativeVideoSource>,
    screen_publication: Option<LocalVideoTrack>,
    screen_stream: Option<Box<dyn ScreenCaptureStream>>,
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
            screen_source: None,
            screen_publication: None,
            screen_stream: None,
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

    /// Starts publishing screen capture frames from the given capture source.
    pub async fn start_screen_share(
        &mut self,
        source: &dyn ScreenCaptureSource,
        fps: u32,
    ) -> Result<(), MediaError> {
        if self.is_screen_sharing() {
            self.stop_screen_share().await?;
        }

        let info = source.info();
        let native_source = NativeVideoSource::new(
            VideoResolution {
                width: info.width,
                height: info.height,
            },
            true,
        );

        let track = LocalVideoTrack::create_video_track(
            "screen-share",
            RtcVideoSource::Native(native_source.clone()),
        );

        timeout(
            DEADLINE,
            self.room.local_participant().publish_track(
                LocalTrack::Video(track.clone()),
                TrackPublishOptions {
                    source: TrackSource::Screenshare,
                    ..Default::default()
                },
            ),
        )
        .await
        .map_err(|_| MediaError::Timeout)?
        .map_err(|_| MediaError::ScreenShare)?;

        let native_source_clone = native_source.clone();
        let stream = source
            .start_stream(
                fps,
                Box::new(move |frame| {
                    if let Some(video_frame) = convert_captured_frame_to_webrtc(&frame) {
                        native_source_clone.capture_frame(&video_frame);
                    }
                }),
            )
            .map_err(|err| MediaError::Capture(err.to_string()))?;

        self.screen_source = Some(native_source);
        self.screen_publication = Some(track);
        self.screen_stream = Some(stream);
        Ok(())
    }

    /// Stops the currently active screen share and unpublishes the track.
    pub async fn stop_screen_share(&mut self) -> Result<(), MediaError> {
        if let Some(mut stream) = self.screen_stream.take() {
            stream.stop();
        }
        self.screen_source = None;
        if let Some(track) = self.screen_publication.take() {
            let sid = track.sid();
            let _ = timeout(
                DEADLINE,
                self.room.local_participant().unpublish_track(&sid),
            )
            .await;
        }
        Ok(())
    }

    /// Returns whether this room is currently publishing screen share.
    pub fn is_screen_sharing(&self) -> bool {
        self.screen_publication.is_some()
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

pub(crate) fn convert_captured_frame_to_webrtc(
    frame: &CapturedFrame,
) -> Option<VideoFrame<I420Buffer>> {
    match frame {
        CapturedFrame::Rgba {
            data,
            width,
            height,
            stride,
            timestamp,
        } => {
            let width = *width;
            let height = *height;
            let stride = *stride as usize;
            let mut buffer = I420Buffer::new(width, height);
            let (stride_y, stride_u, stride_v) = buffer.strides();
            let stride_y = stride_y as usize;
            let stride_u = stride_u as usize;
            let stride_v = stride_v as usize;
            let (data_y, data_u, data_v) = buffer.data_mut();

            for y in 0..height as usize {
                let src_row = y * stride;
                let y_row = y * stride_y;
                let is_even_row = y % 2 == 0;
                let uv_row_idx = (y / 2) * stride_u;
                let v_row_idx = (y / 2) * stride_v;

                for x in 0..width as usize {
                    let px = src_row + x * 4;
                    if px + 2 >= data.len() {
                        break;
                    }
                    let r = data[px] as i32;
                    let g = data[px + 1] as i32;
                    let b = data[px + 2] as i32;

                    let y_val = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
                    if y_row + x < data_y.len() {
                        data_y[y_row + x] = y_val.clamp(0, 255) as u8;
                    }

                    if is_even_row && x % 2 == 0 {
                        let u_val = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                        let v_val = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
                        let uv_col = x / 2;
                        if uv_row_idx + uv_col < data_u.len() {
                            data_u[uv_row_idx + uv_col] = u_val.clamp(0, 255) as u8;
                        }
                        if v_row_idx + uv_col < data_v.len() {
                            data_v[v_row_idx + uv_col] = v_val.clamp(0, 255) as u8;
                        }
                    }
                }
            }

            Some(VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                timestamp_us: timestamp.as_micros() as i64,
                frame_metadata: None,
                buffer,
            })
        }
    }
}

impl Drop for MediaRoom {
    fn drop(&mut self) {
        if let Some(source) = &self.source {
            source.clear_buffer();
        }
        if let Some(mut stream) = self.screen_stream.take() {
            stream.stop();
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
