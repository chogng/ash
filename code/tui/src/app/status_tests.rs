use super::App;
use super::AppCommand;
use crate::config::TerminalSettings;
use crate::keymap::KeyEvent;
use crate::nls::Language;
use crate::terminal::ScreenMode;
use ash_protocol::ModelContextInspection;
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
    app.update(crate::context::Event::Opened(panel(12_345, Some(90_000))));
    let mut frames = Vec::new();
    let (buffer, overview) = frame(&app, 80, 26);
    assert!(
        overview.contains("~12.3k / 100k tokens (12.3%)"),
        "{overview}"
    );
    assert!(overview.contains("Autocompact buffer"));
    assert!(overview.contains("Latest request · provider reported"));
    assert!(overview.contains("25k tokens"));
    assert!(!overview.contains("Capacity details"));
    let category_y = overview
        .lines()
        .position(|line| line.contains("System prompt"))
        .unwrap() as u16;
    let marker_x = (0..80)
        .find(|x| buffer[(*x, category_y)].symbol() == ">")
        .unwrap();
    assert_eq!(buffer[(marker_x + 2, category_y)].symbol(), "■");
    assert_eq!(
        buffer[(marker_x + 2, category_y)].fg,
        app.render_context().identity_colors()[0]
    );
    let used_y = overview
        .lines()
        .position(|line| line.contains("tokens (12.3%)"))
        .unwrap() as u16;
    assert_eq!(buffer[(marker_x + 2, used_y)].symbol(), "~");
    assert!(
        buffer[(marker_x + 2, used_y)]
            .modifier
            .contains(Modifier::BOLD)
    );
    let gauge_y = (0..26)
        .find(|y| (0..80).any(|x| buffer[(x, *y)].symbol() == "▒"))
        .unwrap();
    let gauge_end = (0..80)
        .rfind(|x| buffer[(*x, gauge_y)].symbol() == "▒")
        .unwrap();
    assert_eq!(
        gauge_end,
        match mode {
            ScreenMode::Fullscreen => 69,
            ScreenMode::Inline => 77,
        },
        "{overview}"
    );
    assert_eq!(
        buffer[(gauge_end, gauge_y)].fg,
        app.render_context().accent()
    );
    let gauge_colors = (0..80)
        .filter(|x| buffer[(*x, gauge_y)].symbol() == "█")
        .map(|x| buffer[(x, gauge_y)].fg)
        .collect::<std::collections::HashSet<_>>();
    assert!(
        gauge_colors.len() >= 3,
        "used categories must have distinct colors"
    );
    frames.push(format!("Overview\n{overview}"));
    key(&mut app, KeyCode::Enter);
    let expanded = frame(&app, 80, 26).1;
    assert!(
        expanded.contains("system/prompt · 1.5k tokens"),
        "{expanded}"
    );
    frames.push(format!("Expanded system prompt\n{expanded}"));
    let other_mode = match mode {
        ScreenMode::Fullscreen => ScreenMode::Inline,
        ScreenMode::Inline => ScreenMode::Fullscreen,
    };
    settings(&mut app, other_mode, Language::English);
    assert!(
        frame(&app, 80, 26)
            .1
            .contains("system/prompt · 1.5k tokens")
    );
    assert_eq!(app.input(), "draft to preserve");
    settings(&mut app, mode, Language::English);
    key(&mut app, KeyCode::Enter);
    key(&mut app, KeyCode::Down);
    key(&mut app, KeyCode::Enter);
    let tools = frame(&app, 80, 26).1;
    assert!(tools.contains("Tool definitions"));
    assert!(!tools.contains("read_file"));
    let tools_row = tools
        .lines()
        .find(|line| line.contains("Tool definitions"))
        .unwrap();
    assert!(!tools_row.contains('+') && !tools_row.contains('-'));
    frames.push(format!("Tool definitions summary\n{tools}"));
    key(&mut app, KeyCode::Right);
    assert!(!frame(&app, 80, 26).1.contains("read_file"));
    key(&mut app, KeyCode::Down);
    key(&mut app, KeyCode::Enter);
    let memory = frame(&app, 80, 26).1;
    assert!(memory.contains("AGENTS.md · 300 tokens"), "{memory}");
    frames.push(format!("Expanded memory file\n{memory}"));
    assert_eq!(
        super::frame::process_resource_demand(&app, ratatui::layout::Rect::new(0, 0, 80, 26)),
        ash_memory_diagnostics::ProcessResourceDemand::Disabled
    );
    key(&mut app, KeyCode::Esc);
    assert!(app.command_panel().is_none());
    assert_eq!(app.input(), "draft to preserve");
    key(&mut app, KeyCode::Char('!'));
    assert_eq!(app.input(), "draft to preserve!");
    frames.push(format!(
        "Closed · input restored\n{}",
        frame(&app, 80, 26).1
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
    for (name, tokens, capacity) in [
        ("Before first request", 12_345, Some(90_000)),
        ("Over compact threshold", 99_000, Some(90_000)),
        ("Over full window", 120_000, Some(90_000)),
        ("Unknown capacity", 12_000, None),
    ] {
        let mut inspection = inspection(tokens, capacity);
        inspection.latest_request = None;
        app.update(crate::context::Event::Opened(crate::context::panel(
            inspection,
        )));
        let (_, text) = frame(&app, 40, 16);
        assert!(text.contains("上下文"), "{text}");
        assert!(text.contains("分类估算用量"));
        assert!(text.contains("系统提示词"));
        assert!(!text.contains("等待首次请求"));
        if capacity.is_some() {
            assert!(text.contains("▒"));
        } else {
            assert!(text.contains("已用 ~12k tokens"));
        }
        frames.push(format!("{name}\n{text}"));
        key(&mut app, KeyCode::Enter);
        let expanded = frame(&app, 40, 16).1;
        assert!(expanded.contains("system/prompt"), "{expanded}");
        frames.push(format!("{name} · expanded source\n{expanded}"));
        app.handle_key_in_area(
            KeyEvent::new(KeyCode::End, KeyModifiers::NONE),
            ratatui::layout::Rect::new(0, 0, 40, 16),
        );
        let bottom = frame(&app, 40, 16).1;
        if capacity.is_some() {
            assert!(bottom.contains("自动压缩窗口"), "{bottom}");
            assert!(bottom.contains("自动压缩 buffer"), "{bottom}");
            if tokens > 90_000 {
                assert!(bottom.contains("超过自动压缩阈值"));
            }
        } else {
            assert!(bottom.contains("未提供"), "{bottom}");
        }
        frames.push(format!("{name} · allocation scrolled\n{bottom}"));
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
            ("/debug-context", "Developer: Context diagnostics"),
            ("/status", "Session status"),
            ("/usage", "Usage"),
        ]
        .into_iter()
        .filter(|(command, _)| *command != "/debug-context" || cfg!(debug_assertions))
        {
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
fn context_source_mouse_target_follows_the_summary_and_toggles_details() {
    let mut app = app(ScreenMode::Fullscreen, Language::English);
    app.update(crate::context::Event::Opened(panel(12_345, Some(90_000))));
    let area = ratatui::layout::Rect::new(0, 0, 80, 24);
    for (row_offset, expected_expanded) in [(2, false), (0, true), (0, false)] {
        let text = frame(&app, area.width, area.height).1;
        let row = text
            .lines()
            .position(|line| line.contains("System prompt"))
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
            expanded.contains("system/prompt · 1.5k tokens"),
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
            crate::context::Event::Opened(panel(12_345, Some(90_000))),
        );
        assert!(app.command_panel().is_none());
        app.open_command_panel(super::CommandPanel::loading("Context", "Loading context…"));
        let generation = app.panels().generation();
        app.open_command_panel(super::CommandPanel::loading("Usage", "Loading…"));
        app.update_for_panel(
            generation,
            crate::context::Event::Opened(panel(12_345, Some(90_000))),
        );
        assert!(frame(&app, 80, 24).1.contains("Usage"));
        assert!(
            !frame(&app, 80, 24)
                .1
                .contains("Waiting for the first request")
        );
    }
}

fn panel(tokens: u64, capacity: Option<u64>) -> crate::context::Panel {
    crate::context::panel(inspection(tokens, capacity))
}

fn inspection(tokens: u64, capacity: Option<u64>) -> ModelContextInspection {
    use ash_protocol::ModelContextCategory;
    use ash_protocol::ModelContextCategoryUsage;
    use ash_protocol::ModelContextSourceUsage;
    let categories = [
        (ModelContextCategory::SystemPrompt, 1_500, "system/prompt"),
        (ModelContextCategory::SystemTools, 5_000, "read_file"),
        (ModelContextCategory::MemoryFiles, 300, "AGENTS.md"),
        (ModelContextCategory::Skills, 1_500, "available"),
        (
            ModelContextCategory::Conversation,
            tokens - 8_300,
            "history",
        ),
    ]
    .into_iter()
    .map(|(category, tokens, name)| ModelContextCategoryUsage {
        category,
        tokens,
        sources: vec![ModelContextSourceUsage {
            name: name.into(),
            tokens,
        }],
    })
    .collect();
    ModelContextInspection {
        model: Some(ash_protocol::ModelRef::new(
            ash_protocol::ProviderId::new("test").unwrap(),
            ash_protocol::ModelId::new("model").unwrap(),
        )),
        estimated_tokens: tokens,
        estimator_revision: "test".into(),
        categories,
        allocation: capacity.map(|capacity| ash_protocol::ModelContextAllocation {
            context_window: 100_000,
            auto_compact_window: 93_000,
            auto_compact_at: capacity,
            auto_compact_buffer: 7_000,
            reserved_output: 2_000,
            safety_margin: 1_000,
        }),
        latest_request: Some(ash_protocol::ModelContextUsage {
            used_tokens: 25_000,
            source: ModelContextUsageSource::ProviderReported,
        }),
    }
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

#[test]
fn context_diagnostics_fullscreen_flow() {
    let text = exercise_context_diagnostics(ScreenMode::Fullscreen, Language::English);
    crate::tui_assert_snapshot!(mode = ScreenMode::Fullscreen; "context_diagnostics_flow", text);
}

#[test]
fn context_diagnostics_inline_chinese_flow() {
    let text = exercise_context_diagnostics(ScreenMode::Inline, Language::Chinese);
    crate::tui_assert_snapshot!(mode = ScreenMode::Inline; "context_diagnostics_chinese_flow", text);
}

fn exercise_context_diagnostics(mode: ScreenMode, language: Language) -> String {
    let mut app = app(mode, language);
    app.insert_text("diagnostic draft");
    let tool = ash_app_server_protocol::protocol::model::ContextToolDefinition {
        name: "read_file".into(),
        description: "Read a workspace file".into(),
        parameters: serde_json::json!({"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
        strict: true,
        tokens: 5_000,
    };
    app.update(crate::context::Event::Opened(
        crate::context::diagnostics_panel(inspection(12_345, Some(90_000)), vec![tool]),
    ));
    let title = if language == Language::Chinese {
        "开发者：上下文诊断"
    } else {
        "Developer: Context diagnostics"
    };
    let overview = frame(&app, 100, 44).1;
    assert!(overview.contains(title), "{overview}");
    assert!(overview.contains("read_file"));
    assert!(!overview.contains("Read a workspace file"));
    let mut frames = vec![format!("Diagnostics overview\n{overview}")];
    // Section dividers are skipped by keyboard selection; the sixth selectable row is the tool.
    for _ in 0..5 {
        key(&mut app, KeyCode::Down);
    }
    key(&mut app, KeyCode::Enter);
    let expanded = frame(&app, 100, 44).1;
    assert!(expanded.contains("Read a workspace file"), "{expanded}");
    assert!(expanded.contains("parameters"));
    assert!(expanded.contains("required"));
    assert!(expanded.contains("strict"));
    frames.push(format!("Expanded tool definition\n{expanded}"));
    let other_mode = if mode == ScreenMode::Inline {
        ScreenMode::Fullscreen
    } else {
        ScreenMode::Inline
    };
    settings(&mut app, other_mode, language);
    assert!(frame(&app, 100, 44).1.contains("Read a workspace file"));
    settings(&mut app, mode, language);
    key(&mut app, KeyCode::Esc);
    assert!(app.command_panel().is_none());
    assert_eq!(app.input(), "diagnostic draft");
    app.update(crate::context::Event::Opened(panel(12_345, Some(90_000))));
    assert!(!frame(&app, 100, 44).1.contains("read_file"));
    key(&mut app, KeyCode::Esc);
    frames.push(format!(
        "Closed · draft restored\n{}",
        frame(&app, 100, 44).1
    ));
    frames.join("\n\n")
}

#[test]
fn debug_context_submission_follows_build_registration_in_both_modes() {
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        let mut app = app(mode, Language::English);
        app.insert_text("/debug-context");
        let command = key(&mut app, KeyCode::Enter);
        if cfg!(debug_assertions) {
            let Some(AppCommand::Thread(crate::thread::Command::ExecuteProductCommand(invocation))) =
                command
            else {
                panic!("development build must dispatch the registered diagnostic command");
            };
            assert_eq!(invocation.command.name, "debug-context");
        } else {
            assert_eq!(command, None);
            assert_eq!(
                app.messages().last().unwrap().text(),
                "Unknown command: /debug-context."
            );
            assert!(app.command_panel().is_none());
        }
    }
}
