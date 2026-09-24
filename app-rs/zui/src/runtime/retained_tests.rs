use std::time::Duration;
use std::time::Instant;

use crate::ElementId;
use crate::FrameInvalidation;
use crate::FrameSchedule;
use crate::FrameScheduler;
use crate::RetainedFragmentError;
use crate::RetainedFragmentExit;
use crate::RetainedFragmentMount;
use crate::RetainedFragmentRegistry;
use crate::RetainedFragmentState;

const FIRST: ElementId = ElementId::scoped(72, 1);
const SECOND: ElementId = ElementId::scoped(72, 2);

#[test]
fn mount_is_idempotent_and_reentering_cancels_exit() {
    let now = Instant::now();
    let remove_at = now + Duration::from_secs(1);
    let mut registry = RetainedFragmentRegistry::default();

    assert_eq!(registry.mount(FIRST), RetainedFragmentMount::Inserted);
    assert_eq!(registry.mount(FIRST), RetainedFragmentMount::Updated);
    assert_eq!(
        registry.begin_exit(FIRST, remove_at),
        Ok(RetainedFragmentExit::Scheduled { remove_at })
    );
    assert_eq!(
        registry.state(FIRST),
        Some(RetainedFragmentState::Exiting { remove_at })
    );
    assert_eq!(registry.mount(FIRST), RetainedFragmentMount::Resumed);
    assert_eq!(registry.state(FIRST), Some(RetainedFragmentState::Mounted));
    assert!(registry.advance(remove_at).removed_ids().is_empty());
}

#[test]
fn advance_removes_expired_fragments_in_stable_identity_order() {
    let now = Instant::now();
    let first_deadline = now + Duration::from_millis(10);
    let second_deadline = now + Duration::from_millis(20);
    let mut registry = RetainedFragmentRegistry::default();
    registry.mount(FIRST);
    registry.mount(SECOND);
    registry.begin_exit(SECOND, second_deadline).unwrap();
    registry.begin_exit(FIRST, first_deadline).unwrap();

    let before_second = registry.advance(first_deadline);
    assert_eq!(before_second.removed_ids(), &[FIRST]);
    assert_eq!(before_second.next_deadline(), Some(second_deadline));
    assert_eq!(registry.state(FIRST), None);

    let at_second = registry.advance(second_deadline);
    assert_eq!(at_second.removed_ids(), &[SECOND]);
    assert_eq!(at_second.next_deadline(), None);
    assert!(registry.is_empty());
}

#[test]
fn advance_report_schedules_only_the_removed_fragments() {
    let now = Instant::now();
    let mut registry = RetainedFragmentRegistry::default();
    registry.mount(FIRST);
    registry.mount(SECOND);
    registry.begin_exit(FIRST, now).unwrap();
    registry.begin_exit(SECOND, now).unwrap();

    let report = registry.advance(now);
    let mut scheduler = FrameScheduler::default();
    assert_eq!(
        report.schedule(&mut scheduler),
        Some(FrameSchedule::RequestFrame)
    );
    assert_eq!(scheduler.take(), Some(FrameInvalidation::Fragment));
    assert_eq!(scheduler.take_fragment_ids(), Some(vec![FIRST, SECOND]));
}

#[test]
fn exit_can_be_retargeted_but_unknown_id_is_rejected() {
    let now = Instant::now();
    let first_deadline = now + Duration::from_millis(10);
    let second_deadline = now + Duration::from_millis(20);
    let mut registry = RetainedFragmentRegistry::default();

    assert_eq!(
        registry.begin_exit(FIRST, first_deadline),
        Err(RetainedFragmentError::Missing(FIRST))
    );
    registry.mount(FIRST);
    assert_eq!(
        registry.begin_exit(FIRST, first_deadline),
        Ok(RetainedFragmentExit::Scheduled {
            remove_at: first_deadline
        })
    );
    assert_eq!(
        registry.begin_exit(FIRST, second_deadline),
        Ok(RetainedFragmentExit::Rescheduled {
            previous_remove_at: first_deadline,
            remove_at: second_deadline,
        })
    );
}

#[test]
fn explicit_unmount_removes_the_identity_immediately() {
    let mut registry = RetainedFragmentRegistry::default();
    registry.mount(FIRST);

    assert_eq!(registry.unmount(FIRST), Ok(()));
    assert_eq!(registry.state(FIRST), None);
    assert_eq!(
        registry.unmount(FIRST),
        Err(RetainedFragmentError::Missing(FIRST))
    );
}
