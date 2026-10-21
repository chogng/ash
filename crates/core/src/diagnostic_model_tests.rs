use super::*;

#[test]
fn timing_ignores_empty_reasoning_and_complete_snapshots() {
    let mut timing = InvocationTimer::start();
    for event in [
        ModelStreamEvent::TextDelta(String::new()),
        ModelStreamEvent::ReasoningDelta("thinking".into()),
        ModelStreamEvent::MessageStarted {
            id: "m".into(),
            phase: None,
        },
        ModelStreamEvent::MessageCompleted(ash_protocol::AssistantMessage {
            id: "m".into(),
            text: "completed snapshot".into(),
            phase: None,
        }),
    ] {
        timing.observe(&event, 100);
    }
    let result = timing.finish(None);
    assert_eq!(result.first_text_us, None);
    assert_eq!(result.text_delta_count, 0);
}

#[test]
fn timing_keeps_first_body_delta_and_counts_only_incremental_body() {
    let mut timing = InvocationTimer::start();
    timing.observe(&ModelStreamEvent::TextDelta("a".into()), 20);
    timing.observe(&ModelStreamEvent::ReasoningDelta("thought".into()), 30);
    timing.observe(
        &ModelStreamEvent::MessageDelta {
            id: "m".into(),
            text: "b".into(),
        },
        40,
    );
    let result = timing.finish(None);
    assert_eq!(result.first_text_us, Some(20));
    assert_eq!(result.text_delta_count, 2);
    // An independently started retry must not retain the preceding attempt's first text.
    assert_eq!(InvocationTimer::start().finish(None).first_text_us, None);
}
