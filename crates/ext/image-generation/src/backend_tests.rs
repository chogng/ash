use super::*;
use async_utils::CancellationSource;
use std::sync::Mutex;
struct Client {
    calls: Mutex<Vec<ClientRequest>>,
    status: u16,
}
impl OperationClient for Client {
    fn execute(
        &self,
        request: &ClientRequest,
    ) -> Result<client::ClientResponse, client::ClientError> {
        self.calls.lock().unwrap().push(request.clone());
        Ok(client::ClientResponse::new(
            self.status,
            vec![],
            br#"{"mime_type":"image/png","base64":"AA==","revised_prompt":"edited"}"#.to_vec(),
        ))
    }
}
#[test]
fn json_image_adapter_preserves_edit_inputs_and_never_replays_generation() {
    let client = Arc::new(Client {
        calls: Mutex::new(Vec::new()),
        status: 200,
    });
    let backend = JsonImageGenerationBackend::new(
        "images".into(),
        "https://images.example.test/generate".into(),
        None,
        vec![],
        client.clone(),
    )
    .unwrap();
    let source = CancellationSource::new();
    let request = ImageGenerationRequest {
        prompt: "edit".into(),
        reference_images: vec!["data:image/png;base64,AA==".into()],
    };
    let response = backend.generate(&request, &source.token()).unwrap();
    assert_eq!(response.revised_prompt, "edited");
    let calls = client.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].retry_policy(), RetryPolicy::never());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(calls[0].body()).unwrap(),
        serde_json::to_value(&request).unwrap()
    );
    drop(calls);
    source.cancel();
    assert!(backend.generate(&request, &source.token()).is_err());
    assert_eq!(client.calls.lock().unwrap().len(), 1);
}
#[test]
fn image_service_failures_are_reported_without_implicit_retry() {
    let client = Arc::new(Client {
        calls: Mutex::new(Vec::new()),
        status: 429,
    });
    let backend = JsonImageGenerationBackend::new(
        "images".into(),
        "https://images.example.test/generate".into(),
        None,
        vec![],
        client.clone(),
    )
    .unwrap();
    assert!(
        backend
            .generate(
                &ImageGenerationRequest {
                    prompt: "new image".into(),
                    reference_images: vec![]
                },
                &CancellationSource::new().token()
            )
            .unwrap_err()
            .contains("429")
    );
    assert_eq!(client.calls.lock().unwrap().len(), 1);
}
