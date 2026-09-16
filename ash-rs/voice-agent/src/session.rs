use crate::AgentError;
use crate::audio::AudioBridge;
use ash_api::LiveCommand;
use ash_api::LiveEvent;
use ash_api::LiveSession;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use livekit_client::MediaEvent;
use livekit_client::MediaRoom;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::time::Duration;
use tokio::sync::mpsc;

pub enum AgentCommand {
    /// App Server supplies only authorized task status, capped before entering model context.
    Commentary {
        delegation_id: String,
        text: String,
    },
    StopPlayback,
    ResumePlayback,
    Stop,
}

#[derive(Debug)]
pub enum AgentEvent {
    InputTranscript {
        text: String,
        start_ms: u64,
        end_ms: u64,
    },
    OutputTranscript {
        text: String,
        start_ms: u64,
        end_ms: u64,
    },
    /// Mixed audio is not proof of requester identity. The host must authorize a requester.
    DelegationProposed {
        id: String,
        transcript: String,
        eligible_members: Vec<String>,
    },
    Usage {
        seconds: f64,
    },
    Closed {
        reason: String,
        seconds: f64,
    },
}

/// Owns one media epoch. Membership changes retire this worker and its model context.
pub struct VoiceAgent {
    room: MediaRoom,
    live: LiveSession,
    audio: AudioBridge,
}

impl VoiceAgent {
    /// `human_participants` must exclude AI participants and come from call authority.
    pub fn new(
        room: MediaRoom,
        live: LiveSession,
        human_participants: BTreeMap<String, String>,
    ) -> Result<Self, AgentError> {
        Ok(Self {
            room,
            live,
            audio: AudioBridge::new(human_participants)?,
        })
    }

    pub async fn run(
        mut self,
        mut commands: mpsc::Receiver<AgentCommand>,
        events: mpsc::Sender<AgentEvent>,
        cancellation: &CancellationToken,
    ) -> Result<(), AgentError> {
        let result = self.pump(&mut commands, &events, cancellation).await;
        // Leave media before waiting for model billing, including failed or revoked sessions.
        let media = self.room.close().await.map_err(AgentError::from);
        // Cancellation stops the bridge, but final billing requires a fresh bounded close attempt.
        let finalize = if self.live.is_open() {
            self.live
                .close(&CancellationSource::new().token())
                .await
                .map_err(AgentError::from)
                .and_then(|event| {
                    if let LiveEvent::Closed { reason, seconds } = event {
                        emit(&events, AgentEvent::Closed { reason, seconds })
                    } else {
                        Err(AgentError::Consumer)
                    }
                })
        } else {
            Ok(())
        };
        result.and(finalize).and(media)
    }

    async fn pump(
        &mut self,
        commands: &mut mpsc::Receiver<AgentCommand>,
        events: &mpsc::Sender<AgentEvent>,
        cancellation: &CancellationToken,
    ) -> Result<(), AgentError> {
        let mut clock = tokio::time::interval(Duration::from_millis(10));
        clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut transcript = String::new();
        let mut delegations = BTreeSet::new();
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => return Ok(()),
                _ = events.closed() => return Err(AgentError::Consumer),
                command = commands.recv() => match command {
                    Some(AgentCommand::Stop) | None => return Ok(()),
                    Some(AgentCommand::StopPlayback) => { self.audio.stop_playback(); self.room.mute()?; }
                    Some(AgentCommand::ResumePlayback) => { self.audio.resume_playback(); self.room.unmute()?; }
                    Some(AgentCommand::Commentary { delegation_id, text }) => {
                        // A byte bound also bounds byte-level tokens for non-ASCII commentary.
                        if !delegations.contains(&delegation_id) || text.is_empty() || text.len() > 500 { return Err(AgentError::Consumer); }
                        self.live.send(LiveCommand::Commentary { delegation_id, content: text }, cancellation).await?;
                    }
                },
                event = self.room.next_event() => match event {
                    Some(MediaEvent::Audio(frame)) => self.audio.push_input(&frame.participant_id, &frame.samples),
                    Some(MediaEvent::Disconnected) | None => return Err(livekit_client::MediaError::Connection.into()),
                    Some(MediaEvent::Reconnecting) => return Err(livekit_client::MediaError::Connection.into()),
                    Some(MediaEvent::TrackRemoved { .. } | MediaEvent::ParticipantLeft { .. }) => self.audio.clear_input(),
                    _ => {}
                },
                event = self.live.receive(cancellation) => match event? {
                    LiveEvent::Audio { pcm16 } => self.audio.push_output(&pcm16)?,
                    LiveEvent::InputTranscript { text, start_ms, end_ms } => {
                        transcript.push_str(&text);
                        if transcript.len() > 16 * 1024 {
                            let mut start = transcript.len() - 16 * 1024;
                            while !transcript.is_char_boundary(start) { start += 1; }
                            transcript.drain(..start);
                        }
                        emit(events, AgentEvent::InputTranscript { text, start_ms, end_ms })?;
                    }
                    LiveEvent::OutputTranscript { text, start_ms, end_ms } => emit(events, AgentEvent::OutputTranscript { text, start_ms, end_ms })?,
                    LiveEvent::Delegation { id, .. } => {
                        if delegations.len() >= 256 || !delegations.insert(id.clone()) { return Err(AgentError::Consumer); }
                        emit(events, AgentEvent::DelegationProposed { id, transcript: std::mem::take(&mut transcript), eligible_members: self.audio.members() })?;
                    }
                    LiveEvent::Usage { seconds } => emit(events, AgentEvent::Usage { seconds })?,
                    LiveEvent::Closed { reason, seconds } => { emit(events, AgentEvent::Closed { reason, seconds })?; return Ok(()); }
                    LiveEvent::Error { .. } => return Err(ash_api::ApiError::InvalidResponse("Live session reported an error".into()).into()),
                    LiveEvent::Other { .. } => {}
                },
                _ = clock.tick() => {
                    self.live.send(LiveCommand::AppendAudio { pcm16: self.audio.input()? }, cancellation).await?;
                    if let Some(samples) = self.audio.output()? { self.room.send_audio(&samples).await?; }
                }
            }
        }
    }
}

fn emit(events: &mpsc::Sender<AgentEvent>, event: AgentEvent) -> Result<(), AgentError> {
    events.try_send(event).map_err(|_| AgentError::Consumer)
}
