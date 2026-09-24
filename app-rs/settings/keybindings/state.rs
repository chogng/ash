use std::time::Duration;
use std::time::Instant;

use ash_keybinding::Chord;
use ash_keybinding::KeySequence;
use ash_keybinding::MAX_CHORDS;

const RECORDING_TIMEOUT: Duration = Duration::from_millis(1_000);

/// Host-independent keyboard-shortcut recording state shared by Settings and QuickAccess.
pub struct KeyboardShortcutsState<Command> {
    recording: Option<ShortcutRecording<Command>>,
    status: Option<ShortcutStatus>,
}

struct ShortcutRecording<Command> {
    command: Command,
    chords: Vec<Chord>,
    deadline: Option<Instant>,
}

struct ShortcutStatus {
    message: String,
    error: bool,
}

/// A completed recording that the host must validate and persist.
pub struct ShortcutCommit<Command> {
    pub command: Command,
    pub keybinding: KeySequence,
}

impl<Command> Default for KeyboardShortcutsState<Command> {
    fn default() -> Self {
        Self {
            recording: None,
            status: None,
        }
    }
}

impl<Command: Copy> KeyboardShortcutsState<Command> {
    pub const fn is_recording(&self) -> bool {
        self.recording.is_some()
    }

    pub fn reset(&mut self) {
        self.recording = None;
        self.status = None;
    }

    pub fn window_blurred(&mut self) {
        if self.recording.is_some() {
            self.cancel_recording();
        }
    }

    pub fn start_recording(&mut self, command: Command) {
        self.recording = Some(ShortcutRecording {
            command,
            chords: Vec::new(),
            deadline: None,
        });
        self.status = Some(ShortcutStatus {
            message: "Press a shortcut, then pause to save. Esc cancels.".to_owned(),
            error: false,
        });
    }

    pub fn cancel_recording(&mut self) {
        self.recording = None;
        self.status = Some(ShortcutStatus {
            message: "Recording cancelled.".to_owned(),
            error: false,
        });
    }

    pub fn record(&mut self, chord: Chord, now: Instant) {
        let Some(recording) = self.recording.as_mut() else {
            return;
        };
        if recording.chords.len() == MAX_CHORDS {
            return;
        }
        recording.chords.push(chord);
        recording.deadline = Some(if recording.chords.len() == MAX_CHORDS {
            now
        } else {
            now + RECORDING_TIMEOUT
        });
    }

    pub fn advance(&mut self, now: Instant) -> Option<ShortcutCommit<Command>> {
        let recording = self.recording.as_ref()?;
        if recording.deadline.is_none_or(|deadline| now < deadline) {
            return None;
        }
        let command = recording.command;
        let keybinding = KeySequence::new(recording.chords.clone()).ok()?;
        self.recording = None;
        Some(ShortcutCommit {
            command,
            keybinding,
        })
    }

    pub fn saved(&mut self, command_label: &str) {
        self.status = Some(ShortcutStatus {
            message: format!("Saved {command_label}."),
            error: false,
        });
    }

    pub fn save_failed(&mut self, error: impl Into<String>) {
        self.status = Some(ShortcutStatus {
            message: error.into(),
            error: true,
        });
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.recording
            .as_ref()
            .and_then(|recording| recording.deadline)
    }

    pub(crate) fn recording_command(&self) -> Option<Command> {
        self.recording.as_ref().map(|recording| recording.command)
    }

    pub(crate) fn recorded_keybinding(&self) -> Option<KeySequence> {
        let recording = self.recording.as_ref()?;
        KeySequence::new(recording.chords.clone()).ok()
    }

    pub(crate) fn status_message(&self) -> Option<(&str, bool)> {
        self.status
            .as_ref()
            .map(|status| (status.message.as_str(), status.error))
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
