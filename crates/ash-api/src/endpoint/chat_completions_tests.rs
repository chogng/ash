use super::*;
use serde_json::json;

#[test]
fn kimi_cache_details_and_legacy_cache_read_are_preserved_without_guessing_reasoning() {
    let usage = json!({"prompt_tokens":100,"completion_tokens":25,"cached_tokens":40,
        "prompt_tokens_details":{"cached_tokens":60,"cache_write_tokens":10}});
    let parsed = parse_usage(ApiEndpoint::OpenAiChatCompletions, Some(&usage)).unwrap();
    assert_eq!(parsed.input_tokens, Some(100));
    assert_eq!(parsed.output_tokens, Some(25));
    assert_eq!(parsed.cached_input_tokens, Some(60));
    assert_eq!(parsed.cache_write_input_tokens, Some(10));
    assert_eq!(parsed.reasoning_tokens, None);
    let legacy = json!({"prompt_tokens":100,"completion_tokens":25,"cached_tokens":40});
    assert_eq!(
        parse_usage(ApiEndpoint::OpenAiChatCompletions, Some(&legacy))
            .unwrap()
            .cached_input_tokens,
        Some(40)
    );
}

#[test]
fn missing_or_invalid_compatible_usage_does_not_become_zero() {
    assert_eq!(parse_usage(ApiEndpoint::OpenAiChatCompletions, None), None);
    for usage in [
        json!({}),
        json!({"cached_tokens":-1,"prompt_tokens_details":{"cache_write_tokens":"0"}}),
    ] {
        let parsed = parse_usage(ApiEndpoint::OpenAiChatCompletions, Some(&usage)).unwrap();
        assert_eq!(parsed.cached_input_tokens, None);
        assert_eq!(parsed.cache_write_input_tokens, None);
        assert_eq!(parsed.reasoning_tokens, None);
    }
}

#[test]
fn deepseek_keeps_its_protocol_specific_cache_hit_counter() {
    let usage = json!({"prompt_tokens":100,"completion_tokens":25,"prompt_cache_hit_tokens":30,
        "cached_tokens":99,"completion_tokens_details":{"reasoning_tokens":20}});
    let parsed = parse_usage(ApiEndpoint::DeepSeekChatCompletions, Some(&usage)).unwrap();
    assert_eq!(parsed.cached_input_tokens, Some(30));
    assert_eq!(parsed.reasoning_tokens, Some(20));
}
