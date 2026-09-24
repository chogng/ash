use super::Action;
use super::Status;
use super::action;
use super::status_after_recording;
use ash_memory_diagnostics::MemoryStatus;

#[test]
fn finished_recording_allows_enabled_config_to_start_the_next_segment() {
    assert_eq!(
        status_after_recording(MemoryStatus::Recording),
        Status::Recording
    );
    for status in [
        MemoryStatus::Stopped,
        MemoryStatus::BudgetExpired,
        MemoryStatus::TargetsExited,
    ] {
        assert_eq!(status_after_recording(status), Status::Disabled);
    }
    assert_eq!(action(true, Status::Disabled), Some(Action::Start));
    assert_eq!(action(false, Status::Recording), Some(Action::Stop));
    assert_eq!(action(true, Status::Failed), None);
    assert_eq!(action(false, Status::Starting), None);
    assert_eq!(
        action(true, status_after_recording(MemoryStatus::BudgetExpired)),
        Some(Action::Start)
    );
}
