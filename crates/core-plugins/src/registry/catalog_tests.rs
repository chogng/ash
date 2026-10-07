use semver::Version;

use super::CatalogManifest;
use super::language_ids_for;
use super::validate_manifest;

#[test]
fn accepts_signed_official_mcp_registry_provenance() {
    let manifest: CatalogManifest = serde_json::from_str(
        r#"{
          "schemaVersion": 2,
          "packageType": "mcp",
          "source": "thirdParty",
          "id": "marketplace/docs-mcp",
          "version": "1.2.3",
          "displayName": "Docs MCP",
          "description": "Search documentation.",
          "license": "MIT",
          "upstream": {
            "registry": "officialMcp",
            "name": "ac.example/docs-mcp",
            "version": "1.2.3",
            "recordUrl": "https://registry.modelcontextprotocol.io/v0.1/servers/ac.example%2Fdocs-mcp/versions/1.2.3",
            "repositoryUrl": "https://github.com/example/docs-mcp"
          },
          "capabilities": [{"kind": "mcp", "id": "docs-mcp", "path": "mcp/package.json"}]
        }"#,
    )
    .unwrap();

    validate_manifest(&manifest).unwrap();
    assert_eq!(manifest.upstream.unwrap().version, Version::new(1, 2, 3));
}

#[test]
fn rejects_registry_provenance_on_non_mcp_packages() {
    let manifest: CatalogManifest = serde_json::from_str(
        r#"{
          "schemaVersion": 2,
          "packageType": "skill",
          "source": "thirdParty",
          "id": "marketplace/docs-skill",
          "version": "1.2.3",
          "displayName": "Docs Skill",
          "description": "Search documentation.",
          "license": "MIT",
          "upstream": {
            "registry": "officialMcp",
            "name": "ac.example/docs-mcp",
            "version": "1.2.3",
            "recordUrl": "https://registry.modelcontextprotocol.io/v0.1/servers/ac.example%2Fdocs-mcp/versions/1.2.3"
          },
          "capabilities": [{"kind": "skill", "id": "docs", "path": "skill"}]
        }"#,
    )
    .unwrap();

    assert!(validate_manifest(&manifest).is_err());
}

#[test]
fn schema_two_language_routes_bind_exact_executable_capabilities() {
    let manifest: CatalogManifest = serde_json::from_str(
        r#"{
          "schemaVersion": 2,
          "packageType": "language",
          "source": "official",
          "id": "marketplace/demo-language",
          "version": "1.0.0",
          "displayName": "Demo Language",
          "description": "Demo language support.",
          "license": "MIT",
          "languages": [{
            "id": "demo",
            "displayName": "Demo",
            "aliases": ["demo"],
            "fileExtensions": [".demo"],
            "languageServer": "demo-server"
          }],
          "capabilities": [
            {"kind": "asset", "id": "language-assets", "path": "language"},
            {"kind": "executable", "id": "demo-server", "path": "server/demo.js", "runtime": "node"}
          ]
        }"#,
    )
    .unwrap();

    validate_manifest(&manifest).unwrap();
    let executable = manifest
        .capabilities
        .iter()
        .find(|capability| capability.id == "demo-server")
        .unwrap();
    assert_eq!(language_ids_for(&manifest, executable), vec!["demo"]);
}

#[test]
fn schema_two_language_rejects_an_unknown_server_route() {
    let manifest: CatalogManifest = serde_json::from_str(
        r#"{
          "schemaVersion": 2,
          "packageType": "language",
          "source": "official",
          "id": "marketplace/demo-language",
          "version": "1.0.0",
          "displayName": "Demo Language",
          "description": "Demo language support.",
          "license": "MIT",
          "languages": [{"id": "demo", "displayName": "Demo", "languageServer": "missing"}],
          "capabilities": [{"kind": "asset", "id": "language-assets", "path": "language"}]
        }"#,
    )
    .unwrap();

    assert!(validate_manifest(&manifest).is_err());
}

#[test]
fn language_search_matches_signed_routes_aliases_extensions_and_server_ids() {
    let manifest: CatalogManifest = serde_json::from_value(serde_json::json!({
        "schemaVersion": 2,
        "packageType": "language",
        "source": "official",
        "id": "example/web",
        "version": "1.0.0",
        "displayName": "Web language support",
        "description": "Editor resources and a bundled server.",
        "license": "MIT",
        "languages": [
            {
                "id": "typescriptreact",
                "displayName": "TypeScript JSX",
                "aliases": ["TypeScript React", "tsx"],
                "fileExtensions": [".tsx"],
                "languageServer": "typescript-language-server"
            },
            {
                "id": "javascript",
                "displayName": "JavaScript",
                "aliases": ["js"],
                "fileExtensions": [".mjs", ".cjs"],
                "languageServer": "typescript-language-server"
            },
            { "id": "jsx-tags", "displayName": "JSX Tags" }
        ],
        "capabilities": [
            { "kind": "asset", "id": "language-assets", "path": "language" },
            {
                "kind": "executable",
                "id": "typescript-language-server",
                "path": "server/entry.js",
                "runtime": "node"
            }
        ]
    }))
    .unwrap();
    validate_manifest(&manifest).unwrap();

    for query in [
        "typescriptreact",
        "typescript jsx",
        "typescript react",
        "tsx",
        ".tsx",
        ".mjs",
        "javascript",
        "typescript-language-server",
        "jsx-tags",
    ] {
        assert!(manifest.matches(query), "language query: {query}");
    }
    for query in ["python", "pyright", ".py", "server/entry.js", "node"] {
        assert!(!manifest.matches(query), "unrelated query: {query}");
    }

    let executable = manifest
        .capabilities
        .iter()
        .find(|capability| capability.id == "typescript-language-server")
        .unwrap();
    assert_eq!(
        language_ids_for(&manifest, executable),
        ["typescriptreact", "javascript"],
        "discovering static resources must not add a server route for them"
    );
    for (language_id, expected) in [
        ("typescriptreact", true),
        ("javascript", true),
        ("jsx-tags", false),
        ("typescript", false),
    ] {
        assert_eq!(
            manifest.matches_filters(&crate::SearchPackagesRequest {
                language_id: Some(language_id.into()),
                capability_kind: Some(crate::CapabilityKind::Executable),
                ..Default::default()
            }),
            expected,
            "server route for {language_id}"
        );
    }
}

#[test]
fn package_search_preserves_package_metadata_and_matches_bundled_capabilities() {
    let manifest: CatalogManifest = serde_json::from_value(serde_json::json!({
        "schemaVersion": 2,
        "packageType": "plugin",
        "source": "thirdParty",
        "id": "example/developer-tools",
        "version": "1.0.0",
        "displayName": "Developer Kit",
        "description": "Review changes and maintain repositories.",
        "license": "MIT",
        "capabilities": [
            { "kind": "skill", "id": "code-review", "path": "skills/review" },
            { "kind": "mcp", "id": "repository-tools", "path": "mcp/package.json" }
        ]
    }))
    .unwrap();
    validate_manifest(&manifest).unwrap();

    for query in [
        "",
        "example/developer-tools",
        "developer kit",
        "maintain repositories",
        "code-review",
        "repository-tools",
    ] {
        assert!(manifest.matches(query), "package query: {query}");
    }
    assert!(!manifest.matches("typescriptreact"));
    assert!(manifest.matches_filters(&crate::SearchPackagesRequest {
        capability_kind: Some(crate::CapabilityKind::Skill),
        ..Default::default()
    }));
    assert!(!manifest.matches_filters(&crate::SearchPackagesRequest {
        package_type: Some("skill".into()),
        capability_kind: Some(crate::CapabilityKind::Skill),
        ..Default::default()
    }));
    assert!(!manifest.matches_filters(&crate::SearchPackagesRequest {
        capability_kind: Some(crate::CapabilityKind::Language),
        ..Default::default()
    }));
}
