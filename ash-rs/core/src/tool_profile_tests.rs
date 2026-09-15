use super::snapshot_tool_profile;
use super::validate_tool_profile_definitions;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolName;
use serde_json::json;

fn definition(name: &str, description: &str) -> ToolDefinition {
    ToolDefinition {
        name: ToolName::new(name).unwrap(),
        description: description.into(),
        parameters: json!({
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
        }),
        strict: true,
    }
}

#[test]
fn profile_digest_is_stable_and_order_sensitive() {
    let definitions = vec![definition("read_file", "Read"), definition("edit", "Edit")];
    let first = snapshot_tool_profile(&definitions).unwrap();
    let second = snapshot_tool_profile(&definitions).unwrap();
    assert_eq!(first, second);
    assert_eq!(
        first.definition_digest,
        "sha256:25cfb1c83f13d99c467071270a386191fbe6697f16a76a1f7f0d631a2340ed77"
    );
    assert!(validate_tool_profile_definitions(&first, &definitions).is_ok());

    let reversed = definitions.into_iter().rev().collect::<Vec<_>>();
    assert!(validate_tool_profile_definitions(&first, &reversed).is_err());
}

#[test]
fn selected_catalog_rejects_excluded_calls_before_the_frozen_binder() {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;
    let called = Arc::new(AtomicBool::new(false));
    let observed = called.clone();
    let catalog = crate::services::ModelToolCatalogSnapshot::with_binder(
        vec![
            definition("read_file", "Read"),
            definition("write_file", "Write"),
        ],
        move |_, _| {
            observed.store(true, Ordering::SeqCst);
            Ok(None)
        },
    )
    .restrict_to_names(&[ToolName::new("read_file").unwrap()]);
    assert_eq!(
        catalog
            .definitions()
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        ["read_file"]
    );
    let mut call = ash_protocol::ToolCall {
        id: ash_protocol::ToolCallId::new("call").unwrap(),
        name: ToolName::new("write_file").unwrap(),
        arguments: json!({}),
    };
    assert!(matches!(
        catalog.bind_call(&call, ash_protocol::ToolCallCaller::Direct),
        Some(Err(crate::CoreError::Policy(_)))
    ));
    assert!(!called.load(Ordering::SeqCst));
    call.name = ToolName::new("read_file").unwrap();
    assert!(matches!(
        catalog.bind_call(&call, ash_protocol::ToolCallCaller::Direct),
        Some(Ok(None))
    ));
    assert!(called.load(Ordering::SeqCst));
}
