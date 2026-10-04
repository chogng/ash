use super::App;
use super::AppCommand;
use crate::config::TerminalSettings;
use crate::context::Usage as ContextUsage;
use crate::keymap::KeyEvent;
use crate::nls::Language;
use crate::terminal::ScreenMode;
use ash_protocol::ModelContextUsageSource;
use crossterm::event::KeyCode;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::style::Modifier;
use unicode_width::UnicodeWidthStr;

#[test]
fn context_panel_fullscreen_flow() {
    let text = exercise_panel(ScreenMode::Fullscreen);
    crate::tui_assert_snapshot!(mode = ScreenMode::Fullscreen; "context_panel_flow", text);
}

#[test]
fn context_panel_inline_flow() {
    let text = exercise_panel(ScreenMode::Inline);
    crate::tui_assert_snapshot!(mode = ScreenMode::Inline; "context_panel_flow", text);
}

fn exercise_panel(mode: ScreenMode) -> String {
    let mut app = app(mode, Language::English);
    app.insert_text("draft to preserve");
    app.update(crate::context::Event::Opened(panel(
        ContextUsage::Measured {
            used_tokens: 12_345,
            source: ModelContextUsageSource::Estimated,
        },
        Some(90_000),
    )));
    let mut frames = Vec::new();
    let (buffer, overview) = frame(&app, 80, 24);
    assert!(overview.contains("~12.3k / 90k tokens used"));
    assert!(overview.contains("Latest request · estimated"));
    let capacity_y = overview
        .lines()
        .position(|line| line.contains("Capacity details"))
        .unwrap() as u16;
    let marker_x = (0..80)
        .find(|x| buffer[(*x, capacity_y)].symbol() == ">")
        .unwrap();
    assert_eq!(buffer[(marker_x + 2, capacity_y)].symbol(), "C");
    let used_y = overview
        .lines()
        .position(|line| line.contains("tokens used"))
        .unwrap() as u16;
    assert_eq!(buffer[(marker_x + 2, used_y)].symbol(), "~", "{overview}");
    assert!(
        buffer[(marker_x + 2, used_y)]
            .modifier
            .contains(Modifier::BOLD)
    );
    frames.push(format!("Overview\n{overview}"));
    key(&mut app, KeyCode::Enter);
    let expanded = frame(&app, 80, 24).1;
    assert!(expanded.contains("Output and safety reserve: 10,000 tokens"));
    frames.push(format!("Expanded capacity\n{expanded}"));

    // The mode containers transfer the same editor; expansion and the draft belong to it.
    let other_mode = match mode {
        ScreenMode::Fullscreen => ScreenMode::Inline,
        ScreenMode::Inline => ScreenMode::Fullscreen,
    };
    settings(&mut app, other_mode, Language::English);
    assert!(
        frame(&app, 80, 24)
            .1
            .contains("Output and safety reserve: 10,000 tokens")
    );
    assert_eq!(app.input(), "draft to preserve");
    settings(&mut app, mode, Language::English);
    assert!(!expanded.contains("Model calls:"));
    assert_eq!(
        super::frame::process_resource_demand(&app, ratatui::layout::Rect::new(0, 0, 80, 24)),
        ash_memory_diagnostics::ProcessResourceDemand::Disabled
    );
    key(&mut app, KeyCode::Esc);
    assert!(app.command_panel().is_none());
    assert_eq!(app.input(), "draft to preserve");
    key(&mut app, KeyCode::Char('!'));
    assert_eq!(app.input(), "draft to preserve!");
    frames.push(format!(
        "Closed · input restored\n{}",
        frame(&app, 80, 24).1
    ));
    frames.join("\n\n")
}

#[test]
fn context_panel_fullscreen_chinese_narrow_states() {
    let text = exercise_narrow_states(ScreenMode::Fullscreen);
    crate::tui_assert_snapshot!(mode = ScreenMode::Fullscreen; "context_panel_chinese_narrow_states", text);
}

#[test]
fn context_panel_inline_chinese_narrow_states() {
    let text = exercise_narrow_states(ScreenMode::Inline);
    crate::tui_assert_snapshot!(mode = ScreenMode::Inline; "context_panel_chinese_narrow_states", text);
}

fn exercise_narrow_states(mode: ScreenMode) -> String {
    let mut app = app(mode, Language::Chinese);
    let mut frames = Vec::new();
    for (name, usage, capacity) in [
        ("Not started", ContextUsage::NotStarted, Some(90_000)),
        ("Pending measurement", ContextUsage::Pending, Some(90_000)),
        (
            "Over budget",
            ContextUsage::Measured {
                used_tokens: 99_000,
                source: ModelContextUsageSource::ProviderReported,
            },
            Some(90_000),
        ),
        (
            "Unknown capacity",
            ContextUsage::Measured {
                used_tokens: 12_000,
                source: ModelContextUsageSource::Estimated,
            },
            None,
        ),
    ] {
        app.update(crate::context::Event::Opened(panel(usage, capacity)));
        let (buffer, text) = frame(&app, 40, 14);
        assert!(text.contains("上下文"), "{text}");
        assert!(text.contains("容量说明"));
        let body_text = text
            .lines()
            .skip_while(|line| !line.contains("上下文"))
            .collect::<Vec<_>>()
            .join("\n");
        match usage {
            ContextUsage::NotStarted => {
                assert!(text.contains("等待首次请求"));
                assert!(!body_text.contains('█'));
            }
            ContextUsage::Pending => {
                assert!(text.contains("等待上下文统计"));
                assert!(!body_text.contains('█'));
            }
            ContextUsage::Measured { .. } if capacity.is_some() => {
                assert!(text.contains("110.0%"));
                let gauge = (0..14)
                    .flat_map(|y| (0..40).map(move |x| (x, y)))
                    .find(|position| buffer[*position].symbol() == "█")
                    .unwrap();
                assert_eq!(buffer[gauge].fg, app.render_context().warning());
            }
            ContextUsage::Measured { .. } => {
                assert!(text.contains("已用 ~12k tokens"));
                assert!(!body_text.contains('█'));
                assert!(!text.contains(" / "));
            }
        }
        frames.push(format!("{name}\n{text}"));
        key(&mut app, KeyCode::Enter);
        app.handle_key_in_area(
            KeyEvent::new(KeyCode::End, KeyModifiers::NONE),
            ratatui::layout::Rect::new(0, 0, 40, 14),
        );
        let expanded = frame(&app, 40, 14).1;
        assert!(expanded.contains("可用输入预算"), "{name}\n{expanded}");
        frames.push(format!("{name} · capacity scrolled\n{expanded}"));
        key(&mut app, KeyCode::Esc);
        assert!(app.command_panel().is_none());
    }
    frames.join("\n\n")
}

#[test]
fn context_status_and_usage_commands_have_distinct_titles_in_both_modes() {
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        for (command, title) in [
            ("/context", "Context"),
            ("/status", "Session status"),
            ("/usage", "Usage"),
        ] {
            let mut app = app(mode, Language::Chinese);
            app.insert_text(command);
            let Some(AppCommand::Thread(crate::thread::Command::ExecuteProductCommand(invocation))) =
                key(&mut app, KeyCode::Enter)
            else {
                panic!("expected a product panel request for {command}");
            };
            assert_eq!(invocation.command.name, command.trim_start_matches('/'));
            let command =
                AppCommand::Thread(crate::thread::Command::ExecuteProductCommand(invocation));
            assert_eq!(command.panel_title(), Some(title));
        }
    }
}

#[test]
fn context_capacity_mouse_target_follows_the_summary_and_toggles_details() {
    let mut app = app(ScreenMode::Fullscreen, Language::English);
    app.update(crate::context::Event::Opened(panel(
        ContextUsage::Pending,
        Some(90_000),
    )));
    let area = ratatui::layout::Rect::new(0, 0, 80, 24);
    for (row_offset, expected_expanded) in [(2, false), (0, true), (0, false)] {
        let text = frame(&app, area.width, area.height).1;
        let row = text
            .lines()
            .position(|line| line.contains("Capacity details"))
            .unwrap() as u16;
        let position = ratatui::layout::Position::new(12, row - row_offset);
        for kind in [
            crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
            crossterm::event::MouseEventKind::Up(crossterm::event::MouseButton::Left),
        ] {
            super::fullscreen::pointer::handle_mouse(
                &mut app,
                area,
                crossterm::event::MouseEvent {
                    kind,
                    column: position.x,
                    row: position.y,
                    modifiers: KeyModifiers::NONE,
                },
            );
        }
        let expanded = frame(&app, area.width, area.height).1;
        assert_eq!(
            expanded.contains("Available input budget: 90,000 tokens"),
            expected_expanded,
            "{expanded}"
        );
    }
    assert!(
        !frame(&app, area.width, area.height)
            .1
            .contains("Full context window:")
    );
}

#[test]
fn session_status_fullscreen_flow() {
    let text = exercise_status(ScreenMode::Fullscreen, Language::English, 80, 24);
    crate::tui_assert_snapshot!(mode = ScreenMode::Fullscreen; "session_status_flow", text);
}
#[test]
fn session_status_inline_flow() {
    let text = exercise_status(ScreenMode::Inline, Language::English, 80, 24);
    crate::tui_assert_snapshot!(mode = ScreenMode::Inline; "session_status_flow", text);
}
#[test]
fn session_status_fullscreen_chinese_narrow() {
    let text = exercise_status(ScreenMode::Fullscreen, Language::Chinese, 40, 14);
    crate::tui_assert_snapshot!(mode = ScreenMode::Fullscreen; "session_status_chinese_narrow", text);
}
#[test]
fn session_status_inline_chinese_narrow() {
    let text = exercise_status(ScreenMode::Inline, Language::Chinese, 40, 14);
    crate::tui_assert_snapshot!(mode = ScreenMode::Inline; "session_status_chinese_narrow", text);
}
fn exercise_status(mode: ScreenMode, language: Language, width: u16, height: u16) -> String {
    let mut app = app(mode, language);
    app.insert_text("status draft");
    let usage = ash_protocol::ModelUsageSummary {
        model_invocations: 4,
        input_tokens: ash_protocol::ModelUsageTotal {
            reported: 120_000,
            complete: true,
        },
        ..Default::default()
    };
    app.update(crate::status::Event::PanelOpened(
        crate::status::status_panel(crate::status::StatusViewData {
            model: "test/model",
            usage: &usage,
            reference_cost: &Default::default(),
            session_id: "session-test",
            thread_id: "thread-test",
        }),
    ));
    let area = ratatui::layout::Rect::new(0, 0, width, height);
    let (buffer, overview) = frame(&app, width, height);
    assert!(overview.contains("test/model"));
    assert!(!overview.contains("tokens used"));
    assert!(!overview.contains("Capacity details"));
    let model_y = overview
        .lines()
        .position(|line| line.contains("test/model"))
        .unwrap() as u16;
    let model_x = (0..width)
        .find(|x| {
            buffer[(*x, model_y)].symbol()
                == if language == Language::Chinese {
                    "模"
                } else {
                    "M"
                }
        })
        .unwrap();
    assert!(buffer[(model_x, model_y)].modifier.contains(Modifier::BOLD));
    let mut frames = vec![format!("Session\n{overview}")];
    app.handle_key_in_area(KeyEvent::new(KeyCode::End, KeyModifiers::NONE), area);
    let bottom = frame(&app, width, height).1;
    assert!(
        bottom.contains(if language == Language::Chinese {
            "参考成本"
        } else {
            "Reference cost"
        }),
        "{bottom}"
    );
    frames.push(format!("Session · bottom\n{bottom}"));
    app.handle_key_in_area(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE), area);
    let totals = frame(&app, width, height).1;
    assert!(totals.contains("120,000 tokens"), "{totals}");
    assert!(
        totals.contains(if language == Language::Chinese {
            "本线程累计消耗"
        } else {
            "Thread totals"
        }),
        "{totals}"
    );
    frames.push(format!("Thread totals\n{totals}"));
    app.handle_key_in_area(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE), area);
    assert_eq!(
        super::frame::process_resource_demand(&app, area),
        ash_memory_diagnostics::ProcessResourceDemand::Detailed
    );
    app.handle_key_in_area(KeyEvent::new(KeyCode::End, KeyModifiers::NONE), area);
    let diagnostics = frame(&app, width, height).1;
    assert!(diagnostics.contains(if language == Language::Chinese {
        "内存诊断"
    } else {
        "Memory diagnostics"
    }));
    frames.push(format!("Diagnostics\n{diagnostics}"));
    settings(
        &mut app,
        if mode == ScreenMode::Inline {
            ScreenMode::Fullscreen
        } else {
            ScreenMode::Inline
        },
        language,
    );
    settings(&mut app, mode, language);
    assert!(
        frame(&app, width, height)
            .1
            .contains(if language == Language::Chinese {
                "内存诊断"
            } else {
                "Memory diagnostics"
            })
    );
    key(&mut app, KeyCode::Esc);
    assert!(app.command_panel().is_none());
    assert_eq!(app.input(), "status draft");
    key(&mut app, KeyCode::Char('!'));
    assert_eq!(app.input(), "status draft!");
    frames.push(format!("Closed\n{}", frame(&app, width, height).1));
    frames.join("\n\n")
}

#[test]
fn context_late_results_do_not_reopen_a_closed_or_replace_a_newer_panel() {
    for mode in [ScreenMode::Inline, ScreenMode::Fullscreen] {
        let mut app = app(mode, Language::English);
        app.open_command_panel(super::CommandPanel::loading("Context", "Loading context…"));
        let generation = app.panels().generation();
        key(&mut app, KeyCode::Esc);
        app.update_for_panel(
            generation,
            crate::context::Event::Opened(panel(ContextUsage::NotStarted, Some(90_000))),
        );
        assert!(app.command_panel().is_none());
        app.open_command_panel(super::CommandPanel::loading("Context", "Loading context…"));
        let generation = app.panels().generation();
        app.open_command_panel(super::CommandPanel::loading("Usage", "Loading…"));
        app.update_for_panel(
            generation,
            crate::context::Event::Opened(panel(ContextUsage::NotStarted, Some(90_000))),
        );
        assert!(frame(&app, 80, 24).1.contains("Usage"));
        assert!(
            !frame(&app, 80, 24)
                .1
                .contains("Waiting for the first request")
        );
    }
}

fn panel(
    context_usage: ContextUsage,
    available_context_window: Option<u64>,
) -> crate::context::Panel {
    crate::context::panel(crate::context::ViewData {
        model: "test/model",
        full_context_window: Some(100_000),
        available_context_window,
        context_usage,
    })
}

fn app(mode: ScreenMode, language: Language) -> App {
    let mut app = App::new();
    settings(&mut app, mode, language);
    app
}

fn settings(app: &mut App, mode: ScreenMode, language: Language) {
    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(mode);
    settings.set_language(language);
    app.update(crate::config::Event::SettingsReceived(settings));
}

fn key(app: &mut App, code: KeyCode) -> Option<AppCommand> {
    app.handle_key(KeyEvent::new(code, KeyModifiers::NONE))
}

fn frame(app: &App, width: u16, height: u16) -> (Buffer, String) {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal
        .draw(|frame| super::frame::draw(frame, app))
        .unwrap();
    let buffer = terminal.backend().buffer().clone();
    let text = (0..height)
        .map(|y| {
            let mut text = String::new();
            let mut continuation = 0;
            for x in 0..width {
                if continuation > 0 {
                    continuation -= 1;
                    continue;
                }
                let symbol = buffer[(x, y)].symbol();
                text.push_str(symbol);
                continuation = symbol.width().saturating_sub(1);
            }
            text
        })
        .collect::<Vec<_>>()
        .join("\n");
    (buffer, text)
}
