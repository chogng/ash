use super::*;
use crate::PluginManifest;
use serde_json::{Value, json};

fn valid_manifest() -> Value {
    json!({
        "schemaVersion": 1,
        "id": "acme/code-review",
        "version": "1.2.3",
        "displayName": "Acme Code Review",
        "description": "Review workflows.",
        "license": "Apache-2.0",
        "compatibility": {
            "ash": ">=0.1.0"
        },
        "contributions": {
            "skills": [
                { "id": "code-review", "path": "skills/code-review" }
            ],
            "mcpServers": [
                { "id": "review", "definition": "mcp/review-server.json" }
            ],
            "connectors": [
                {
                    "id": "review-account",
                    "displayName": "Acme Review",
                    "description": "Connect an Acme Review account.",
                    "mcpServer": "review"
                }
            ],
            "assets": [
                { "id": "icon", "path": "assets/icon.png" }
            ],
            "editorExtensions": [
                {
                    "id": "review-runtime",
                    "entrypoint": "bin/review-server",
                    "runtime": "hostRpc",
                    "runtimeApiVersion": 1,
                    "activationEvents": [
                        { "type": "startup" },
                        { "type": "onCommand", "id": "acme.review.run" },
                        { "type": "onLanguage", "id": "rust" },
                        { "type": "onDemand", "capability": "debugAdapter" },
                        { "type": "onDebugType", "debugType": "acme-review" },
                        { "type": "onTaskType", "taskType": "acme-review" },
                        { "type": "onTestProfile", "profileId": "acme-review" }
                    ],
                    "capabilities": [
                        "command",
                        "languageProvider",
                        "debugAdapter",
                        "taskProvider",
                        "testProfileProvider",
                        "dataChannel",
                        "linkPresentationProvider",
                        "externalUriOpener"
                    ]
                }
            ],
            "declarativeExtensions": [
                {
                    "id": "review-theme",
                    "path": "extensions/review-theme"
                }
            ]
        },
        "permissions": [
            { "type": "process", "executable": "bin/review-server" },
            { "type": "directory", "access": "read" },
            { "type": "network", "hosts": ["api.example.com"] }
        ],
        "credentialSlots": [
            {
                "name": "api-token",
                "kind": "secretText",
                "requiredFor": [
                    "mcp:review",
                    "connector:review-account",
                    "editorExtension:review-runtime"
                ]
            }
        ],
        "metadata": {
            "acme/category": "review"
        }
    })
}

fn parse(value: &Value) -> Result<PluginManifest, crate::PluginError> {
    PluginManifest::from_json(&serde_json::to_vec(value).unwrap())
}

#[test]
fn strict_v1_manifest_parses_typed_security_fields() {
    let manifest = parse(&valid_manifest()).unwrap();

    assert_eq!(manifest.id.as_str(), "acme/code-review");
    assert_eq!(manifest.version.to_string(), "1.2.3");
    assert!(
        manifest
            .compatibility
            .ash
            .matches(&semver::Version::new(0, 1, 0))
    );
    assert_eq!(manifest.contributions.skills[0].id.as_str(), "code-review");
    assert_eq!(
        manifest.credential_slots[0].required_for[0].to_string(),
        "mcp:review"
    );
    assert_eq!(
        manifest.credential_slots[0].required_for[1].to_string(),
        "connector:review-account"
    );
    assert_eq!(
        manifest.credential_slots[0].required_for[2].to_string(),
        "editorExtension:review-runtime"
    );
    assert!(matches!(
        manifest.permissions[2],
        crate::Permission::Network { .. }
    ));
    let editor_extension = &manifest.contributions.editor_extensions[0];
    assert_eq!(editor_extension.id.as_str(), "review-runtime");
    assert_eq!(editor_extension.runtime_api_version.as_u16(), 1);
    assert!(matches!(
        editor_extension.activation_events[1],
        crate::EditorExtensionActivationEvent::OnCommand { .. }
    ));
    assert_eq!(
        editor_extension.capabilities[1],
        crate::EditorExtensionCapability::LanguageProvider
    );
    assert_eq!(
        editor_extension.capabilities[5],
        crate::EditorExtensionCapability::DataChannel
    );
    assert_eq!(
        editor_extension.capabilities[6],
        crate::EditorExtensionCapability::LinkPresentationProvider
    );
    assert_eq!(
        editor_extension.capabilities[7],
        crate::EditorExtensionCapability::ExternalUriOpener
    );
    let declarative_extension = &manifest.contributions.declarative_extensions[0];
    assert_eq!(declarative_extension.id.as_str(), "review-theme");
    assert_eq!(
        declarative_extension.path.as_str(),
        "extensions/review-theme"
    );
}

#[test]
fn declarative_extension_identity_is_unique_and_bounded() {
    let extension = valid_manifest()["contributions"]["declarativeExtensions"][0].clone();
    let mut duplicate = valid_manifest();
    duplicate["contributions"]["declarativeExtensions"] = json!([extension.clone(), extension]);

    let error = parse(&duplicate).unwrap_err();

    assert!(
        error
            .to_string()
            .contains("duplicate declarative Extension")
    );
}

#[test]
fn editor_extension_runtime_api_and_process_permission_are_exact() {
    let mut future_api = valid_manifest();
    future_api["contributions"]["editorExtensions"][0]["runtimeApiVersion"] = json!(2);
    assert!(
        parse(&future_api)
            .unwrap_err()
            .to_string()
            .contains("runtimeApiVersion 2")
    );

    let mut missing_permission = valid_manifest();
    missing_permission["permissions"][0]["executable"] = json!("bin/other-host");
    assert!(
        parse(&missing_permission)
            .unwrap_err()
            .to_string()
            .contains("exact process permission")
    );
}

#[test]
fn editor_extension_identity_and_entrypoint_are_unique() {
    let extension = valid_manifest()["contributions"]["editorExtensions"][0].clone();

    let mut duplicate_id = valid_manifest();
    duplicate_id["contributions"]["editorExtensions"] = json!([
        extension.clone(),
        {
            "id": "review-runtime",
            "entrypoint": "bin/second-host",
            "runtime": "hostRpc",
                    "runtimeApiVersion": 1,
            "activationEvents": [{"type": "startup"}],
            "capabilities": ["command"]
        }
    ]);
    assert!(
        parse(&duplicate_id)
            .unwrap_err()
            .to_string()
            .contains("duplicate Editor Extension")
    );

    let mut duplicate_entrypoint = valid_manifest();
    duplicate_entrypoint["contributions"]["editorExtensions"] = json!([
        extension,
        {
            "id": "second-runtime",
            "entrypoint": "bin/review-server",
            "runtime": "hostRpc",
                    "runtimeApiVersion": 1,
            "activationEvents": [{"type": "startup"}],
            "capabilities": ["command"]
        }
    ]);
    assert!(
        parse(&duplicate_entrypoint)
            .unwrap_err()
            .to_string()
            .contains("declared more than once")
    );
}

#[test]
fn editor_extension_activation_and_capability_sets_are_nonempty_unique_and_bounded() {
    let mut empty_events = valid_manifest();
    empty_events["contributions"]["editorExtensions"][0]["activationEvents"] = json!([]);
    assert!(
        parse(&empty_events)
            .unwrap_err()
            .to_string()
            .contains("at least one activation")
    );

    let mut duplicate_events = valid_manifest();
    duplicate_events["contributions"]["editorExtensions"][0]["activationEvents"] =
        json!([{"type": "startup"}, {"type": "startup"}]);
    assert!(
        parse(&duplicate_events)
            .unwrap_err()
            .to_string()
            .contains("duplicate activation")
    );

    let mut too_many_events = valid_manifest();
    too_many_events["contributions"]["editorExtensions"][0]["activationEvents"] = Value::Array(
        (0..65)
            .map(|index| json!({"type": "onCommand", "id": format!("acme.command.{index}")}))
            .collect(),
    );
    assert!(
        parse(&too_many_events)
            .unwrap_err()
            .to_string()
            .contains("at most 64")
    );

    let mut empty_capabilities = valid_manifest();
    empty_capabilities["contributions"]["editorExtensions"][0]["capabilities"] = json!([]);
    assert!(
        parse(&empty_capabilities)
            .unwrap_err()
            .to_string()
            .contains("at least one capability")
    );

    let mut duplicate_capabilities = valid_manifest();
    duplicate_capabilities["contributions"]["editorExtensions"][0]["capabilities"] =
        json!(["command", "command"]);
    assert!(
        parse(&duplicate_capabilities)
            .unwrap_err()
            .to_string()
            .contains("duplicate capability")
    );
}

#[test]
fn editor_extension_activation_cannot_expand_its_capability_ceiling() {
    let mut missing_capability = valid_manifest();
    missing_capability["contributions"]["editorExtensions"][0]["capabilities"] = json!(["command"]);

    let error = parse(&missing_capability).unwrap_err();

    assert!(error.to_string().contains("undeclared capability"));
}

#[test]
fn editor_extension_activation_selectors_are_bounded_and_unknown_triggers_are_rejected() {
    let mut whitespace_selector = valid_manifest();
    whitespace_selector["contributions"]["editorExtensions"][0]["activationEvents"] =
        json!([{"type": "onCommand", "id": "acme invalid"}]);
    whitespace_selector["contributions"]["editorExtensions"][0]["capabilities"] =
        json!(["command"]);
    assert!(
        parse(&whitespace_selector)
            .unwrap_err()
            .to_string()
            .contains("selector")
    );

    let mut unsupported_workspace_scan = valid_manifest();
    unsupported_workspace_scan["contributions"]["editorExtensions"][0]["activationEvents"] =
        json!([{"type": "workspaceContains", "pattern": "**/Cargo.toml"}]);
    unsupported_workspace_scan["contributions"]["editorExtensions"][0]["capabilities"] =
        json!(["command"]);
    assert!(parse(&unsupported_workspace_scan).is_err());
}

#[test]
fn unknown_and_duplicate_json_fields_are_rejected() {
    let mut unknown = valid_manifest();
    unknown["autoApprove"] = json!(true);
    assert_eq!(
        parse(&unknown).unwrap_err().kind(),
        PluginErrorKind::ManifestInvalid
    );

    let duplicate = br#"{
        "schemaVersion": 1,
        "schemaVersion": 1,
        "id": "acme/review",
        "version": "1.0.0",
        "displayName": "Review",
        "compatibility": {"ash": ">=0.1.0"},
        "contributions": {"assets": [{"id": "icon", "path": "assets/icon.png"}]}
    }"#;
    assert!(PluginManifest::from_json(duplicate).is_err());
}

#[test]
fn duplicate_contribution_and_credential_ids_are_rejected() {
    let mut duplicate = valid_manifest();
    duplicate["contributions"]["skills"] = json!([
        { "id": "review", "path": "skills/one" },
        { "id": "review", "path": "skills/two" }
    ]);
    assert!(serde_json::from_value::<PluginManifest>(duplicate.clone()).is_err());
    assert!(
        parse(&duplicate)
            .unwrap_err()
            .to_string()
            .contains("duplicate skill")
    );

    let mut slots = valid_manifest();
    slots["credentialSlots"] = json!([
        {"name": "token", "kind": "secretText", "requiredFor": []},
        {"name": "token", "kind": "secretText", "requiredFor": []}
    ]);
    assert!(
        parse(&slots)
            .unwrap_err()
            .to_string()
            .contains("duplicate credential slot")
    );
}

#[test]
fn credential_requirements_must_reference_declared_contributions() {
    let mut manifest = valid_manifest();
    manifest["credentialSlots"][0]["requiredFor"] = json!(["mcp:missing"]);

    let error = parse(&manifest).unwrap_err();

    assert!(error.to_string().contains("missing contribution"));
}

#[test]
fn connector_must_reference_a_declared_mcp_server() {
    let mut manifest = valid_manifest();
    manifest["contributions"]["connectors"][0]["mcpServer"] = json!("missing");

    let error = parse(&manifest).unwrap_err();

    assert!(error.to_string().contains("missing MCP server"));
}

#[test]
fn permissions_and_metadata_are_conservative_in_v1() {
    let mut wildcard = valid_manifest();
    wildcard["permissions"][2]["hosts"] = json!(["*.example.com"]);
    assert!(parse(&wildcard).is_err());

    let mut empty_network = valid_manifest();
    empty_network["permissions"][2]["hosts"] = json!([]);
    assert!(
        parse(&empty_network)
            .unwrap_err()
            .to_string()
            .contains("at least one exact host")
    );

    let mut metadata = valid_manifest();
    metadata["metadata"] = json!({"category": "review"});
    assert!(
        parse(&metadata)
            .unwrap_err()
            .to_string()
            .contains("namespaced")
    );
}

#[test]
fn schema_and_version_are_explicit() {
    let mut future = valid_manifest();
    future["schemaVersion"] = json!(2);
    assert!(
        parse(&future)
            .unwrap_err()
            .to_string()
            .contains("unsupported")
    );

    let mut non_semver = valid_manifest();
    non_semver["version"] = json!("latest");
    assert!(parse(&non_semver).is_err());
}

#[test]
fn javascript_entry_uses_sdk_without_requesting_execution_of_its_source_file() {
    let mut value = valid_manifest();
    value["contributions"]["editorExtensions"] = json!([{
        "id": "review-runtime", "runtime": "javascript", "entrypoint": "extension/main.js",
        "runtimeApiVersion": 1, "activationEvents": [{"type": "startup"}], "capabilities": ["command"]
    }]);
    value["permissions"] = json!([{"type": "directory", "access": "read"}]);
    let manifest = parse(&value).unwrap();
    assert_eq!(
        manifest.contributions.editor_extensions[0].runtime,
        super::super::EditorExtensionRuntime::JavaScript
    );
    let mut unsupported = value.clone();
    unsupported["contributions"]["editorExtensions"][0]["capabilities"] =
        json!(["languageProvider"]);
    unsupported["contributions"]["editorExtensions"][0]["activationEvents"] =
        json!([{"type": "onLanguage", "id": "typescript"}]);
    assert!(parse(&unsupported).is_ok());
    unsupported["contributions"]["editorExtensions"][0]["capabilities"] = json!(["taskProvider"]);
    assert!(parse(&unsupported).is_err());
    value["contributions"]["editorExtensions"][0]["entrypoint"] = json!("bin/program");
    assert!(parse(&value).is_err());
}

#[test]
fn sdk_example_manifest_declares_the_supported_javascript_contract() {
    let manifest = PluginManifest::from_json(include_bytes!(
        "../../../../app-ts/extension-sdk/example/.ash-plugin/plugin.json"
    ))
    .unwrap();
    assert_eq!(
        manifest.contributions.editor_extensions[0].runtime,
        super::super::EditorExtensionRuntime::JavaScript
    );
}
