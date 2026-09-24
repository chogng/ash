use std::time::{Duration, Instant};

use crate::AnimationProperty;
use crate::ElementId;

use super::AnimationAdvance;
use super::AnimationAdvanceReport;
use super::AnimationEasing;
use super::AnimationKey;
use super::AnimationRegistry;
use super::FrameInvalidation;
use super::FrameScheduler;
use super::ScalarAnimation;
use super::ScalarAnimationSpec;

const FRAME: Duration = Duration::from_millis(16);
const DURATION: Duration = Duration::from_millis(100);
const ELEMENT: ElementId = ElementId::scoped(8, 1);
const SECOND_ELEMENT: ElementId = ElementId::scoped(8, 2);
const OPACITY: AnimationKey = AnimationKey::new(ELEMENT, AnimationProperty::Opacity);
const TRANSLATE_X: AnimationKey = AnimationKey::new(ELEMENT, AnimationProperty::TranslateX);
const SECOND_OPACITY: AnimationKey = AnimationKey::new(SECOND_ELEMENT, AnimationProperty::Opacity);
const FRAGMENT_TRANSITION: ScalarAnimationSpec = ScalarAnimationSpec::new(
    DURATION,
    AnimationEasing::Linear,
    FrameInvalidation::Fragment,
);
const REBUILD_TRANSITION: ScalarAnimationSpec = ScalarAnimationSpec::new(
    DURATION,
    AnimationEasing::Linear,
    FrameInvalidation::Rebuild,
);

#[test]
fn scalar_animation_interpolates_and_schedules_frames() {
    let now = Instant::now();
    let mut animation = ScalarAnimation::new(0.0);

    animation.transition_to(1.0, DURATION, AnimationEasing::Linear, now);

    assert_eq!(animation.value(), 0.0);
    assert_eq!(animation.next_deadline(), now.checked_add(FRAME));
    assert_eq!(
        animation.advance(now + Duration::from_millis(50)),
        AnimationAdvance::Changed
    );
    assert!((animation.value() - 0.5).abs() <= f32::EPSILON);
    assert_eq!(animation.advance(now + DURATION), AnimationAdvance::Changed);
    assert_eq!(animation.value(), 1.0);
    assert_eq!(animation.next_deadline(), None);
}

#[test]
fn scalar_animation_deadline_does_not_skip_a_short_transition_end() {
    let now = Instant::now();
    let duration = Duration::from_millis(5);
    let mut animation = ScalarAnimation::new(0.0);

    animation.transition_to(1.0, duration, AnimationEasing::Linear, now);

    assert_eq!(animation.next_deadline(), now.checked_add(duration));
}

#[test]
fn scalar_animation_ignores_early_wakeups_until_the_next_frame_deadline() {
    let now = Instant::now();
    let mut animation = ScalarAnimation::new(0.0);

    animation.transition_to(1.0, DURATION, AnimationEasing::Linear, now);

    assert_eq!(
        animation.advance(now + Duration::from_millis(1)),
        AnimationAdvance::Unchanged
    );
    assert_eq!(animation.value(), 0.0);
    assert_eq!(
        animation.advance(now + Duration::from_millis(16)),
        AnimationAdvance::Changed
    );
}

#[test]
fn scalar_animation_retargets_from_the_current_value_without_jumping() {
    let now = Instant::now();
    let mut animation = ScalarAnimation::new(0.0);

    animation.transition_to(1.0, DURATION, AnimationEasing::Linear, now);
    animation.advance(now + Duration::from_millis(40));
    let current = animation.value();
    animation.transition_to(
        0.0,
        DURATION,
        AnimationEasing::Linear,
        now + Duration::from_millis(40),
    );

    assert_eq!(animation.value(), current);
    assert_eq!(
        animation.advance(now + Duration::from_millis(90)),
        AnimationAdvance::Changed
    );
    assert!(animation.value() < current);
}

#[test]
fn scalar_animation_repeated_target_does_not_restart_the_transition() {
    let now = Instant::now();
    let mut animation = ScalarAnimation::new(0.0);

    animation.transition_to(1.0, DURATION, AnimationEasing::Linear, now);
    animation.advance(now + Duration::from_millis(40));
    animation.transition_to(
        1.0,
        DURATION,
        AnimationEasing::Linear,
        now + Duration::from_millis(40),
    );
    animation.advance(now + Duration::from_millis(80));

    assert!((animation.value() - 0.8).abs() <= f32::EPSILON);
}

#[test]
fn scalar_animation_ease_in_out_has_smooth_midpoint() {
    let now = Instant::now();
    let mut animation = ScalarAnimation::new(0.0);

    animation.transition_to(1.0, DURATION, AnimationEasing::EaseInOut, now);
    animation.advance(now + Duration::from_millis(25));

    assert!((animation.value() - 0.15625).abs() <= f32::EPSILON);
}

#[test]
fn scalar_animation_zero_duration_snaps_and_cancel_preserves_value() {
    let now = Instant::now();
    let mut animation = ScalarAnimation::new(0.0);

    animation.transition_to(1.0, Duration::ZERO, AnimationEasing::EaseInOut, now);
    assert_eq!(animation.value(), 1.0);
    assert_eq!(animation.next_deadline(), None);

    animation.transition_to(0.0, DURATION, AnimationEasing::Linear, now);
    animation.cancel(now + Duration::from_millis(30));
    assert!((animation.value() - 0.7).abs() <= f32::EPSILON);
    assert_eq!(animation.next_deadline(), None);
}

#[test]
fn animation_registry_preserves_a_track_when_a_component_rebuilds() {
    let now = Instant::now();
    let mut registry = AnimationRegistry::default();

    assert_eq!(
        registry.transition_to(OPACITY, 0.0, 1.0, FRAGMENT_TRANSITION, now,),
        0.0
    );
    registry.advance(now + Duration::from_millis(40));
    let current = registry.value(OPACITY).unwrap();

    registry.transition_to(
        OPACITY,
        99.0,
        0.0,
        FRAGMENT_TRANSITION,
        now + Duration::from_millis(40),
    );

    assert_eq!(registry.value(OPACITY), Some(current));
    assert_eq!(registry.len(), 1);
}

#[test]
fn animation_report_aggregates_fragment_ids_and_schedules_one_frame() {
    let now = Instant::now();
    let mut registry = AnimationRegistry::default();
    registry.transition_to(OPACITY, 0.0, 1.0, FRAGMENT_TRANSITION, now);
    registry.transition_to(SECOND_OPACITY, 0.0, 1.0, FRAGMENT_TRANSITION, now);

    let report = registry.advance(now + FRAME);

    assert_eq!(report.changed_keys(), &[OPACITY, SECOND_OPACITY]);
    assert_eq!(report.invalidation(), Some(FrameInvalidation::Fragment));
    assert_eq!(
        report.fragment_ids(),
        Some([ELEMENT, SECOND_ELEMENT].as_slice())
    );
    assert_eq!(report.next_deadline(), now.checked_add(FRAME * 2));

    let mut scheduler = FrameScheduler::default();
    assert_eq!(
        report.schedule(&mut scheduler),
        Some(super::FrameSchedule::RequestFrame)
    );
    assert_eq!(scheduler.pending(), Some(FrameInvalidation::Fragment));
    assert_eq!(
        scheduler.take_fragment_ids(),
        Some(vec![ELEMENT, SECOND_ELEMENT])
    );
}

#[test]
fn animation_report_promotes_layout_work_and_element_removal_cleans_all_tracks() {
    let now = Instant::now();
    let mut registry = AnimationRegistry::default();
    registry.transition_to(OPACITY, 0.0, 1.0, FRAGMENT_TRANSITION, now);
    registry.transition_to(TRANSLATE_X, 0.0, 20.0, REBUILD_TRANSITION, now);

    let report = registry.advance(now + FRAME);

    assert_eq!(report.invalidation(), Some(FrameInvalidation::Rebuild));
    assert_eq!(report.fragment_ids(), None);

    assert_eq!(registry.remove_element(ELEMENT), 2);
    assert!(registry.is_empty());
    let empty_report = AnimationAdvanceReport::default();
    assert_eq!(empty_report.schedule(&mut FrameScheduler::default()), None);
}
