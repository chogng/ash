use super::ProgramStatus;
use super::StatusReporter;
use std::io;
use std::io::Write;

#[test]
fn terminal_program_status_deduplicates_and_resumes_after_clear() {
    let mut status = StatusReporter::default();
    let mut output = Vec::new();
    status.clear(&mut output).unwrap();
    for state in [
        ProgramStatus::Idle,
        ProgramStatus::Working,
        ProgramStatus::Blocked,
    ] {
        status.set(&mut output, state).unwrap();
        status.set(&mut output, state).unwrap();
    }
    status.clear(&mut output).unwrap();
    status.clear(&mut output).unwrap();
    status.set(&mut output, ProgramStatus::Blocked).unwrap();
    assert_eq!(
        String::from_utf8(output).unwrap(),
        concat!(
            "\x1b]7501;state=idle:app=ash\x1b\\",
            "\x1b]7501;state=working:app=ash\x1b\\",
            "\x1b]7501;state=blocked:app=ash\x1b\\",
            "\x1b]7501;state=clear\x1b\\",
            "\x1b]7501;state=blocked:app=ash\x1b\\",
        )
    );
}

struct BrokenFlush(Vec<u8>);

impl Write for BrokenFlush {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Err(io::Error::other("flush failed"))
    }
}

#[test]
fn terminal_program_status_retries_failed_writes_and_clear() {
    let mut status = StatusReporter::default();
    assert!(
        status
            .set(&mut BrokenFlush(Vec::new()), ProgramStatus::Working)
            .is_err()
    );
    let mut output = Vec::new();
    status.set(&mut output, ProgramStatus::Working).unwrap();
    assert!(status.clear(&mut BrokenFlush(Vec::new())).is_err());
    status.clear(&mut output).unwrap();
    assert_eq!(
        output,
        b"\x1b]7501;state=working:app=ash\x1b\\\x1b]7501;state=clear\x1b\\"
    );
}
