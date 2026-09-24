use super::append;
use ratatui::Terminal;
use ratatui::TerminalOptions;
use ratatui::Viewport;
use ratatui::backend::Backend;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::widgets::Paragraph;

fn text(buffer: &Buffer) -> String {
    buffer
        .content
        .chunks(usize::from(buffer.area.width))
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

#[test]
fn scrollback_keeps_shell_text_and_inserts_styled_output_above_input() {
    let mut backend = TestBackend::with_lines([
        "SHELL MARKER        ",
        "                    ",
        "                    ",
        "                    ",
        "                    ",
        "                    ",
    ]);
    backend.set_cursor_position((0, 1)).unwrap();
    let mut terminal = Terminal::with_options(
        backend,
        TerminalOptions {
            viewport: Viewport::Inline(2),
        },
    )
    .unwrap();
    terminal
        .draw(|frame| frame.render_widget(Paragraph::new("INPUT"), frame.area()))
        .unwrap();
    append(&mut terminal, 5, |buffer, offset| {
        for row in 0..buffer.area.height {
            buffer.set_string(
                0,
                row,
                format!("RESULT-{}", offset + usize::from(row)),
                Style::default().fg(Color::Green),
            );
        }
    })
    .unwrap();
    terminal
        .draw(|frame| frame.render_widget(Paragraph::new("INPUT"), frame.area()))
        .unwrap();
    let backend = terminal.backend();
    let all = format!("{}\n{}", text(backend.scrollback()), text(backend.buffer()));
    assert!(
        all.starts_with("SHELL MARKER\nRESULT-0\nRESULT-1\nRESULT-2\nRESULT-3\nRESULT-4\nINPUT"),
        "{all}"
    );
    assert_eq!(all.matches("INPUT").count(), 1);
    let green_cells = backend
        .scrollback()
        .content
        .iter()
        .chain(backend.buffer().content.iter())
        .filter(|cell| cell.fg == Color::Green)
        .count();
    assert_eq!(green_cells, 5 * "RESULT-0".len());
    terminal.clear().unwrap();
    let origin = terminal.get_frame().area().as_position();
    terminal.set_cursor_position(origin).unwrap();
    let all = format!(
        "{}\n{}",
        text(terminal.backend().scrollback()),
        text(terminal.backend().buffer())
    );
    assert!(!all.contains("INPUT"));
    assert!(all.contains("RESULT-4"));
}

#[test]
fn scrollback_chunks_long_output_without_losing_or_reordering_rows() {
    let mut terminal = Terminal::with_options(
        TestBackend::new(16, 12),
        TerminalOptions {
            viewport: Viewport::Inline(3),
        },
    )
    .unwrap();
    let mut offsets = Vec::new();
    append(&mut terminal, 600, |buffer, offset| {
        offsets.push((offset, buffer.area.height));
        for row in 0..buffer.area.height {
            buffer.set_string(
                0,
                row,
                format!("ROW-{:03}", offset + usize::from(row)),
                Style::default(),
            );
        }
    })
    .unwrap();
    assert_eq!(offsets, [(0, 256), (256, 256), (512, 88)]);
    let all = format!(
        "{}\n{}",
        text(terminal.backend().scrollback()),
        text(terminal.backend().buffer())
    );
    let actual = all
        .lines()
        .filter(|line| line.starts_with("ROW-"))
        .collect::<Vec<_>>();
    let expected = (0..600)
        .map(|row| format!("ROW-{row:03}"))
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
}
