use super::Node;
fn parse(source: &str) -> Result<super::Document, external_ext_sdk::ExtensionError> {
    super::parse_checked(source, true, || Ok(()))
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

#[test]
fn math_fences_share_formula_nodes_and_disabled_math_remains_source() {
    let source = "$x^2$\n\n$$y^2$$\n\n```math\n\\frac{1}{2}\n```\n";
    let rendered = serde_json::to_string(&parse(source).unwrap()).unwrap();
    assert_eq!(rendered.matches("[\"math\"").count(), 3);
    assert!(rendered.contains("\\\\frac{1}{2}\",true"));
    let disabled = super::parse_checked(source, false, || Ok(())).unwrap();
    let disabled = serde_json::to_string(&disabled).unwrap();
    assert!(!disabled.contains("[\"math\""));
    assert!(disabled.contains("$x^2$"));
    assert!(disabled.contains("\"pre\""));
}

#[test]
fn shared_math_syntax_and_original_source_ranges() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../../../test/fixtures/markdownMath.json")).unwrap();
    let mut cases = cases.as_array().unwrap().clone();
    let combined: Vec<_> = cases
        .iter()
        .filter(|case| {
            !case["formulas"].as_array().unwrap().is_empty()
                || ["code and escapes", "currency and jQuery"]
                    .contains(&case["name"].as_str().unwrap())
        })
        .collect();
    let source = combined
        .iter()
        .map(|case| case["markdown"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n\n");
    let formulas: Vec<_> = combined
        .iter()
        .flat_map(|case| case["formulas"].as_array().unwrap().clone())
        .collect();
    cases.push(serde_json::json!({"name":"combined compatibility document","markdown":source,"formulas":formulas}));
    for case in cases {
        let source = case["markdown"].as_str().unwrap();
        let mut document = parse(source).unwrap();
        let mut formulas = Vec::new();
        let mut end = 0;
        for block in &mut document.blocks {
            assert_eq!(block.start, end, "{}", case["name"]);
            end = block.end;
            block.content.visit_math(&mut |value, display, _| {
                formulas.push(serde_json::json!({"source":value,"display":if display {"block"} else {"inline"}}));
            });
        }
        assert_eq!(
            end as usize,
            source.encode_utf16().count(),
            "{}",
            case["name"]
        );
        assert_eq!(
            serde_json::json!(formulas),
            case["formulas"],
            "{}",
            case["name"]
        );
    }
}
