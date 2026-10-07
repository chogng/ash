use super::parse_frontmatter_document;

#[test]
fn document_without_frontmatter_keeps_whole_body() {
    let document = parse_frontmatter_document("# Just a body\n");
    assert!(document.frontmatter.is_empty());
    assert!(document.frontmatter_error.is_none());
    assert_eq!(document.body, "# Just a body\n");
}

#[test]
fn document_with_frontmatter_splits_mapping_and_body() {
    let document = parse_frontmatter_document(
        "---\nname: reviewer\ndescription: Reviews code\n---\nBody text\n",
    );
    assert_eq!(
        document
            .frontmatter
            .get("name")
            .and_then(|value| value.as_scalar()),
        Some("reviewer")
    );
    assert_eq!(
        document
            .frontmatter
            .get("description")
            .and_then(|value| value.as_scalar()),
        Some("Reviews code")
    );
    assert_eq!(document.body, "Body text\n");
    assert!(document.frontmatter_error.is_none());
}

#[test]
fn unterminated_frontmatter_is_treated_as_plain_body() {
    let document = parse_frontmatter_document("---\nname: reviewer\n");
    assert!(document.frontmatter.is_empty());
    assert_eq!(document.body, "---\nname: reviewer\n");
}

#[test]
fn non_mapping_frontmatter_reports_error() {
    let document = parse_frontmatter_document("---\n- just\n- a list\n---\nBody\n");
    assert!(document.frontmatter.is_empty());
    assert!(document.frontmatter_error.is_some());
    assert_eq!(document.body, "Body\n");
}

#[test]
fn complex_frontmatter_values_are_marked_other() {
    let document =
        parse_frontmatter_document("---\nname: reviewer\ntools:\n  - read\n  - grep\n---\nBody\n");
    assert_eq!(
        document
            .frontmatter
            .get("name")
            .and_then(|value| value.as_scalar()),
        Some("reviewer")
    );
    assert!(matches!(
        document.frontmatter.get("tools"),
        Some(super::FrontmatterValue::Other)
    ));
}

#[test]
fn crlf_frontmatter_delimiters_are_supported() {
    let document = parse_frontmatter_document("---\r\nname: reviewer\r\n---\r\nBody\r\n");
    assert_eq!(
        document
            .frontmatter
            .get("name")
            .and_then(|value| value.as_scalar()),
        Some("reviewer")
    );
    assert_eq!(document.body, "Body\r\n");
}

#[test]
fn deeply_nested_frontmatter_is_rejected() {
    let depth = crate::source::MAX_DOCUMENT_DEPTH + 2;
    let content = format!(
        "---\nname: reviewer\ntools: {}0{}\n---\nBody\n",
        "[".repeat(depth),
        "]".repeat(depth)
    );
    let document = parse_frontmatter_document(&content);
    assert_eq!(
        document.frontmatter_error,
        Some(crate::AgentImportDiagnosticCode::LimitExceeded)
    );
    assert!(document.frontmatter.is_empty());
}

#[test]
fn yaml_alias_expansion_is_bounded_before_materializing_values() {
    let scalar = "x".repeat(16 * 1024);
    let aliases = vec!["*text"; 65].join(",");
    let content =
        format!("---\nname: reviewer\ntext: &text {scalar}\ntools: [{aliases}]\n---\nBody\n");
    assert!(content.len() < crate::source::MAX_FILE_BYTES);
    let document = parse_frontmatter_document(&content);
    assert_eq!(
        document.frontmatter_error,
        Some(crate::AgentImportDiagnosticCode::LimitExceeded)
    );
    assert!(document.frontmatter.is_empty());
}

#[test]
fn yaml_node_budget_keeps_small_aliases_and_tags_but_rejects_large_sequences() {
    let document = parse_frontmatter_document(
        "---\nname: &name reviewer\ndescription: *name\ntools: !custom [a, b]\n---\nBody\n",
    );
    assert!(document.frontmatter_error.is_none());
    assert_eq!(
        document
            .frontmatter
            .get("description")
            .and_then(|value| value.as_scalar()),
        Some("reviewer")
    );
    let values = vec!["0"; crate::source::MAX_DOCUMENT_NODES].join(",");
    let document = parse_frontmatter_document(&format!("---\ntools: [{values}]\n---\n"));
    assert_eq!(
        document.frontmatter_error,
        Some(crate::AgentImportDiagnosticCode::LimitExceeded)
    );
}
