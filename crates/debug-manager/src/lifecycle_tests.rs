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
    assert!(lifecycle.configure(&mut client, vec![]).is_err());
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
                    .configure(&mut client, vec!["unknown".into()])
                    .is_err()
            );
            assert_eq!(
                lifecycle.snapshot.phase,
                DebugInitializationPhase::Configuring
            );
        }
        let message = lifecycle.configure(&mut client, vec![]).unwrap();
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
