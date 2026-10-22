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
    let catalog = crate::services::ModelToolCatalogSnapshot::new(vec![
        definition("read_file", "Read"),
        definition("write_file", "Write"),
    ])
    .with_binder(move |_, _| {
        observed.store(true, Ordering::SeqCst);
        Ok(None)
    })
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

#[test]
fn derived_catalog_keeps_the_inflight_schema_scope_and_binder() {
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let original = crate::ModelToolCatalogSnapshot::new(vec![
        definition("read_file", "Read"),
        definition("write_file", "Write"),
    ])
    .with_binder(move |_, _| {
        observed.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    });
    let expected = original.definitions().to_vec();
    let restricted = original
        .clone()
        .restrict_to_names(&[ToolName::new("read_file").unwrap()]);
    assert_eq!(original.definitions(), expected);
    assert_eq!(restricted.definitions(), &expected[..1]);
    let call = ash_protocol::ToolCall {
        id: ash_protocol::ToolCallId::new("write").unwrap(),
        name: ToolName::new("write_file").unwrap(),
        arguments: json!({}),
    };
    assert!(matches!(
        restricted.bind_call(&call, ash_protocol::ToolCallCaller::Direct),
        Some(Err(crate::CoreError::Policy(_)))
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(matches!(
        original.bind_call(&call, ash_protocol::ToolCallCaller::Direct),
        Some(Ok(None))
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    #[cfg(feature = "code-mode")]
    {
        let expanded = original
            .clone()
            .with_additional_definitions(vec![definition("exec", "Execute")]);
        assert_eq!(expanded.definitions().len(), 3);
        assert_eq!(original.definitions(), expected);
    }
}
