use super::*;
use crate::ChatGptAuthManagement;
use ash_async_utils::CancellationSource;
use ash_client::ClientError;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_secrets::MemorySecretStore;
use base64::Engine;
use std::sync::Mutex;

struct Client {
    requests: Mutex<Vec<ClientRequest>>,
    response: (u16, serde_json::Value),
    during_request: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl OperationClient for Client {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        if let Some(action) = self.during_request.lock().unwrap().take() {
            action();
        }
        Ok(ClientResponse::new(
            self.response.0,
            Vec::new(),
            serde_json::to_vec(&self.response.1).unwrap(),
        ))
    }
}

fn credentials(path: &std::path::Path, user: &str) {
    let claims = serde_json::json!({"https://api.openai.com/auth":{"chatgpt_user_id":user,"chatgpt_account_id":"account-1","chatgpt_plan_type":"plus"}});
    let jwt = |value| {
        format!(
            "e30.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&value).unwrap())
        )
    };
    std::fs::write(path.join("auth.json"), serde_json::to_vec(&serde_json::json!({
        "auth_mode":"chatgpt", "tokens":{"id_token":jwt(claims),"access_token":jwt(serde_json::json!({"exp":4000000000u64})),"refresh_token":"synthetic","account_id":"account-1"},"last_refresh":"2026-10-16T00:00:00Z"
    })).unwrap()).unwrap();
}

fn setup(
    root: &std::path::Path,
    status: u16,
    body: serde_json::Value,
) -> (ChatGptDictation, Arc<Client>) {
    credentials(root, "user-1");
    let client = Arc::new(Client {
        requests: Mutex::new(Vec::new()),
        response: (status, body),
        during_request: Mutex::new(None),
    });
    let auth = ChatGptOAuth::with_client(
        root.into(),
        Arc::new(MemorySecretStore::default()),
        client.clone(),
        ChatGptAuthManagement::Codex,
    );
    (ChatGptDictation::new(auth).unwrap(), client)
}

fn wav() -> Vec<u8> {
    let mut value = vec![0; 46];
    value[..4].copy_from_slice(b"RIFF");
    value[8..12].copy_from_slice(b"WAVE");
    value
}

#[test]
fn subscription_dictation_uploads_once_without_a_public_model_or_auth_writes() {
    let root = tempfile::tempdir().unwrap();
    let (dictation, client) = setup(root.path(), 200, serde_json::json!({"text":"测试文字"}));
    let before = std::fs::read(root.path().join("auth.json")).unwrap();
    assert_eq!(
        dictation
            .transcribe(&wav(), Some("zh"), &CancellationSource::new().token())
            .unwrap(),
        "测试文字"
    );
    assert_eq!(
        std::fs::read(root.path().join("auth.json")).unwrap(),
        before
    );
    let requests = client.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].url(),
        "https://chatgpt.com/backend-api/transcribe"
    );
    assert_eq!(requests[0].retry_policy(), RetryPolicy::never());
    let body = String::from_utf8_lossy(requests[0].body());
    assert!(body.contains("name=\"file\"; filename=\"dictation.wav\""));
    assert!(body.contains("name=\"language\"\r\n\r\nzh\r\n"));
    assert!(!body.contains("name=\"model\""));
}

#[test]
fn cancelled_invalid_and_changed_account_recordings_never_upload() {
    let root = tempfile::tempdir().unwrap();
    let (dictation, client) = setup(
        root.path(),
        200,
        serde_json::json!({"text":"must not arrive"}),
    );
    let cancellation = CancellationSource::new();
    cancellation.cancel();
    assert_eq!(
        dictation.transcribe(&wav(), None, &cancellation.token()),
        Err(ChatGptDictationError::Cancelled)
    );
    assert_eq!(
        dictation.transcribe(b"invalid", None, &CancellationSource::new().token()),
        Err(ChatGptDictationError::InvalidAudio)
    );
    credentials(root.path(), "user-2");
    assert_eq!(
        dictation.transcribe(&wav(), None, &CancellationSource::new().token()),
        Err(ChatGptDictationError::AccountChanged)
    );
    assert!(client.requests.lock().unwrap().is_empty());
}

#[test]
fn account_change_during_upload_discards_the_result() {
    let root = tempfile::tempdir().unwrap();
    let (dictation, client) = setup(
        root.path(),
        200,
        serde_json::json!({"text":"old account result"}),
    );
    let path = root.path().to_owned();
    *client.during_request.lock().unwrap() = Some(Box::new(move || credentials(&path, "user-2")));
    assert_eq!(
        dictation.transcribe(&wav(), None, &CancellationSource::new().token()),
        Err(ChatGptDictationError::AccountChanged)
    );
    assert_eq!(client.requests.lock().unwrap().len(), 1);
}

#[test]
fn logout_expiry_and_oversized_audio_never_upload() {
    let root = tempfile::tempdir().unwrap();
    let (dictation, client) = setup(
        root.path(),
        200,
        serde_json::json!({"text":"must not arrive"}),
    );
    assert_eq!(
        dictation.transcribe(
            &vec![0; super::MAX_AUDIO_BYTES + 1],
            None,
            &CancellationSource::new().token()
        ),
        Err(ChatGptDictationError::AudioTooLong)
    );
    let path = root.path().join("auth.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    value["tokens"]["access_token"] = serde_json::Value::String(format!(
        "e30.{}.signature",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"exp":1}"#)
    ));
    let expired = serde_json::to_vec(&value).unwrap();
    std::fs::write(&path, &expired).unwrap();
    assert_eq!(
        dictation.transcribe(&wav(), None, &CancellationSource::new().token()),
        Err(ChatGptDictationError::AuthenticationRequired)
    );
    assert_eq!(std::fs::read(&path).unwrap(), expired);
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        dictation.transcribe(&wav(), None, &CancellationSource::new().token()),
        Err(ChatGptDictationError::AuthenticationRequired)
    );
    assert!(client.requests.lock().unwrap().is_empty());
}

#[test]
fn provider_failures_are_sanitized_and_never_replayed() {
    for (status, body, expected) in [
        (
            401,
            serde_json::json!({"secret":"must not surface"}),
            ChatGptDictationError::AuthenticationRequired,
        ),
        (
            403,
            serde_json::json!({}),
            ChatGptDictationError::AccessDenied,
        ),
        (
            429,
            serde_json::json!({}),
            ChatGptDictationError::RateLimited,
        ),
        (
            500,
            serde_json::json!({}),
            ChatGptDictationError::RequestFailed,
        ),
        (
            200,
            serde_json::json!({"text":42}),
            ChatGptDictationError::InvalidResponse,
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let (dictation, client) = setup(root.path(), status, body);
        assert_eq!(
            dictation.transcribe(&wav(), None, &CancellationSource::new().token()),
            Err(expected)
        );
        assert_eq!(client.requests.lock().unwrap().len(), 1);
    }
}
