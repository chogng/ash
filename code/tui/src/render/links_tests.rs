use super::*;
use ratatui::style::Style;

#[test]
fn links_wrap_with_wide_text_and_never_enter_the_visible_buffer() {
    let mut line = HyperlinkLine::default();
    line.push(
        "中文🙂 alpha",
        Style::default(),
        Some("https://example.com/a"),
    );
    let rows = wrap(&line, 6);
    assert!(rows.iter().all(|row| row.line.width() <= 6));
    assert_eq!(
        rows.iter()
            .map(|row| row.line.to_string())
            .collect::<String>(),
        "中文🙂alpha"
    );
    let mut links = FrameLinks::default();
    links.place(
        &rows.iter().map(|row| row.links.clone()).collect::<Vec<_>>(),
        Rect::new(2, 3, 6, 2),
        1,
    );
    assert!(
        links
            .cells
            .keys()
            .all(|&(x, y)| (2..8).contains(&x) && (3..5).contains(&y))
    );
    assert!(
        links
            .cells
            .values()
            .all(|url| url.as_ref() == "https://example.com/a")
    );
    links.clear(Rect::new(2, 3, 6, 1));
    assert!(links.cells.keys().all(|&(_, y)| y == 4));
}

#[test]
fn links_follow_source_columns_when_styles_split_words_or_wide_glyphs_are_clipped() {
    let mut line = HyperlinkLine::default();
    line.push("ab a", Style::default(), None);
    line.push(
        "bcde",
        Style::default().fg(ratatui::style::Color::Red),
        Some("https://example.com/word"),
    );
    let rows = wrap(&line, 6);
    assert_eq!(
        rows.iter()
            .map(|row| row.line.to_string())
            .collect::<Vec<_>>(),
        ["ab ", "abcde"]
    );
    assert!(rows[0].links.is_empty());
    assert_eq!(rows[1].links[0].columns, 1..5);
    assert_eq!(rows[1].links[0].destination, "https://example.com/word");

    let mut narrow = HyperlinkLine::default();
    narrow.push("中", Style::default(), Some("https://example.com/wide"));
    narrow.push("x y", Style::default(), Some("https://example.com/letters"));
    let rows = wrap(&narrow, 1);
    assert_eq!(
        rows.iter()
            .map(|row| row.line.to_string())
            .collect::<Vec<_>>(),
        ["x", "y"]
    );
    for row in rows {
        assert_eq!(row.links[0].columns, 0..1);
        assert_eq!(row.links[0].destination, "https://example.com/letters");
    }
}

#[test]
fn unsafe_destinations_cannot_emit_terminal_commands() {
    for value in [
        "javascript:alert(1)",
        "file:///tmp/script.sh",
        "https://example.com/\x1b]8;;bad",
        "https://example.com/\n",
    ] {
        assert!(web_destination(value).is_none());
    }
    assert!(web_destination(&format!("https://example.com/{}", "a".repeat(8192))).is_none());
    let mut line = HyperlinkLine::default();
    line.push("hello\x1b\x07", Style::default(), None);
    assert_eq!(line.line.to_string(), "hello");
}

#[test]
fn ash_created_preview_links_survive_wrapping_without_enabling_message_file_links() {
    let mut line = HyperlinkLine::default();
    line.push_trusted_file(
        "Open Mermaid in browser",
        Style::default(),
        "file:///tmp/ash-mermaid-preview.html",
    );
    let rows = wrap(&line, 12);
    assert!(rows.len() > 1);
    assert!(
        rows.iter()
            .flat_map(|row| &row.links)
            .all(|link| { link.destination == "file:///tmp/ash-mermaid-preview.html" })
    );
    let mut untrusted = HyperlinkLine::default();
    untrusted.push("open", Style::default(), Some("file:///tmp/arbitrary.html"));
    assert!(untrusted.links.is_empty());
}
