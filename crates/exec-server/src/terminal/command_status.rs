use crate::terminal::TerminalCommandStatus;
use crate::terminal::TerminalCommandStatusEvent;
use crate::terminal::TerminalCwd;
use crate::terminal::TerminalShellIntegration;
use exec_server_protocol::terminal::TerminalShellIntegrationEvent;
use std::collections::VecDeque;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

const OSC_633_PREFIX: &[u8] = b"\x1b]633;";
const MAX_COMMAND_EVENTS: usize = 1_024;
const MAX_HISTORY_COMMANDS: usize = 256;
// Include cwd and JSON escaping so metadata cannot exhaust the terminal wire frame.
const MAX_COMMAND_RECORD_BYTES: usize = 512 * 1024;
const MAX_OSC_BYTES: usize = 65_536;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum CommandStatusMode {
    Disabled,
    ShellIntegration,
}

pub(crate) enum ParsedTerminalOutput {
    Bytes(Vec<u8>),
    CommandStarted,
    CommandFinished(Option<i32>),
    Cwd(String, bool),
    CommandLine(String, bool),
    PromptStart,
    RichCommandDetection(bool),
    CommandStorageDisabled,
    PromptType(String),
    ShellIntegration(TerminalShellIntegrationEvent),
}

/// Tracks shell command lifecycle independently of any renderer.
pub(crate) struct TerminalCommandStatusTracker {
    mode: CommandStatusMode,
    pending_output: Vec<u8>,
    discarded_osc: Option<OscDiscardState>,
    events: VecDeque<TerminalCommandStatusEvent>,
    next_event_sequence: u64,
    next_command_id: u64,
    active_command: Option<ActiveCommand>,
    cwd: Option<TerminalCwd>,
    nonce: Option<String>,
    pending_command_line: Option<CommandLine>,
    integration: TerminalShellIntegration,
    environment_budget: Option<(usize, usize)>,
}

enum OscDiscardState {
    InPayload,
    AfterEscape,
}

struct ActiveCommand {
    id: String,
    cwd: Option<String>,
    text: Option<CommandLine>,
    started: Instant,
    timestamp_millis: u64,
}

#[derive(Clone)]
struct CommandLine {
    command: String,
    is_trusted: bool,
}

impl TerminalCommandStatusTracker {
    pub(crate) fn new(mode: CommandStatusMode, nonce: Option<String>) -> Self {
        Self {
            mode,
            pending_output: Vec::new(),
            discarded_osc: None,
            events: VecDeque::new(),
            next_event_sequence: 0,
            next_command_id: 1,
            active_command: None,
            cwd: None,
            nonce,
            pending_command_line: None,
            environment_budget: None,
            integration: TerminalShellIntegration {
                command_detection: false,
                cwd_detection: false,
                has_rich_command_detection: false,
                command_storage_disabled: false,
                prompt_type: None,
                commands: Vec::new(),
                after_output_sequence: 0,
            },
        }
    }

    pub(crate) fn start_active(&mut self, after_output_sequence: u64) {
        if self.active_command.is_some() {
            return;
        }
        self.integration.command_detection = true;
        self.integration.after_output_sequence = after_output_sequence;
        let text = self.pending_command_line.take();
        let command_id = format!("command-{:x}", self.next_command_id);
        self.next_command_id = self.next_command_id.saturating_add(1);
        let cwd = self.cwd.as_ref().map(|cwd| cwd.value.clone());
        self.active_command = Some(ActiveCommand {
            id: command_id.clone(),
            cwd: cwd.clone(),
            text: text.clone(),
            started: Instant::now(),
            timestamp_millis: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u64::MAX as u128) as u64,
        });
        self.push_event(
            command_id,
            TerminalCommandStatus::Running,
            None,
            after_output_sequence,
            cwd,
            text,
        );
    }

    pub(crate) fn parse_output(&mut self, bytes: Vec<u8>) -> Vec<ParsedTerminalOutput> {
        if self.mode == CommandStatusMode::Disabled {
            return vec![ParsedTerminalOutput::Bytes(bytes)];
        }
        self.pending_output.extend(bytes);
        let mut parsed = Vec::new();
        loop {
            if self.discarded_osc.is_some() {
                let mut consumed = 0;
                for byte in &self.pending_output {
                    consumed += 1;
                    if *byte == 0x07
                        || (*byte == b'\\'
                            && matches!(self.discarded_osc, Some(OscDiscardState::AfterEscape)))
                    {
                        self.discarded_osc = None;
                        break;
                    }
                    self.discarded_osc = Some(if *byte == 0x1b {
                        OscDiscardState::AfterEscape
                    } else {
                        OscDiscardState::InPayload
                    });
                }
                self.pending_output.drain(..consumed);
                if self.discarded_osc.is_some() {
                    break;
                }
            }
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
                if self.pending_output.len() > MAX_OSC_BYTES {
                    let payload = &self.pending_output[OSC_633_PREFIX.len()..];
                    if private_metadata(payload) {
                        if payload.starts_with(b"Env") {
                            self.environment_budget = None;
                            parsed.push(ParsedTerminalOutput::ShellIntegration(
                                TerminalShellIntegrationEvent::Environment {
                                    values: None,
                                    is_trusted: false,
                                },
                            ));
                        }
                        self.pending_command_line = None;
                        self.discarded_osc = Some(OscDiscardState::InPayload);
                        continue;
                    }
                    // Release an unterminated OSC rather than retaining unbounded child output.
                    parsed.push(ParsedTerminalOutput::Bytes(
                        self.pending_output.drain(..1).collect(),
                    ));
                    continue;
                }
                break;
            };
            let payload = &self.pending_output[OSC_633_PREFIX.len()..payload_end];
            if payload_end > MAX_OSC_BYTES && private_metadata(payload) {
                if payload.starts_with(b"Env") {
                    self.environment_budget = None;
                    parsed.push(ParsedTerminalOutput::ShellIntegration(
                        TerminalShellIntegrationEvent::Environment {
                            values: None,
                            is_trusted: false,
                        },
                    ));
                }
                self.pending_command_line = None;
                self.pending_output.drain(..payload_end + terminator_length);
                continue;
            }
            let item = if payload_end > MAX_OSC_BYTES {
                None
            } else if payload == b"C" {
                Some(ParsedTerminalOutput::CommandStarted)
            } else if let Some(exit_code) = command_finished_payload(payload) {
                Some(ParsedTerminalOutput::CommandFinished(exit_code))
            } else if let Some(value) = payload.strip_prefix(b"P;Cwd=") {
                self.decode_metadata(value)
                    .filter(|(value, _)| !value.is_empty())
                    .map(|(value, trusted)| ParsedTerminalOutput::Cwd(value, trusted))
            } else if payload == b"E" {
                Some(ParsedTerminalOutput::CommandLine(String::new(), false))
            } else if let Some(value) = payload.strip_prefix(b"E;") {
                self.decode_metadata(value)
                    .map(|(value, trusted)| ParsedTerminalOutput::CommandLine(value, trusted))
            } else if payload == b"A" {
                Some(ParsedTerminalOutput::PromptStart)
            } else if payload == b"P;HasRichCommandDetection=True" {
                Some(ParsedTerminalOutput::RichCommandDetection(true))
            } else if payload == b"P;HasRichCommandDetection=False" {
                Some(ParsedTerminalOutput::RichCommandDetection(false))
            } else if payload == b"P;Task" || payload.starts_with(b"P;Task=") {
                Some(ParsedTerminalOutput::CommandStorageDisabled)
            } else if let Some(value) = payload.strip_prefix(b"P;PromptType=") {
                let value = self.decode_metadata(value).map(|(value, _)| value);
                // This is display metadata. Drop malformed properties rather than
                // forwarding a possible nonce suffix into a renderer's buffer.
                if let Some(value) =
                    value.filter(|value| value.len() <= 128 && !value.chars().any(char::is_control))
                {
                    Some(ParsedTerminalOutput::PromptType(value))
                } else {
                    self.pending_output.drain(..payload_end + terminator_length);
                    continue;
                }
            } else if payload.starts_with(b"Env") {
                Some(ParsedTerminalOutput::ShellIntegration(
                    self.parse_environment(payload).unwrap_or(
                        TerminalShellIntegrationEvent::Environment {
                            values: None,
                            is_trusted: false,
                        },
                    ),
                ))
            } else if let Some(boundary) = match payload {
                b"B" => Some(TerminalShellIntegrationEvent::CommandStart),
                b"F" => Some(TerminalShellIntegrationEvent::ContinuationStart),
                b"G" => Some(TerminalShellIntegrationEvent::ContinuationEnd),
                b"H" => Some(TerminalShellIntegrationEvent::RightPromptStart),
                b"I" => Some(TerminalShellIntegrationEvent::RightPromptEnd),
                _ => None,
            } {
                Some(ParsedTerminalOutput::ShellIntegration(boundary))
            } else {
                None
            };
            if let Some(item) = item {
                let item = match item {
                    ParsedTerminalOutput::ShellIntegration(event) => {
                        ParsedTerminalOutput::ShellIntegration(self.limit_environment(event))
                    }
                    other => other,
                };
                parsed.push(item);
            } else if !private_metadata(payload) {
                parsed.push(ParsedTerminalOutput::Bytes(
                    self.pending_output[..payload_end + terminator_length].to_vec(),
                ));
            }
            self.pending_output.drain(..payload_end + terminator_length);
        }
        parsed
    }

    pub(crate) fn flush_output(&mut self) -> Vec<u8> {
        // Never reflect an incomplete metadata value or nonce into a display replay.
        if self.discarded_osc.is_some()
            || self
                .pending_output
                .strip_prefix(OSC_633_PREFIX)
                .is_some_and(private_metadata)
        {
            self.pending_output.clear();
        }
        std::mem::take(&mut self.pending_output)
    }

    pub(crate) fn executed_boundary(&self) -> Option<TerminalShellIntegrationEvent> {
        self.active_command
            .as_ref()
            .map(|command| TerminalShellIntegrationEvent::CommandExecuted {
                command_id: command.id.clone(),
                command: command.text.as_ref().map(|text| text.command.clone()),
                is_trusted: command.text.as_ref().is_some_and(|text| text.is_trusted),
                command_storage_disabled: self.integration.command_storage_disabled,
                cwd: command.cwd.clone(),
                timestamp_millis: command.timestamp_millis,
            })
    }

    pub(crate) fn finished_boundary(
        &self,
        exit_code: Option<i32>,
    ) -> TerminalShellIntegrationEvent {
        TerminalShellIntegrationEvent::CommandFinished {
            exit_code,
            duration_millis: self
                .active_command
                .as_ref()
                .map(|command| command.started.elapsed().as_millis().min(u64::MAX as u128) as u64),
        }
    }

    pub(crate) fn finish_active(&mut self, exit_code: Option<i32>, after_output_sequence: u64) {
        self.pending_command_line = None;
        self.integration.after_output_sequence = after_output_sequence;
        let Some(command) = self.active_command.take() else {
            return;
        };
        let status = match exit_code {
            Some(0) => TerminalCommandStatus::Succeeded,
            Some(_) => TerminalCommandStatus::Failed,
            None => TerminalCommandStatus::Completed,
        };
        self.push_event(
            command.id,
            status,
            exit_code,
            after_output_sequence,
            command.cwd,
            command.text,
        );
    }

    pub(crate) fn cancel_active(&mut self, after_output_sequence: u64) {
        self.pending_command_line = None;
        self.integration.after_output_sequence = after_output_sequence;
        let Some(command) = self.active_command.take() else {
            return;
        };
        self.push_event(
            command.id,
            TerminalCommandStatus::Canceled,
            None,
            after_output_sequence,
            command.cwd,
            command.text,
        );
    }

    pub(crate) fn record_cwd(
        &mut self,
        value: String,
        is_trusted: bool,
        after_output_sequence: u64,
    ) {
        self.integration.cwd_detection = true;
        self.integration.after_output_sequence = after_output_sequence;
        if self
            .cwd
            .as_ref()
            .is_none_or(|cwd| cwd.value != value || cwd.is_trusted != Some(is_trusted))
        {
            self.cwd = Some(TerminalCwd {
                value,
                is_trusted: Some(is_trusted),
                after_output_sequence,
            });
        }
    }

    fn nonce_matches(&self, nonce: Option<&[u8]>) -> bool {
        self.nonce.as_ref().is_some_and(|expected| {
            !expected.is_empty()
                && nonce.is_some_and(|nonce| {
                    std::str::from_utf8(nonce)
                        .is_ok_and(|nonce| super::constant_time_eq(expected, nonce))
                })
        })
    }

    fn parse_environment(&self, payload: &[u8]) -> Option<TerminalShellIntegrationEvent> {
        use TerminalShellIntegrationEvent as Event;
        let mut fields = payload.split(|byte| *byte == b';');
        let kind = fields.next()?;
        match kind {
            b"EnvSingleStart" => {
                let clear = match fields.next()? {
                    b"1" => true,
                    b"0" => false,
                    _ => return None,
                };
                let is_trusted = self.nonce_matches(fields.next());
                if fields.next().is_some() {
                    return None;
                }
                Some(Event::EnvironmentStart { clear, is_trusted })
            }
            b"EnvSingleEnd" => {
                let is_trusted = self.nonce_matches(fields.next());
                // Some producers include one empty final field after the nonce.
                if fields.next().is_some_and(|field| !field.is_empty()) || fields.next().is_some() {
                    return None;
                }
                Some(Event::EnvironmentEnd { is_trusted })
            }
            b"EnvSingleEntry" | b"EnvSingleDelete" => {
                let key = decode_value(fields.next()?)?;
                let value = decode_value(fields.next()?)?;
                let is_trusted = self.nonce_matches(fields.next());
                if fields.next().is_some() || !valid_env_entry(&key, &Some(value.clone())) {
                    return None;
                }
                if kind == b"EnvSingleEntry" {
                    Some(Event::EnvironmentEntry {
                        key,
                        value: Some(value),
                        is_trusted,
                    })
                } else {
                    Some(Event::EnvironmentDelete {
                        key,
                        value: Some(value),
                        is_trusted,
                    })
                }
            }
            b"EnvJson" => {
                let (value, is_trusted) =
                    self.decode_metadata(payload.strip_prefix(b"EnvJson;")?)?;
                let values: std::collections::BTreeMap<String, Option<String>> =
                    serde_json::from_str(&value).ok()?;
                if values.len() > 512
                    || !values
                        .iter()
                        .all(|(key, value)| valid_env_entry(key, value))
                {
                    return None;
                }
                Some(Event::Environment {
                    values: Some(values),
                    is_trusted,
                })
            }
            _ => None,
        }
    }

    fn limit_environment(
        &mut self,
        event: TerminalShellIntegrationEvent,
    ) -> TerminalShellIntegrationEvent {
        use TerminalShellIntegrationEvent as Event;
        match &event {
            Event::EnvironmentStart { .. } => self.environment_budget = Some((0, 0)),
            Event::EnvironmentEntry { key, value, .. }
            | Event::EnvironmentDelete { key, value, .. } => {
                if let Some((entries, bytes)) = self.environment_budget.as_mut() {
                    *entries += 1;
                    *bytes += key.len() + value.as_ref().map_or(0, String::len);
                    if *entries > 512 || *bytes > 256 * 1024 {
                        self.environment_budget = None;
                        return Event::Environment {
                            values: None,
                            is_trusted: false,
                        };
                    }
                }
            }
            Event::Environment { .. } | Event::EnvironmentEnd { .. } => {
                self.environment_budget = None
            }
            _ => {}
        }
        event
    }

    fn decode_metadata(&self, bytes: &[u8]) -> Option<(String, bool)> {
        let mut fields = bytes.split(|byte| *byte == b';');
        let value = decode_value(fields.next()?)?;
        let nonce = fields.next();
        if fields.next().is_some() || value.len() > 32768 || value.contains('\0') {
            return None;
        }
        let trusted = self.nonce_matches(nonce);
        Some((value, trusted))
    }

    pub(crate) fn record_command_line(&mut self, command: String, is_trusted: bool, sequence: u64) {
        self.integration.command_detection = true;
        self.integration.after_output_sequence = sequence;
        if self.integration.command_storage_disabled {
            return;
        }
        let text = Some(CommandLine {
            command,
            is_trusted,
        });
        if let Some(active) = &mut self.active_command {
            active.text = text;
        } else {
            self.pending_command_line = text;
        }
    }

    pub(crate) fn record_prompt(&mut self, sequence: u64) {
        self.integration.command_detection = true;
        self.integration.after_output_sequence = sequence;
        // An abandoned input line must not become the text of the next execution.
        if self.active_command.is_none() {
            self.pending_command_line = None;
        }
    }

    pub(crate) fn record_rich_detection(&mut self, rich: bool, sequence: u64) {
        self.integration.command_detection = true;
        self.integration.has_rich_command_detection = rich;
        self.integration.after_output_sequence = sequence;
    }

    pub(crate) fn record_prompt_type(&mut self, value: String, sequence: u64) {
        self.integration.prompt_type = Some(value);
        self.integration.after_output_sequence = sequence;
    }

    pub(crate) fn is_command_storage_disabled(&self) -> bool {
        self.integration.command_storage_disabled
    }

    pub(crate) fn disable_command_storage(&mut self, sequence: u64) {
        self.integration.command_storage_disabled = true;
        self.integration.commands.clear();
        self.integration.after_output_sequence = sequence;
        self.pending_command_line = None;
        if let Some(active) = &mut self.active_command {
            active.text = None;
        }
        for event in &mut self.events {
            event.command = None;
            event.is_trusted = None;
        }
    }

    pub(crate) fn shell_integration(&self) -> Option<TerminalShellIntegration> {
        (self.integration.command_detection
            || self.integration.cwd_detection
            || self.integration.command_storage_disabled
            || self.integration.prompt_type.is_some())
        .then(|| self.integration.clone())
    }

    pub(crate) fn cwd(&self) -> Option<&TerminalCwd> {
        self.cwd.as_ref()
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
        cwd: Option<String>,
        text: Option<CommandLine>,
    ) {
        self.next_event_sequence = self.next_event_sequence.saturating_add(1);
        let event = TerminalCommandStatusEvent {
            sequence: self.next_event_sequence,
            command_id,
            status,
            exit_code,
            after_output_sequence,
            cwd,
            command: text.as_ref().map(|text| text.command.clone()),
            is_trusted: text.map(|text| text.is_trusted),
        };
        if status != TerminalCommandStatus::Running && !self.integration.command_storage_disabled {
            self.integration.commands.push(event.clone());
            while self.integration.commands.len() > MAX_HISTORY_COMMANDS
                || self
                    .integration
                    .commands
                    .iter()
                    .map(command_record_bytes)
                    .sum::<usize>()
                    > MAX_COMMAND_RECORD_BYTES
            {
                self.integration.commands.remove(0);
            }
        }
        self.events.push_back(event);
        while self.events.len() > MAX_COMMAND_EVENTS
            || self.events.iter().map(command_record_bytes).sum::<usize>()
                > MAX_COMMAND_RECORD_BYTES
        {
            self.events.pop_front();
        }
    }
}

fn command_record_bytes(event: &TerminalCommandStatusEvent) -> usize {
    // Scalar fields, field names, IDs and delimiters fit this fixed allowance.
    256 + event
        .command
        .as_ref()
        .map_or(0, |value| escaped_json_bytes(value))
        + event
            .cwd
            .as_ref()
            .map_or(0, |value| escaped_json_bytes(value))
}

fn escaped_json_bytes(value: &str) -> usize {
    value
        .bytes()
        .map(|byte| match byte {
            0..=31 => 6,
            b'"' | b'\\' => 2,
            _ => 1,
        })
        .sum()
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

fn private_metadata(payload: &[u8]) -> bool {
    [b"Env".as_slice(), b"E;", b"P;Cwd=", b"P;PromptType="]
        .iter()
        .any(|prefix| payload.starts_with(prefix))
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

pub(super) fn decode_value(bytes: &[u8]) -> Option<String> {
    let mut value = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\' && bytes.get(index + 1) == Some(&b'\\') {
            value.push(b'\\');
            index += 2;
        } else if bytes[index] == b'\\'
            && bytes.get(index + 1) == Some(&b'x')
            && let Some(digits) = bytes.get(index + 2..index + 4)
            && let Some(high) = (digits[0] as char).to_digit(16)
            && let Some(low) = (digits[1] as char).to_digit(16)
        {
            value.push((high * 16 + low) as u8);
            index += 4;
        } else {
            value.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(value).ok()
}

fn valid_env_entry(key: &str, value: &Option<String>) -> bool {
    !key.is_empty()
        && key.len() <= 256
        && !key.contains(['=', '\0'])
        && value
            .as_ref()
            .is_none_or(|value| value.len() <= 32768 && !value.contains('\0'))
}
