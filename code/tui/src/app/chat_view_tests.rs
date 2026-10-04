use super::session_areas;
use ratatui::layout::Rect;

#[test]
fn session_layout_bounds_queue_and_preserves_transcript() {
    let areas = session_areas(
        Rect::new(0, 0, 80, 20),
        1,
        1,
        12,
        0,
        0,
        3,
        2,
        4,
        super::MIN_TRANSCRIPT_ROWS,
    );

    assert_eq!(areas.transcript.height, 4);
    assert_eq!(areas.goal.height, 0);
    assert_eq!(areas.plan.height, 0);
    assert_eq!(areas.queue.height, 5);
    assert_eq!(areas.tipline.height, 1);
    assert_eq!(areas.composer.height, 3);
    assert_eq!(areas.footer.statusline.height, 1);
    assert_eq!(areas.footer.hintline.height, 1);
    assert_eq!(areas.agent_thread_switcher.height, 4);
}

#[test]
fn session_layout_uses_zero_height_for_absent_rows() {
    let areas = session_areas(
        Rect::new(0, 0, 80, 20),
        0,
        0,
        0,
        0,
        0,
        3,
        1,
        0,
        super::MIN_TRANSCRIPT_ROWS,
    );

    assert_eq!(areas.queue.height, 0);
    assert_eq!(areas.tipline.y, areas.transcript.height);
    assert_eq!(areas.composer.y, areas.tipline.y + areas.tipline.height);
}

#[test]
fn session_layout_places_goal_plan_and_queue_above_input() {
    let areas = session_areas(
        Rect::new(0, 0, 80, 20),
        1,
        1,
        2,
        0,
        0,
        3,
        1,
        2,
        super::MIN_TRANSCRIPT_ROWS,
    );

    assert_eq!(areas.goal.y, areas.transcript.height);
    assert_eq!(areas.plan.y, areas.goal.y + areas.goal.height);
    assert_eq!(areas.queue.y, areas.plan.y + areas.plan.height);
    assert_eq!(areas.tipline.y, areas.queue.y + areas.queue.height);
    assert_eq!(areas.composer.y, areas.tipline.y + areas.tipline.height);
    assert_eq!(
        areas.footer.hintline.y,
        areas.composer.y + areas.composer.height
    );
    assert_eq!(
        areas.agent_thread_switcher.y,
        areas.footer.hintline.y + areas.footer.hintline.height + 1
    );
}

#[test]
fn session_layout_does_not_reserve_an_agent_thread_gap_without_both_surfaces() {
    let without_switcher = session_areas(
        Rect::new(0, 0, 80, 20),
        0,
        0,
        0,
        0,
        0,
        3,
        1,
        0,
        super::MIN_TRANSCRIPT_ROWS,
    );
    let without_bottom = session_areas(
        Rect::new(0, 0, 80, 20),
        0,
        0,
        0,
        0,
        0,
        3,
        0,
        2,
        super::MIN_TRANSCRIPT_ROWS,
    );

    assert_eq!(
        without_switcher.agent_thread_switcher.y,
        without_switcher.footer.hintline.y + without_switcher.footer.hintline.height
    );
    assert_eq!(
        without_bottom.agent_thread_switcher.y,
        without_bottom.footer.hintline.y + without_bottom.footer.hintline.height
    );
}

#[test]
fn session_layout_places_query_above_the_fixed_top_tip_row() {
    let areas = session_areas(
        Rect::new(0, 0, 80, 20),
        0,
        0,
        0,
        1,
        0,
        3,
        1,
        0,
        super::MIN_TRANSCRIPT_ROWS,
    );

    assert_eq!(areas.request.height, 1);
    assert_eq!(areas.tipline.y, areas.request.y + areas.request.height);
    assert_eq!(areas.tipline.height, 1);
    assert_eq!(areas.composer.y, areas.tipline.y + areas.tipline.height);
}

#[test]
fn short_session_keeps_the_entire_question_visible_before_transcript_space() {
    let areas = session_areas(Rect::new(0, 0, 42, 15), 0, 0, 0, 6, 0, 3, 1, 2, 4);

    assert_eq!(areas.request.height, 6);
    assert_eq!(areas.transcript.height, 1);
}

#[test]
fn fixed_footer_and_tip_stay_bounded_on_short_terminals() {
    for height in 0..40 {
        let area = Rect::new(3, 5, 40, height);
        let areas = session_areas(area, 0, 0, 0, 0, 0, 3, 2, 0, super::MIN_TRANSCRIPT_ROWS);
        assert!(areas.footer.hintline.bottom() <= area.bottom());
        assert!(areas.tipline.y >= area.y);
        assert_eq!(areas.tipline.bottom(), areas.composer.y);
        assert_eq!(areas.composer.bottom(), areas.footer.statusline.y);
        assert_eq!(areas.footer.statusline.bottom(), areas.footer.hintline.y);
    }
}

use crate::app::App;
use crate::app::AppCommand;
use crate::status::StatusLineItem;
use crate::status::StatusLineSettings;
use crate::terminal::ScreenMode;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;

fn configured_app(mode: ScreenMode) -> App {
    let mut app = App::for_dir(std::path::Path::new("/work/ash"));
    let mut terminal = crate::config::TerminalSettings::default();
    terminal.set_screen_mode(mode);
    app.update(crate::config::Event::SettingsReceived(terminal));
    let mut settings = StatusLineSettings::default();
    settings.set(StatusLineItem::Context, true);
    settings.set(StatusLineItem::Mode, true);
    app.update(crate::status::Event::LineSettingsReceived(settings));
    app.set_collaboration_mode(ash_protocol::CollaborationMode::Plan);
    app.chat_panel
        .status_line_mut()
        .apply_model_label("Shared model (high)");
    app.update(crate::status::Event::GitStatusReceived(
        ash_app_server_protocol::protocol::git::GitStatusResult {
            repository_id: "repository".into(),
            stream_instance_id: ash_protocol::StreamInstanceId::new("git-stream").unwrap(),
            revision: 1,
            path: "/work/ash".into(),
            head: ash_app_server_protocol::protocol::git::GitHeadDto::Unborn {
                name: "branch-layout".into(),
            },
            changes: vec![],
        },
    ));
    app.insert_text("keep this draft");
    app
}

fn render(app: &App, area: Rect) -> Buffer {
    let mut terminal = Terminal::new(TestBackend::new(area.width, area.height)).unwrap();
    terminal
        .draw(|frame| crate::app::frame::draw(frame, app))
        .unwrap();
    terminal.backend().buffer().clone()
}

fn row(buffer: &Buffer, y: u16) -> String {
    (0..buffer.area.width)
        .map(|x| buffer[(x, y)].symbol())
        .collect()
}

fn text(buffer: &Buffer) -> String {
    (0..buffer.area.height)
        .map(|y| row(buffer, y))
        .collect::<Vec<_>>()
        .join("\n")
}

fn areas(app: &App, area: Rect) -> super::SessionAreas {
    match app.screen_mode() {
        ScreenMode::Fullscreen => crate::app::fullscreen::layout(app, area).session,
        ScreenMode::Inline => crate::app::inline::layout(app, area).session,
    }
}

fn permission_row(mode: ScreenMode, footer: crate::app::footer::Layout) -> u16 {
    match mode {
        ScreenMode::Fullscreen => footer.statusline.y,
        ScreenMode::Inline => footer.hintline.y,
    }
}

#[test]
fn statusline_items_keep_their_configured_locations_and_switches_in_both_modes() {
    let area = Rect::new(0, 0, 100, 20);
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = configured_app(mode);
        let before = render(&app, area);
        let regions = areas(&app, area);
        assert_eq!(regions.footer.statusline.height, 1);
        assert_eq!(
            regions.footer.statusline.bottom(),
            regions.footer.hintline.y
        );
        assert!(row(&before, permission_row(mode, regions.footer)).starts_with("  ⏸ Manual"));
        match mode {
            ScreenMode::Fullscreen => {
                assert!(!row(&before, regions.footer.hintline.y).contains("Manual"));
                assert!(row(&before, regions.footer.hintline.y).starts_with("  Enter send"));
                assert_eq!(before[(2, regions.footer.hintline.y)].symbol(), "E");
            }
            ScreenMode::Inline => {
                assert_eq!(
                    regions.footer.hintline.y,
                    regions.footer.statusline.bottom()
                );
                assert!(!text(&before).contains("Enter send"));
            }
        }
        let model_row = match mode {
            ScreenMode::Fullscreen => crate::app::fullscreen::layout(&app, area).input.bottom() - 1,
            ScreenMode::Inline => regions.footer.statusline.y,
        };
        assert!(row(&before, model_row).contains("Shared model (high)"));
        assert!(row(&before, model_row).contains("Plan"));
        let environment_row = match mode {
            ScreenMode::Fullscreen => crate::app::fullscreen::layout(&app, area).top_statusline.y,
            ScreenMode::Inline => regions.footer.statusline.y,
        };
        assert!(row(&before, environment_row).contains("branch-layout"));
        assert_eq!(text(&before).matches("Shared model (high)").count(), 1);
        assert_eq!(text(&before).matches("branch-layout").count(), 1);
        assert!(row(&before, regions.tipline.y).trim().is_empty());
        match mode {
            ScreenMode::Fullscreen => {
                crate::tui_assert_snapshot!(app = &app; "configured_statusline_fullscreen", text(&before))
            }
            ScreenMode::Inline => {
                crate::tui_assert_snapshot!(app = &app; "configured_statusline_inline", text(&before))
            }
        }
        for (item, label) in [
            (StatusLineItem::Model, "Shared model (high)"),
            (StatusLineItem::Mode, "Plan"),
            (StatusLineItem::GitBranch, "branch-layout"),
            (StatusLineItem::Permissions, "Manual"),
        ] {
            let mut settings = StatusLineSettings::default();
            settings.set(StatusLineItem::Context, true);
            settings.set(StatusLineItem::Mode, true);
            settings.set(item, false);
            app.update(crate::status::Event::LineSettingsReceived(settings));
            assert!(
                !text(&render(&app, area)).contains(label),
                "{mode:?}: {item:?}"
            );
            assert_eq!(app.input(), "keep this draft");
        }
        let mut disabled = StatusLineSettings::default();
        for item in StatusLineItem::ALL {
            disabled.set(item, false);
        }
        app.update(crate::status::Event::LineSettingsReceived(disabled));
        let hidden = render(&app, area);
        assert!(!text(&hidden).contains("Manual"));
        assert!(!text(&hidden).contains("branch-layout"));
        assert!(!text(&hidden).contains("Shared model"));
        match mode {
            ScreenMode::Fullscreen => {
                crate::tui_assert_snapshot!(app = &app; "disabled_statusline_fullscreen", text(&hidden))
            }
            ScreenMode::Inline => {
                crate::tui_assert_snapshot!(app = &app; "disabled_statusline_inline", text(&hidden))
            }
        }
        let mut terminal = crate::config::TerminalSettings::default();
        terminal.set_screen_mode(match mode {
            ScreenMode::Fullscreen => ScreenMode::Inline,
            ScreenMode::Inline => ScreenMode::Fullscreen,
        });
        app.update(crate::config::Event::SettingsReceived(terminal));
        assert!(!text(&render(&app, area)).contains("Shared model"));
        assert_eq!(app.input(), "keep this draft");
    }
}

#[test]
fn accounting_stays_in_the_bottom_statusline_in_both_modes() {
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = configured_app(mode);
        let mut settings = StatusLineSettings::default();
        for item in StatusLineItem::ALL {
            settings.set(
                item,
                matches!(
                    item,
                    StatusLineItem::CacheHitRate
                        | StatusLineItem::ReferenceCost
                        | StatusLineItem::Permissions
                ),
            );
        }
        app.update(crate::status::Event::LineSettingsReceived(settings));
        let mut usage = ash_protocol::ModelUsageSummary::default();
        usage.model_invocations = 2;
        usage.input_tokens.reported = 10_000;
        usage.cached_input_tokens.reported = 7_500;
        app.chat_panel.status_line_mut().apply_thread_accounting(
            &usage,
            &ash_protocol::ModelReferenceCostSummary {
                known_amounts: vec![ash_protocol::ModelMoneyAmount {
                    currency: "USD".into(),
                    pico_units: "10080000000".into(),
                }],
                complete: true,
            },
        );
        let area = Rect::new(0, 0, 80, 18);
        let buffer = render(&app, area);
        let regions = areas(&app, area);
        assert!(
            row(&buffer, regions.footer.statusline.y).contains("cache hit 75.0% · cost $0.01008")
        );
        assert!(!row(&buffer, regions.footer.hintline.y).contains("cost"));
        assert!(row(&buffer, permission_row(mode, regions.footer)).contains("Manual"));
        assert_eq!(text(&buffer).matches("cost $0.01008").count(), 1);
        if mode == ScreenMode::Fullscreen {
            assert!(row(&buffer, regions.footer.hintline.y).starts_with("  Enter send"));
            assert_eq!(buffer[(2, regions.footer.hintline.y)].symbol(), "E");
        }
        match mode {
            ScreenMode::Fullscreen => crate::tui_assert_snapshot!(
                app = &app;
                "accounting_bottom_statusline_fullscreen",
                text(&buffer)
            ),
            ScreenMode::Inline => {
                crate::tui_assert_snapshot!(app = &app; "accounting_bottom_statusline_inline", text(&buffer))
            }
        }
    }
}

#[test]
fn resource_sampling_follows_each_modes_statistics_row_when_permission_takes_space() {
    use ash_memory_diagnostics::ProcessResourceDemand;
    use ash_memory_diagnostics::ProcessResourceMetrics;
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = configured_app(mode);
        let mut settings = StatusLineSettings::default();
        for item in StatusLineItem::ALL {
            settings.set(
                item,
                matches!(item, StatusLineItem::Permissions | StatusLineItem::Memory),
            );
        }
        app.update(crate::status::Event::LineSettingsReceived(settings));
        assert_eq!(
            crate::app::frame::process_resource_demand(&app, Rect::new(0, 0, 80, 18)),
            ProcessResourceDemand::Summary(ProcessResourceMetrics::Memory)
        );
        assert_eq!(
            crate::app::frame::process_resource_demand(&app, Rect::new(0, 0, 15, 18)),
            match mode {
                ScreenMode::Fullscreen => ProcessResourceDemand::Disabled,
                ScreenMode::Inline =>
                    ProcessResourceDemand::Summary(ProcessResourceMetrics::Memory),
            }
        );
        assert_eq!(
            crate::app::frame::process_resource_demand(&app, Rect::new(0, 0, 80, 1)),
            ProcessResourceDemand::Disabled
        );
    }
}

#[test]
fn permission_survives_tips_dictation_and_narrow_widths_in_both_modes() {
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = configured_app(mode);
        app.chat_panel
            .show_notice("Copied".into(), std::time::Instant::now());
        for width in [80, 24] {
            let area = Rect::new(0, 0, width, 18);
            let regions = areas(&app, area);
            let buffer = render(&app, area);
            assert!(row(&buffer, regions.tipline.y).contains("Copied"));
            assert!(row(&buffer, permission_row(mode, regions.footer)).contains("Manual"));
            if mode == ScreenMode::Fullscreen {
                assert!(row(&buffer, regions.footer.hintline.y).starts_with("  Enter send"));
            }
            assert_eq!(
                buffer[(2, permission_row(mode, regions.footer))].fg,
                app.render_context().warning()
            );
        }
        for _ in 0..app.input().chars().count() {
            app.handle_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE));
        }
        app.insert_text("/voice");
        let Some(AppCommand::DictationStart { resource_id }) =
            app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
        else {
            panic!("expected dictation start")
        };
        app.update(crate::app::AppEvent::DictationStarted {
            resource_id: resource_id.clone(),
            error: None,
        });
        app.dictation_model_progress(
            &resource_id,
            ash_app_server_protocol::protocol::dictation::DictationModelStage::Loading,
        );
        let area = Rect::new(0, 0, 80, 18);
        let regions = areas(&app, area);
        let buffer = render(&app, area);
        assert!(row(&buffer, regions.tipline.y).contains("Dictation · loading model"));
        assert!(row(&buffer, regions.tipline.y).contains("ctrl+c to stop dictation"));
        assert!(row(&buffer, permission_row(mode, regions.footer)).contains("Manual"));
        assert!(!row(&buffer, regions.footer.hintline.y).contains("stop dictation"));
        match mode {
            ScreenMode::Fullscreen => {
                crate::tui_assert_snapshot!(app = &app; "dictation_and_permission_fullscreen", text(&buffer))
            }
            ScreenMode::Inline => {
                crate::tui_assert_snapshot!(app = &app; "dictation_and_permission_inline", text(&buffer))
            }
        }
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Some(AppCommand::DictationStop { resource_id })
        );
        assert!(!text(&render(&app, area)).contains("ctrl+c to stop dictation"));
        assert!(row(&render(&app, area), permission_row(mode, regions.footer)).contains("Manual"));
    }
}

#[test]
fn chat_progress_stays_fixed_while_history_scrolls_in_both_modes() {
    use crate::thread::Event;
    use crate::thread::TurnActivity;
    use ash_protocol::TurnId;

    let area = Rect::new(0, 0, 80, 20);
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = configured_app(mode);
        for index in 0..16 {
            app.update(Event::ProductNotice(format!("History entry {index}")));
        }
        app.set_active_turn(TurnId::new("fixed-progress").unwrap());
        app.update(Event::TurnActivityChanged(TurnActivity::Working));
        let regions = areas(&app, area);
        let before = render(&app, area);
        assert_eq!(regions.progress.height, 1);
        assert_eq!(regions.progress.bottom(), regions.tipline.y);
        assert_eq!(regions.tipline.bottom(), regions.composer.y);
        assert!(row(&before, regions.progress.y).starts_with("⠋ Working... · 0s"));
        assert_eq!(
            before[(0, regions.progress.y)].fg,
            app.render_context().accent()
        );
        assert_eq!(
            before[(2, regions.progress.y)].fg,
            app.render_context().muted()
        );
        assert!(row(&before, regions.progress.y).contains("ctrl+c to interrupt"));
        assert!(!app.transcript_markdown().contains("Working..."));
        assert_eq!(
            app.handle_key_in_area(KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL), area),
            Some(AppCommand::Thread(crate::thread::Command::LoadOlderHistory))
        );
        assert!(app.transcript_scroll().anchor().is_some());
        let scrolled = render(&app, area);
        assert!(text(&scrolled).contains("History entry 0"));
        assert_eq!(
            row(&before, regions.progress.y),
            row(&scrolled, regions.progress.y)
        );
        match mode {
            ScreenMode::Fullscreen => {
                crate::tui_assert_snapshot!(app = &app; "fixed_progress_scrolled_fullscreen", text(&scrolled))
            }
            ScreenMode::Inline => {
                crate::tui_assert_snapshot!(app = &app; "fixed_progress_scrolled_inline", text(&scrolled))
            }
        }
        app.handle_key_in_area(KeyEvent::new(KeyCode::End, KeyModifiers::CONTROL), area);
        assert!(app.transcript_scroll().anchor().is_none());
        let latest = render(&app, area);
        if mode == ScreenMode::Fullscreen {
            assert!(text(&latest).contains("History entry 15"));
        }
        assert!(row(&latest, areas(&app, area).progress.y).contains("Working..."));
        app.update(Event::TurnActivityChanged(
            TurnActivity::WaitingForUserInput,
        ));
        let waiting = render(&app, area);
        assert!(row(&waiting, areas(&app, area).progress.y).starts_with("○ Waiting for input"));
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Some(AppCommand::Thread(crate::thread::Command::Interrupt))
        );
        assert!(text(&render(&app, area)).contains("Cancelling..."));
        app.update(Event::TurnCompleted);
        assert_eq!(areas(&app, area).progress.height, 0);
        assert!(!text(&render(&app, area)).contains("Cancelling..."));
    }
}

#[test]
fn chat_progress_yields_to_question_and_input_on_short_terminals() {
    for height in 0..24 {
        let area = Rect::new(3, 5, 42, height);
        let regions = session_areas(area, 1, 1, 8, 6, 2, 3, 2, 0, 4);
        for region in [
            regions.transcript,
            regions.goal,
            regions.plan,
            regions.queue,
            regions.request,
            regions.progress,
            regions.tipline,
            regions.composer,
            regions.footer.statusline,
            regions.footer.hintline,
        ] {
            assert!(region.y >= area.y && region.bottom() <= area.bottom());
        }
        assert_eq!(regions.request.bottom(), regions.progress.y);
        assert_eq!(regions.progress.bottom(), regions.tipline.y);
        assert_eq!(regions.tipline.bottom(), regions.composer.y);
        if height >= 11 {
            assert_eq!(regions.request.height, 6);
            assert_eq!(regions.composer.height, 3);
        }
    }
}
