use std::io;
use std::io::Write;

/// Coarse lifecycle state exposed to the host terminal without conversation content.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProgramStatus {
    Idle,
    Working,
    Blocked,
}

#[derive(Default)]
pub(super) struct StatusReporter {
    emitted: Option<ProgramStatus>,
}

impl StatusReporter {
    pub(super) fn set(&mut self, output: &mut impl Write, status: ProgramStatus) -> io::Result<()> {
        if self.emitted == Some(status) {
            return Ok(());
        }
        let state = match status {
            ProgramStatus::Idle => "idle",
            ProgramStatus::Working => "working",
            ProgramStatus::Blocked => "blocked",
        };
        write!(output, "\x1b]7501;state={state}:app=ash\x1b\\")?;
        output.flush()?;
        self.emitted = Some(status);
        Ok(())
    }

    pub(super) fn clear(&mut self, output: &mut impl Write) -> io::Result<()> {
        if self.emitted.is_none() {
            return Ok(());
        }
        output.write_all(b"\x1b]7501;state=clear\x1b\\")?;
        output.flush()?;
        self.emitted = None;
        Ok(())
    }
}

#[cfg(test)]
#[path = "program_status_tests.rs"]
mod tests;
