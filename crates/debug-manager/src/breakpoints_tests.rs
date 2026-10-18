use super::*;
use std::time::Duration;

fn point(id: &str, line: u32) -> DebugBreakpointIntent {
    DebugBreakpointIntent {
        id: id.into(),
        enabled: true,
        location: DebugBreakpointLocation::Source {
            source: DebugSourceAddress {
                path: Some("/work/main.rs".into()),
                source_reference: None,
            },
            line,
            column: None,
        },
        condition: None,
        hit_condition: None,
        log_message: None,
    }
}
fn respond(client: &mut DebugClient, request: &Value, body: Value) {
    client.accept(&json!({"seq":0,"type":"response","command":request["command"],"request_seq":request["seq"],"success":true,"body":body})).unwrap();
}
fn progress(
    points: &mut Breakpoints,
    client: &mut DebugClient,
    caps: &DebugCapabilities,
) -> Vec<Value> {
    points
        .progress(client, caps, "public", "rust", false, true)
        .unwrap()
}

#[test]
fn late_replies_and_reordered_edits_cannot_reinstall_removed_breakpoints() {
    let mut points = Breakpoints::new();
    let mut client = DebugClient::new(Duration::from_secs(15));
    let caps = DebugCapabilities::default();
    points.replace(1, vec![point("one", 4)]).unwrap();
    let first = progress(&mut points, &mut client, &caps).remove(0);
    points.replace(3, vec![]).unwrap();
    points.replace(2, vec![point("obsolete", 8)]).unwrap();
    respond(
        &mut client,
        &first,
        json!({"breakpoints":[{"id":0,"verified":true,"line":4}]}),
    );
    let clear = progress(&mut points, &mut client, &caps).remove(0);
    assert_eq!(clear["arguments"]["breakpoints"], json!([]));
    assert!(points.snapshot().bindings.is_empty());
    respond(&mut client, &clear, json!({"breakpoints":[]}));
    assert!(progress(&mut points, &mut client, &caps).is_empty());
    assert_eq!(points.snapshot().applied_version, 3);
}

#[test]
fn unsupported_conditions_are_never_downgraded_into_unconditional_breakpoints() {
    let mut points = Breakpoints::new();
    let mut client = DebugClient::new(Duration::from_secs(15));
    let mut intent = point("condition", 4);
    intent.condition = Some("danger()".into());
    points.replace(1, vec![intent]).unwrap();
    let request = progress(&mut points, &mut client, &DebugCapabilities::default()).remove(0);
    assert_eq!(request["arguments"]["breakpoints"], json!([]));
    assert_eq!(
        points.snapshot().bindings[0].unsupported,
        Some(DebugBreakpointUnsupported::Conditional)
    );
    assert!(points.snapshot().bindings[0].protocol.is_none());
}

#[test]
fn session_bound_addresses_are_not_sent_or_verified_by_another_session() {
    let mut points = Breakpoints::new();
    let mut client = DebugClient::new(Duration::from_secs(15));
    let mut intent = point("address", 4);
    intent.location = DebugBreakpointLocation::Instruction {
        instruction_reference: "0x1000".into(),
        offset: None,
        session_id: "other".into(),
    };
    points.replace(1, vec![intent]).unwrap();
    let caps = DebugCapabilities {
        supports_instruction_breakpoints: true,
        ..Default::default()
    };
    let request = progress(&mut points, &mut client, &caps).remove(0);
    assert_eq!(request["command"], "setInstructionBreakpoints");
    assert_eq!(request["arguments"]["breakpoints"], json!([]));
    assert!(!points.snapshot().bindings[0].applicable);
}

#[test]
fn adapter_breakpoints_retain_signed_ids_and_do_not_rebind_disabled_intents() {
    let mut points = Breakpoints::new();
    let mut client = DebugClient::new(Duration::from_secs(15));
    points.replace(1, vec![point("known", 4)]).unwrap();
    let request = progress(&mut points, &mut client, &DebugCapabilities::default()).remove(0);
    respond(
        &mut client,
        &request,
        json!({"breakpoints":[{"id":-1,"verified":true}]}),
    );
    progress(&mut points, &mut client, &DebugCapabilities::default());
    points.accept(&json!({"type":"event","event":"breakpoint","body":{"reason":"changed","breakpoint":{"id":-1,"verified":true,"line":8}}}),"public").unwrap();
    assert_eq!(
        points.snapshot().bindings[0].protocol.as_ref().unwrap()["line"],
        8
    );
    let mut disabled = point("known", 4);
    disabled.enabled = false;
    points.replace(2, vec![disabled]).unwrap();
    points.accept(&json!({"type":"event","event":"breakpoint","body":{"reason":"changed","breakpoint":{"id":-1,"verified":true}}}),"public").unwrap();
    assert!(points.snapshot().bindings[0].protocol.is_none());
    points.accept(&json!({"type":"event","event":"breakpoint","body":{"reason":"new","breakpoint":{"id":0,"verified":true,"source":{"sourceReference":18},"line":7}}}),"public").unwrap();
    assert!(points.snapshot().bindings[1].created);
    assert_eq!(
        points.snapshot().bindings[1].protocol.as_ref().unwrap()["id"],
        0
    );
    points.accept(&json!({"type":"event","event":"breakpoint","body":{"reason":"removed","breakpoint":{"id":0}}}),"public").unwrap();
    assert!(points.snapshot().bindings[1].removed);
}

#[test]
fn intent_boundary_rejects_duplicate_ids_and_invalid_source_addresses() {
    let mut points = Breakpoints::new();
    assert!(
        points
            .replace(1, vec![point("one", 1), point("one", 2)])
            .is_err()
    );
    let mut invalid = point("one", 0);
    assert!(points.replace(1, vec![invalid.clone()]).is_err());
    invalid.location = DebugBreakpointLocation::Source {
        source: DebugSourceAddress {
            path: None,
            source_reference: Some(0),
        },
        line: 1,
        column: None,
    };
    assert!(points.replace(1, vec![invalid]).is_err());
    assert_eq!(points.snapshot().version, 0);
}

#[test]
fn adapter_confirmed_removal_retires_only_its_source_without_echoing_it_back() {
    let mut points = Breakpoints::new();
    let mut client = DebugClient::new(Duration::from_secs(15));
    points.accept(&json!({"type":"event","event":"breakpoint","body":{"reason":"new","breakpoint":{"id":777,"verified":true,"source":{"name":"generated.rs","sourceReference":17},"line":6}}}),"public").unwrap();
    points.accept(&json!({"type":"event","event":"breakpoint","body":{"reason":"removed","breakpoint":{"id":777}}}),"public").unwrap();
    let mut next = point("next", 7);
    next.location = DebugBreakpointLocation::Source {
        source: DebugSourceAddress {
            path: None,
            source_reference: Some(18),
        },
        line: 7,
        column: None,
    };
    points.replace(1, vec![next]).unwrap();
    let messages = progress(&mut points, &mut client, &DebugCapabilities::default());
    assert_eq!(messages.len(), 1);
    assert_eq!(
        messages[0]["arguments"]["source"],
        json!({"sourceReference":18})
    );
    assert!(
        points
            .sources
            .values()
            .all(|source| source.source_reference != Some(17))
    );
}
