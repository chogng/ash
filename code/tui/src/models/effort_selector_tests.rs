use super::*;
use crate::render::RenderTheme;
use crate::render::ThemePalette;
use ash_terminal_detection::ColorLevel;
use crossterm::event::KeyModifiers;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use std::time::Duration;

fn key(selector: &mut EffortSelector, code: KeyCode) -> Outcome {
    selector.handle_key(KeyEvent::new(code, KeyModifiers::NONE))
}

fn render(selector: &EffortSelector, width: u16, context: RenderContext<'_>) -> Buffer {
    let height = selector.body_rows(width, context);
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal
        .draw(|frame| selector.draw(frame, frame.area(), None, None, context))
        .unwrap();
    terminal.backend().buffer().clone()
}

fn text(buffer: &Buffer) -> String {
    crate::terminal::text::text_in_range(
        buffer,
        crate::terminal::text::ScreenSelectionRange::new(
            Position::new(buffer.area.x, buffer.area.y),
            Position::new(buffer.area.right() - 1, buffer.area.bottom() - 1),
        ),
    )
    .unwrap()
}

#[test]
fn effort_selector_stages_edits_and_restores_the_original_task_mode() {
    let levels = [
        ReasoningEffort::Low,
        ReasoningEffort::High,
        ReasoningEffort::Max,
    ];
    for mode in [
        CollaborationMode::Agent,
        CollaborationMode::Plan,
        CollaborationMode::Debug,
        CollaborationMode::Ask,
        CollaborationMode::Multitask,
    ] {
        let mut selector = EffortSelector::new(&levels, Some(ReasoningEffort::High), mode);
        key(&mut selector, KeyCode::Left);
        key(&mut selector, KeyCode::Left);
        key(&mut selector, KeyCode::Tab);
        key(&mut selector, KeyCode::Tab);
        assert!(matches!(key(&mut selector, KeyCode::Enter),
            Outcome::Apply { effort: ReasoningEffort::Low, mode: result } if result == mode));
        assert!(matches!(key(&mut selector, KeyCode::Esc), Outcome::Dismiss));
    }
    let mut selector = EffortSelector::new(&levels, None, CollaborationMode::Multitask);
    key(&mut selector, KeyCode::Tab);
    assert!(matches!(
        key(&mut selector, KeyCode::Enter),
        Outcome::Apply {
            mode: CollaborationMode::Agent,
            ..
        }
    ));
}

#[test]
fn effort_selector_held_arrows_adjust_but_held_controls_do_not_apply_or_toggle() {
    let mut selector = EffortSelector::new(
        &[
            ReasoningEffort::Low,
            ReasoningEffort::High,
            ReasoningEffort::Max,
        ],
        Some(ReasoningEffort::Low),
        CollaborationMode::Agent,
    );
    key(&mut selector, KeyCode::Right);
    let repeat = |code| KeyEvent::new_with_kind(code, KeyModifiers::NONE, KeyEventKind::Repeat);
    selector.handle_key(repeat(KeyCode::Right));
    assert_eq!(selector.selected, 2);
    for code in [KeyCode::Tab, KeyCode::Enter, KeyCode::Esc] {
        assert!(matches!(
            selector.handle_key(repeat(code)),
            Outcome::Consumed
        ));
    }
    assert!(matches!(
        key(&mut selector, KeyCode::Enter),
        Outcome::Apply {
            effort: ReasoningEffort::Max,
            mode: CollaborationMode::Agent
        }
    ));
}

#[test]
fn effort_selector_max_colors_advance_on_fixed_ticks_and_stop_after_selection_changes() {
    for palette in [ThemePalette::dark(), ThemePalette::light()] {
        let theme = RenderTheme::from_palette(palette, ColorLevel::TrueColor);
        let context = RenderContext::new(&theme, 0);
        let mut selector = EffortSelector::new(
            &[ReasoningEffort::Low, ReasoningEffort::Max],
            Some(ReasoningEffort::Max),
            CollaborationMode::Agent,
        );
        let first = render(&selector, 80, context);
        let layout = selector.layout(first.area, context);
        let max = layout.levels[1].label;
        assert_eq!(first[(max.x, max.y)].symbol(), "m");
        assert_eq!(first[(max.x, max.y)].fg, context.danger());
        assert_eq!(first[(max.x + 1, max.y)].fg, context.warning());
        assert_eq!(first[(max.x + 2, max.y)].fg, context.success());
        assert_eq!(first[(max.x + 1, max.y - 1)].symbol(), "▲");
        assert!(selector.tick(selector.opened + Duration::from_millis(160)));
        let second = render(&selector, 80, context);
        assert_eq!(text(&first), text(&second));
        assert_eq!(second[(max.x, max.y)].fg, context.warning());
        assert_ne!(first[(max.x, max.y)].fg, second[(max.x, max.y)].fg);
        assert!(!selector.tick(selector.opened + Duration::from_millis(160)));
        assert_eq!(second, render(&selector, 80, context));
        key(&mut selector, KeyCode::Left);
        assert!(!selector.tick(selector.opened + Duration::from_secs(2)));
        assert_eq!(
            render(&selector, 80, context)[(max.x, max.y)].fg,
            context.muted()
        );
    }
}

#[test]
fn effort_selector_centers_a_bounded_group_and_labels_both_axis_ends() {
    let context = crate::render::test_context();
    let mut selector = EffortSelector::new(
        &[
            ReasoningEffort::Low,
            ReasoningEffort::High,
            ReasoningEffort::Max,
        ],
        Some(ReasoningEffort::High),
        CollaborationMode::Agent,
    );
    for width in [120, 200] {
        let buffer = render(&selector, width, context);
        let layout = selector.layout(buffer.area, context);
        assert_eq!(layout.axis.width, 31);
        let left = layout.axis.x;
        let right = width - layout.toggle.right();
        assert!(left.abs_diff(right) <= 1);
        assert!(left >= 20);
        assert_eq!(buffer[(layout.axis.x, 0)].symbol(), "F");
        assert_eq!(buffer[(layout.axis.right() - 7, 0)].symbol(), "S");
        assert_eq!(buffer[(layout.axis.right() - 1, 0)].symbol(), "r");
        let high = layout.levels[1].label;
        assert_eq!(buffer[(high.x + 2, layout.axis.y)].symbol(), "▲");
        assert_eq!(
            selector.target_at(buffer.area, Position::new(high.x, high.y), context),
            Some(Target::Level(1))
        );
        assert_eq!(
            selector.target_at(
                buffer.area,
                Position::new(layout.toggle.x, layout.toggle.y),
                context
            ),
            Some(Target::Multitask)
        );
        assert_eq!(
            selector.target_at(buffer.area, Position::new(0, high.y), context),
            None
        );
        assert_eq!(layout.description.width, 84);
        assert!(!text(&buffer).contains("Current:"));
        assert!(!text(&buffer).contains("Ash coordinates"));
    }
    crate::tui_assert_snapshot!(
        "effort_selector_centered_wide",
        text(&render(&selector, 120, context))
    );
    for width in [73, 120] {
        let rows = selector.body_rows(width, context);
        let area = Rect::new(0, 0, width, rows);
        let before = selector.layout(area, context);
        key(&mut selector, KeyCode::Tab);
        let enabled = selector.layout(area, context);
        assert_eq!(before.axis, enabled.axis);
        assert_eq!(before.toggle, enabled.toggle);
        assert_eq!(rows, selector.body_rows(width, context));
        key(&mut selector, KeyCode::Tab);
    }
}

#[test]
fn effort_selector_generates_uniform_ticks_from_catalog_level_counts() {
    let supported = [
        ReasoningEffort::None,
        ReasoningEffort::Minimal,
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
        ReasoningEffort::ExtraHigh,
        ReasoningEffort::Max,
    ];
    let context = crate::render::test_context();
    let mut screens = Vec::new();
    for count in [1, 2, 3, 5, 7] {
        let levels = &supported[..count];
        let model = ash_protocol::ModelRef::new(
            ash_protocol::ProviderId::new("test-provider").unwrap(),
            ash_protocol::ModelId::new("test-model").unwrap(),
        );
        let mut info = ash_protocol::ModelInfo::new(model.model.clone(), "Test model");
        info.supported_reasoning_efforts = levels.to_vec();
        info.model_reasoning_effort = levels.last().copied();
        let catalog = ash_app_server_protocol::protocol::model::ModelListResult {
            models: vec![
                ash_app_server_protocol::protocol::model::ModelCatalogEntry::from_info(
                    model, &info,
                ),
            ],
        };
        let mut config = crate::test_support::empty_config_snapshot();
        config.model = Some(ash_app_server_protocol::protocol::config::ModelRefDto {
            provider: "test-provider".into(),
            model: "test-model".into(),
        });
        let data = crate::models::ModelPickerData::new(catalog, config);
        let mut selector = data.effort_selector(CollaborationMode::Agent).unwrap();
        assert_eq!(selector.levels, levels);
        assert_eq!(selector.selected, count - 1);
        let buffer = render(&selector, 120, context);
        let layout = selector.layout(buffer.area, context);
        assert_eq!(layout.levels.len(), count);
        for pair in layout.levels.windows(2) {
            assert_eq!(pair[1].marker.x - pair[0].marker.x, 12);
            assert_eq!(pair[0].hit_area.right(), pair[1].hit_area.x);
        }
        for level in &layout.levels {
            assert_eq!(level.marker.x, level.label.x + level.label.width / 2);
            assert_eq!(
                buffer[level.label.as_position()].symbol(),
                &levels[level.index].as_str()[..1]
            );
            assert_eq!(
                selector.target_at(buffer.area, level.label.as_position(), context),
                Some(Target::Level(level.index))
            );
        }
        let selected = &layout.levels[count - 1];
        assert_eq!(buffer[selected.marker].symbol(), "▲");
        assert_eq!(buffer[selected.marker].fg, context.focus());
        if count == 1 {
            assert_eq!(
                selected.marker.x - layout.axis.x,
                (layout.axis.width - 1) / 2
            );
        }
        screens.push(format!("{count} levels\n{}", text(&buffer)));
        assert!(
            matches!(key(&mut selector, KeyCode::Enter), Outcome::Apply { effort, .. } if effort == levels[count - 1])
        );
    }
    crate::tui_assert_snapshot!("effort_selector_catalog_level_counts", screens.join("\n\n"));
}

#[test]
fn effort_selector_compresses_then_scrolls_without_losing_selected_ticks() {
    let levels = [
        ReasoningEffort::None,
        ReasoningEffort::Minimal,
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
        ReasoningEffort::ExtraHigh,
        ReasoningEffort::Max,
    ];
    let context = crate::render::test_context();
    for width in [1, 8, 12, 24, 40, 64, 80, 120] {
        let mut selector = EffortSelector::new(&levels, Some(levels[0]), CollaborationMode::Agent);
        for selected in 0..levels.len() {
            let buffer = render(&selector, width, context);
            let layout = selector.layout(buffer.area, context);
            let tick = layout
                .levels
                .iter()
                .find(|level| level.index == selected)
                .unwrap();
            assert_eq!(buffer[tick.marker].symbol(), "▲");
            assert_eq!(tick.label.intersection(buffer.area), tick.label);
            if width >= 9 {
                assert_eq!(tick.label.width as usize, levels[selected].as_str().len());
            }
            for pair in layout.levels.windows(2) {
                assert!(pair[1].marker.x - pair[0].marker.x <= 12);
                assert!(pair[0].label.right() < pair[1].label.x);
            }
            assert_eq!(layout.levels[0].hit_area.x, layout.axis.x);
            assert_eq!(
                layout.levels.last().unwrap().hit_area.right(),
                layout.axis.right()
            );
            for level in &layout.levels {
                for x in level.hit_area.x..level.hit_area.right() {
                    assert_eq!(
                        selector.target_at(
                            buffer.area,
                            Position::new(x, level.hit_area.y),
                            context
                        ),
                        Some(Target::Level(level.index))
                    );
                }
            }
            if width == 80 {
                assert_eq!(layout.levels.len(), levels.len());
                assert_eq!(layout.levels[1].marker.x - layout.levels[0].marker.x, 11);
            }
            key(&mut selector, KeyCode::Right);
        }
        for selected in (0..levels.len()).rev() {
            let buffer = render(&selector, width, context);
            assert!(
                selector
                    .layout(buffer.area, context)
                    .levels
                    .iter()
                    .any(|level| level.index == selected)
            );
            key(&mut selector, KeyCode::Left);
        }
    }
}

#[test]
fn effort_selector_multitask_wave_moves_without_changing_text_or_effort() {
    for palette in [ThemePalette::dark(), ThemePalette::light()] {
        for capability in [ColorLevel::TrueColor, ColorLevel::Ansi256] {
            let theme = RenderTheme::from_palette(palette, capability).with_terminal_defaults();
            let context = RenderContext::new(&theme, 0);
            let mut selector = EffortSelector::new(
                &[ReasoningEffort::Low, ReasoningEffort::High],
                Some(ReasoningEffort::High),
                CollaborationMode::Multitask,
            );
            let first = render(&selector, 120, context);
            let toggle = selector.layout(first.area, context).toggle;
            let head = (toggle.x, toggle.y);
            let middle = (toggle.x + 4, toggle.y);
            assert_eq!(
                first[head].fg,
                context.mode_color(CollaborationMode::Multitask)
            );
            assert_ne!(first[head].fg, first[middle].fg);
            assert!(first[head].modifier.contains(Modifier::BOLD));
            let halfway = selector.opened + Duration::from_millis(1920);
            assert!(selector.tick(halfway));
            let second = render(&selector, 120, context);
            assert_eq!(text(&first), text(&second));
            assert_ne!(first[head].fg, second[head].fg);
            assert_ne!(first[middle].fg, second[middle].fg);
            assert!(!selector.tick(halfway));
            assert_eq!(second, render(&selector, 120, context));
            assert!(selector.tick(selector.opened + Duration::from_millis(3840)));
            assert_eq!(first, render(&selector, 120, context));
            key(&mut selector, KeyCode::Tab);
            assert!(!selector.tick(selector.opened + Duration::from_secs(5)));
            let disabled = render(&selector, 120, context);
            assert_eq!(disabled[head].fg, context.foreground());
            assert!(!disabled[head].modifier.contains(Modifier::BOLD));
            assert!(matches!(
                key(&mut selector, KeyCode::Enter),
                Outcome::Apply {
                    effort: ReasoningEffort::High,
                    mode: CollaborationMode::Agent
                }
            ));
        }
    }
}

#[test]
fn effort_selector_multitask_wave_preserves_hover_and_press_feedback() {
    let context = crate::render::test_context();
    let mut selector = EffortSelector::new(
        &[ReasoningEffort::High],
        Some(ReasoningEffort::High),
        CollaborationMode::Multitask,
    );
    selector.tick(selector.opened + Duration::from_millis(1920));
    let mut terminal =
        Terminal::new(TestBackend::new(120, selector.body_rows(120, context))).unwrap();
    let toggle = selector
        .layout(terminal.backend().buffer().area, context)
        .toggle;
    for pressed in [None, Some(Target::Multitask)] {
        terminal
            .draw(|frame| {
                selector.draw(
                    frame,
                    frame.area(),
                    Some(Target::Multitask),
                    pressed,
                    context,
                )
            })
            .unwrap();
        let cell = &terminal.backend().buffer()[(toggle.x, toggle.y)];
        assert_eq!(
            cell.bg,
            if pressed.is_some() {
                context.pressed_background()
            } else {
                context.hover_background()
            }
        );
        assert_eq!(
            cell.fg,
            if pressed.is_some() {
                context.pressed_foreground()
            } else {
                context.hover_foreground()
            }
        );
        assert!(cell.modifier.contains(Modifier::BOLD));
        assert!(matches!(
            key(&mut selector, KeyCode::Enter),
            Outcome::Apply {
                effort: ReasoningEffort::High,
                mode: CollaborationMode::Multitask
            }
        ));
    }
}

#[test]
fn effort_selector_narrow_layout_keeps_selected_levels_and_pointer_targets_aligned() {
    let context = crate::render::test_context();
    let levels = [
        ReasoningEffort::None,
        ReasoningEffort::Minimal,
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
        ReasoningEffort::ExtraHigh,
        ReasoningEffort::Max,
    ];
    let mut selector = EffortSelector::new(
        &levels,
        Some(ReasoningEffort::Max),
        CollaborationMode::Agent,
    );
    for width in [24, 40, 80] {
        let buffer = render(&selector, width, context);
        assert!(text(&buffer).contains("max"));
        for level in selector.layout(buffer.area, context).levels {
            let rect = level.hit_area;
            for x in rect.x..rect.right() {
                assert_eq!(
                    selector.target_at(buffer.area, Position::new(x, rect.y), context),
                    Some(Target::Level(level.index))
                );
            }
        }
    }
    let buffer = render(&selector, 40, context);
    crate::tui_assert_snapshot!("effort_selector_narrow", text(&buffer));
    let toggle = selector.layout(buffer.area, context).toggle;
    assert_eq!(
        selector.target_at(buffer.area, Position::new(toggle.x, toggle.y), context),
        Some(Target::Multitask)
    );
    selector.activate(Target::Multitask);
    selector.activate(Target::Level(0));
    assert!(matches!(
        key(&mut selector, KeyCode::Enter),
        Outcome::Apply {
            effort: ReasoningEffort::None,
            mode: CollaborationMode::Multitask
        }
    ));
}

#[test]
fn effort_selector_localizes_live_content_and_wrapped_descriptions() {
    let theme = RenderTheme::from_palette(ThemePalette::light(), ColorLevel::TrueColor);
    let context = RenderContext::new(&theme, 0).with_language(crate::nls::Language::Chinese);
    let selector = EffortSelector::new(
        &[
            ReasoningEffort::Low,
            ReasoningEffort::High,
            ReasoningEffort::Max,
        ],
        Some(ReasoningEffort::Max),
        CollaborationMode::Multitask,
    );
    let buffer = render(&selector, 60, context);
    let content = text(&buffer);
    assert!(content.contains("更快"));
    assert!(content.contains("更聪明"));
    assert!(!content.contains("当前："));
    assert!(!content.contains("由 Ash 协调"));
    assert!(content.contains("多任务  开启"));
    assert!(content.contains("最高推理强度"));
    crate::tui_assert_snapshot!("effort_selector_chinese", content);
}

#[test]
fn effort_selector_hover_and_press_do_not_change_the_keyboard_selection() {
    let context = crate::render::test_context();
    let selector = EffortSelector::new(
        &[
            ReasoningEffort::Low,
            ReasoningEffort::High,
            ReasoningEffort::Max,
        ],
        Some(ReasoningEffort::Low),
        CollaborationMode::Agent,
    );
    let mut terminal =
        Terminal::new(TestBackend::new(80, selector.body_rows(80, context))).unwrap();
    let layout = selector.layout(terminal.backend().buffer().area, context);
    let high = layout.levels[1].label;
    let target = Target::Level(1);
    for pressed in [None, Some(target)] {
        terminal
            .draw(|frame| selector.draw(frame, frame.area(), Some(target), pressed, context))
            .unwrap();
        let cell = &terminal.backend().buffer()[(high.x, high.y)];
        assert_eq!(
            cell.bg,
            if pressed.is_some() {
                context.pressed_background()
            } else {
                context.hover_background()
            }
        );
        assert_eq!(selector.selected, 0);
        let low = layout.levels[0].label;
        assert_eq!(
            terminal.backend().buffer()[(low.x + 1, low.y - 1)].symbol(),
            "▲"
        );
    }
}
