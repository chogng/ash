use super::App;
use super::driver::CommandEffect;
use super::event_pump::EventPump;
use super::event_pump::RuntimeEvent;
use super::frame;
use super::fullscreen::pointer::MouseAction;
use super::fullscreen::pointer::finish_pointer_gesture;
use super::fullscreen::pointer::handle_mouse;
use super::inline;
use super::redraw::RedrawPriority;
use super::redraw::RedrawScheduler;
use super::start::StartedSession;
use crate::TuiError;
use crate::TuiExit;
use crate::TuiOptions;
use crate::client;
use crate::host::Command as HostCommand;
use crate::host::Event as HostEvent;
use crate::terminal;
use crate::thread::transcript::batch::TranscriptBatch;
use ash_app_server_client::AppServerSession;
use ash_memory_diagnostics::ProcessResourceDemand;
use crossterm::event::Event;
use crossterm::event::KeyEventKind;
use std::time::Duration;
use std::time::Instant;

pub(crate) fn run(mut session: AppServerSession, options: TuiOptions) -> Result<TuiExit, TuiError> {
    let result = run_session(&mut session, options);
    let shutdown = session.shutdown();
    match (result, shutdown) {
        (Err(error), _) => Err(error),
        (Ok(exit @ TuiExit::ConnectionLost { .. }), _) => Ok(exit),
        (Ok(_), Err(error)) => Err(error.into()),
        (Ok(exit), Ok(())) => Ok(exit),
    }
}

fn run_session(session: &mut AppServerSession, options: TuiOptions) -> Result<TuiExit, TuiError> {
    let StartedSession {
        mut driver,
        mut pump,
        mut terminal,
    } = super::start::start(session, options)?;
    let mut redraw = RedrawScheduler::default();
    let mut output = inline::Output::default();
    let mut process_resource_demand = ProcessResourceDemand::Disabled;
    let mut pending_runtime_event = None;
    if let Err(error) = draw_terminal(&mut terminal, driver.app_mut(), &mut output) {
        let _ = pump.shutdown();
        return Err(error.into());
    }
    let result = (|| {
        loop {
            advance_stream(driver.app_mut(), &mut redraw, Instant::now());
            if redraw.take_due(Instant::now()) {
                draw_terminal(&mut terminal, driver.app_mut(), &mut output)?;
            }
            sync_process_resource_demand(
                &mut pump,
                driver.app_mut(),
                terminal.area()?,
                &mut process_resource_demand,
            );
            let had_active_turn = driver.app().active_turn().is_some();
            let mut runtime_event = match pending_runtime_event.take() {
                Some(event) => event,
                None => match next_wait(driver.app(), &redraw, Instant::now()) {
                    Some(timeout) => match pump.recv_timeout(timeout)? {
                        Some(event) => event,
                        None => continue,
                    },
                    None => pump.recv()?,
                },
            };
            match &runtime_event {
                RuntimeEvent::Client(_) => {
                    redraw.request(Instant::now(), RedrawPriority::Batched);
                }
                RuntimeEvent::Terminal(terminal::TerminalEvent::Input(_)) => {
                    redraw.request(Instant::now(), RedrawPriority::Immediate);
                }
                RuntimeEvent::Terminal(terminal::TerminalEvent::Tick)
                | RuntimeEvent::Terminal(terminal::TerminalEvent::Failed(_))
                | RuntimeEvent::ProcessResources(_)
                | RuntimeEvent::HostNotice(_)
                | RuntimeEvent::TerminationRequested => {}
            }
            runtime_event = match runtime_event {
                RuntimeEvent::Client(client::ClientEvent::ThreadTranscriptUpdated(update)) => {
                    match TranscriptBatch::start(*update) {
                        Ok(mut batch) => {
                            while let Some(timeout) =
                                next_wait(driver.app(), &redraw, Instant::now())
                            {
                                if timeout.is_zero() {
                                    break;
                                }
                                let Some(next) = pump.recv_timeout(timeout)? else {
                                    break;
                                };
                                match next {
                                    RuntimeEvent::Client(
                                        client::ClientEvent::ThreadTranscriptUpdated(update),
                                    ) => match batch.push(*update) {
                                        Ok(()) => {}
                                        Err(update) => {
                                            pending_runtime_event = Some(RuntimeEvent::Client(
                                                client::ClientEvent::ThreadTranscriptUpdated(
                                                    Box::new(update),
                                                ),
                                            ));
                                            break;
                                        }
                                    },
                                    event => {
                                        pending_runtime_event = Some(event);
                                        break;
                                    }
                                }
                            }
                            RuntimeEvent::Client(client::ClientEvent::ThreadTranscriptUpdated(
                                Box::new(batch.finish()),
                            ))
                        }
                        Err(update) => RuntimeEvent::Client(
                            client::ClientEvent::ThreadTranscriptUpdated(Box::new(update)),
                        ),
                    }
                }
                event => event,
            };
            let action = match runtime_event {
                RuntimeEvent::Client(event) => {
                    let event = match super::recovery::continue_or_exit(event, || {
                        (driver.recovery_state(), driver.recovery_drafts())
                    }) {
                        Ok(event) => event,
                        Err(exit) => return Ok(exit),
                    };
                    driver.handle_client_event(event);
                    None
                }
                RuntimeEvent::TerminationRequested => {
                    return Ok(TuiExit::TerminationRequested);
                }
                RuntimeEvent::ProcessResources(reading) => {
                    driver
                        .app_mut()
                        .update(HostEvent::ProcessResourcesSampled(reading));
                    if !matches!(process_resource_demand, ProcessResourceDemand::Disabled) {
                        redraw.request(Instant::now(), RedrawPriority::Batched);
                    }
                    None
                }
                RuntimeEvent::HostNotice(notice) => {
                    driver
                        .app_mut()
                        .update(HostEvent::TopTipNoticeShown(notice));
                    redraw.request(Instant::now(), RedrawPriority::Immediate);
                    None
                }
                RuntimeEvent::Terminal(terminal::TerminalEvent::Failed(error)) => {
                    return Err(error.into());
                }
                RuntimeEvent::Terminal(terminal::TerminalEvent::Tick) => {
                    let now = Instant::now();
                    if driver.app_mut().handle_tick(now) {
                        redraw.request(now, RedrawPriority::Batched);
                    }
                    driver.app_mut().poll_issue_refresh(now)
                }
                RuntimeEvent::Terminal(terminal::TerminalEvent::Input(event)) => match event {
                    Event::FocusGained => {
                        Some(HostCommand::RefreshClipboardImageAvailability.into())
                    }
                    Event::Key(key) if key.kind != KeyEventKind::Release => {
                        driver.app_mut().handle_key_in_area(key, terminal.area()?)
                    }
                    Event::Mouse(mouse) => {
                        match handle_mouse(driver.app_mut(), terminal.area()?, mouse) {
                            MouseAction::Selection(outcome) => {
                                finish_pointer_gesture(driver.app_mut(), &terminal, outcome)?
                            }
                            MouseAction::Command(command) => command,
                        }
                    }
                    Event::Paste(text) => {
                        driver.app_mut().handle_paste(text);
                        None
                    }
                    Event::Resize(_, _) => {
                        driver.app_mut().fullscreen.clear();
                        None
                    }
                    _ => None,
                },
            };

            if driver.poll_request_completions() {
                redraw.request(Instant::now(), RedrawPriority::Batched);
            }

            let command = driver.next_command(action, had_active_turn);
            if driver.poll_file_search() {
                redraw.request(Instant::now(), RedrawPriority::Batched);
            }
            if let Some(command) = command {
                match driver.execute(command) {
                    CommandEffect::None => {}
                    CommandEffect::Quit => return Ok(TuiExit::UserRequested),
                    CommandEffect::Suspend => terminal.suspend()?,
                }
            }
            driver.schedule_refreshes();
            sync_process_resource_demand(
                &mut pump,
                driver.app_mut(),
                terminal.area()?,
                &mut process_resource_demand,
            );
            advance_stream(driver.app_mut(), &mut redraw, Instant::now());
            if redraw.take_due(Instant::now()) {
                draw_terminal(&mut terminal, driver.app_mut(), &mut output)?;
            }
        }
    })();
    let result = result.and_then(|exit| {
        terminal.set_screen_mode(driver.app().screen_mode())?;
        if driver.app().screen_mode() == terminal::ScreenMode::Inline {
            output.finish(&mut terminal, driver.app())?;
        }
        Ok(exit)
    });
    let pump_result = pump.shutdown();
    match (result, pump_result) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error.into()),
        (Ok(exit), Ok(())) => Ok(exit),
    }
}

/// Commit deadlines are checked on every loop pass, even when input never becomes idle.
fn advance_stream(app: &mut App, redraw: &mut RedrawScheduler, now: Instant) {
    if app.advance_stream(now) {
        redraw.request(now, RedrawPriority::Immediate);
    }
}

fn next_wait(app: &App, redraw: &RedrawScheduler, now: Instant) -> Option<Duration> {
    let stream = app
        .stream_deadline()
        .map(|at| at.saturating_duration_since(now));
    match (redraw.wait_timeout(now), stream) {
        (Some(frame), Some(commit)) => Some(frame.min(commit)),
        (frame, commit) => frame.or(commit),
    }
}

fn sync_process_resource_demand(
    pump: &mut EventPump,
    app: &mut App,
    terminal_area: ratatui::layout::Rect,
    current: &mut ProcessResourceDemand,
) {
    let next = frame::process_resource_demand(app, terminal_area);
    if next == *current {
        return;
    }
    let request = pump.set_process_resource_demand(next);
    app.apply_process_resource_request(request);
    *current = next;
}

fn draw_terminal(
    terminal: &mut terminal::TerminalSession,
    app: &mut App,
    output: &mut inline::Output,
) -> Result<(), std::io::Error> {
    if !app.mouse_mode().enables_pointer_actions() {
        app.fullscreen.clear();
    }
    terminal.set_screen_mode(app.screen_mode())?;
    terminal.set_mouse_mode(app.mouse_mode())?;
    terminal.set_cursor_color(app.render_context().cursor_color())?;
    match app.screen_mode() {
        terminal::ScreenMode::Fullscreen => terminal
            .draw(|terminal_frame, links| frame::draw_with_links(terminal_frame, app, links)),
        terminal::ScreenMode::Inline => output.draw(terminal, app),
    }
}

#[cfg(test)]
#[path = "event_loop_tests.rs"]
mod tests;
