use super::{NodeRuntime, configure_browser_paths};
use serde_json::json;
use std::collections::BTreeMap;

#[test]
fn vite_filesystem_sources_have_a_default_mapping_and_explicit_mappings_are_preserved() {
    let mut properties = BTreeMap::new();
    configure_browser_paths(&mut properties);
    assert_eq!(
        properties["pathMapping"]["/@fs/"],
        if cfg!(windows) { "" } else { "/" }
    );
    let mut properties =
        BTreeMap::from([("pathMapping".into(), json!({"/custom/":"/workspace/"}))]);
    let original = properties.clone();
    configure_browser_paths(&mut properties);
    assert_eq!(properties, original);
}

#[test]
fn managed_electron_selects_node_mode_without_losing_the_user_environment() {
    let mut properties = BTreeMap::from([("env".into(), json!({"CUSTOM":"kept", "REMOVED":null}))]);
    NodeRuntime::Electron {
        executable: "/managed/Electron".into(),
        launcher: "/provider/ash-debug-javascript".into(),
    }
    .apply(&mut properties, "invalid")
    .unwrap();
    assert_eq!(
        properties["runtimeExecutable"],
        json!("/provider/ash-debug-javascript")
    );
    assert_eq!(
        properties["env"],
        json!({"CUSTOM":"kept", "REMOVED":null, "ASH_JS_DEBUG_NODE_RUNTIME":"/managed/Electron"})
    );
}

#[test]
fn explicit_runtime_or_version_keeps_its_own_launch_environment() {
    for property in ["runtimeExecutable", "runtimeVersion"] {
        let mut properties = BTreeMap::from([
            (property.into(), json!("user-selected")),
            ("env".into(), json!({"CUSTOM":"kept"})),
        ]);
        let original = properties.clone();
        NodeRuntime::Electron {
            executable: "/managed/Electron".into(),
            launcher: "/provider/ash-debug-javascript".into(),
        }
        .apply(&mut properties, "invalid")
        .unwrap();
        assert_eq!(properties, original);
    }
    let mut properties = BTreeMap::new();
    NodeRuntime::Node("/managed/node".into())
        .apply(&mut properties, "invalid")
        .unwrap();
    assert!(!properties.contains_key("env"));
}

#[test]
fn malformed_managed_node_environment_returns_the_localized_configuration_error() {
    for message in [
        "Invalid JavaScript debug configuration.",
        "JavaScript 调试配置无效。",
    ] {
        let mut properties = BTreeMap::from([("env".into(), json!([]))]);
        let error = NodeRuntime::Electron {
            executable: "/managed/Electron".into(),
            launcher: "/provider/ash-debug-javascript".into(),
        }
        .apply(&mut properties, message)
        .unwrap_err();
        assert!(error.to_string().contains(message));
    }
}
