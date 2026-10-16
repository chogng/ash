use super::Node;
fn parse(source: &str) -> Result<super::Document, external_ext_sdk::ExtensionError> {
    super::parse_checked(source, || Ok(()))
}

#[test]
fn blocks_partition_original_source_in_utf16_without_normalization() {
    let source = "\u{feff}---\r\ntitle: 中文😀\r\n---\r\n\r\n# 标题  \r\n\r\n段落 **加粗** &amp; \\*literal\\*\r\n\r\n[id]: <https://example.com>  \"标题\"\r\n";
    let document = parse(source).unwrap();
    let units: Vec<_> = source.encode_utf16().collect();
    let mut rebuilt = Vec::new();
    let mut end = 0;
    for block in document.blocks {
        assert_eq!(block.start, end);
        rebuilt.extend_from_slice(&units[block.start as usize..block.end as usize]);
        end = block.end;
    }
    assert_eq!(rebuilt, units);
}

#[test]
fn reference_links_resolve_without_rewriting_the_definition() {
    let serialized = serde_json::to_string(
        &parse("[中文][id]\n\n[id]: https://example.com \"title\"\n").unwrap(),
    )
    .unwrap();
    assert!(serialized.contains("https://example.com"));
    assert!(serialized.contains("[id]: https://example.com"));
}

#[test]
fn math_tables_and_tasks_are_structured_and_html_is_inert() {
    let serialized = serde_json::to_string(&parse("- [x] 中文😀\n\n$x^2$\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n").unwrap()).unwrap();
    assert!(serialized.contains("[\"task\",true,2]"));
    assert!(serialized.contains("[\"math\""));
    assert!(serialized.contains("[\"el\",\"table\""));
    assert!(serialized.contains("[\"raw\",\"<script>"));
}

#[test]
fn empty_documents_and_deep_nesting_are_editable() {
    assert_eq!(parse("").unwrap().blocks.len(), 1);
    let source = format!("{}text\n", "> ".repeat(256));
    let document = parse(&source).unwrap();
    assert_eq!(document.blocks.last().unwrap().end as usize, source.len());
    assert!(matches!(document.blocks[0].content, Node::Element { .. }));
}
