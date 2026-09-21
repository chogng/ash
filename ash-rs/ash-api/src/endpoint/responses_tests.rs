use super::*;
use crate::Message;

#[test]
fn xai_replays_complete_encrypted_reasoning_and_requests_it_without_a_summary() {
    let item = json!({"id":"reasoning-1","type":"reasoning","summary":[],"encrypted_content":"opaque-ciphertext","provider_extension":{"revision":2}});
    let mut events = ResponsesEventDecoder::new();
    events
        .decode_json(&json!({"type":"response.output_item.done","output_index":0,"item":item}))
        .unwrap();
    events
        .decode_json(
            &json!({"type":"response.completed","response":{"status":"completed","output":[]}}),
        )
        .unwrap();
    let response = parse_response(events.finish_response().unwrap()).unwrap();
    let OutputItem::ReasoningState(state) = &response.output[0] else {
        panic!("missing encrypted reasoning");
    };
    let mut request = ModelRequest::text("continue");
    request.input.insert(0, InputItem::Reasoning(state.clone()));
    let body = build_request(ApiEndpoint::XaiSubscriptionResponses, "grok-test", &request).unwrap();
    assert_eq!(body["input"][0], item);
    assert_eq!(body["store"], false);
    assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
    assert!(body.get("reasoning").is_none());
}

#[test]
fn xai_requests_use_conversation_affinity_and_fresh_request_ids() {
    let mut request = ModelRequest::text("hello");
    request.prompt_cache_key = Some("ash-thread-1".into());
    let target = ResolvedApiTarget::new("https://cli-chat-proxy.grok.com/v1", Vec::new());
    let first = request_target(
        ApiEndpoint::XaiSubscriptionResponses,
        &target,
        "grok-test",
        &request,
    )
    .unwrap();
    let second = request_target(
        ApiEndpoint::XaiSubscriptionResponses,
        &target,
        "grok-test",
        &request,
    )
    .unwrap();
    let header = |target: &ResolvedApiTarget, name: &str| {
        target
            .headers
            .iter()
            .find(|header| header.name() == name)
            .unwrap()
            .value()
            .to_owned()
    };
    assert_eq!(header(&first, "x-grok-conv-id"), "ash-thread-1");
    assert_eq!(header(&first, "x-grok-session-id"), "ash-thread-1");
    assert_eq!(header(&first, "x-grok-model-override"), "grok-test");
    assert_ne!(
        header(&first, "x-grok-req-id"),
        header(&second, "x-grok-req-id")
    );
    assert!(
        request_target(ApiEndpoint::OpenAiResponses, &target, "grok-test", &request)
            .unwrap()
            .headers
            .is_empty()
    );
}

#[test]
fn stable_prefix_breakpoint_precedes_the_changing_environment_suffix() {
    let mut request = ModelRequest::text("stable inherited history".repeat(500));
    request.prompt_cache_key = Some("session".into());
    request.input.push(InputItem::Message(Message::text(
        MessageRole::User,
        "branch environment",
    )));
    let original = request.clone();
    let first = build_request(ApiEndpoint::OpenAiResponses, "gpt-5.6-sol", &request).unwrap();
    request.input[1] =
        InputItem::Message(Message::text(MessageRole::User, "different environment"));
    let second = build_request(ApiEndpoint::OpenAiResponses, "gpt-5.6-sol", &request).unwrap();
    assert_eq!(first["input"][0], second["input"][0]);
    assert_eq!(
        first["input"][0]["content"][0]["prompt_cache_breakpoint"],
        json!({"mode":"explicit"})
    );
    assert!(
        second["input"][1]["content"][0]
            .get("prompt_cache_breakpoint")
            .is_none()
    );
    assert_eq!(first["prompt_cache_key"], second["prompt_cache_key"]);
    assert_eq!(original.input[0], request.input[0]);
    assert!(
        build_count_request("gpt-5.6-sol", &request).unwrap()["input"][0]["content"][0]
            .get("prompt_cache_breakpoint")
            .is_none()
    );
}

#[test]
fn older_and_unrecognized_model_families_keep_automatic_caching() {
    for model in ["gpt-5.5", "gpt-4.1", "other-model", "gpt-invalid"] {
        let request = build_request(
            ApiEndpoint::OpenAiResponses,
            model,
            &ModelRequest::text("history"),
        )
        .unwrap();
        assert!(
            request["input"][0]["content"][0]
                .get("prompt_cache_breakpoint")
                .is_none()
        );
    }
    assert_eq!(cache_support("gpt-6-astra"), CacheSupport::Breakpoints);
}
