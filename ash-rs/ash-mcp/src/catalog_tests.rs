use super::{exposed_name, slug};
use ash_config::McpServerId;

#[test]
fn aliases_are_valid_bounded_and_preserve_exact_identity_in_digest() {
    let server = McpServerId::new("user:mcp:Docs Server").expect_err("spaces are invalid config");
    assert!(server.to_string().contains("MCP server id"));

    let server = McpServerId::new("user:mcp:docs").expect("valid server");
    let dotted = exposed_name(&server, "docs.search").expect("valid alias");
    let underscored = exposed_name(&server, "docs_search").expect("valid alias");
    assert_ne!(dotted, underscored);
    assert!(dotted.as_str().len() <= 128);
}

#[test]
fn slug_collapses_untrusted_punctuation() {
    assert_eq!(slug("GitHub / Search...Issues", 40), "github_search_issues");
    assert_eq!(slug("🔥", 40), "unnamed");
}
