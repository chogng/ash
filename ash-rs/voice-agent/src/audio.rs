use crate::AgentError;
use livekit_client::AudioRate;
use livekit_client::AudioResampler;
use std::collections::BTreeMap;
use std::collections::VecDeque;

const PACKET: usize = 480;
const INPUT_LIMIT: usize = PACKET * 20;
const OUTPUT_LIMIT: usize = 24_000 * 2;

pub(super) struct AudioBridge {
    // Supplied by call authority, never from participant metadata or model text.
    members: BTreeMap<String, String>,
    input: BTreeMap<String, VecDeque<i16>>,
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
            input: BTreeMap::new(),
            output: VecDeque::new(),
            downsample: AudioResampler::new(AudioRate::Room, AudioRate::Voice),
            upsample: AudioResampler::new(AudioRate::Voice, AudioRate::Room),
            playback: true,
        })
    }

    pub(super) fn push_input(&mut self, participant: &str, samples: &[i16]) {
        if !self.members.contains_key(participant) || samples.len() > INPUT_LIMIT {
            return;
        }
        let queue = self.input.entry(participant.into()).or_default();
        // Drop old speech when the producer gets ahead of the 10 ms media clock.
        let overflow = (queue.len() + samples.len()).saturating_sub(INPUT_LIMIT);
        queue.drain(..overflow);
        queue.extend(samples);
    }

    pub(super) fn clear_input(&mut self) {
        self.input.clear();
        self.downsample = AudioResampler::new(AudioRate::Room, AudioRate::Voice);
    }

    pub(super) fn input(&mut self) -> Result<Vec<u8>, AgentError> {
        let mut mixed = [0_i32; PACKET];
        for queue in self.input.values_mut() {
            for sample in &mut mixed {
                *sample += i32::from(queue.pop_front().unwrap_or(0));
            }
        }
        let samples: Vec<i16> = mixed
            .into_iter()
            .map(|value| value.clamp(i16::MIN.into(), i16::MAX.into()) as i16)
            .collect();
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

    pub(super) fn resume_playback(&mut self) {
        self.playback = true;
    }
    pub(super) fn members(&self) -> Vec<String> {
        self.members
            .values()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}

#[cfg(test)]
#[path = "audio_tests.rs"]
mod tests;
