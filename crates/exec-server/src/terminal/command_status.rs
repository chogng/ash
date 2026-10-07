use crate::terminal::TerminalCommandStatus;
use crate::terminal::TerminalCommandStatusEvent;
use std::collections::VecDeque;

const OSC_633_PREFIX: &[u8] = b"\x1b]633;";
const MAX_COMMAND_EVENTS: usize = 1_024;

pub(crate) enum ParsedTerminalOutput {
    Bytes(Vec<u8>),
    CommandFinished(Option<i32>),
}

/// Tracks shell command lifecycle independently of any renderer.
pub(crate) struct TerminalCommandStatusTracker {
    enabled: bool,
    pending_output: Vec<u8>,
    events: VecDeque<TerminalCommandStatusEvent>,
    next_event_sequence: u64,
    next_command_id: u64,
    active_command_id: Option<String>,
}

impl TerminalCommandStatusTracker {
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            enabled,
            pending_output: Vec::new(),
            events: VecDeque::new(),
            next_event_sequence: 0,
            next_command_id: 1,
            active_command_id: None,
        }
    }

    pub(crate) fn note_input(&mut self, data: &str, after_output_sequence: u64) {
        if !self.enabled
            || self.active_command_id.is_some()
            || !data.bytes().any(|byte| matches!(byte, b'\r' | b'\n'))
        {
            return;
        }
        let command_id = format!("command-{:x}", self.next_command_id);
        self.next_command_id = self.next_command_id.saturating_add(1);
        self.active_command_id = Some(command_id.clone());
        self.push_event(
            command_id,
            TerminalCommandStatus::Running,
            None,
            after_output_sequence,
        );
    }

    pub(crate) fn parse_output(&mut self, bytes: Vec<u8>) -> Vec<ParsedTerminalOutput> {
        if !self.enabled {
            return vec![ParsedTerminalOutput::Bytes(bytes)];
        }
        self.pending_output.extend(bytes);
        let mut parsed = Vec::new();
        loop {
            let Some(prefix_index) = find_bytes(&self.pending_output, OSC_633_PREFIX) else {
                let retained = partial_prefix_len(&self.pending_output, OSC_633_PREFIX);
                let visible_length = self.pending_output.len().saturating_sub(retained);
                if visible_length > 0 {
                    parsed.push(ParsedTerminalOutput::Bytes(
                        self.pending_output.drain(..visible_length).collect(),
                    ));
                }
                break;
            };
            if prefix_index > 0 {
                parsed.push(ParsedTerminalOutput::Bytes(
                    self.pending_output.drain(..prefix_index).collect(),
                ));
            }
            let Some((payload_end, terminator_length)) = osc_terminator(&self.pending_output)
            else {
                break;
            };
            let payload = &self.pending_output[OSC_633_PREFIX.len()..payload_end];
            if let Some(exit_code) = command_finished_payload(payload) {
                parsed.push(ParsedTerminalOutput::CommandFinished(exit_code));
            }
            self.pending_output.drain(..payload_end + terminator_length);
        }
        parsed
    }

    pub(crate) fn flush_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending_output)
    }

    pub(crate) fn finish_active(&mut self, exit_code: Option<i32>, after_output_sequence: u64) {
        let Some(command_id) = self.active_command_id.take() else {
            return;
        };
        let status = match exit_code {
            Some(0) => TerminalCommandStatus::Succeeded,
            Some(_) => TerminalCommandStatus::Failed,
            None => TerminalCommandStatus::Completed,
        };
        self.push_event(command_id, status, exit_code, after_output_sequence);
    }

    pub(crate) fn cancel_active(&mut self, after_output_sequence: u64) {
        let Some(command_id) = self.active_command_id.take() else {
            return;
        };
        self.push_event(
            command_id,
            TerminalCommandStatus::Canceled,
            None,
            after_output_sequence,
        );
    }

    pub(crate) fn next_event_sequence(&self) -> u64 {
        self.next_event_sequence
    }

    pub(crate) fn read_events(
        &self,
        after_sequence: u64,
        maximum_events: usize,
    ) -> (Vec<TerminalCommandStatusEvent>, u64, bool) {
        let oldest_sequence = self
            .events
            .front()
            .map_or(self.next_event_sequence.saturating_add(1), |event| {
                event.sequence
            });
        let requested_sequence = after_sequence.saturating_add(1);
        let event_gap = requested_sequence < oldest_sequence;
        let first_sequence = if event_gap {
            oldest_sequence
        } else {
            requested_sequence
        };
        let events = self
            .events
            .iter()
            .filter(|event| event.sequence >= first_sequence)
            .take(maximum_events)
            .cloned()
            .collect::<Vec<_>>();
        let next_sequence = events.last().map_or_else(
            || {
                if event_gap {
                    self.next_event_sequence
                } else {
                    after_sequence
                }
            },
            |event| event.sequence,
        );
        (events, next_sequence, event_gap)
    }

    fn push_event(
        &mut self,
        command_id: String,
        status: TerminalCommandStatus,
        exit_code: Option<i32>,
        after_output_sequence: u64,
    ) {
        self.next_event_sequence = self.next_event_sequence.saturating_add(1);
        self.events.push_back(TerminalCommandStatusEvent {
            sequence: self.next_event_sequence,
            command_id,
            status,
            exit_code,
            after_output_sequence,
        });
        while self.events.len() > MAX_COMMAND_EVENTS {
            self.events.pop_front();
        }
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn partial_prefix_len(bytes: &[u8], prefix: &[u8]) -> usize {
    (1..prefix.len())
        .rev()
        .find(|length| bytes.ends_with(&prefix[..*length]))
        .unwrap_or(0)
}

fn osc_terminator(bytes: &[u8]) -> Option<(usize, usize)> {
    let payload = &bytes[OSC_633_PREFIX.len()..];
    for (index, byte) in payload.iter().enumerate() {
        if *byte == 0x07 {
            return Some((OSC_633_PREFIX.len() + index, 1));
        }
        if *byte == 0x1b && payload.get(index + 1) == Some(&b'\\') {
            return Some((OSC_633_PREFIX.len() + index, 2));
        }
    }
    None
}

fn command_finished_payload(payload: &[u8]) -> Option<Option<i32>> {
    if payload == b"D" {
        return Some(None);
    }
    let exit_code = payload.strip_prefix(b"D;")?;
    let exit_code = std::str::from_utf8(exit_code).ok()?.parse().ok()?;
    Some(Some(exit_code))
}

#[cfg(test)]
#[path = "command_status_tests.rs"]
mod tests;
