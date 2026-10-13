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

#[test]
fn app_uri_is_retained_only_from_declared_tool_ui_metadata() {
    let server = McpServerId::new("user:mcp:apps").unwrap();
    let tool = |uri: &str| {
        serde_json::from_value(serde_json::json!({"name":"chart","description":"Chart","inputSchema":{"type":"object"},"_meta":{"ui":{"resourceUri":uri}}})).unwrap()
    };
    let descriptor = super::project_tool(
        &server,
        tool("ui://charts/view"),
        1,
        1,
        ash_tools::ToolLoading::Eager,
    )
    .unwrap();
    assert_eq!(
        descriptor.app_resource_uri.as_deref(),
        Some("ui://charts/view")
    );
    for uri in [
        "file:///secret.html",
        "https://untrusted.example/app",
        "ui://bad\nuri",
    ] {
        assert!(
            super::project_tool(&server, tool(uri), 1, 1, ash_tools::ToolLoading::Eager).is_err()
        );
    }
}

#[test]
fn app_only_tools_stay_in_the_origin_catalog_but_never_enter_model_definitions() {
    let server = McpServerId::new("user:mcp:apps").unwrap();
    let mut descriptors = Vec::new();
    for (name, visibility) in [
        ("shared", serde_json::json!(["model", "app"])),
        ("model", serde_json::json!(["model"])),
        ("app", serde_json::json!(["app"])),
    ] {
        let tool = serde_json::from_value(serde_json::json!({"name":name,"description":name,"inputSchema":{"type":"object"},"_meta":{"ui":{"visibility":visibility}}})).unwrap();
        descriptors
            .push(super::project_tool(&server, tool, 1, 1, ash_tools::ToolLoading::Eager).unwrap());
    }
    let app_name = descriptors[2].binding().exposed_name().clone();
    let catalog = super::McpCatalogSnapshot::new(1, descriptors).unwrap();
    assert_eq!(catalog.tools().len(), 3);
    assert!(catalog.resolve(&app_name).is_some());
    assert_eq!(catalog.model_definitions().unwrap().len(), 2);
    assert!(
        catalog
            .model_definitions()
            .unwrap()
            .iter()
            .all(|definition| definition.name != app_name)
    );
}
