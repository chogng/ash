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

#[test]
fn heading_ids_preserve_document_order_across_explicit_suffixes_and_many_duplicates() {
    let mut ids = HeadingIds::default();
    for (title, expected) in [
        ("Alpha", "alpha"),
        ("Alpha-1", "alpha-1"),
        ("Alpha", "alpha-2"),
        ("Alpha-2", "alpha-2-1"),
        ("Alpha", "alpha-3"),
        ("Alpha-1", "alpha-1-1"),
    ] {
        assert_eq!(ids.insert(title), expected);
    }
    for number in 4..20000 {
        assert_eq!(ids.insert("Alpha"), format!("alpha-{number}"));
    }
}

#[test]
fn escaped_reference_labels_preserve_utf8_and_edit_the_entire_label() {
    let source = "[a\\]😀]: <https://example.com>\n";
    let definition = Definition::new(
        "a\\]😀",
        0..source.len(),
        "https://example.com".into(),
        source,
    )
    .unwrap();
    assert_eq!(&source[definition.label.clone()], "a\\]😀");
    assert_eq!(
        source[definition.label.end + 2..].trim(),
        "<https://example.com>"
    );
    for (raw, kind, expected) in [
        ("[go][a\\]😀]", LinkType::Reference, "a\\]😀"),
        ("[a\\[😀]", LinkType::Shortcut, "a\\[😀"),
        ("[nested [text]][a\\]😀]", LinkType::Reference, "a\\]😀"),
        ("[a\\]😀][]", LinkType::Collapsed, ""),
    ] {
        assert_eq!(&raw[link_range(raw, kind)], expected);
    }
}

#[test]
fn root_links_use_the_longest_containing_workspace_or_document_directory() {
    let folders = vec![
        "file:///workspace".into(),
        "file:///workspace/nested".into(),
    ];
    for (resource, expected) in [
        (
            "file:///workspace/current.md",
            "file:///workspace/target.md",
        ),
        (
            "file:///workspace/nested/docs/current.md",
            "file:///workspace/nested/target.md",
        ),
        (
            "file:///workspace-other/docs/current.md",
            "file:///workspace-other/docs/target.md",
        ),
    ] {
        assert_eq!(
            target(resource, "/target.md#中文", &folders),
            Some((expected.into(), Some("中文".into())))
        );
    }
    assert_eq!(
        target("file:///workspace/current.md", "./relative.md", &folders),
        Some(("file:///workspace/relative.md".into(), None))
    );
    assert_eq!(
        target(
            "file:///workspace/current.md",
            "https://example.com",
            &folders
        ),
        None
    );
}

#[test]
fn dependency_index_replaces_old_links_releases_closed_sources_and_bounds_edges() {
    let mut index = DependencyIndex::default();
    index.update("a".into(), Some(BTreeSet::from(["target".into()])));
    index.update("b".into(), Some(BTreeSet::new()));
    assert_eq!(index.affected("target"), BTreeSet::from(["a".into()]));
    index.update("a".into(), Some(BTreeSet::from(["other".into()])));
    assert!(index.affected("target").is_empty());
    index.update(
        "oversized".into(),
        Some(BTreeSet::from(["x".repeat(DependencyIndex::MAX_BYTES + 1)])),
    );
    assert_eq!(
        index.affected("other"),
        BTreeSet::from(["a".into(), "oversized".into()])
    );
    index.remove("a");
    index.remove("oversized");
    assert_eq!((index.bytes, index.edges), (0, 0));
    assert!(index.affected("other").is_empty());
}

fn analysis(uri: &str, version: u32, text: String) -> Arc<Document> {
    Arc::new(Document {
        index: SourceIndex::new(&text),
        snapshot: DocumentSnapshot {
            uri: uri.into(),
            version,
            language_id: "markdown".into(),
            text,
        },
        headings: Vec::new(),
        links: Vec::new(),
        definitions: Vec::new(),
        heading_ids: BTreeMap::new(),
    })
}

#[test]
fn analysis_cache_matches_exact_snapshots_and_bounds_retention() {
    let mut cache = AnalysisCache::default();
    let latest = analysis("a", 2, "最新😀".into());
    cache.insert(Arc::clone(&latest));
    cache.insert(analysis("a", 1, "old".into()));
    assert!(Arc::ptr_eq(&cache.get(&latest.snapshot).unwrap(), &latest));
    assert!(
        cache
            .get(&analysis("a", 2, "different client".into()).snapshot)
            .is_none()
    );
    assert!(
        cache
            .get(&analysis("a", 1, "最新😀".into()).snapshot)
            .is_none()
    );
    for number in 0..AnalysisCache::MAX_ENTRIES {
        cache.insert(analysis(&number.to_string(), 1, "x".into()));
    }
    assert!(cache.get(&latest.snapshot).is_none());
    let retained = cache.bytes;
    cache.insert(analysis(
        "oversized",
        1,
        String::with_capacity(AnalysisCache::MAX_BYTES + 1),
    ));
    assert_eq!(cache.bytes, retained);
    cache.remove("0");
    assert!(cache.get(&analysis("0", 1, "x".into()).snapshot).is_none());
    assert!(cache.bytes < retained);
}
