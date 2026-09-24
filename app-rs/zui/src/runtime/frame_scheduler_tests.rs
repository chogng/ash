use super::{FrameInvalidation, FrameSchedule, FrameScheduler};
use crate::ElementId;

#[test]
fn scheduler_requests_one_platform_frame_for_repeated_work() {
    let mut scheduler = FrameScheduler::default();

    assert_eq!(
        scheduler.request(FrameInvalidation::Rebuild),
        FrameSchedule::RequestFrame
    );
    assert_eq!(
        scheduler.request(FrameInvalidation::Rebuild),
        FrameSchedule::Coalesced
    );
    assert_eq!(scheduler.take(), Some(FrameInvalidation::Rebuild));
    assert_eq!(scheduler.take(), None);
}

#[test]
fn scheduler_retains_the_strongest_invalidation() {
    let mut scheduler = FrameScheduler::default();

    scheduler.request(FrameInvalidation::Render);
    scheduler.request(FrameInvalidation::Fragment);
    scheduler.request(FrameInvalidation::Rebuild);
    scheduler.request(FrameInvalidation::Render);

    assert_eq!(scheduler.pending(), Some(FrameInvalidation::Rebuild));
}

#[test]
fn fragment_work_subsumes_render_without_forcing_a_full_rebuild() {
    let mut scheduler = FrameScheduler::default();

    scheduler.request(FrameInvalidation::Render);
    scheduler.request(FrameInvalidation::Fragment);

    assert_eq!(scheduler.take(), Some(FrameInvalidation::Fragment));
}

#[test]
fn synchronous_completion_clears_pending_work() {
    let mut scheduler = FrameScheduler::default();
    scheduler.request(FrameInvalidation::Rebuild);

    scheduler.clear();

    assert_eq!(scheduler.pending(), None);
    assert_eq!(
        scheduler.request(FrameInvalidation::Render),
        FrameSchedule::RequestFrame
    );
}

#[test]
fn scheduler_retains_stable_fragment_ids_until_the_frame_is_taken() {
    let first = ElementId::scoped(4, 1);
    let second = ElementId::scoped(4, 2);
    let mut scheduler = FrameScheduler::default();

    assert_eq!(
        scheduler.request_fragment(first),
        FrameSchedule::RequestFrame
    );
    assert_eq!(scheduler.request_fragment(second), FrameSchedule::Coalesced);
    assert_eq!(scheduler.take(), Some(FrameInvalidation::Fragment));
    assert_eq!(scheduler.take_fragment_ids(), Some(vec![first, second]));
}

#[test]
fn generic_fragment_work_supersedes_specific_fragment_ids() {
    let fragment = ElementId::scoped(4, 3);
    let mut scheduler = FrameScheduler::default();

    scheduler.request_fragment(fragment);
    scheduler.request(FrameInvalidation::Fragment);

    assert_eq!(scheduler.take(), Some(FrameInvalidation::Fragment));
    assert_eq!(scheduler.take_fragment_ids(), None);
}
