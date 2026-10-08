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
        overview.contains("12.3k / 100k tokens (12.3%)"),
        "{overview}"
    );
    assert!(overview.contains("Skills (41)"), "{overview}");
    assert!(overview.contains("Autocompact buffer"));
    assert!(overview.contains("Test model"));
    assert!(!overview.contains("test/model"));
    assert!(!overview.contains("~12.3k"));
    assert!(!overview.contains("Compaction mode"));
    assert!(!overview.contains("Layered summary"));
    assert!(overview.contains("90k (90.0%)"));
    assert!(!overview.contains("Output reserve"));
    assert!(!overview.contains("Safety margin"));
    assert!(!overview.contains("Auto-compact window"));
    assert!(overview.find("Test model").unwrap() < overview.find("12.3k / 100k").unwrap());
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
    assert!(
        overview
            .lines()
            .nth(used_y as usize)
            .unwrap()
            .contains("Test model")
    );
    assert!(!overview.contains("Estimated usage by category"));
    let used_x = (0..80)
        .find(|x| buffer[(*x, used_y)].symbol() == "1")
        .unwrap();
    assert!(buffer[(used_x, used_y)].modifier.contains(Modifier::BOLD));
    let gauge_y = used_y + 1;
    let gauge_end = (0..80)
        .rfind(|x| buffer[(*x, gauge_y)].bg == app.render_context().muted())
        .unwrap();
    assert_eq!(buffer[(gauge_end, used_y)].symbol(), ")");
    assert_eq!(
        gauge_end,
        match mode {
            ScreenMode::Fullscreen => 69,
            ScreenMode::Inline => 77,
        },
        "{overview}"
    );
    assert_eq!(
        buffer[(gauge_end, gauge_y)].bg,
        app.render_context().muted()
    );
    let colors = app.render_context().identity_colors();
    let mut gauge_colors = (0..80)
        .map(|x| buffer[(x, gauge_y)].bg)
        .filter(|color| colors.contains(color))
        .collect::<Vec<_>>();
    gauge_colors.dedup();
    assert_eq!(gauge_colors, colors);
    for x in marker_x + 2..=gauge_end {
        assert_eq!(buffer[(x, gauge_y)].symbol(), " ");
    }
    frames.push(format!("Overview\n{overview}"));
    for _ in 0..5 {
        let before = frame(&app, 80, 26).1;
        for code in [KeyCode::Enter, KeyCode::Right, KeyCode::Left] {
            key(&mut app, code);
            assert_eq!(frame(&app, 80, 26).1, before);
        }
        key(&mut app, KeyCode::Down);
    }
    key(&mut app, KeyCode::Up);
    frames.push(format!(
        "Categories remain collapsed\n{}",
        frame(&app, 80, 26).1
    ));
    let other_mode = match mode {
        ScreenMode::Fullscreen => ScreenMode::Inline,
        ScreenMode::Inline => ScreenMode::Fullscreen,
    };
    settings(&mut app, other_mode, Language::English);
    let summary = frame(&app, 80, 26).1;
    for source in [
        "system/prompt",
        "read_file",
        "AGENTS.md",
        "available",
        "history",
    ] {
        assert!(!summary.contains(source), "{summary}");
    }
    assert!(!summary.contains("Enter details"));
    assert_eq!(app.input(), "draft to preserve");
    settings(&mut app, mode, Language::English);
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
            &context_catalog(),
        )));
        let (buffer, text) = frame(&app, 40, 16);
        assert!(text.contains("上下文"), "{text}");
        assert!(!text.contains("分类估算用量"));
        assert!(text.contains("系统提示词"));
        assert!(!text.contains("等待首次请求"));
        if capacity.is_some() {
            let used_y = text
                .lines()
                .position(|line| line.contains("tokens（"))
                .unwrap() as u16;
            let model_x = (0..40)
                .find(|x| buffer[(*x, used_y)].symbol() == "T")
                .unwrap();
            assert_eq!(
                buffer[(model_x, used_y)].fg,
                app.render_context().foreground()
            );
            assert!(buffer[(model_x, used_y)].modifier.contains(Modifier::BOLD));
            assert!((0..40).any(|x| buffer[(x, used_y + 1)].bg == app.render_context().muted()));
            let gauge_end = (0..40)
                .rfind(|x| buffer[(*x, used_y + 1)].bg == app.render_context().muted())
                .unwrap();
            assert_eq!(buffer[(gauge_end - 1, used_y)].symbol(), "）");
            let expected_color = if tokens > 90_000 {
                app.render_context().warning()
            } else {
                app.render_context().foreground()
            };
            assert!(
                (0..40).any(|x| {
                    let cell = &buffer[(x, used_y)];
                    cell.fg == expected_color
                        && cell.modifier.contains(Modifier::BOLD)
                        && cell.symbol() == tokens.to_string().chars().next().unwrap().to_string()
                }),
                "{text}"
            );
        } else {
            assert!(text.contains("已用 12k tokens"));
        }
        frames.push(format!("{name}\n{text}"));
        key(&mut app, KeyCode::Enter);
        assert_eq!(frame(&app, 40, 16).1, text);
        assert!(!text.contains("Enter 详情"));
        app.handle_key_in_area(
            KeyEvent::new(KeyCode::End, KeyModifiers::NONE),
            ratatui::layout::Rect::new(0, 0, 40, 16),
        );
        let bottom = frame(&app, 40, 16).1;
        if capacity.is_some() {
            assert!(bottom.contains("自动压缩阈值"), "{bottom}");
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
fn context_diagnostics_source_mouse_target_follows_the_summary_and_toggles_details() {
    let mut app = app(ScreenMode::Fullscreen, Language::English);
    app.update(crate::context::Event::Opened(
        crate::context::diagnostics_panel(
            inspection(12_345, Some(90_000)),
            vec![],
            &context_catalog(),
        ),
    ));
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
    crate::context::panel(inspection(tokens, capacity), &context_catalog())
}

fn context_catalog() -> ash_app_server_protocol::protocol::model::ModelListResult {
    let model = inspection(12_345, None).model.unwrap();
    ash_app_server_protocol::protocol::model::ModelListResult {
        catalog_scopes: None,
        models: vec![
            ash_app_server_protocol::protocol::model::ModelCatalogEntry::from_info(
                model.clone(),
                &ash_protocol::ModelInfo::new(model.model, "Test model"),
            ),
        ],
    }
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
            item_count: (category == ModelContextCategory::Skills).then_some(41),
            tokens,
        }],
    })
    .collect();
    ModelContextInspection {
        compaction_policy: Default::default(),
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
        crate::context::diagnostics_panel(
            inspection(12_345, Some(90_000)),
            vec![tool],
            &context_catalog(),
        ),
    ));
    let title = if language == Language::Chinese {
        "开发者：上下文诊断"
    } else {
        "Developer: Context diagnostics"
    };
    let overview = frame(&app, 100, 44).1;
    assert!(overview.contains(title), "{overview}");
    assert!(
        overview.contains(if language == Language::Chinese {
            "分层摘要"
        } else {
            "Layered summary"
        }),
        "{overview}"
    );
    assert!(overview.contains("read_file"));
    assert!(!overview.contains("Read a workspace file"));
    let mut frames = vec![format!("Diagnostics overview\n{overview}")];
    for source in [
        Some("system/prompt · 1.5k tokens"),
        None,
        Some("AGENTS.md · 300 tokens"),
        Some(if language == Language::Chinese {
            "共 41 个技能 · 1.5k tokens"
        } else {
            "41 skills · 1.5k tokens"
        }),
        Some("history · 4k tokens"),
    ] {
        if let Some(source) = source {
            key(&mut app, KeyCode::Enter);
            let expanded = frame(&app, 100, 44).1;
            assert!(expanded.contains(source), "{expanded}");
            if source.contains("skills") || source.contains("个技能") {
                assert!(!expanded.contains("available"));
                frames.push(format!("Expanded skill count\n{expanded}"));
            }
            if source.starts_with("AGENTS.md") {
                frames.push(format!("Expanded memory source\n{expanded}"));
            }
            key(&mut app, KeyCode::Left);
            assert!(!frame(&app, 100, 44).1.contains(source));
            key(&mut app, KeyCode::Right);
            assert!(frame(&app, 100, 44).1.contains(source));
            key(&mut app, KeyCode::Enter);
        }
        // Section dividers are skipped by keyboard selection.
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
fn context_skill_count_counts_catalog_entries_once_in_both_languages() {
    for mode in [ScreenMode::Fullscreen, ScreenMode::Inline] {
        for language in [Language::Chinese, Language::English] {
            for count in [0, 1, 41] {
                let mut app = app(mode, language);
                let mut context = inspection(12_345, Some(90_000));
                let skills = context
                    .categories
                    .iter_mut()
                    .find(|category| {
                        category.category == ash_protocol::ModelContextCategory::Skills
                    })
                    .unwrap();
                if count == 0 {
                    skills.sources.clear();
                    skills.tokens = 0;
                } else {
                    skills.sources[0].item_count = Some(count);
                    skills.sources.push(ash_protocol::ModelContextSourceUsage {
                        name: "built-in:review".into(),
                        item_count: None,
                        tokens: 100,
                    });
                    skills.tokens += 100;
                }
                app.update(crate::context::Event::Opened(
                    crate::context::diagnostics_panel(context, vec![], &context_catalog()),
                ));
                let title = if language == Language::Chinese {
                    format!("技能（{count} 个）")
                } else {
                    format!("Skills ({count})")
                };
                assert!(frame(&app, 100, 44).1.contains(&title));
                for _ in 0..3 {
                    key(&mut app, KeyCode::Down);
                }
                key(&mut app, KeyCode::Enter);
                let text = frame(&app, 100, 44).1;
                assert!(text.contains(&title), "{text}");
                if count > 0 {
                    let detail = if language == Language::Chinese {
                        format!("共 {count} 个技能 · 1.5k tokens")
                    } else if count == 1 {
                        "1 skill · 1.5k tokens".into()
                    } else {
                        format!("{count} skills · 1.5k tokens")
                    };
                    assert!(text.contains(&detail), "{text}");
                    assert!(text.contains("built-in:review · 100 tokens"));
                    assert!(!text.contains("available"));
                }
            }
        }
    }
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

#[test]
fn context_panel_fullscreen_low_usage_order() {
    let text = exercise_low_usage_order(ScreenMode::Fullscreen);
    crate::tui_assert_snapshot!(mode = ScreenMode::Fullscreen; "context_panel_low_usage_order", text);
}

#[test]
fn context_panel_inline_low_usage_order() {
    let text = exercise_low_usage_order(ScreenMode::Inline);
    crate::tui_assert_snapshot!(mode = ScreenMode::Inline; "context_panel_low_usage_order", text);
}

fn exercise_low_usage_order(mode: ScreenMode) -> String {
    let mut app = app(mode, Language::Chinese);
    let mut inspection = inspection(10_242, None);
    for (category, tokens) in inspection
        .categories
        .iter_mut()
        .zip([1_400, 7_700, 897, 245, 0])
    {
        category.tokens = tokens;
    }
    inspection.latest_request = None;
    inspection.allocation = Some(ash_protocol::ModelContextAllocation {
        context_window: 1_000_000,
        auto_compact_window: 900_000,
        auto_compact_at: 894_904,
        auto_compact_buffer: 100_000,
        reserved_output: 4_096,
        safety_margin: 1_000,
    });
    app.update(crate::context::Event::Opened(crate::context::panel(
        inspection,
        &context_catalog(),
    )));
    let (buffer, text) = frame(&app, 100, 26);
    let gauge_y = text
        .lines()
        .position(|line| line.contains("10.2k / 1m"))
        .unwrap() as u16
        + 1;
    let context = app.render_context();
    let colors = context.identity_colors();
    let gauge = (0..100)
        .filter(|x| {
            let background = buffer[(*x, gauge_y)].bg;
            colors.contains(&background)
                || background == context.segmented_inactive()
                || background == context.muted()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        gauge.last().unwrap() - gauge.first().unwrap() + 1,
        gauge.len() as u16
    );
    let mut segment_colors = Vec::new();
    for x in &gauge {
        let cell = &buffer[(*x, gauge_y)];
        // Solid backgrounds fill every cell and cannot acquire the gaps of patterned glyphs.
        assert_eq!(cell.symbol(), " ");
        assert!(!cell.modifier.contains(Modifier::REVERSED));
        if segment_colors.last() != Some(&cell.bg) {
            segment_colors.push(cell.bg);
        }
    }
    assert_eq!(
        segment_colors,
        [
            colors[0],
            colors[1],
            colors[2],
            colors[3],
            context.segmented_inactive(),
            context.muted(),
        ]
    );
    let reserve_cells = gauge
        .iter()
        .filter(|x| buffer[(**x, gauge_y)].bg == context.muted())
        .count();
    assert!(reserve_cells.abs_diff(gauge.len() / 10) <= 2);
    assert!(!segment_colors.contains(&colors[4]));
    for glyph in ['░', '▒', '▓', '▚', '▤', '▧'] {
        assert!(!text.contains(glyph));
    }
    let labels = [
        "系统提示词",
        "工具定义",
        "记忆／指令文件",
        "技能",
        "对话／工具",
        "剩余空间",
        "自动压缩 buffer",
    ];
    let positions = labels.map(|label| text.find(label).unwrap());
    assert!(positions.windows(2).all(|pair| pair[0] < pair[1]), "{text}");
    assert!(text.contains("10.2k / 1m tokens（1.0%）"), "{text}");
    assert!(text.contains("894.9k (89.5%)"), "{text}");
    assert!(!text.contains("压缩方式"), "{text}");
    assert!(!text.contains("分层摘要"), "{text}");
    assert!(!text.contains("输出预留"), "{text}");
    assert!(!text.contains("安全余量"), "{text}");
    text
}

#[test]
fn context_panel_fullscreen_handoff() {
    let text = exercise_handoff_panel(ScreenMode::Fullscreen);
    crate::tui_assert_snapshot!(mode = ScreenMode::Fullscreen; "context_panel_handoff", text);
}

#[test]
fn context_panel_inline_handoff() {
    let text = exercise_handoff_panel(ScreenMode::Inline);
    crate::tui_assert_snapshot!(mode = ScreenMode::Inline; "context_panel_handoff", text);
}

fn exercise_handoff_panel(mode: ScreenMode) -> String {
    let mut app = app(mode, Language::Chinese);
    app.insert_text("继续当前任务");
    let mut context = inspection(12_345, Some(79_000));
    context.compaction_policy = ash_protocol::ContextCompactionPolicy::Handoff {
        buffer_tokens: 16_000,
        state_tokens: 8_000,
    };
    let allocation = context.allocation.as_mut().unwrap();
    allocation.auto_compact_buffer = 18_000;
    allocation.auto_compact_window = 82_000;
    app.update(crate::context::Event::Opened(crate::context::panel(
        context.clone(),
        &context_catalog(),
    )));
    let (buffer, text) = frame(&app, 100, 26);
    assert!(!text.contains("压缩方式"), "{text}");
    assert!(!text.contains("保存进度后换窗口"), "{text}");
    assert!(!text.contains("交接预留"), "{text}");
    assert!(text.contains("自动压缩 buffer"), "{text}");
    assert!(text.contains("18k (18.0%)"), "{text}");
    assert!(text.contains("79k (79.0%)"), "{text}");
    assert!(!text.contains("安全余量"));
    assert!(!text.contains("输出预留"));
    assert!(!text.contains("自动压缩窗口"));
    let gauge_y = text
        .lines()
        .position(|line| line.contains("12.3k / 100k"))
        .unwrap() as u16
        + 1;
    let colors = app.render_context().identity_colors();
    for cell in (0..100).map(|x| &buffer[(x, gauge_y)]).filter(|cell| {
        colors.contains(&cell.bg)
            || cell.bg == app.render_context().segmented_inactive()
            || cell.bg == app.render_context().muted()
    }) {
        assert_eq!(cell.symbol(), " ");
    }
    key(&mut app, KeyCode::Esc);
    assert!(app.command_panel().is_none());
    assert_eq!(app.input(), "继续当前任务");
    app.update(crate::context::Event::Opened(
        crate::context::diagnostics_panel(context, Vec::new(), &context_catalog()),
    ));
    let diagnostics = frame(&app, 100, 36).1;
    assert!(diagnostics.contains("开发者：上下文诊断"), "{diagnostics}");
    assert!(diagnostics.contains("压缩方式"), "{diagnostics}");
    assert!(diagnostics.contains("保存进度后换窗口"), "{diagnostics}");
    assert!(diagnostics.contains("交接预留"), "{diagnostics}");
    assert!(diagnostics.contains("18k (18.0%)"), "{diagnostics}");
    key(&mut app, KeyCode::Esc);
    assert_eq!(app.input(), "继续当前任务");
    format!("Context usage\n{text}\n\nDeveloper diagnostics\n{diagnostics}")
}
