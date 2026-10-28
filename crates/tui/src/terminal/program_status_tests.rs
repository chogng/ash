use super::DictationStatus;
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
        status
            .set(&mut output, state, DictationStatus::Idle)
            .unwrap();
        status
            .set(&mut output, state, DictationStatus::Idle)
            .unwrap();
    }
    status.clear(&mut output).unwrap();
    status.clear(&mut output).unwrap();
    status
        .set(&mut output, ProgramStatus::Blocked, DictationStatus::Idle)
        .unwrap();
    assert_eq!(
        String::from_utf8(output).unwrap(),
        concat!(
            "\x1b]7501;state=idle:app=ash:dictation=idle:protocol=1\x1b\\",
            "\x1b]7501;state=working:app=ash:dictation=idle:protocol=1\x1b\\",
            "\x1b]7501;state=blocked:app=ash:dictation=idle:protocol=1\x1b\\",
            "\x1b]7501;state=clear\x1b\\",
            "\x1b]7501;state=blocked:app=ash:dictation=idle:protocol=1\x1b\\",
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
            .set(
                &mut BrokenFlush(Vec::new()),
                ProgramStatus::Working,
                DictationStatus::Idle
            )
            .is_err()
    );
    let mut output = Vec::new();
    status
        .set(&mut output, ProgramStatus::Working, DictationStatus::Idle)
        .unwrap();
    assert!(status.clear(&mut BrokenFlush(Vec::new())).is_err());
    status.clear(&mut output).unwrap();
    assert_eq!(
        output,
        b"\x1b]7501;state=working:app=ash:dictation=idle:protocol=1\x1b\\\x1b]7501;state=clear\x1b\\"
    );
}

#[test]
fn terminal_dictation_capability_changes_without_program_status_or_draft_changes() {
    let mut reporter = StatusReporter::default();
    let mut output = Vec::new();
    for dictation in [
        DictationStatus::Idle,
        DictationStatus::Active,
        DictationStatus::Busy,
        DictationStatus::Unavailable,
    ] {
        reporter
            .set(&mut output, ProgramStatus::Idle, dictation)
            .unwrap();
    }
    reporter.invalidate();
    reporter
        .set(&mut output, ProgramStatus::Idle, DictationStatus::Idle)
        .unwrap();
    let output = String::from_utf8(output).unwrap();
    assert_eq!(output.matches("dictation=idle:protocol=1").count(), 2);
    assert!(output.contains("dictation=active:protocol=1"));
    assert!(output.contains("dictation=busy:protocol=1"));
    assert!(output.contains("dictation=unavailable:protocol=1"));
}
