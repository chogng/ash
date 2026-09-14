use super::*;
use crate::config::TerminalSettings;
use crate::status::StatusLineSettings;
use ash_app_server_protocol::protocol::config::ModelContextConfigDto;

fn panel() -> Panel {
    Panel::new(Settings::new(
        &crate::test_support::empty_config_snapshot(),
        &ProviderListResult {
            providers: Vec::new(),
        },
        "",
    ))
}
fn key(panel: &mut Panel, code: KeyCode) -> ConfigEditorOutcome {
    panel.handle_key(KeyEvent::new(code, KeyModifiers::NONE))
}
fn populated() -> Panel {
    let mut panel = panel();
    panel.name.accept("My gateway".into());
    panel
        .url
        .accept(" https://example.test/gateway/v1/ ".into());
    panel.model.accept("private-model-alias".into());
    panel
}
fn request(outcome: ConfigEditorOutcome) -> Request {
    let ConfigEditorOutcome::Action(ConfigSelectionAction::Connection(request)) = outcome else {
        panic!("expected request");
    };
    request
}
fn choices() -> ConfigChoices {
    super::super::config_choices(
        &crate::test_support::empty_config_snapshot(),
        &ProviderListResult {
            providers: Vec::new(),
        },
        TerminalSettings::default(),
        StatusLineSettings::default(),
    )
}

#[test]
fn urls_keep_version_and_gateway_paths_and_strip_only_matching_operations() {
    use CustomProviderProtocolDto::*;
    for (input, protocol, expected) in [
        (" https://example.test/ ", Responses, "https://example.test"),
        (
            "https://example.test/v1/",
            Responses,
            "https://example.test/v1",
        ),
        (
            "https://example.test/gateway/v1/responses/",
            Responses,
            "https://example.test/gateway/v1",
        ),
        (
            "https://example.test/v1beta/openai/chat/completions",
            ChatCompletions,
            "https://example.test/v1beta/openai",
        ),
        (
            "https://example.test/v1/messages",
            AnthropicMessages,
            "https://example.test/v1",
        ),
    ] {
        assert_eq!(normalize_url(input, protocol).unwrap(), expected);
    }
    for input in [
        "https://example.test/messages",
        "https://user:secret@example.test",
        "file:///tmp/api",
        "https://example.test?key=x",
    ] {
        assert!(normalize_url(input, Responses).is_err());
    }
}

#[test]
fn save_keeps_original_model_id_and_selected_context_without_output_override() {
    let mut panel = populated();
    panel.focus = 5;
    let request = request(key(&mut panel, KeyCode::Right));
    assert_eq!(request.operation, Operation::Save);
    assert_eq!(
        request.config.base_url.as_deref(),
        Some("https://example.test/gateway/v1")
    );
    assert_eq!(
        request.config.custom.as_ref().unwrap().context_window,
        1_000_000
    );
    assert_eq!(request.config.max_output_tokens, None);
    panel.complete(Reply {
        id: request.id,
        result: Ok((choices(), None)),
    });
}

#[test]
fn test_uses_unsaved_values_ignores_stale_results_and_clears_when_edited() {
    let mut panel = populated();
    panel.focus = 6;
    let request = request(key(&mut panel, KeyCode::Enter));
    assert!(panel.is_testing());
    assert!(matches!(
        key(&mut panel, KeyCode::Enter),
        ConfigEditorOutcome::Consumed
    ));
    panel.complete(Reply {
        id: new_command_id("stale"),
        result: Ok((choices(), Some(Ok(Vec::new())))),
    });
    assert!(panel.is_testing());
    panel.complete(Reply {
        id: request.id,
        result: Ok((choices(), Some(Ok(Vec::new())))),
    });
    assert!(matches!(panel.status, TestStatus::Passed));
    panel.focus = 5;
    key(&mut panel, KeyCode::Right);
    assert!(matches!(panel.status, TestStatus::Untested));
}

#[test]
fn failure_preserves_inputs_and_allows_another_test() {
    let mut panel = populated();
    panel.focus = 6;
    let first = request(key(&mut panel, KeyCode::Enter));
    panel.complete(Reply {
        id: first.id,
        result: Ok((choices(), Some(Err("HTTP 401".into())))),
    });
    assert!(matches!(panel.status, TestStatus::Failed));
    assert_eq!(panel.model.query(), "private-model-alias");
    assert_eq!(panel.message, "HTTP 401");
    assert_eq!(
        request(key(&mut panel, KeyCode::Enter)).operation,
        Operation::Test
    );
}

#[test]
fn empty_model_id_tests_the_selected_builtin_id_on_the_custom_endpoint() {
    let mut panel = populated();
    panel.model.accept(String::new());
    panel.settings.inherited_model = Some("gpt-5.6".into());
    panel.focus = 6;
    let request = request(key(&mut panel, KeyCode::Enter));
    assert_eq!(request.model.as_deref(), Some("gpt-5.6"));
    assert!(request.config.provider.starts_with("custom-"));
    assert!(request.config.custom.unwrap().model.is_none());
}

#[test]
fn context_defaults_to_272k_and_test_requires_a_model() {
    let mut panel = populated();
    assert_eq!(panel.context, 272_000);
    panel.model.accept(String::new());
    panel.focus = 6;
    assert!(matches!(
        key(&mut panel, KeyCode::Enter),
        ConfigEditorOutcome::Consumed
    ));
    assert!(panel.pending.is_none());
    assert!(panel.message.contains("model ID"));
    panel.focus = 5;
    assert_eq!(
        request(key(&mut panel, KeyCode::Right)).operation,
        Operation::Save
    );
}

#[test]
fn keyboard_navigation_reaches_all_fields_and_test_is_last() {
    let mut panel = panel();
    for expected in 1..=6 {
        key(&mut panel, KeyCode::Tab);
        assert_eq!(panel.focus, expected);
    }
    key(&mut panel, KeyCode::Down);
    assert_eq!(panel.focus, 6);
    for expected in (0..6).rev() {
        key(&mut panel, KeyCode::BackTab);
        assert_eq!(panel.focus, expected);
    }
    assert!(matches!(
        key(&mut panel, KeyCode::Esc),
        ConfigEditorOutcome::Dismiss
    ));
}

#[test]
fn saved_model_selection_survives_other_model_ids_and_can_be_cleared() {
    let mut panel = populated();
    panel.settings.config.model_context.insert(
        "aaa-old-model".into(),
        ModelContextConfigDto {
            context_window: 272_000,
            auto_compact_token_limit: None,
        },
    );
    let config = panel.config().unwrap();
    let reopened = Panel::new(Settings {
        revision: 1,
        config,
        key_saved: false,
        inherited_model: None,
    });
    assert_eq!(reopened.model.query(), "private-model-alias");
    panel.model.accept(String::new());
    let reopened = Panel::new(Settings {
        revision: 2,
        config: panel.config().unwrap(),
        key_saved: false,
        inherited_model: None,
    });
    assert!(reopened.model.query().is_empty());
    assert!(reopened.settings.config.model_context.is_empty());
}

fn render(panel: &Panel, width: u16, height: u16, now: Instant) -> ratatui::buffer::Buffer {
    let mut terminal =
        ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height)).unwrap();
    terminal
        .draw(|frame| {
            panel.draw_body_at(
                frame,
                Rect::new(2, 0, width.saturating_sub(4), height),
                crate::render::test_context(),
                now,
            )
        })
        .unwrap();
    terminal.backend().buffer().clone()
}

fn text(buffer: &ratatui::buffer::Buffer) -> String {
    buffer
        .content
        .chunks(buffer.area.width as usize)
        .map(|row| {
            row.iter()
                .map(|cell| cell.symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn focus_test(panel: &mut Panel) {
    for _ in 0..6 {
        key(panel, KeyCode::Tab);
    }
    assert_eq!(panel.focus, 6);
}

fn begin_test(panel: &mut Panel) -> (Request, Instant) {
    focus_test(panel);
    let request = request(key(panel, KeyCode::Enter));
    assert_eq!(request.operation, Operation::Test);
    let TestStatus::Running(start) = panel.status else {
        panic!("expected running test")
    };
    (request, start)
}

#[test]
fn new_provider_shows_all_fields() {
    let panel = panel();
    assert_eq!(panel.focus, 0);
    let buffer = render(&panel, 80, 25, Instant::now());
    assert_eq!(buffer[(0, 0)].symbol(), ">");
    assert_eq!(buffer[(0, 1)].symbol(), " ");
    assert_eq!(buffer[(2, 1)].symbol(), "╭");
    assert_eq!(buffer[(0, 2)].symbol(), " ");
    assert_eq!(buffer[(2, 2)].symbol(), "│");
    assert_eq!(buffer[(2, 0)].symbol(), "P");
    assert_eq!(buffer[(4, 2)].symbol(), "P");
    crate::tui_assert_snapshot!(text(&render(&panel, 80, 25, Instant::now())));
}

#[test]
fn narrow_provider_keeps_focused_inputs_visible() {
    let panel = populated();
    crate::tui_assert_snapshot!(text(&render(&panel, 36, 14, Instant::now())));
}

#[test]
fn narrow_provider_scrolls_to_last_test_action() {
    let mut panel = populated();
    focus_test(&mut panel);
    let buffer = render(&panel, 36, 14, Instant::now());
    assert_eq!(buffer[(0, 10)].symbol(), "●");
    crate::tui_assert_snapshot!(text(&buffer));
}

#[test]
fn untested_provider_masks_key_and_keeps_marker_in_leading_column() {
    let mut panel = populated();
    panel.key.accept("synthetic-secret".into());
    focus_test(&mut panel);
    let buffer = render(&panel, 80, 25, Instant::now());
    assert!(!text(&buffer).contains("synthetic-secret"));
    assert_eq!(buffer[(0, 18)].symbol(), "●");
    assert_eq!(buffer[(0, 18)].fg, crate::render::test_context().muted());
    assert!(buffer[(0, 18)].modifier.contains(Modifier::DIM));
    assert_eq!(buffer[(2, 18)].fg, crate::render::test_context().focus());
    crate::tui_assert_snapshot!(text(&buffer));
}

#[test]
fn running_provider_shows_pending_feedback() {
    let mut panel = populated();
    let (_, start) = begin_test(&mut panel);
    crate::tui_assert_snapshot!(text(&render(&panel, 80, 25, start)));
}

#[test]
fn passed_provider_shows_success_feedback() {
    let mut panel = populated();
    let (request, start) = begin_test(&mut panel);
    panel.complete(Reply {
        id: request.id,
        result: Ok((choices(), Some(Ok(Vec::new())))),
    });
    assert!(matches!(panel.status, TestStatus::Passed));
    let buffer = render(&panel, 80, 25, start);
    assert_eq!(buffer[(0, 18)].symbol(), "●");
    assert_eq!(buffer[(0, 18)].fg, crate::render::test_context().success());
    assert_eq!(buffer[(0, 18)].modifier, Modifier::empty());
    assert_eq!(buffer[(2, 18)].fg, crate::render::test_context().focus());
    crate::tui_assert_snapshot!(text(&buffer));
}

#[test]
fn failed_provider_shows_reason_and_warning_feedback() {
    let mut panel = populated();
    let (request, start) = begin_test(&mut panel);
    panel.complete(Reply {
        id: request.id,
        result: Ok((
            choices(),
            Some(Err("Authentication failed (HTTP 401)".into())),
        )),
    });
    assert!(matches!(panel.status, TestStatus::Failed));
    let buffer = render(&panel, 80, 25, start);
    assert_eq!(buffer[(0, 18)].symbol(), "●");
    assert_eq!(buffer[(0, 18)].fg, crate::render::test_context().warning());
    assert_eq!(buffer[(0, 18)].modifier, Modifier::empty());
    crate::tui_assert_snapshot!(text(&buffer));
}

#[test]
fn testing_marker_breathes_deterministically_without_moving_or_changing_text() {
    use ratatui::style::Color;
    use std::time::Duration;
    let mut panel = populated();
    let (_, start) = begin_test(&mut panel);
    let first = render(&panel, 80, 25, start);
    // The fixed dark theme's muted gray is 128. The marker remains dark gray,
    // brightens halfway through its 1.6-second cycle, then returns to its start.
    for (millis, gray) in [(0, 44), (800, 83), (1600, 44)] {
        let now = start + Duration::from_millis(millis);
        let buffer = render(&panel, 80, 25, now);
        assert_eq!(buffer, render(&panel, 80, 25, now));
        assert_eq!(text(&buffer), text(&first));
        assert_eq!(buffer[(0, 18)].symbol(), "●");
        assert_eq!(buffer[(0, 18)].fg, Color::Rgb(gray, gray, gray));
        assert_eq!(buffer[(0, 18)].modifier, Modifier::empty());
        assert_eq!(buffer[(2, 18)].fg, crate::render::test_context().focus());
    }
}

#[test]
fn editing_context_resets_success_color_and_moves_focus_without_moving_marker() {
    let mut panel = populated();
    let (request, start) = begin_test(&mut panel);
    panel.complete(Reply {
        id: request.id,
        result: Ok((choices(), Some(Ok(Vec::new())))),
    });
    for _ in 0..1 {
        key(&mut panel, KeyCode::Up);
    }
    key(&mut panel, KeyCode::Right);
    assert_eq!(panel.focus, 5);
    assert_eq!(panel.context, 1_000_000);
    assert!(matches!(panel.status, TestStatus::Untested));
    let buffer = render(&panel, 80, 25, start);
    assert_eq!(buffer[(0, 18)].symbol(), "●");
    assert_eq!(buffer[(0, 18)].fg, crate::render::test_context().muted());
    assert!(buffer[(0, 18)].modifier.contains(Modifier::DIM));
    assert_eq!(
        buffer[(2, 18)].fg,
        crate::render::test_context().foreground()
    );
    assert_eq!(buffer[(0, 17)].symbol(), ">");
    assert_eq!(buffer[(2, 17)].fg, crate::render::test_context().focus());
}

#[test]
fn enter_autosaves_complete_fields_and_keeps_focus_for_the_next_edit() {
    let mut panel = panel();
    key(&mut panel, KeyCode::Enter);
    panel.handle_paste("Gateway".into());
    assert!(matches!(
        key(&mut panel, KeyCode::Enter),
        ConfigEditorOutcome::Consumed
    ));
    assert!(panel.pending.is_none());
    key(&mut panel, KeyCode::Down);
    key(&mut panel, KeyCode::Enter);
    panel.handle_paste("https://example.test/v1".into());
    let first = request(key(&mut panel, KeyCode::Enter));
    assert_eq!(first.operation, Operation::Save);
    assert_eq!(panel.focus, 1);
    assert!(matches!(
        key(&mut panel, KeyCode::Esc),
        ConfigEditorOutcome::Consumed
    ));
    let mut saved = crate::test_support::empty_config_snapshot();
    saved.revision = 1;
    saved
        .providers
        .insert(first.config.provider.clone(), first.config.clone());
    panel.complete(Reply {
        id: first.id,
        result: Ok((
            super::super::config_choices(
                &saved,
                &ProviderListResult { providers: vec![] },
                TerminalSettings::default(),
                StatusLineSettings::default(),
            ),
            None,
        )),
    });
    assert_eq!(panel.focus, 1);
    assert!(panel.pending.is_none());
    key(&mut panel, KeyCode::Down);
    key(&mut panel, KeyCode::Enter);
    panel.handle_paste("synthetic-key".into());
    let next = request(key(&mut panel, KeyCode::Enter));
    assert_eq!(next.revision, 1);
    assert_eq!(next.config.provider, first.config.provider);
    panel.complete(Reply {
        id: next.id,
        result: Err("Write rejected".into()),
    });
    assert_eq!(panel.key.query(), "synthetic-key");
    assert_eq!(panel.focus, 2);
    assert_eq!(panel.message, "Write rejected");
}

#[test]
fn api_type_uses_one_row_with_the_value_at_the_content_right_edge() {
    for width in [36u16, 80] {
        for (protocol, value) in [
            (CustomProviderProtocolDto::Responses, "OpenAI Responses"),
            (
                CustomProviderProtocolDto::ChatCompletions,
                "OpenAI Chat Completions",
            ),
            (
                CustomProviderProtocolDto::AnthropicMessages,
                "Anthropic Messages",
            ),
        ] {
            let mut panel = panel();
            panel.focus = 4;
            panel.protocol = protocol;
            let buffer = render(&panel, width, 25, Instant::now());
            assert_eq!(buffer[(0, 16)].symbol(), ">");
            assert_eq!(buffer[(2, 16)].symbol(), "A");
            let right_value = (width - 2 - value.len() as u16..width - 2)
                .map(|x| buffer[(x, 16)].symbol())
                .collect::<String>();
            assert_eq!(right_value, value);
            assert_eq!(
                buffer[(width - 3, 16)].fg,
                crate::render::test_context().focus()
            );
            assert_eq!(
                buffer[(2, 12)].symbol(),
                "M",
                "Model ID belongs to the input block above the options"
            );
        }
    }
}

#[test]
fn model_id_is_the_last_input_and_api_type_arrows_autosave_the_next_row() {
    let mut panel = populated();
    panel.model.accept(String::new());
    for _ in 0..3 {
        key(&mut panel, KeyCode::Down);
    }
    key(&mut panel, KeyCode::Enter);
    assert!(panel.model.is_editing());
    panel.handle_paste("gateway-alias".into());
    let model = request(key(&mut panel, KeyCode::Enter));
    assert_eq!(model.operation, Operation::Save);
    assert_eq!(
        model.config.custom.unwrap().model.as_deref(),
        Some("gateway-alias")
    );
    panel.complete(Reply {
        id: model.id,
        result: Err("Synthetic save failure".into()),
    });
    key(&mut panel, KeyCode::Down);
    let api = request(key(&mut panel, KeyCode::Right));
    assert_eq!(api.operation, Operation::Save);
    assert_eq!(
        api.config.custom.unwrap().protocol,
        CustomProviderProtocolDto::ChatCompletions
    );
}

#[test]
fn clicking_fields_starts_editing_and_does_not_submit_on_second_click() {
    let mut panel = panel();
    let area = Rect::new(2, 0, 76, 25);
    let target = panel
        .target_at(area, ratatui::layout::Position::new(10, 6))
        .unwrap();
    assert!(matches!(
        panel.activate(target),
        ConfigEditorOutcome::Consumed
    ));
    key(&mut panel, KeyCode::Char('h'));
    assert_eq!(panel.url.query(), "h");
    assert!(panel.url.is_editing());
    assert!(matches!(
        panel.activate(target),
        ConfigEditorOutcome::Consumed
    ));
    assert!(panel.pending.is_none());
    let name = panel
        .target_at(area, ratatui::layout::Position::new(10, 2))
        .unwrap();
    panel.activate(name);
    key(&mut panel, KeyCode::Char('N'));
    assert_eq!(panel.name.query(), "N");
    assert!(!panel.url.is_editing());
    assert_eq!(panel.url.query(), "h");
    crate::tui_assert_snapshot!(
        "provider_click_to_edit",
        text(&render(&panel, 80, 25, Instant::now()))
    );
}

#[test]
fn scrolled_provider_hit_targets_follow_rendered_fields_and_pending_requests_disable_them() {
    let mut panel = populated();
    panel.focus = 3;
    let area = Rect::new(2, 0, 32, 8);
    let rows = panel.rows(area);
    for (index, row) in rows {
        for y in row.y..row.bottom() {
            assert_eq!(
                panel.target_at(area, ratatui::layout::Position::new(row.x, y)),
                Some(Target(index))
            );
        }
    }
    let target = panel
        .target_at(area, ratatui::layout::Position::new(4, 6))
        .unwrap();
    assert_eq!(target, Target(3));
    panel.activate(target);
    assert!(panel.model.is_editing());
    let request = request(key(&mut panel, KeyCode::Enter));
    assert_eq!(request.operation, Operation::Save);
    assert!(
        panel
            .target_at(area, ratatui::layout::Position::new(4, 6))
            .is_none()
    );
}

#[test]
fn provider_hover_and_press_use_shared_feedback_without_changing_keyboard_focus() {
    let panel = panel();
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 25)).unwrap();
    for pressed in [None, Some(Target(1))] {
        terminal
            .draw(|frame| {
                panel.draw_with_pointer(
                    frame,
                    Rect::new(2, 0, 76, 25),
                    Some(Target(1)),
                    pressed,
                    crate::render::test_context(),
                )
            })
            .unwrap();
        let cell = &terminal.backend().buffer()[(2, 4)];
        assert_eq!(
            cell.bg,
            if pressed.is_some() {
                crate::render::test_context().pressed_background()
            } else {
                crate::render::test_context().hover_background()
            }
        );
        assert_eq!(panel.focus, 0);
    }
}
