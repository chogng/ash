use std::io;
use std::io::Write;

/// Coarse lifecycle state exposed to the host terminal without conversation content.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProgramStatus {
    Idle,
    Working,
    Blocked,
}

/// Input capability projected by the IDE. Recording and drafts remain owned by the TUI.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DictationStatus {
    Unavailable,
    Idle,
    Active,
    Busy,
}

#[derive(Default)]
pub(super) struct StatusReporter {
    emitted: Option<(ProgramStatus, DictationStatus)>,
    refresh_requested: bool,
}

impl StatusReporter {
    pub(super) fn invalidate(&mut self) {
        self.refresh_requested = true;
    }

    pub(super) fn set(
        &mut self,
        output: &mut impl Write,
        status: ProgramStatus,
        dictation: DictationStatus,
    ) -> io::Result<()> {
        if !self.refresh_requested && self.emitted == Some((status, dictation)) {
            return Ok(());
        }
        let state = match status {
            ProgramStatus::Idle => "idle",
            ProgramStatus::Working => "working",
            ProgramStatus::Blocked => "blocked",
        };
        let input = match dictation {
            DictationStatus::Unavailable => "unavailable",
            DictationStatus::Idle => "idle",
            DictationStatus::Active => "active",
            DictationStatus::Busy => "busy",
        };
        write!(
            output,
            "\x1b]7501;state={state}:app=ash:dictation={input}:protocol=1\x1b\\"
        )?;
        output.flush()?;
        self.emitted = Some((status, dictation));
        self.refresh_requested = false;
        Ok(())
    }

    pub(super) fn clear(&mut self, output: &mut impl Write) -> io::Result<()> {
        if self.emitted.is_none() {
            return Ok(());
        }
        output.write_all(b"\x1b]7501;state=clear\x1b\\")?;
        output.flush()?;
        self.emitted = None;
        self.refresh_requested = false;
        Ok(())
    }
}

#[cfg(test)]
#[path = "program_status_tests.rs"]
mod tests;
