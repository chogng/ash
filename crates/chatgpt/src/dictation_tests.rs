use super::*;
use crate::ChatGptAuthManagement;
use ash_client::AshClient;
use ash_http_client::UreqHttpClient;
use ash_secrets::MemorySecretStore;

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

#[test]
fn subscription_dictation_stays_bound_to_the_admitting_account() {
    let root = tempfile::tempdir().unwrap();
    credentials(root.path(), "user-1");
    let auth = ChatGptOAuth::with_client(
        root.path().into(),
        Arc::new(MemorySecretStore::default()),
        Arc::new(AshClient::new(Arc::new(UreqHttpClient::new().unwrap()))),
        ChatGptAuthManagement::Codex,
    );
    let dictation = ChatGptDictation::new(auth).unwrap();
    assert!(dictation.check_account().is_ok());
    credentials(root.path(), "user-2");
    assert_eq!(
        dictation.check_account(),
        Err(ChatGptDictationError::AccountChanged)
    );
    std::fs::remove_file(root.path().join("auth.json")).unwrap();
    assert_eq!(
        dictation.check_account(),
        Err(ChatGptDictationError::AuthenticationRequired)
    );
}

#[test]
fn subscription_dictation_keeps_confirmed_text_and_replaces_partial_revisions() {
    let mut utterances = Vec::new();
    let transcript = |id: &str, revision, text: &str| WireTranscript {
        utterance_id: id.into(),
        revision,
        text: text.into(),
    };
    store_transcript(&mut utterances, transcript("one", 2, "first draft"), false);
    store_transcript(&mut utterances, transcript("one", 1, "stale"), false);
    store_transcript(&mut utterances, transcript("two", 1, "second draft"), false);
    assert_eq!(
        join_transcripts(&utterances, false),
        "first draft second draft"
    );
    store_transcript(&mut utterances, transcript("one", 1, "first final"), true);
    store_transcript(&mut utterances, transcript("one", 3, "late draft"), false);
    assert_eq!(
        join_transcripts(&utterances, false),
        "first final second draft"
    );
    assert_eq!(join_transcripts(&utterances, true), "first final");
    store_transcript(&mut utterances, transcript("two", 2, "second final"), true);
    assert_eq!(
        join_transcripts(&utterances, true),
        "first final second final"
    );
}
