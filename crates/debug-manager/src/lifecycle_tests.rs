use super::DebugClient;
use super::DebugExecutionState;
use super::DebugInitializationPhase;
use super::DebugInitialize;
use super::DebugLaunchRequest;
use super::Duration;
use super::Instant;
use super::Lifecycle;
use super::json;

#[test]
fn initialized_deadline_is_owned_by_rust_and_cannot_revive_after_timeout() {
    let mut lifecycle = Lifecycle::new();
    let mut client = DebugClient::new(Duration::from_secs(15));
    lifecycle
        .begin(
            &mut client,
            DebugInitialize {
                adapter_id: "test".into(),
                request: DebugLaunchRequest::Attach,
                arguments: Default::default(),
                run_in_terminal: false,
                start_debugging: true,
            },
        )
        .unwrap();
    client.accept(&json!({"seq":0,"type":"response","request_seq":1,"command":"initialize","success":true,"body":{}})).unwrap();
    let launch = lifecycle.progress(&mut client).unwrap();
    assert_eq!(launch[0]["command"], "attach");
    lifecycle.initialized_deadline = Some(Instant::now() - Duration::from_millis(1));
    assert!(lifecycle.progress(&mut client).unwrap().is_empty());
    assert_eq!(lifecycle.snapshot.state, DebugExecutionState::Error);
    lifecycle
        .accept(&json!({"seq":0,"type":"event","event":"initialized"}))
        .unwrap();
    assert!(lifecycle.progress(&mut client).unwrap().is_empty());
    assert_eq!(lifecycle.snapshot.phase, DebugInitializationPhase::Ended);
    assert!(lifecycle.configure(&mut client, None).is_err());
}

#[test]
fn terminal_events_win_and_unknown_capability_keys_are_not_retained() {
    let mut lifecycle = Lifecycle::new();
    lifecycle
        .merge_capabilities(
            &json!({"supportsRestartRequest":true,"vendorBlob":{"large":"payload"}}),
        )
        .unwrap();
    assert_eq!(lifecycle.capabilities.len(), 1);
    lifecycle
        .accept(&json!({"seq":0,"type":"event","event":"terminated"}))
        .unwrap();
    lifecycle
        .accept(&json!({"seq":0,"type":"event","event":"stopped","body":{"threadId":3}}))
        .unwrap();
    assert_eq!(lifecycle.snapshot.state, DebugExecutionState::Terminated);
    assert!(!lifecycle.allows("continue", &None));
}

#[test]
fn no_debug_suppresses_exception_defaults_and_bad_filters_do_not_advance_configuration() {
    for no_debug in [false, true] {
        let mut lifecycle = Lifecycle::new();
        lifecycle.snapshot.phase = DebugInitializationPhase::Configuring;
        lifecycle.no_debug = no_debug;
        lifecycle.merge_capabilities(&json!({"exceptionBreakpointFilters":[{"filter":"uncaught","label":"Uncaught","default":true}]})).unwrap();
        let mut client = DebugClient::new(Duration::from_secs(15));
        if !no_debug {
            assert!(
                lifecycle
                    .configure(&mut client, Some(vec!["unknown".into()]))
                    .is_err()
            );
            assert_eq!(
                lifecycle.snapshot.phase,
                DebugInitializationPhase::Configuring
            );
        }
        let message = lifecycle.configure(&mut client, None).unwrap();
        assert_eq!(
            message["arguments"]["filters"],
            if no_debug {
                json!([])
            } else {
                json!(["uncaught"])
            }
        );
    }
}

#[test]
fn live_exception_edits_are_serialized_and_a_rejection_does_not_end_the_session() {
    let mut lifecycle = Lifecycle::new();
    lifecycle.snapshot.phase = DebugInitializationPhase::Active;
    lifecycle.configured = true;
    lifecycle
        .merge_capabilities(&json!({"exceptionBreakpointFilters":[{"filter":"all","label":"All"}]}))
        .unwrap();
    let mut client = DebugClient::new(Duration::from_secs(15));
    assert!(lifecycle.set_exceptions(vec!["unknown".into()]).is_err());
    assert!(!lifecycle.allows("setExceptionBreakpoints", &Some(json!({"filters":[]}))));
    assert_eq!(
        lifecycle
            .set_exceptions(vec![" all ".into(), "all".into()])
            .unwrap(),
        1
    );
    let first = lifecycle.progress(&mut client).unwrap();
    assert_eq!(first[0]["arguments"]["filters"], json!(["all"]));
    lifecycle.set_exceptions(vec![]).unwrap();
    assert!(lifecycle.progress(&mut client).unwrap().is_empty());
    client.accept(&json!({"seq":0,"type":"response","request_seq":1,"command":"setExceptionBreakpoints","success":false,"message":"old failure"})).unwrap();
    let latest = lifecycle.progress(&mut client).unwrap();
    assert_eq!(latest[0]["arguments"]["filters"], json!([]));
    assert!(lifecycle.exceptions.error.is_none());
    client.accept(&json!({"seq":0,"type":"response","request_seq":2,"command":"setExceptionBreakpoints","success":false,"message":"rejected"})).unwrap();
    assert!(lifecycle.progress(&mut client).unwrap().is_empty());
    assert_eq!(lifecycle.exceptions.error.as_deref(), Some("rejected"));
    assert_eq!(lifecycle.snapshot.phase, DebugInitializationPhase::Active);
    lifecycle.set_exceptions(vec![]).unwrap();
    lifecycle.progress(&mut client).unwrap();
    client.accept(&json!({"seq":0,"type":"response","request_seq":3,"command":"setExceptionBreakpoints","success":true})).unwrap();
    lifecycle.progress(&mut client).unwrap();
    assert_eq!(lifecycle.exceptions.applied_version, 3);
    assert!(lifecycle.exceptions.error.is_none());
}

#[test]
fn an_explicit_empty_initial_exception_selection_does_not_restore_defaults() {
    let mut lifecycle = Lifecycle::new();
    lifecycle.snapshot.phase = DebugInitializationPhase::Configuring;
    lifecycle
        .merge_capabilities(
            &json!({"exceptionBreakpointFilters":[{"filter":"all","label":"All","default":true}]}),
        )
        .unwrap();
    let mut client = DebugClient::new(Duration::from_secs(15));
    assert_eq!(
        lifecycle.configure(&mut client, Some(vec![])).unwrap()["arguments"]["filters"],
        json!([])
    );
}

#[test]
fn dynamic_exception_capabilities_reconcile_the_live_selection_without_restarting() {
    let mut lifecycle = Lifecycle::new();
    lifecycle.snapshot.phase = DebugInitializationPhase::Active;
    lifecycle.configured = true;
    lifecycle
        .merge_capabilities(&json!({"exceptionBreakpointFilters":[{"filter":"all","label":"All"}]}))
        .unwrap();
    lifecycle.set_exceptions(vec!["all".into()]).unwrap();
    let mut client = DebugClient::new(Duration::from_secs(15));
    lifecycle.progress(&mut client).unwrap();
    lifecycle
        .merge_capabilities(&json!({"exceptionBreakpointFilters":[]}))
        .unwrap();
    client.accept(&json!({"seq":0,"type":"response","request_seq":1,"command":"setExceptionBreakpoints","success":true})).unwrap();
    let next = lifecycle.progress(&mut client).unwrap();
    assert_eq!(next[0]["arguments"]["filters"], json!([]));
    assert_eq!(lifecycle.exceptions.version, 2);
    assert_eq!(lifecycle.snapshot.phase, DebugInitializationPhase::Active);
}

#[test]
fn live_rejection_preserves_the_acknowledged_exception_selection() {
    let mut lifecycle = Lifecycle::new();
    lifecycle.snapshot.phase = DebugInitializationPhase::Active;
    lifecycle.configured = true;
    lifecycle
        .merge_capabilities(&json!({"exceptionBreakpointFilters":[{"filter":"all","label":"All"}]}))
        .unwrap();
    let mut client = DebugClient::new(Duration::from_secs(15));
    lifecycle.set_exceptions(vec!["all".into()]).unwrap();
    lifecycle.progress(&mut client).unwrap();
    client.accept(&json!({"seq":0,"type":"response","request_seq":1,"command":"setExceptionBreakpoints","success":true})).unwrap();
    lifecycle.progress(&mut client).unwrap();
    lifecycle.set_exceptions(vec![]).unwrap();
    lifecycle.progress(&mut client).unwrap();
    client.accept(&json!({"seq":0,"type":"response","request_seq":2,"command":"setExceptionBreakpoints","success":false,"message":"refused"})).unwrap();
    lifecycle.progress(&mut client).unwrap();
    assert_eq!(lifecycle.exceptions.filters, Vec::<String>::new());
    assert_eq!(lifecycle.exceptions.applied_filters, ["all"]);
    assert_eq!(lifecycle.exceptions.applied_version, 1);
    assert_eq!(lifecycle.exceptions.version, 2);
    assert_eq!(lifecycle.snapshot.phase, DebugInitializationPhase::Active);
}

#[test]
fn no_debug_suppresses_wire_filters_without_erasing_the_confirmed_preference() {
    let mut lifecycle = Lifecycle::new();
    lifecycle.snapshot.phase = DebugInitializationPhase::Configuring;
    lifecycle.no_debug = true;
    lifecycle
        .merge_capabilities(
            &json!({"exceptionBreakpointFilters":[{"filter":"all","label":"All","default":true}]}),
        )
        .unwrap();
    let mut client = DebugClient::new(Duration::from_secs(15));
    let request = lifecycle.configure(&mut client, None).unwrap();
    assert_eq!(request["arguments"]["filters"], json!([]));
    client.accept(&json!({"seq":0,"type":"response","request_seq":1,"command":"setExceptionBreakpoints","success":true})).unwrap();
    lifecycle.progress(&mut client).unwrap();
    assert_eq!(lifecycle.exceptions.applied_filters, ["all"]);
    lifecycle
        .merge_capabilities(&json!({"exceptionBreakpointFilters":[]}))
        .unwrap();
    assert_eq!(lifecycle.exceptions.filters, ["all"]);
}

#[test]
fn completion_capabilities_are_bounded_and_merge_without_vendor_state() {
    let mut lifecycle = Lifecycle::new();
    lifecycle.snapshot.phase = DebugInitializationPhase::Active;
    assert!(!lifecycle.allows("completions", &None));
    lifecycle
        .merge_capabilities(&json!({"supportsCompletionsRequest":true}))
        .unwrap();
    assert_eq!(
        lifecycle
            .snapshot
            .capabilities
            .completion_trigger_characters,
        vec!["."]
    );
    lifecycle.merge_capabilities(&json!({"supportsCompletionsRequest":true,"supportsCancelRequest":true,"completionTriggerCharacters":[".","::","."]})).unwrap();
    assert!(lifecycle.allows("completions", &None));
    assert!(lifecycle.allows("cancel", &None));
    assert_eq!(
        lifecycle
            .snapshot
            .capabilities
            .completion_trigger_characters,
        vec![".", "::"]
    );
    lifecycle
        .merge_capabilities(&json!({"supportsCompletionsRequest":false}))
        .unwrap();
    assert!(!lifecycle.allows("completions", &None));
    assert_eq!(
        lifecycle
            .snapshot
            .capabilities
            .completion_trigger_characters,
        vec![".", "::"]
    );
    for invalid in [
        json!("."),
        json!([1]),
        json!([""]),
        json!(["\0"]),
        json!(["12345678901234567"]),
        json!(vec!["."; 33]),
    ] {
        assert!(
            lifecycle
                .merge_capabilities(&json!({"completionTriggerCharacters":invalid}))
                .is_err()
        );
    }
    lifecycle
        .merge_capabilities(&json!({"completionTriggerCharacters":null}))
        .unwrap();
    assert!(
        lifecycle
            .snapshot
            .capabilities
            .completion_trigger_characters
            .is_empty()
    );
}

#[test]
fn completion_results_share_the_backend_inspection_lifetime() {
    let mut lifecycle = Lifecycle::new();
    lifecycle.requested(42, "completions");
    lifecycle
        .accept(&json!({"seq":0,"type":"event","event":"continued","body":{"threadId":0}}))
        .unwrap();
    assert!(matches!(
        lifecycle.response(
            42,
            ash_debug_client::DebugResponse::Complete(json!({"body":{"targets":[]}}))
        ),
        ash_debug_client::DebugResponse::Failed(_)
    ));
    lifecycle.requested(43, "completions");
    assert!(matches!(
        lifecycle.response(
            43,
            ash_debug_client::DebugResponse::Complete(json!({"body":{"targets":[]}}))
        ),
        ash_debug_client::DebugResponse::Complete(_)
    ));
}
