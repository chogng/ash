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
use livekit::webrtc::video_frame::VideoFormatType;
use livekit::webrtc::video_frame::native::VideoFrameBufferExt;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_stream::native::NativeVideoStream;
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
    /// Reports collected for locally published media.
    pub publisher_reports: usize,
    /// Reports collected for subscribed remote media.
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

/// Owns a room and its bounded media streams. Dropping signals the room worker to close.
pub struct MediaRoom {
    room: Arc<Room>,
    source: Option<PcmAudioSource>,
    publication: Option<LocalAudioTrack>,
    events: mpsc::Receiver<MediaEvent>,
    audio: mpsc::Receiver<AudioFrame>,
    video: mpsc::Receiver<ScreenFrame>,
    video_tracks: HashMap<String, String>,
    stop: Option<oneshot::Sender<()>>,
    worker: Option<JoinHandle<Result<(), MediaError>>>,
    muted: HashSet<String>,
    screen_source: Option<NativeVideoSource>,
    screen_publication: Option<LocalVideoTrack>,
    screen_stream: Option<Box<dyn ScreenCaptureStream>>,
}

impl MediaRoom {
    /// Counts the available publisher and subscriber connection reports.
    pub async fn stats(&self) -> Result<MediaStats, MediaError> {
        let stats = timeout(DEADLINE, self.room.get_stats())
            .await
            .map_err(|_| MediaError::Timeout)?
            .map_err(|_| MediaError::Connection)?;
        Ok(MediaStats {
            publisher_reports: stats.publisher_stats.len(),
            subscriber_reports: stats.subscriber_stats.len(),
        })
    }

    pub async fn connect(
        server_url: &str,
        token: &str,
        publish: AudioPublication,
    ) -> Result<Self, MediaError> {
        crate::validate_url(server_url)?;
        crate::transport::install()?;
        let (room, receiver) = timeout(
            DEADLINE,
            Room::connect(server_url, token, RoomOptions::default()),
        )
        .await
        .map_err(|_| MediaError::Timeout)?
        .map_err(|_| MediaError::Connection)?;
        let room = Arc::new(room);
        let (event_tx, events) = mpsc::channel(64);
        let (audio_tx, audio) = mpsc::channel(128);
        let (video_tx, video) = mpsc::channel(2);
        let (stop, stopped) = oneshot::channel();
        // Start ownership before any cancellable publication operation.
        let worker_room = room.clone();
        let worker = tokio::spawn(async move {
            receive(worker_room, receiver, event_tx, audio_tx, video_tx, stopped).await
        });
        let mut result = Self {
            room: room.clone(),
            source: None,
            publication: None,
            events,
            audio,
            video,
            video_tracks: HashMap::new(),
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
            if self
                .screen_stream
                .as_ref()
                .is_some_and(|stream| !stream.is_active())
            {
                let error = self
                    .screen_stream
                    .as_ref()
                    .and_then(|stream| stream.error());
                let _ = self.stop_screen_share().await;
                return Some(MediaEvent::ScreenStopped { error });
            }
            tokio::select! {
                biased;
                _ = tokio::time::sleep(Duration::from_millis(100)), if self.screen_stream.is_some() => {
                    if self.screen_stream.as_ref().is_some_and(|stream| !stream.is_active()) {
                        let error = self.screen_stream.as_ref().and_then(|stream| stream.error());
                        let _ = self.stop_screen_share().await;
                        return Some(MediaEvent::ScreenStopped { error });
                    }
                }
                event = self.events.recv() => {
                    match &event {
                        Some(MediaEvent::ScreenAdded { track_id, participant_id }) => { self.video_tracks.insert(track_id.clone(), participant_id.clone()); }
                        Some(MediaEvent::ParticipantLeft { participant_id }) => { self.video_tracks.retain(|_, owner| owner != participant_id); }
                        Some(MediaEvent::TrackRemoved { track_id }) => { self.video_tracks.remove(track_id); self.muted.remove(track_id); }
                        Some(MediaEvent::TrackMuted { track_id }) => { self.muted.insert(track_id.clone()); }
                        Some(MediaEvent::TrackUnmuted { track_id }) => { self.muted.remove(track_id); }
                        _ => {}
                    }
                    if matches!(event, Some(MediaEvent::Reconnecting | MediaEvent::Disconnected | MediaEvent::TrackRemoved { .. } | MediaEvent::ParticipantLeft { .. } | MediaEvent::TrackMuted { .. } | MediaEvent::TrackUnmuted { .. })) {
                        // Control changes invalidate audio already queued under the old topology.
                        while self.audio.try_recv().is_ok() {}
                        while self.video.try_recv().is_ok() {}
                    }
                    return event;
                }
                frame = self.audio.recv() => {
                    let frame = frame?;
                    if frame.received_at.elapsed() <= MAX_AGE && !self.muted.contains(&frame.track_id) { return Some(MediaEvent::Audio(frame)); }
                }
                frame = self.video.recv() => {
                    let frame = frame?;
                    if frame.received_at.elapsed() <= MAX_AGE && self.video_tracks.contains_key(&frame.track_id) && !self.muted.contains(&frame.track_id) {
                        return Some(MediaEvent::Video(frame));
                    }
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
        if self.screen_source.is_some()
            || self.screen_publication.is_some()
            || self.screen_stream.is_some()
        {
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

        let native_source_clone = native_source.clone();
        let mut stream = source
            .start_stream(
                fps,
                Box::new(move |frame| {
                    if let Some(video_frame) = convert_captured_frame_to_webrtc(&frame) {
                        native_source_clone.capture_frame(&video_frame);
                    }
                }),
            )
            .map_err(|err| MediaError::Capture(err.to_string()))?;

        let publish_result = timeout(
            DEADLINE,
            self.room.local_participant().publish_track(
                LocalTrack::Video(track.clone()),
                TrackPublishOptions {
                    source: TrackSource::Screenshare,
                    ..Default::default()
                },
            ),
        )
        .await;
        match publish_result {
            Err(_) => {
                stream.stop();
                return Err(MediaError::Timeout);
            }
            Ok(Err(_)) => {
                stream.stop();
                return Err(MediaError::ScreenShare);
            }
            Ok(Ok(_)) => {}
        }

        self.screen_source = Some(native_source);
        self.screen_publication = Some(track);
        self.screen_stream = Some(stream);
        Ok(())
    }

    /// Stops the currently active screen share and unpublishes the track.
    pub async fn stop_screen_share(&mut self) -> Result<(), MediaError> {
        // Stop collecting pixels even when the server cannot acknowledge unpublication.
        if let Some(mut stream) = self.screen_stream.take() {
            stream.stop();
        }
        self.screen_source = None;
        if let Some(track) = self.screen_publication.as_ref() {
            let sid = track.sid();
            let unpublish_result = timeout(
                DEADLINE,
                self.room.local_participant().unpublish_track(&sid),
            )
            .await;
            match unpublish_result {
                Err(_) => return Err(MediaError::Timeout),
                Ok(Err(_)) => return Err(MediaError::ScreenShare),
                Ok(Ok(_)) => {}
            }
        }
        self.screen_publication = None;
        Ok(())
    }

    /// Returns whether this room is currently publishing screen share.
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
            if width == 0
                || height == 0
                || width > 8192
                || height > 8192
                || u64::from(width) * u64::from(height) > 16_777_216
                || stride < width as usize * 4
                || data.len() < stride.checked_mul(height as usize)?
            {
                return None;
            }
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
    video: mpsc::Sender<ScreenFrame>,
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
                track: RemoteTrack::Video(track),
                participant,
                publication,
                ..
            } if publication.source() == TrackSource::Screenshare => {
                let id = track.sid().to_string();
                if let Some(old) = tracks.remove(&id) {
                    old.abort();
                }
                if tracks.len() >= 64 {
                    break Err(MediaError::Consumer);
                }
                let participant_id = participant.identity().to_string();
                let notification = MediaEvent::ScreenAdded {
                    participant_id: participant_id.clone(),
                    track_id: id.clone(),
                };
                let track_id = id.clone();
                let tx = video.clone();
                let mut stream = NativeVideoStream::new(track.rtc_track());
                tracks.insert(
                    id,
                    tokio::spawn(async move {
                        while let Some(frame) = stream.next().await {
                            let width = frame.buffer.width();
                            let height = frame.buffer.height();
                            if width == 0
                                || height == 0
                                || width > 8192
                                || height > 8192
                                || u64::from(width) * u64::from(height) > 16_777_216
                                || tx.capacity() == 0
                            {
                                continue;
                            }
                            let mut rgba = vec![0; width as usize * height as usize * 4];
                            frame.buffer.to_i420().to_argb(
                                VideoFormatType::ABGR,
                                &mut rgba,
                                width * 4,
                                width as i32,
                                height as i32,
                            );
                            let packet = ScreenFrame {
                                participant_id: participant_id.clone(),
                                track_id: track_id.clone(),
                                received_at: Instant::now(),
                                width,
                                height,
                                rotation: frame.rotation as u16,
                                rgba,
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
