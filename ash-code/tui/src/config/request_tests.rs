use super::set_language_server_mode;
use crate::config::LanguageServerEdit;
use crate::test_support::empty_config_snapshot;
use crate::widgets::list_selection::ListSelectionState;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::config::ConfigCommandDispositionDto;
use ash_app_server_protocol::protocol::config::ConfigCommandResult;
use ash_app_server_protocol::protocol::config::LanguageServerConfigDto;
use ash_app_server_protocol::protocol::config::LanguageServerModeDto;
use ash_app_server_protocol::protocol::provider::ProviderListResult;

#[derive(Clone)]
struct RecordingTransport {
    responses: VecDeque<String>,
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
}

impl JsonRpcTransport for RecordingTransport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        self.requests
            .lock()
            .expect("request log is not poisoned")
            .push(serde_json::from_str(request).expect("request is valid JSON"));
        self.responses
            .pop_front()
            .ok_or_else(|| ClientError::Transport("no response".into()))
    }
}

#[test]
fn issue_config_write_uses_its_backend_contract_without_changing_tui_preferences() {
    let mut current = empty_config_snapshot();
    current.revision = 2;
    current.issues.auto_refresh_minutes = 30;
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        requests: requests.clone(),
        responses: VecDeque::from([
            response(
                1,
                serde_json::json!({"revision":2,"generation":2,"disposition":"updated"}),
            ),
            response(2, serde_json::to_value(&current).unwrap()),
            response(3, serde_json::json!({"providers":[]})),
        ]),
    });
    super::set_issue_settings(
        &mut client,
        crate::config::IssueConfigEdit {
            expected_revision: 1,
            config: current.issues.clone(),
        },
    )
    .unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|request| request["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["issue/configure", "config/read", "provider/list"]
    );
    assert_eq!(requests[0]["params"]["expectedRevision"], 1);
    assert_eq!(
        requests[0]["params"]["config"],
        serde_json::json!({"autoRefreshMinutes":30})
    );
    assert!(requests[0]["params"].get("tui").is_none());
    assert!(requests[0]["params"].get("model").is_none());
}

#[test]
fn probing_unsaved_values_does_not_write_configuration_or_credentials() {
    for operation in [crate::config::provider::Operation::Test] {
        let current = empty_config_snapshot();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let mut client = AppServerClient::new(RecordingTransport {
            requests: requests.clone(),
            responses: VecDeque::from([
                response(
                    1,
                    serde_json::json!({"type":"failed","message":"Check the API key"}),
                ),
                response(2, serde_json::to_value(&current).unwrap()),
                response(3, serde_json::json!({"providers":[]})),
            ]),
        });
        let (_, result) = super::execute_connection(
            &mut client,
            crate::config::provider::Request {
                model: Some("alias".into()),
                id: crate::client::new_command_id("probe"),
                revision: 7,
                config: ash_app_server_protocol::protocol::config::ProviderConfigDto {
                    provider: "custom-test".into(),
                    custom: None,
                    base_url: Some("https://example.test/v1".into()),
                    max_output_tokens: None,
                    model_context: [(
                        "alias".into(),
                        ash_app_server_protocol::protocol::config::ModelContextConfigDto {
                            context_window: 272_000,
                            auto_compact_token_limit: None,
                        },
                    )]
                    .into(),
                },
                key: Some(crate::config::ProviderApiKeyEdit::new(
                    "custom-test".into(),
                    "draft-key".into(),
                )),
                operation,
            },
        )
        .unwrap();
        assert_eq!(result.unwrap().unwrap_err(), "Check the API key");
        let requests = requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .map(|request| request["method"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["provider/probe", "config/read", "provider/list"]
        );
        assert_eq!(requests[0]["params"]["apiKey"], "draft-key");
        assert_eq!(
            requests[0]["params"]["config"]["baseUrl"],
            "https://example.test/v1"
        );
        if operation == crate::config::provider::Operation::Test {
            assert_eq!(requests[0]["params"]["model"], "alias");
        } else {
            assert!(requests[0]["params"]["model"].is_null());
        }
    }
}

#[test]
fn language_server_switch_uses_the_backend_config_authority_and_refreshes_the_tab() {
    let executable = "C:\\tools\\rust-analyzer.exe";
    let mut refreshed = empty_config_snapshot();
    refreshed.revision = 8;
    refreshed.language_servers.insert(
        "rust-analyzer".into(),
        LanguageServerConfigDto {
            mode: LanguageServerModeDto::Enabled,
            executable: Some(executable.into()),
        },
    );
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        responses: VecDeque::from([
            response(
                1,
                serde_json::to_value(ConfigCommandResult {
                    revision: 8,
                    generation: 2,
                    disposition: ConfigCommandDispositionDto::Updated,
                })
                .unwrap(),
            ),
            response(2, serde_json::to_value(refreshed).unwrap()),
            response(
                3,
                serde_json::to_value(ProviderListResult {
                    providers: Vec::new(),
                })
                .unwrap(),
            ),
        ]),
        requests: Arc::clone(&requests),
    });

    let result = set_language_server_mode(
        &mut client,
        LanguageServerEdit {
            expected_revision: 7,
            server_id: "rust-analyzer".into(),
            config: LanguageServerConfigDto {
                mode: LanguageServerModeDto::Enabled,
                executable: Some(executable.into()),
            },
        },
    )
    .unwrap();

    let requests = requests.lock().expect("request log is not poisoned");
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0]["method"], "languageServer/configure");
    assert_eq!(requests[0]["params"]["expectedRevision"], 7);
    assert_eq!(requests[0]["params"]["serverId"], "rust-analyzer");
    assert_eq!(requests[0]["params"]["config"]["mode"], "enabled");
    assert_eq!(requests[0]["params"]["config"]["executable"], executable);
    assert_eq!(requests[1]["method"], "config/read");
    assert_eq!(requests[2]["method"], "provider/list");
    drop(requests);

    let mut state = ListSelectionState::new(result.choices.model);
    state.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    state.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    let _ = state.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    let _ = state.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    assert_eq!(state.visible_items().len(), 1);
    assert_eq!(
        state.visible_items()[0].description(),
        Some("C:\\tools\\rust-analyzer.exe [ ✔ ]")
    );
}

fn response(id: u64, result: serde_json::Value) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
    .to_string()
}

#[test]
fn probe_transport_failure_returns_without_writing_or_refreshing() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        requests: requests.clone(),
        responses: VecDeque::new(),
    });
    let result = super::execute_connection(
        &mut client,
        crate::config::provider::Request {
            model: Some("alias".into()),
            id: crate::client::new_command_id("test"),
            revision: 0,
            config: ash_app_server_protocol::protocol::config::ProviderConfigDto {
                provider: "custom-test".into(),
                custom: None,
                base_url: Some("https://example.test/v1".into()),
                max_output_tokens: None,
                model_context: Default::default(),
            },
            key: None,
            operation: crate::config::provider::Operation::Test,
        },
    );
    assert!(result.is_err());
    assert_eq!(requests.lock().unwrap().len(), 1);
}

#[test]
fn custom_provider_saves_settings_and_key_separately_then_refreshes() {
    let config = ash_app_server_protocol::protocol::config::ProviderConfigDto {
        provider: "custom-one".into(),
        custom: Some(
            ash_app_server_protocol::protocol::config::CustomProviderConfigDto {
                context_window: 272_000,
                order: 0,
                model: None,
                name: "Example".into(),
                protocol:
                    ash_app_server_protocol::protocol::config::CustomProviderProtocolDto::Responses,
            },
        ),
        base_url: Some("https://example.test/v1".into()),
        max_output_tokens: Some(2048),
        model_context: Default::default(),
    };
    let mut refreshed = empty_config_snapshot();
    refreshed.revision = 8;
    refreshed
        .providers
        .insert(config.provider.clone(), config.clone());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        requests: requests.clone(),
        responses: VecDeque::from([
            response(1, serde_json::to_value(empty_config_snapshot()).unwrap()),
            response(
                2,
                serde_json::json!({"revision":8,"generation":2,"disposition":"updated"}),
            ),
            response(
                3,
                serde_json::json!({"provider":"custom-one","apiKeyConfigured":true}),
            ),
            response(4, serde_json::to_value(refreshed).unwrap()),
            response(5, serde_json::json!({"providers":[]})),
        ]),
    });
    let result = super::execute(
        &mut client,
        super::Command::Connection(crate::config::provider::Request {
            model: Some("alias".into()),
            id: crate::client::new_command_id("test"),
            revision: 7,
            config: config.clone(),
            key: Some(crate::config::ProviderApiKeyEdit::new(
                "custom-one".into(),
                "test-key".into(),
            )),
            operation: crate::config::provider::Operation::Save,
        }),
    )
    .unwrap();
    assert!(matches!(result, super::Event::Connection(reply) if reply.result.is_ok()));
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 5);
    assert_eq!(requests[1]["method"], "provider/configure");
    assert_eq!(requests[1]["params"]["expectedRevision"], 7);
    assert_eq!(
        requests[1]["params"]["config"],
        serde_json::to_value(config).unwrap()
    );
    assert!(!requests[1].to_string().contains("test-key"));
    assert_eq!(requests[2]["method"], "provider/apiKey/set");
    assert_eq!(requests[2]["params"]["provider"], "custom-one");
}

#[test]
fn rejected_connection_update_does_not_send_key_or_report_saved() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        requests: requests.clone(), responses: VecDeque::from([
            response(1, serde_json::to_value(empty_config_snapshot()).unwrap()),
            serde_json::json!({"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"InvalidParams"}}).to_string(),
        ]),
    });
    let result = super::execute(
        &mut client,
        super::Command::Connection(crate::config::provider::Request {
            model: Some("alias".into()),
            id: crate::client::new_command_id("test"),
            revision: 7,
            config: ash_app_server_protocol::protocol::config::ProviderConfigDto {
                provider: "openai-compatible".into(),
                custom: None,
                base_url: Some("invalid".into()),
                max_output_tokens: None,
                model_context: Default::default(),
            },
            key: Some(crate::config::ProviderApiKeyEdit::new(
                "openai-compatible".into(),
                "test-key".into(),
            )),
            operation: crate::config::provider::Operation::Save,
        }),
    )
    .unwrap();
    assert!(matches!(result, super::Event::Connection(reply) if reply.result.is_err()));
    assert_eq!(requests.lock().unwrap().len(), 2);
}

#[test]
fn saving_key_configures_default_model_without_fetching_models() {
    for existing in [false, true] {
        let mut current = empty_config_snapshot();
        let config = ash_app_server_protocol::protocol::config::ProviderConfigDto {
            provider: "openai".into(),
            custom: None,
            base_url: Some("https://proxy.example.test/v1".into()),
            max_output_tokens: None,
            model_context: Default::default(),
        };
        if existing {
            current.providers.insert("openai".into(), config.clone());
        }
        let requests = Arc::new(Mutex::new(Vec::new()));
        let mut client = AppServerClient::new(RecordingTransport {
            requests: requests.clone(),
            responses: VecDeque::from([
                response(1, serde_json::to_value(&current).unwrap()),
                response(
                    2,
                    serde_json::json!({"revision":8,"generation":2,"disposition":"updated"}),
                ),
                response(
                    3,
                    serde_json::json!({"provider":"openai","apiKeyConfigured":true}),
                ),
                response(4, serde_json::to_value(&current).unwrap()),
                response(5, serde_json::json!({"providers":[]})),
            ]),
        });
        super::set_provider_api_key(
            &mut client,
            crate::config::ProviderApiKeyEdit::new("openai".into(), "test-key".into()),
        )
        .unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .map(|request| request["method"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "config/read",
                "provider/configure",
                "provider/apiKey/set",
                "config/read",
                "provider/list"
            ]
        );
        if existing {
            assert_eq!(
                requests[1]["params"]["config"],
                serde_json::to_value(&config).unwrap()
            );
        }
    }
}

#[test]
fn saving_unchanged_connection_with_no_model_still_configures_provider() {
    let mut current = empty_config_snapshot();
    let config = ash_app_server_protocol::protocol::config::ProviderConfigDto {
        provider: "openai".into(),
        custom: None,
        base_url: None,
        max_output_tokens: None,
        model_context: Default::default(),
    };
    current.providers.insert("openai".into(), config.clone());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        requests: requests.clone(),
        responses: VecDeque::from([
            response(1, serde_json::to_value(&current).unwrap()),
            response(
                2,
                serde_json::json!({"revision":8,"generation":2,"disposition":"updated"}),
            ),
            response(3, serde_json::to_value(&current).unwrap()),
            response(4, serde_json::json!({"providers":[]})),
        ]),
    });
    let result = super::execute(
        &mut client,
        super::Command::Connection(crate::config::provider::Request {
            model: Some("alias".into()),
            id: crate::client::new_command_id("test"),
            revision: current.revision,
            config,
            key: None,
            operation: crate::config::provider::Operation::Save,
        }),
    )
    .unwrap();
    assert!(matches!(result, super::Event::Connection(reply) if reply.result.is_ok()));
    let requests = requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|request| request["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "config/read",
            "provider/configure",
            "config/read",
            "provider/list"
        ]
    );
}
