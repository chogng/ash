use crate::AgentError;
use livekit_client::AudioFrame;
use livekit_client::AudioMixer;
use livekit_client::AudioRate;
use livekit_client::AudioResampler;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::VecDeque;
use std::time::Instant;

const PACKET: usize = 480;
const OUTPUT_LIMIT: usize = 24_000 * 2;

pub(super) struct AudioBridge {
    // Supplied by call authority, never from participant metadata or model text.
    members: BTreeMap<String, String>,
    input: AudioMixer,
    output: VecDeque<i16>,
    downsample: AudioResampler,
    upsample: AudioResampler,
    playback: bool,
}

impl AudioBridge {
    pub(super) fn new(members: BTreeMap<String, String>) -> Result<Self, AgentError> {
        if members.is_empty()
            || members.len() > 64
            || members.iter().any(|(participant, member)| {
                participant.is_empty()
                    || member.is_empty()
                    || participant.len() > 128
                    || member.len() > 128
            })
        {
            return Err(AgentError::Participants);
        }
        Ok(Self {
            members,
            input: AudioMixer::default(),
            output: VecDeque::new(),
            downsample: AudioResampler::new(AudioRate::Room, AudioRate::Voice),
            upsample: AudioResampler::new(AudioRate::Voice, AudioRate::Room),
            playback: true,
        })
    }

    pub(super) fn push_input(&mut self, frame: AudioFrame) -> Result<(), AgentError> {
        if self.is_human(&frame.participant_id) {
            self.input.push(frame)?;
        }
        Ok(())
    }

    pub(super) fn remove_track(&mut self, track: &str) {
        self.input.remove_track(track);
        self.downsample = AudioResampler::new(AudioRate::Room, AudioRate::Voice);
    }

    pub(super) fn remove_participant(&mut self, participant: &str) {
        self.input.remove_participant(participant);
        self.downsample = AudioResampler::new(AudioRate::Room, AudioRate::Voice);
    }

    pub(super) fn is_human(&self, participant: &str) -> bool {
        self.members.contains_key(participant)
    }

    pub(super) fn input(&mut self, now: Instant) -> Result<Vec<u8>, AgentError> {
        let samples = self.input.render(PACKET, now)?;
        Ok(self
            .downsample
            .process(&samples)?
            .into_iter()
            .flat_map(i16::to_le_bytes)
            .collect())
    }

    pub(super) fn push_output(&mut self, pcm16: &[u8]) -> Result<(), AgentError> {
        if !self.playback {
            return Ok(());
        }
        if pcm16.len() % 2 != 0 || self.output.len() + pcm16.len() / 2 > OUTPUT_LIMIT {
            return Err(AgentError::AudioOverflow);
        }
        self.output.extend(
            pcm16
                .chunks_exact(2)
                .map(|sample| i16::from_le_bytes([sample[0], sample[1]])),
        );
        Ok(())
    }

    pub(super) fn output(&mut self) -> Result<Option<Vec<i16>>, AgentError> {
        if self.output.len() < 240 {
            return Ok(None);
        }
        let samples: Vec<i16> = self.output.drain(..240).collect();
        Ok(Some(self.upsample.process(&samples)?))
    }

    pub(super) fn stop_playback(&mut self) {
        self.playback = false;
        self.output.clear();
        self.upsample = AudioResampler::new(AudioRate::Voice, AudioRate::Room);
    }

    pub(super) fn members(&self, participants: &BTreeSet<String>) -> Vec<String> {
        participants
            .iter()
            .filter_map(|id| self.members.get(id))
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}

#[cfg(test)]
#[path = "audio_tests.rs"]
mod tests;
