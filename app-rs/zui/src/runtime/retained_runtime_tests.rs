use std::time::Duration;
use std::time::Instant;

use crate::AnimationEasing;
use crate::AnimationKey;
use crate::AnimationProperty;
use crate::ElementId;
use crate::FrameInvalidation;
use crate::RetainedFragmentMount;
use crate::RetainedRuntime;
use crate::ScalarAnimationSpec;

const FRAGMENT: ElementId = ElementId::scoped(73, 1);
const OPACITY: AnimationKey = AnimationKey::new(FRAGMENT, AnimationProperty::Opacity);

#[test]
fn expired_fragment_cleanup_removes_all_owned_animation_tracks() {
    let now = Instant::now();
    let mut runtime = RetainedRuntime::default();
    runtime.mount(FRAGMENT);
    runtime.animation_registry_mut().transition_to(
        OPACITY,
        0.0,
        1.0,
        ScalarAnimationSpec::new(
            Duration::from_millis(100),
            AnimationEasing::Linear,
            FrameInvalidation::Fragment,
        ),
        now,
    );
    runtime.begin_exit(FRAGMENT, now).unwrap();

    let report = runtime.advance(now);

    assert_eq!(report.fragment().removed_ids(), &[FRAGMENT]);
    assert_eq!(report.removed_animation_tracks(), 1);
    assert!(report.animation().changed_keys().is_empty());
    assert!(runtime.animation_registry().is_empty());
    assert_eq!(runtime.next_deadline(), None);
}

#[test]
fn reentering_a_fragment_preserves_its_animation_continuity() {
    let now = Instant::now();
    let remove_at = now + Duration::from_millis(100);
    let mut runtime = RetainedRuntime::default();
    assert_eq!(runtime.mount(FRAGMENT), RetainedFragmentMount::Inserted);
    runtime.animation_registry_mut().transition_to(
        OPACITY,
        0.0,
        1.0,
        ScalarAnimationSpec::new(
            Duration::from_millis(200),
            AnimationEasing::Linear,
            FrameInvalidation::Fragment,
        ),
        now,
    );
    runtime.begin_exit(FRAGMENT, remove_at).unwrap();
    assert_eq!(runtime.mount(FRAGMENT), RetainedFragmentMount::Resumed);

    let report = runtime.advance(remove_at);

    assert!(report.fragment().removed_ids().is_empty());
    assert_eq!(report.removed_animation_tracks(), 0);
    assert_eq!(runtime.animation_registry().len(), 1);
}

#[test]
fn immediate_unmount_reports_and_cleans_owned_tracks() {
    let now = Instant::now();
    let mut runtime = RetainedRuntime::default();
    runtime.mount(FRAGMENT);
    runtime.animation_registry_mut().transition_to(
        OPACITY,
        0.0,
        1.0,
        ScalarAnimationSpec::new(
            Duration::from_millis(100),
            AnimationEasing::Linear,
            FrameInvalidation::Fragment,
        ),
        now,
    );

    assert_eq!(runtime.unmount(FRAGMENT), Ok(1));
    assert!(runtime.animation_registry().is_empty());
}
