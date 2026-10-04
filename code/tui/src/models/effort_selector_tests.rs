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
        assert_eq!(selector.current, Some(ReasoningEffort::High));
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
        let max = layout.levels[1].1;
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
        for (index, rect) in selector.layout(buffer.area, context).levels {
            for x in rect.x..rect.right() {
                assert_eq!(
                    selector.target_at(buffer.area, Position::new(x, rect.y), context),
                    Some(Target::Level(index))
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
    assert!(content.contains("当前：max"));
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
    let high = layout.levels[1].1;
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
        let low = layout.levels[0].1;
        assert_eq!(
            terminal.backend().buffer()[(low.x + 1, low.y - 1)].symbol(),
            "▲"
        );
    }
}
