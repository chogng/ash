use super::*;
use crate::render::links::Hyperlink;
use ratatui::layout::Rect;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Widget;

fn frame(destination: &str) -> FrameLinks {
    let mut links = FrameLinks::default();
    links.place(
        &[vec![Hyperlink {
            columns: 0..1,
            destination: destination.into(),
        }]],
        Rect::new(0, 0, 1, 1),
        0,
    );
    links
}

#[test]
fn changed_and_removed_destinations_repaint_even_when_text_is_unchanged() {
    let mut buffer = Buffer::empty(Rect::new(0, 0, 3, 1));
    Paragraph::new("abc").render(buffer.area, &mut buffer);
    let first = frame("https://one.example/");
    let second = frame("https://two.example/");
    let mut backend = CrosstermBackend::new(Vec::new());
    second
        .write(&first, &buffer, Some(&buffer), &mut backend)
        .unwrap();
    let output = String::from_utf8(backend.writer_mut().clone()).unwrap();
    assert!(output.contains("\x1b]8;;https://two.example/\x1b\\"));
    assert!(output.ends_with("\x1b]8;;\x1b\\\x1b8"));
    assert_eq!(buffer[(0, 0)].symbol(), "a");
    backend.writer_mut().clear();
    second
        .write(&second, &buffer, Some(&buffer), &mut backend)
        .unwrap();
    assert!(backend.writer_mut().is_empty());
    FrameLinks::default()
        .write(&second, &buffer, Some(&buffer), &mut backend)
        .unwrap();
    let output = String::from_utf8(backend.writer_mut().clone()).unwrap();
    assert!(output.contains('a'));
    assert!(!output.contains("https://"));
}

#[test]
fn wide_glyph_continuations_are_not_written_over_the_link() {
    let mut buffer = Buffer::empty(Rect::new(0, 0, 4, 1));
    Paragraph::new("中x").render(buffer.area, &mut buffer);
    let mut links = frame("https://example.com/");
    links.place(
        &[vec![Hyperlink {
            columns: 0..2,
            destination: "https://example.com/".into(),
        }]],
        Rect::new(0, 0, 2, 1),
        0,
    );
    let mut backend = CrosstermBackend::new(Vec::new());
    links
        .write(&FrameLinks::default(), &buffer, None, &mut backend)
        .unwrap();
    let output = String::from_utf8(backend.writer_mut().clone()).unwrap();
    assert_eq!(output.matches("https://example.com/").count(), 1);
    assert!(output.contains('中'));
}

#[test]
fn redraw_and_resize_reapply_links_even_with_identical_destinations() {
    let mut old = Buffer::empty(Rect::new(0, 0, 4, 1));
    Paragraph::new("text").render(old.area, &mut old);
    let links = frame("https://example.com/");
    let mut changed = old.clone();
    changed[(0, 0)].set_fg(ratatui::style::Color::Red);
    for buffer in [changed, Buffer::empty(Rect::new(0, 0, 5, 1))] {
        let mut backend = CrosstermBackend::new(Vec::new());
        links
            .write(&links, &buffer, Some(&old), &mut backend)
            .unwrap();
        let output = String::from_utf8(backend.writer_mut().clone()).unwrap();
        assert!(output.contains("https://example.com/"));
    }
}
#[test]
fn history_output_preserves_links_and_does_not_print_wide_continuation_spaces() {
    let mut buffer = ratatui::buffer::Buffer::empty(ratatui::layout::Rect::new(0, 0, 8, 1));
    buffer.set_string(0, 0, "中文ab", ratatui::style::Style::default());
    let original = buffer.clone();
    let mut links = super::FrameLinks::default();
    links.place(
        &[vec![Hyperlink {
            columns: 0..6,
            destination: "https://example.com/".into(),
        }]],
        buffer.area,
        0,
    );
    links.encode_history(&mut buffer);
    assert_eq!(buffer[(1, 0)].symbol(), "");
    assert_eq!(buffer[(3, 0)].symbol(), "");
    assert_eq!(
        buffer[(0, 0)].symbol(),
        "\x1b]8;;https://example.com/\x1b\\中\x1b]8;;\x1b\\"
    );
    assert_eq!(original[(0, 0)].symbol(), "中");
    assert_eq!(original[(1, 0)].symbol(), " ");
}
