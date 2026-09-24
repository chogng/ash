use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use futures::executor::block_on;

use super::TestEvent;
use super::TestRuntime;
use super::TestTimerScope;
use super::TestWindowCloseDecision;
use crate::app::ApplicationActivation;
use crate::app::ApplicationExitDecision;
use crate::app::ApplicationExitReason;
use crate::app::ApplicationPhase;
use crate::app::ApplicationReadyError;
use crate::app::ProtocolUrl;
use crate::app::SecondInstance;
use crate::runtime::AccessibilityRole;
use crate::runtime::FocusBehavior;
use crate::runtime::InteractionFrame;
use crate::runtime::UiDispatch;
use crate::runtime::UiNode;
use crate::ui::foundation::Color;
use crate::ui::foundation::ElementId;
use crate::ui::foundation::Rect;
use crate::ui::presentation::UiFrame;
use crate::window::LogicalSize;

#[test]
fn lifecycle_and_timer_events_follow_deterministic_fifo_order() {
    let mut runtime = TestRuntime::at(Instant::now());
    runtime.resume();
    let first = runtime.open_window("First", LogicalSize::new(640.0, 480.0));
    let second = runtime.open_window("Second", LogicalSize::new(320.0, 240.0));
    assert!(runtime.request_redraw(first));
    runtime.schedule_after(
        TestTimerScope::Window(second),
        Duration::from_millis(5),
        "cancelled",
    );
    runtime.schedule_after(
        TestTimerScope::Application,
        Duration::from_millis(10),
        "delivered",
    );
    assert!(runtime.close_window(second));
    runtime.advance(Duration::from_millis(10));
    assert!(runtime.close_window(first));

    assert_eq!(runtime.next_event(), Some(TestEvent::Ready));
    assert_eq!(runtime.next_event(), Some(TestEvent::Resumed));
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowOpened(first)));
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowOpened(second)));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::RedrawRequested(first))
    );
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowClosed(second)));
    assert_eq!(runtime.next_event(), Some(TestEvent::User("delivered")));
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowClosed(first)));
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowAllClosed));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::ExitRequested(
            ApplicationExitReason::LastWindowClosed
        ))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WillExitRequested(
            ApplicationExitReason::LastWindowClosed
        ))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::Exiting(ApplicationExitReason::LastWindowClosed))
    );
    assert_eq!(runtime.next_event(), None);
    assert_eq!(runtime.phase(), ApplicationPhase::Exiting);
    assert_eq!(
        runtime.exit_reason(),
        Some(ApplicationExitReason::LastWindowClosed)
    );
}

#[test]
fn repeated_resume_only_emits_ready_once() {
    let mut runtime = TestRuntime::<()>::at(Instant::now());

    runtime.resume();
    runtime.resume();

    assert_eq!(runtime.next_event(), Some(TestEvent::Ready));
    assert_eq!(runtime.next_event(), Some(TestEvent::Resumed));
    assert_eq!(runtime.next_event(), Some(TestEvent::Resumed));
    assert_eq!(runtime.next_event(), None);
}

#[test]
fn readiness_future_commits_on_first_resume_and_remains_ready() {
    let mut runtime = TestRuntime::<()>::at(Instant::now());
    let ready = runtime.when_ready();
    assert!(!runtime.is_ready());

    runtime.resume();

    assert!(runtime.is_ready());
    assert_eq!(block_on(ready), Ok(()));
    runtime.suspend();
    runtime.resume();
    assert!(runtime.is_ready());
}

#[test]
fn exit_before_resume_completes_readiness_with_an_error() {
    let mut runtime = TestRuntime::<()>::at(Instant::now());
    let ready = runtime.when_ready();

    assert!(runtime.force_exit(0));

    assert!(!runtime.is_ready());
    assert_eq!(block_on(ready), Err(ApplicationReadyError));
}

#[test]
fn activation_file_and_url_events_follow_fifo_order() {
    let mut runtime = TestRuntime::<()>::at(Instant::now());
    let activation = ApplicationActivation::new(false);
    let path = PathBuf::from("/tmp/zui-open-file.txt");
    let url = ProtocolUrl::parse("zui://open/settings").unwrap();
    let second_instance = SecondInstance::new(
        ["zui", "zui://open/secondary"],
        PathBuf::from("/tmp/secondary"),
    )
    .with_additional_data([4, 2]);

    runtime.activate(activation);
    runtime.send_open_file(path.clone());
    runtime.send_second_instance(second_instance.clone());
    runtime.send_open_url(url.clone());

    assert_eq!(runtime.next_event(), Some(TestEvent::Activated(activation)));
    assert_eq!(runtime.next_event(), Some(TestEvent::OpenFile(path)));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::SecondInstance(second_instance))
    );
    assert_eq!(runtime.next_event(), Some(TestEvent::OpenUrl(url)));
    assert_eq!(runtime.next_event(), None);
}

#[test]
fn explicit_exit_policy_keeps_a_windowless_runtime_active_until_requested() {
    let mut runtime =
        TestRuntime::<()>::at(Instant::now()).with_exit_policy(crate::app::ExitPolicy::Explicit);
    runtime.resume();
    let window = runtime.open_window("utility", LogicalSize::new(320.0, 240.0));
    assert!(runtime.close_window(window));

    assert_eq!(runtime.phase(), ApplicationPhase::Active);
    assert_eq!(runtime.exit_reason(), None);
    assert!(runtime.exit());
    assert_eq!(
        runtime.exit_reason(),
        Some(ApplicationExitReason::Requested)
    );
}

#[test]
fn programmatic_window_close_remains_cancelable_until_accepted() {
    let mut runtime =
        TestRuntime::<()>::at(Instant::now()).with_exit_policy(crate::app::ExitPolicy::Explicit);
    let window = runtime.open_window("Cancelable", LogicalSize::new(320.0, 240.0));
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowOpened(window)));

    assert!(runtime.request_window_close(window));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WindowCloseRequested(window))
    );
    assert!(runtime.window(window).is_some());

    assert!(runtime.close_window(window));
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowClosed(window)));
    assert!(runtime.window(window).is_none());
}

#[test]
fn cancelled_exit_keeps_runtime_work_and_allows_a_later_request() {
    let mut runtime =
        TestRuntime::at(Instant::now()).with_exit_policy(crate::app::ExitPolicy::Explicit);
    runtime.resume();
    runtime.schedule_after(
        TestTimerScope::Application,
        Duration::from_millis(10),
        "still-running",
    );
    runtime.decide_next_exit(ApplicationExitDecision::Cancel);

    assert!(runtime.exit());
    assert_eq!(runtime.phase(), ApplicationPhase::Active);
    assert_eq!(runtime.exit_reason(), None);
    runtime.advance(Duration::from_millis(10));
    assert!(runtime.exit());

    assert_eq!(runtime.next_event(), Some(TestEvent::Ready));
    assert_eq!(runtime.next_event(), Some(TestEvent::Resumed));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::ExitRequested(ApplicationExitReason::Requested))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::ExitCancelled(ApplicationExitReason::Requested))
    );
    assert_eq!(runtime.next_event(), Some(TestEvent::User("still-running")));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::ExitRequested(ApplicationExitReason::Requested))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WillExitRequested(
            ApplicationExitReason::Requested
        ))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::Exiting(ApplicationExitReason::Requested))
    );
    assert_eq!(runtime.next_event(), None);
}

#[test]
fn application_exit_closes_every_window_child_first_without_window_all_closed() {
    let mut runtime =
        TestRuntime::<()>::at(Instant::now()).with_exit_policy(crate::app::ExitPolicy::Explicit);
    let root = runtime.open_window("Root", LogicalSize::new(800.0, 600.0));
    let child = runtime
        .open_child_window(root, "Child", LogicalSize::new(500.0, 400.0))
        .unwrap();
    let second_root = runtime.open_window("Second", LogicalSize::new(320.0, 240.0));

    assert!(runtime.exit());

    assert_eq!(runtime.next_event(), Some(TestEvent::WindowOpened(root)));
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowOpened(child)));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WindowOpened(second_root))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::ExitRequested(ApplicationExitReason::Requested))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WindowCloseRequested(child))
    );
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowClosed(child)));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WindowCloseRequested(root))
    );
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowClosed(root)));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WindowCloseRequested(second_root))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WindowClosed(second_root))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WillExitRequested(
            ApplicationExitReason::Requested
        ))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::Exiting(ApplicationExitReason::Requested))
    );
    assert_eq!(runtime.next_event(), None);
    assert!(runtime.window(root).is_none());
    assert!(runtime.window(child).is_none());
    assert!(runtime.window(second_root).is_none());
}

#[test]
fn window_close_can_cancel_app_exit_after_earlier_children_close() {
    let mut runtime =
        TestRuntime::<()>::at(Instant::now()).with_exit_policy(crate::app::ExitPolicy::Explicit);
    runtime.resume();
    let root = runtime.open_window("Root", LogicalSize::new(800.0, 600.0));
    let child = runtime
        .open_child_window(root, "Child", LogicalSize::new(500.0, 400.0))
        .unwrap();
    assert!(runtime.decide_next_window_close(root, TestWindowCloseDecision::Cancel));
    assert!(!runtime.decide_next_window_close(
        crate::window::WindowId::from_raw(999),
        TestWindowCloseDecision::Cancel,
    ));

    assert!(runtime.exit());

    assert_eq!(runtime.next_event(), Some(TestEvent::Ready));
    assert_eq!(runtime.next_event(), Some(TestEvent::Resumed));
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowOpened(root)));
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowOpened(child)));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::ExitRequested(ApplicationExitReason::Requested))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WindowCloseRequested(child))
    );
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowClosed(child)));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WindowCloseRequested(root))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::ExitCancelled(ApplicationExitReason::Requested))
    );
    assert_eq!(runtime.next_event(), None);
    assert_eq!(runtime.phase(), ApplicationPhase::Active);
    assert!(runtime.window(root).is_some());
    assert!(runtime.window(child).is_none());

    assert!(runtime.exit());
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::ExitRequested(ApplicationExitReason::Requested))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WindowCloseRequested(root))
    );
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowClosed(root)));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WillExitRequested(
            ApplicationExitReason::Requested
        ))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::Exiting(ApplicationExitReason::Requested))
    );
    assert_eq!(runtime.next_event(), None);
}

#[test]
fn will_exit_can_cancel_after_windows_close_without_cancelling_app_timers() {
    let mut runtime =
        TestRuntime::at(Instant::now()).with_exit_policy(crate::app::ExitPolicy::Explicit);
    runtime.resume();
    let window = runtime.open_window("Unsaved", LogicalSize::new(640.0, 480.0));
    runtime.schedule_after(
        TestTimerScope::Application,
        Duration::from_millis(5),
        "still-running",
    );
    runtime.decide_next_will_exit(ApplicationExitDecision::Cancel);

    assert!(runtime.exit());
    assert_eq!(runtime.phase(), ApplicationPhase::Active);
    assert_eq!(runtime.exit_reason(), None);
    assert!(runtime.window(window).is_none());
    runtime.advance(Duration::from_millis(5));

    assert_eq!(runtime.next_event(), Some(TestEvent::Ready));
    assert_eq!(runtime.next_event(), Some(TestEvent::Resumed));
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowOpened(window)));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::ExitRequested(ApplicationExitReason::Requested))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WindowCloseRequested(window))
    );
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowClosed(window)));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WillExitRequested(
            ApplicationExitReason::Requested
        ))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::ExitCancelled(ApplicationExitReason::Requested))
    );
    assert_eq!(runtime.next_event(), Some(TestEvent::User("still-running")));
    assert_eq!(runtime.next_event(), None);

    assert!(runtime.exit());
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::ExitRequested(ApplicationExitReason::Requested))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WillExitRequested(
            ApplicationExitReason::Requested
        ))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::Exiting(ApplicationExitReason::Requested))
    );
    assert_eq!(runtime.next_event(), None);
}

#[test]
fn forced_exit_skips_every_cancelable_callback_and_preserves_its_code() {
    let mut runtime = TestRuntime::at(Instant::now());
    let window = runtime.open_window("Force", LogicalSize::new(640.0, 480.0));
    runtime.schedule_after(
        TestTimerScope::Application,
        Duration::from_millis(5),
        "cancelled",
    );
    runtime.decide_next_exit(ApplicationExitDecision::Cancel);
    runtime.decide_next_will_exit(ApplicationExitDecision::Cancel);
    assert!(runtime.decide_next_window_close(window, TestWindowCloseDecision::Cancel));

    assert!(runtime.force_exit(23));
    runtime.advance(Duration::from_millis(5));

    assert_eq!(runtime.next_event(), Some(TestEvent::WindowOpened(window)));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::Exiting(ApplicationExitReason::Forced(23)))
    );
    assert_eq!(runtime.next_event(), None);
    assert_eq!(runtime.phase(), ApplicationPhase::Exiting);
    assert_eq!(
        runtime.exit_reason(),
        Some(ApplicationExitReason::Forced(23))
    );
    assert_eq!(
        runtime
            .exit_reason()
            .and_then(|reason| reason.forced_exit_code()),
        Some(23)
    );
    assert!(runtime.window(window).is_some());
}

#[test]
fn headless_windows_record_presented_scene_snapshots() {
    let mut runtime = TestRuntime::<()>::at(Instant::now());
    let window = runtime.open_window("Preview", LogicalSize::new(800.0, 600.0));
    let target = ElementId::scoped(1, 1);
    let mut frame = UiFrame::<InteractionFrame>::new(Color::rgb(10, 20, 30));
    frame.interaction_mut().register(
        UiNode::new(
            target,
            Rect::from_xywh(10.0, 20.0, 80.0, 30.0),
            AccessibilityRole::Button,
            "Run",
        )
        .with_focus(FocusBehavior::TabStop),
    );
    let mut dispatch = UiDispatch::default();
    dispatch.focus_element(frame.interaction(), target);

    runtime.present_frame(window, &frame, &dispatch).unwrap();

    let window = runtime.window(window).unwrap();
    assert_eq!(window.title(), "Preview");
    assert_eq!(window.logical_size(), LogicalSize::new(800.0, 600.0));
    assert_eq!(window.renderer().state().scenes(), &[frame.scene().clone()]);
    assert_eq!(window.accessibility().len(), 1);
    assert_eq!(window.accessibility()[0].id, target);
    assert!(window.accessibility()[0].focused);
}

#[test]
fn closing_a_parent_closes_descendants_before_the_parent() {
    let mut runtime = TestRuntime::<()>::at(Instant::now());
    let root = runtime.open_window("Root", LogicalSize::new(800.0, 600.0));
    let child = runtime
        .open_child_window(root, "Child", LogicalSize::new(500.0, 400.0))
        .unwrap();
    let grandchild = runtime
        .open_child_window(child, "Grandchild", LogicalSize::new(300.0, 200.0))
        .unwrap();

    assert_eq!(
        runtime.parent_window(child).map(|window| window.id()),
        Some(root)
    );
    assert_eq!(
        runtime
            .child_windows(child)
            .into_iter()
            .map(|window| window.id())
            .collect::<Vec<_>>(),
        vec![grandchild]
    );
    assert!(runtime.close_window(root));

    assert_eq!(runtime.next_event(), Some(TestEvent::WindowOpened(root)));
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowOpened(child)));
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WindowOpened(grandchild))
    );
    assert_eq!(
        runtime.next_event(),
        Some(TestEvent::WindowClosed(grandchild))
    );
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowClosed(child)));
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowClosed(root)));
    assert_eq!(runtime.next_event(), Some(TestEvent::WindowAllClosed));
}

#[test]
fn modal_parent_input_is_restored_after_the_last_modal_child_closes() {
    let mut runtime = TestRuntime::<()>::at(Instant::now());
    let parent = runtime.open_window("Parent", LogicalSize::new(800.0, 600.0));
    let first = runtime
        .open_modal_window(parent, "First", LogicalSize::new(400.0, 300.0))
        .unwrap();
    let second = runtime
        .open_modal_window(parent, "Second", LogicalSize::new(400.0, 300.0))
        .unwrap();

    assert!(!runtime.window(parent).unwrap().input_enabled());
    assert!(runtime.window(first).unwrap().is_modal());
    assert!(runtime.close_window(first));
    assert!(!runtime.window(parent).unwrap().input_enabled());
    assert!(runtime.close_window(second));
    assert!(runtime.window(parent).unwrap().input_enabled());
    assert!(
        runtime
            .open_modal_window(
                crate::window::WindowId::from_raw(999),
                "Missing",
                LogicalSize::new(100.0, 100.0),
            )
            .is_none()
    );
}
