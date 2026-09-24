use super::ScheduledCommand;
use super::schedule_command as schedule;
use crate::app::requests::RequestOrigin;

fn origin() -> RequestOrigin {
    RequestOrigin {
        mode: crate::terminal::ScreenMode::Fullscreen,
        panel_generation: 0,
    }
}

fn scheduled(command: AppCommand) -> ScheduledCommand {
    ScheduledCommand {
        command,
        origin: origin(),
    }
}

fn schedule_command(
    command: Option<AppCommand>,
    requests: &RequestTasks,
    queued: &mut VecDeque<ScheduledCommand>,
) -> Option<AppCommand> {
    schedule(command.map(scheduled), requests, queued).map(|scheduled| scheduled.command)
}
use crate::app::App;
use crate::app::AppCommand;
use crate::app::completion::Completion;
use crate::app::requests::RequestKey;
use crate::app::requests::RequestTasks;
use crate::host::Command as HostCommand;
use crate::keymap_setup::Command as KeymapCommand;
use crate::theme::Command as ThemeCommand;
use crate::thread::Command as ThreadCommand;
use std::collections::VecDeque;

#[test]
fn unrelated_actions_bypass_a_busy_request_without_losing_same_domain_order() {
    let mut app = App::new();
    let mut requests = RequestTasks::default();
    let (release, wait) = std::sync::mpsc::sync_channel(0);
    requests.spawn(
        Some(RequestKey::Config),
        "ash-tui-test-write",
        move || {
            wait.recv().expect("the test releases the write request");
            Completion::Presentation(Err("finished".into()))
        },
        &mut app,
        origin(),
    );
    let mut queued = VecDeque::new();
    let write = ThemeCommand::Set {
        preference: "ash-code-dark".into(),
    }
    .into();

    assert!(schedule_command(Some(write), &requests, &mut queued).is_none());
    assert!(matches!(
        schedule_command(
            Some(KeymapCommand::OpenEditor.into()),
            &requests,
            &mut queued
        ),
        Some(AppCommand::Keymap(KeymapCommand::OpenEditor))
    ));
    assert!(matches!(
        schedule_command(
            Some(ThreadCommand::Interrupt.into()),
            &requests,
            &mut queued
        ),
        Some(AppCommand::Thread(ThreadCommand::Interrupt))
    ));
    assert_eq!(queued.len(), 1);
    release
        .send(())
        .expect("the write request remains alive until released");
    let completed = (0..10_000)
        .find_map(|_| {
            let completed = requests.poll();
            if completed.is_empty() {
                std::thread::yield_now();
                None
            } else {
                Some(completed)
            }
        })
        .expect("the released write request completes");
    assert_eq!(completed.len(), 1);
    assert!(matches!(
        schedule_command(None, &requests, &mut queued),
        Some(AppCommand::Theme(ThemeCommand::Set { .. }))
    ));
}

#[test]
fn interrupt_bypasses_an_active_interaction_response() {
    let mut app = App::new();
    let mut requests = RequestTasks::default();
    let (release, wait) = std::sync::mpsc::sync_channel(0);
    requests.spawn(
        Some(RequestKey::Interaction),
        "ash-tui-test-interaction",
        move || {
            wait.recv()
                .expect("the test releases the interaction request");
            Completion::Presentation(Err("finished".into()))
        },
        &mut app,
        origin(),
    );
    let mut queued = VecDeque::new();

    assert!(matches!(
        schedule_command(
            Some(ThreadCommand::Interrupt.into()),
            &requests,
            &mut queued
        ),
        Some(AppCommand::Thread(ThreadCommand::Interrupt))
    ));
    release
        .send(())
        .expect("the interaction request remains alive until released");
    let completed = (0..10_000)
        .find_map(|_| {
            let completed = requests.poll();
            if completed.is_empty() {
                std::thread::yield_now();
                None
            } else {
                Some(completed)
            }
        })
        .expect("the released interaction request completes");
    assert_eq!(completed.len(), 1);
}

#[test]
fn quit_bypasses_a_pending_request() {
    let mut app = App::new();
    let mut requests = RequestTasks::default();
    requests.spawn(
        Some(RequestKey::Config),
        "ash-tui-test-write",
        || Completion::Presentation(Err("finished".into())),
        &mut app,
        origin(),
    );
    let mut queued = VecDeque::new();

    assert!(matches!(
        schedule_command(Some(AppCommand::Quit), &requests, &mut queued),
        Some(AppCommand::Quit)
    ));
    assert!(queued.is_empty());
}

#[test]
fn repeated_clipboard_availability_refreshes_are_coalesced() {
    let requests = RequestTasks::default();
    let mut queued = VecDeque::from([scheduled(AppCommand::from(
        HostCommand::RefreshClipboardImageAvailability,
    ))]);

    let action = schedule_command(
        Some(HostCommand::RefreshClipboardImageAvailability.into()),
        &requests,
        &mut queued,
    );

    assert_eq!(
        action,
        Some(AppCommand::Host(
            HostCommand::RefreshClipboardImageAvailability
        ))
    );
    assert!(queued.is_empty());
}

#[test]
fn repeated_older_history_requests_are_coalesced() {
    let requests = RequestTasks::default();
    let mut queued = VecDeque::from([scheduled(AppCommand::from(ThreadCommand::LoadOlderHistory))]);

    let action = schedule_command(
        Some(ThreadCommand::LoadOlderHistory.into()),
        &requests,
        &mut queued,
    );

    assert_eq!(
        action,
        Some(AppCommand::Thread(ThreadCommand::LoadOlderHistory))
    );
    assert!(queued.is_empty());
}

#[test]
fn queued_work_and_completion_keep_the_origin_recorded_before_a_mode_switch() {
    let mut app = App::new();
    let expected = RequestOrigin::current(&app);
    let mut queued = VecDeque::from([ScheduledCommand::new(
        ThreadCommand::LoadOlderHistory.into(),
        &app,
    )]);
    let mut settings = crate::config::TerminalSettings::default();
    settings.set_screen_mode(crate::terminal::ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings));
    let mut requests = RequestTasks::default();
    let scheduled = schedule(None, &requests, &mut queued).unwrap();
    assert_eq!(scheduled.origin, expected);
    assert_ne!(scheduled.origin.mode, app.screen_mode());
    let (release, wait) = std::sync::mpsc::channel();
    requests.spawn(
        Some(RequestKey::Thread),
        "ash-tui-origin-test",
        move || {
            wait.recv().unwrap();
            Completion::Presentation(Ok(
                crate::thread::Event::ProductNotice("finished".into()).into()
            ))
        },
        &mut app,
        scheduled.origin,
    );
    release.send(()).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let completion = loop {
        if let Some(completion) = requests.poll().pop() {
            break completion.unwrap();
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    };
    assert_eq!(completion.origin, expected);
}
