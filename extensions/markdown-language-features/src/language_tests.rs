use super::*;

#[test]
fn source_index_round_trips_utf16_and_rejects_invalid_columns() {
    let text = format!("\u{feff}中文😀\r\n{}😀\n", "wide 中 ".repeat(200));
    let index = SourceIndex::new(&text);
    for offset in text
        .char_indices()
        .map(|(offset, _)| offset)
        .chain([text.len()])
    {
        let position: Position = serde_json::from_value(index.position(&text, offset)).unwrap();
        assert_eq!(index.offset(&text, position).unwrap(), offset);
    }
    assert!(index.offset(&text, Position::new(0, 4)).is_err());
    assert!(index.offset(&text, Position::new(0, 100)).is_err());
    assert!(index.offset(&text, Position::new(10, 0)).is_err());
}

#[test]
fn inline_destination_ignores_delimiters_in_labels_and_titles() {
    for raw in [
        "[go](<#heading> \"title ](bad\")",
        "[nested [label]](#heading \"title ](bad\")",
        "[escaped \\]](#heading)",
    ] {
        assert_eq!(&raw[link_range(raw, LinkType::Inline)], "#heading");
    }
    let raw = "[go](path\\(one\\).md \"title\")";
    assert_eq!(&raw[link_range(raw, LinkType::Inline)], "path\\(one\\).md");
}

#[test]
fn slugs_preserve_combining_marks_and_trim_heading_space() {
    assert_eq!(slug(" Café Cafe\u{301} 中文 "), "café-cafe\u{301}-中文");
}
