use super::ApplicationActivation;
use super::ApplicationExitDecision;
use super::ApplicationExitReason;
use super::ApplicationPhase;
use super::ExitPolicy;
use super::LifecycleCore;
use super::WindowCommand;
use crate::app::ApplicationReadiness;
use crate::window::WindowId;

fn core(exit_policy: ExitPolicy) -> LifecycleCore {
    LifecycleCore::new(exit_policy, ApplicationReadiness::default())
}

#[test]
fn activation_retains_the_platform_visible_window_observation() {
    assert!(ApplicationActivation::new(true).has_visible_windows());
    assert!(!ApplicationActivation::new(false).has_visible_windows());
}

#[test]
fn exit_policy_defaults_to_closing_with_the_last_window() {
    assert_eq!(ExitPolicy::default(), ExitPolicy::OnLastWindowClosed);
}

#[test]
fn first_resume_is_distinct_from_later_platform_resumes() {
    let mut lifecycle = core(ExitPolicy::Explicit);

    assert_eq!(lifecycle.phase(), ApplicationPhase::Initializing);
    assert!(lifecycle.resumed());
    assert_eq!(lifecycle.phase(), ApplicationPhase::Active);
    lifecycle.suspended();
    assert_eq!(lifecycle.phase(), ApplicationPhase::Suspended);
    assert!(!lifecycle.resumed());
    assert_eq!(lifecycle.phase(), ApplicationPhase::Active);
}

#[test]
fn window_commands_distinguish_cancelable_requests_from_destruction() {
    let mut lifecycle = core(ExitPolicy::Explicit);
    let window = WindowId::from_raw(11);
    lifecycle.record_window_opened(window);

    assert!(lifecycle.request_window_close(window));
    assert!(!lifecycle.request_window_close(window));
    assert_eq!(
        lifecycle.next_command(),
        Some(WindowCommand::Opened(window))
    );
    assert_eq!(
        lifecycle.next_command(),
        Some(WindowCommand::RequestClose(window))
    );
    assert!(lifecycle.destroy_window(window));
    assert!(!lifecycle.destroy_window(window));
    assert!(lifecycle.request_exit(ApplicationExitReason::Requested));
    assert!(!lifecycle.request_exit(ApplicationExitReason::FatalError));

    assert_eq!(
        lifecycle.next_command(),
        Some(WindowCommand::Destroy(window))
    );
    assert_eq!(
        lifecycle.next_command(),
        Some(WindowCommand::Exit(ApplicationExitReason::FatalError))
    );
    assert_eq!(lifecycle.next_command(), None);
}

#[test]
fn last_window_policy_uses_the_shared_live_window_registry() {
    let mut lifecycle = core(ExitPolicy::OnLastWindowClosed);
    let first = WindowId::from_raw(1);
    let second = WindowId::from_raw(2);
    lifecycle.record_window_opened(first);
    lifecycle.record_window_opened(second);

    assert!(lifecycle.record_window_closed(first));
    assert!(!lifecycle.should_exit_after_last_window());
    assert!(lifecycle.record_window_closed(second));
    assert!(lifecycle.should_exit_after_last_window());

    lifecycle.begin_exit(ApplicationExitReason::LastWindowClosed);
    assert_eq!(lifecycle.phase(), ApplicationPhase::Exiting);
    assert_eq!(
        lifecycle.exit_reason(),
        Some(ApplicationExitReason::LastWindowClosed)
    );
}

#[test]
fn cancelled_normal_exit_can_be_requested_again() {
    let mut lifecycle = core(ExitPolicy::Explicit);
    lifecycle.resumed();

    assert!(lifecycle.request_exit(ApplicationExitReason::Requested));
    assert_eq!(
        lifecycle.next_command(),
        Some(WindowCommand::Exit(ApplicationExitReason::Requested))
    );
    assert!(!lifecycle.resolve_exit(
        ApplicationExitReason::Requested,
        ApplicationExitDecision::Cancel,
    ));
    assert_eq!(lifecycle.phase(), ApplicationPhase::Active);
    assert_eq!(lifecycle.exit_reason(), None);
    assert!(lifecycle.request_exit(ApplicationExitReason::Requested));
}

#[test]
fn fatal_exit_ignores_a_cancel_decision() {
    let mut lifecycle = core(ExitPolicy::Explicit);

    assert!(lifecycle.resolve_exit(
        ApplicationExitReason::FatalError,
        ApplicationExitDecision::Cancel,
    ));
    assert_eq!(lifecycle.phase(), ApplicationPhase::Exiting);
    assert_eq!(
        lifecycle.exit_reason(),
        Some(ApplicationExitReason::FatalError)
    );
}

#[test]
fn accepted_window_destroy_can_be_consumed_by_an_application_exit() {
    let mut lifecycle = core(ExitPolicy::Explicit);
    let window = WindowId::from_raw(7);
    lifecycle.record_window_opened(window);
    assert_eq!(
        lifecycle.next_command(),
        Some(WindowCommand::Opened(window))
    );

    assert!(lifecycle.destroy_window(window));
    assert!(lifecycle.take_window_destroy(window));
    assert!(!lifecycle.take_window_destroy(window));
    assert_eq!(lifecycle.next_command(), None);
}

#[test]
fn fatal_exit_supersedes_an_exit_already_inside_its_callback() {
    let mut lifecycle = core(ExitPolicy::Explicit);
    lifecycle.resumed();
    assert!(lifecycle.request_exit(ApplicationExitReason::Requested));
    assert_eq!(
        lifecycle.next_command(),
        Some(WindowCommand::Exit(ApplicationExitReason::Requested))
    );

    assert!(!lifecycle.request_exit(ApplicationExitReason::FatalError));
    assert_eq!(
        lifecycle.pending_exit(),
        Some(ApplicationExitReason::FatalError)
    );
    assert!(!lifecycle.resolve_exit(
        ApplicationExitReason::Requested,
        ApplicationExitDecision::Exit,
    ));
    assert_eq!(
        lifecycle.next_command(),
        Some(WindowCommand::Exit(ApplicationExitReason::FatalError))
    );
    assert!(lifecycle.resolve_exit(
        ApplicationExitReason::FatalError,
        ApplicationExitDecision::Exit,
    ));
    assert_eq!(
        lifecycle.exit_reason(),
        Some(ApplicationExitReason::FatalError)
    );
}

#[test]
fn forced_exit_supersedes_an_active_normal_exit_and_preserves_its_code() {
    let mut lifecycle = core(ExitPolicy::Explicit);
    lifecycle.resumed();
    assert!(lifecycle.request_exit(ApplicationExitReason::Requested));
    assert_eq!(
        lifecycle.next_command(),
        Some(WindowCommand::Exit(ApplicationExitReason::Requested))
    );

    assert!(!lifecycle.request_exit(ApplicationExitReason::Forced(17)));
    assert_eq!(
        lifecycle.pending_exit(),
        Some(ApplicationExitReason::Forced(17))
    );
    assert!(!lifecycle.resolve_exit(
        ApplicationExitReason::Requested,
        ApplicationExitDecision::Exit,
    ));
    assert_eq!(
        lifecycle.next_command(),
        Some(WindowCommand::Exit(ApplicationExitReason::Forced(17)))
    );
    assert!(lifecycle.resolve_exit(
        ApplicationExitReason::Forced(17),
        ApplicationExitDecision::Cancel,
    ));
    assert_eq!(
        lifecycle.exit_reason(),
        Some(ApplicationExitReason::Forced(17))
    );
    assert_eq!(
        lifecycle
            .exit_reason()
            .and_then(|reason| reason.forced_exit_code()),
        Some(17)
    );
}

#[test]
fn fatal_exit_has_priority_over_a_queued_forced_exit() {
    let mut lifecycle = core(ExitPolicy::Explicit);
    assert!(lifecycle.request_exit(ApplicationExitReason::Forced(9)));
    assert!(!lifecycle.request_exit(ApplicationExitReason::FatalError));

    assert_eq!(
        lifecycle.next_command(),
        Some(WindowCommand::Exit(ApplicationExitReason::FatalError))
    );
}
