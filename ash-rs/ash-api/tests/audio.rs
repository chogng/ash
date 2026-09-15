use ash_api::ApiEndpoint;
use ash_api::ApiError;
use ash_api::ContentPart;
use ash_api::InputItem;
use ash_api::MessageRole;
use ash_api::ModelRequest;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_client::ResolvedApiTarget;
use serde_json::Value;
use serde_json::json;
use std::sync::Mutex;

#[derive(Default)]
struct Transport(Mutex<Option<Value>>);

impl OperationClient for Transport {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        *self.0.lock().unwrap() = Some(serde_json::from_slice(request.body()).unwrap());
        let body = json!({"id":"response", "status":"completed", "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"heard"}]}], "choices":[{"message":{"role":"assistant","content":"heard"},"finish_reason":"stop"}]});
        Ok(ClientResponse::new(
            200,
            Vec::new(),
            serde_json::to_vec(&body).unwrap(),
        ))
    }
}

fn audio_request() -> (ModelRequest, String) {
    let url = audio::load_bytes(
        include_bytes!("../../utils/audio/tests/fixtures/tone.wav")
            .as_slice()
            .into(),
        audio::AudioFormat::Wav,
    )
    .unwrap()
    .data_url();
    let mut request = ModelRequest::text("Listen");
    let InputItem::Message(message) = &mut request.input[0] else {
        panic!("expected user message")
    };
    message
        .content
        .push(ContentPart::AudioUrl { url: url.clone() });
    message.content.push(ContentPart::Text("Describe".into()));
    (request, url)
}

#[test]
fn chat_completions_encodes_audio_between_its_surrounding_text() {
    let transport = Transport::default();
    let (request, url) = audio_request();
    ApiEndpoint::OpenAiChatCompletions
        .complete_with_client(
            &ResolvedApiTarget::new("https://example.test/v1", Vec::new()),
            "audio-model",
            &request,
            &transport,
        )
        .unwrap();
    let body = transport.0.lock().unwrap().clone().unwrap();
    assert_eq!(
        body["messages"][0]["content"],
        json!([
            {"type":"text","text":"Listen"},
            {"type":"input_audio","input_audio":{"data":url.split_once(',').unwrap().1,"format":"wav"}},
            {"type":"text","text":"Describe"}
        ])
    );
}

#[test]
fn chatgpt_responses_encodes_the_validated_audio_data_url() {
    let transport = Transport::default();
    let (request, url) = audio_request();
    ApiEndpoint::ChatGptResponses
        .complete_with_client(
            &ResolvedApiTarget::new("https://example.test", Vec::new()),
            "audio-model",
            &request,
            &transport,
        )
        .unwrap();
    let body = transport.0.lock().unwrap().clone().unwrap();
    assert_eq!(
        body["input"][0]["content"][1],
        json!({"type":"input_audio","audio_url":url})
    );
}

#[test]
fn unsupported_endpoints_roles_and_invalid_audio_fail_before_transport() {
    for (endpoint, role) in [
        (ApiEndpoint::OpenAiResponses, MessageRole::User),
        (ApiEndpoint::AnthropicMessages, MessageRole::User),
        (ApiEndpoint::OpenAiChatCompletions, MessageRole::Assistant),
        (ApiEndpoint::ChatGptResponses, MessageRole::System),
    ] {
        let transport = Transport::default();
        let (mut request, _) = audio_request();
        let InputItem::Message(message) = &mut request.input[0] else {
            unreachable!()
        };
        message.role = role;
        let result = endpoint.complete_with_client(
            &ResolvedApiTarget::new("https://example.test", Vec::new()),
            "model",
            &request,
            &transport,
        );
        assert!(
            matches!(result, Err(ApiError::InvalidRequest(_))),
            "{result:?}"
        );
        assert!(transport.0.lock().unwrap().is_none());
    }
    let transport = Transport::default();
    let (mut request, _) = audio_request();
    let InputItem::Message(message) = &mut request.input[0] else {
        unreachable!()
    };
    message.content[1] = ContentPart::AudioUrl {
        url: "data:audio/wav;base64,AA==".into(),
    };
    assert!(matches!(
        ApiEndpoint::OpenAiChatCompletions.complete_with_client(
            &ResolvedApiTarget::new("https://example.test", Vec::new()),
            "model",
            &request,
            &transport
        ),
        Err(ApiError::InvalidRequest(_))
    ));
    assert!(transport.0.lock().unwrap().is_none());
}
