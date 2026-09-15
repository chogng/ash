use crate::TransportError;
use std::collections::HashMap;
use std::collections::VecDeque;

/// A bounded sequence window, followed by Opus decoding and fixed 20 ms PCM output.
pub(crate) struct Playout {
    packets: HashMap<u16, Vec<u8>>,
    next: Option<u16>,
    started: bool,
    missing: usize,
    decoded: VecDeque<i16>,
    decoder: opus::Decoder,
}

impl Playout {
    pub(crate) fn new() -> Result<Self, TransportError> {
        Ok(Self {
            packets: HashMap::new(),
            next: None,
            started: false,
            missing: 0,
            decoded: VecDeque::new(),
            decoder: opus::Decoder::new(48_000, opus::Channels::Mono)
                .map_err(|_| TransportError::Codec)?,
        })
    }

    pub(crate) fn insert(&mut self, sequence: u16, payload: &[u8]) -> Result<(), TransportError> {
        if payload.is_empty() || payload.len() > 1275 {
            return Err(TransportError::InvalidInput);
        }
        let next = *self.next.get_or_insert(sequence);
        let distance = sequence.wrapping_sub(next) as i16;
        if distance < 0 {
            if self.started || distance < -9 {
                return Ok(());
            }
            self.next = Some(sequence);
            self.packets
                .retain(|&number, _| number.wrapping_sub(sequence) < 10);
        }
        if distance >= 10 {
            // A large discontinuity starts a fresh live window; old speech is never replayed.
            self.packets.clear();
            self.decoded.clear();
            self.next = Some(sequence);
            self.started = false;
            self.missing = 0;
            self.decoder
                .reset_state()
                .map_err(|_| TransportError::Codec)?;
        }
        self.packets
            .entry(sequence)
            .or_insert_with(|| payload.to_vec());
        Ok(())
    }

    pub(crate) fn tick(&mut self) -> Result<Option<Vec<i16>>, TransportError> {
        if !self.started {
            if self.packets.len() < 3 {
                return Ok(None);
            }
            self.started = true;
        }
        while self.decoded.len() < 960 {
            let Some(next) = self.next else {
                return Ok(None);
            };
            let packet = self.packets.remove(&next);
            self.next = Some(next.wrapping_add(1));
            if packet.is_some() {
                self.missing = 0;
            } else {
                self.missing += 1;
            }
            if self.missing > 10 {
                self.next = None;
                self.started = false;
                self.decoded.clear();
                self.packets.clear();
                self.decoder
                    .reset_state()
                    .map_err(|_| TransportError::Codec)?;
                return Ok(None);
            }
            let mut decoded = [0; 5760];
            // Empty input asks Opus for packet-loss concealment, bounded to one 20 ms frame.
            let capacity = if packet.is_some() { 5760 } else { 960 };
            let count = self
                .decoder
                .decode(
                    packet.as_deref().unwrap_or(&[]),
                    &mut decoded[..capacity],
                    false,
                )
                .map_err(|_| TransportError::Codec)?;
            if count == 0 {
                return Err(TransportError::Codec);
            }
            self.decoded.extend(&decoded[..count]);
        }
        if self.decoded.len() < 960 {
            return Ok(None);
        }
        Ok(Some(self.decoded.drain(..960).collect()))
    }
}

#[cfg(test)]
#[path = "playout_tests.rs"]
mod tests;
