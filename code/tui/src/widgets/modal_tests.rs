use super::ModalLayout;
use crate::render::InteractionState;
use crate::render::test_context;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::layout::Rect;

#[test]
fn chrome_remains_inside_resized_terminals() {
    for width in 0..130 {
        for height in 0..45 {
            let available = Rect::new(3, 5, width, height);
            let layout = ModalLayout::new(available, 100, 32);
            assert_eq!(layout.surface.intersection(available), layout.surface);
            for area in [layout.content, layout.footer, layout.title, layout.close] {
                if !area.is_empty() {
                    assert_eq!(area.intersection(layout.surface), area);
                }
            }
            assert!(layout.content.bottom() <= layout.footer.y.max(layout.content.y));
        }
    }
}

#[test]
fn border_uses_the_modal_theme_color() {
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    let layout = ModalLayout::new(Rect::new(0, 0, 40, 12), 32, 10);

    terminal
        .draw(|frame| {
            super::draw(
                frame,
                layout,
                "Config",
                &crate::widgets::key_hint::KeyHints::new().with_action("Esc", "close"),
                InteractionState::default(),
                false,
                crate::config::KeyHintStyle::Contrast,
                test_context(),
            )
        })
        .unwrap();

    assert_eq!(
        terminal.backend().buffer()[(layout.surface.x, layout.surface.y)].fg,
        test_context().modal_border()
    );
}

#[test]
fn border_uses_warning_color_when_blocked_alert_is_active() {
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    let layout = ModalLayout::new(Rect::new(0, 0, 40, 12), 32, 10);

    terminal
        .draw(|frame| {
            super::draw(
                frame,
                layout,
                "Config",
                &crate::widgets::key_hint::KeyHints::new().with_action("Esc", "close"),
                InteractionState::default(),
                true,
                crate::config::KeyHintStyle::Contrast,
                test_context(),
            )
        })
        .unwrap();

    assert_eq!(
        terminal.backend().buffer()[(layout.surface.x, layout.surface.y)].fg,
        test_context().warning()
    );
}

#[test]
fn close_uses_shared_hover_and_pressed_theme_states() {
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    let layout = ModalLayout::new(Rect::new(0, 0, 40, 12), 32, 10);
    let context = test_context();
    let states = [
        (
            InteractionState {
                hovered: true,
                ..InteractionState::default()
            },
            context.hover_foreground(),
            context.hover_background(),
        ),
        (
            InteractionState {
                hovered: true,
                pressed: true,
                ..InteractionState::default()
            },
            context.pressed_foreground(),
            context.pressed_background(),
        ),
    ];

    for (state, foreground, background) in states {
        terminal
            .draw(|frame| {
                super::draw(
                    frame,
                    layout,
                    "Config",
                    &crate::widgets::key_hint::KeyHints::new().with_action("Esc", "close"),
                    state,
                    false,
                    crate::config::KeyHintStyle::Contrast,
                    context,
                )
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        let symbols = (layout.close.x..layout.close.right())
            .map(|column| buffer[(column, layout.close.y)].symbol())
            .collect::<String>();
        assert_eq!(symbols, "[✗]");
        for column in layout.close.x..layout.close.right() {
            assert_eq!(buffer[(column, layout.close.y)].fg, foreground);
            assert_eq!(buffer[(column, layout.close.y)].bg, background);
        }
    }
}
