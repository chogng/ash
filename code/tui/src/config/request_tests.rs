use crate::test_support::empty_config_snapshot;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::provider::ProviderListResult;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

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
fn advisor_model_selection_updates_global_config() {
    let mut current = empty_config_snapshot();
    current.revision = 4;
    let advisor = ash_protocol::AdvisorConfig::new(ash_protocol::ModelRef::new(
        ash_protocol::ProviderId::new("openai").unwrap(),
        ash_protocol::ModelId::new("gpt-ash").unwrap(),
    ));
    let mut saved = current.clone();
    saved.revision = 5;
    saved.advisor = Some(advisor.clone());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        requests: requests.clone(),
        responses: VecDeque::from([
            response(1, serde_json::json!({"models":[]})),
            response(2, serde_json::to_value(&current).unwrap()),
            response(
                3,
                serde_json::json!({"revision":5,"generation":2,"disposition":"updated"}),
            ),
            response(4, serde_json::to_value(&saved).unwrap()),
            response(5, serde_json::json!({"providers":[]})),
        ]),
    });
    let crate::config::Event::AdvisorSaved(_, _) =
        super::execute(&mut client, super::Command::SetAdvisor(Some(advisor))).unwrap()
    else {
        panic!("expected refreshed settings")
    };
    let requests = requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|request| request["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "model/list",
            "config/read",
            "config/update",
            "config/read",
            "provider/list"
        ]
    );
    assert_eq!(requests[2]["params"]["expectedRevision"], 4);
    assert_eq!(requests[0]["params"]["view"], "builtIn");
    assert_eq!(
        requests[2]["params"]["advisor"]["model"],
        serde_json::json!({"provider":"openai","model":"gpt-ash"})
    );
    assert!(requests[2]["params"].get("tui").is_none());
    assert!(requests[2]["params"].get("model").is_none());
}

#[test]
fn advisor_off_command_preserves_the_selected_model() {
    let mut current = empty_config_snapshot();
    current.revision = 4;
    current.advisor = Some(ash_protocol::AdvisorConfig::new(
        ash_protocol::ModelRef::new(
            ash_protocol::ProviderId::new("openai").unwrap(),
            ash_protocol::ModelId::new("reviewer").unwrap(),
        ),
    ));
    let mut saved = current.clone();
    saved.revision = 5;
    saved.advisor.as_mut().unwrap().enabled = false;
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        requests: requests.clone(),
        responses: VecDeque::from([
            response(1, serde_json::to_value(&current).unwrap()),
            response(2, serde_json::to_value(&current).unwrap()),
            response(
                3,
                serde_json::json!({"revision":5,"generation":2,"disposition":"updated"}),
            ),
            response(4, serde_json::to_value(&saved).unwrap()),
            response(5, serde_json::json!({"providers":[]})),
        ]),
    });
    super::execute(&mut client, super::Command::SelectAdvisor("off".into())).unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests[2]["method"], "config/update");
    assert_eq!(requests[2]["params"]["advisor"]["enabled"], false);
    assert_eq!(
        requests[2]["params"]["advisor"]["model"],
        serde_json::json!({"provider":"openai","model":"reviewer"})
    );
}

#[test]
fn advisor_model_command_selects_a_configured_provider_model() {
    use ash_app_server_protocol::protocol::model::{ModelCatalogEntry, ModelListResult};
    use ash_protocol::{
        AdvisorConfig, ModelAccess, ModelCapabilities, ModelId, ModelOutputTransport, ModelRef,
        ProviderId,
    };

    let model = ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new("reviewer").unwrap(),
    );
    let mut current = empty_config_snapshot();
    current.revision = 4;
    current.providers.insert(
        "openai".into(),
        ash_app_server_protocol::protocol::config::ProviderConfigDto {
            provider: "openai".into(),
            custom: None,
            base_url: None,
            max_output_tokens: None,
            model_context: Default::default(),
        },
    );
    let catalog = ModelListResult {
        models: vec![ModelCatalogEntry {
            model: model.clone(),
            display_name: "Reviewer".into(),
            access: ModelAccess::Unknown,
            output_transport: ModelOutputTransport::Unary,
            context_window: None,
            auto_compact_token_limit: None,
            available_context_window: None,
            capabilities: ModelCapabilities::UNKNOWN,
            supported_reasoning_efforts: Vec::new(),
            model_reasoning_effort: None,
            default_personality: None,
        }],
    };
    let mut saved = current.clone();
    saved.revision = 5;
    saved.advisor = Some(AdvisorConfig::new(model));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        requests: requests.clone(),
        responses: VecDeque::from([
            response(1, serde_json::to_value(&current).unwrap()),
            response(2, serde_json::to_value(&catalog).unwrap()),
            response(3, serde_json::to_value(&current).unwrap()),
            response(
                4,
                serde_json::json!({"revision":5,"generation":2,"disposition":"updated"}),
            ),
            response(5, serde_json::to_value(&saved).unwrap()),
            response(6, serde_json::json!({"providers":[]})),
        ]),
    });
    super::execute(
        &mut client,
        super::Command::SelectAdvisor("openai/reviewer".into()),
    )
    .unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests[3]["method"], "config/update");
    assert_eq!(requests[3]["params"]["advisor"]["enabled"], true);
    assert_eq!(
        requests[3]["params"]["advisor"]["model"],
        serde_json::json!({"provider":"openai","model":"reviewer"})
    );
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
fn coding_plan_sign_in_saves_each_key_on_its_own_endpoint() {
    for (subscription, plan_id, api_id, api_endpoint, plan_endpoint) in [
        (
            crate::config::SubscriptionProvider::BigModel,
            "bigmodel-coding-plan",
            "bigmodel",
            "https://open.bigmodel.cn/api/paas/v4",
            ash_model_provider_config::BIGMODEL_CODING_PLAN_BASE_URL,
        ),
        (
            crate::config::SubscriptionProvider::Zai,
            "zai-coding-plan",
            "zai",
            "https://api.z.ai/api/paas/v4",
            ash_model_provider_config::ZAI_CODING_PLAN_BASE_URL,
        ),
    ] {
        let mut current = empty_config_snapshot();
        let mut plan = ash_app_server_protocol::protocol::config::ProviderConfigDto {
            provider: plan_id.into(),
            custom: None,
            base_url: None,
            max_output_tokens: None,
            model_context: Default::default(),
        };
        current.providers.insert(plan_id.into(), plan.clone());
        current.providers.insert(
            api_id.into(),
            ash_app_server_protocol::protocol::config::ProviderConfigDto {
                provider: api_id.into(),
                custom: None,
                base_url: Some(api_endpoint.into()),
                max_output_tokens: None,
                model_context: Default::default(),
            },
        );
        plan.base_url = Some(plan_endpoint.into());
        let mut saved = current.clone();
        saved.providers.insert(plan_id.into(), plan.clone());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let mut client = AppServerClient::new(RecordingTransport {
            requests: requests.clone(),
            responses: VecDeque::from([
                response(1, serde_json::to_value(&current).unwrap()),
                response(
                    2,
                    serde_json::json!({"revision":2,"generation":1,"disposition":"updated"}),
                ),
                response(
                    3,
                    serde_json::json!({"provider":plan_id,"apiKeyConfigured":true}),
                ),
                response(4, serde_json::to_value(&saved).unwrap()),
                response(
                    5,
                    serde_json::json!({"providers":[{"provider":plan_id,"displayName":plan_id,"apiKeyPolicy":"required","apiKeyConfigured":true}]}),
                ),
            ]),
        });
        let update = super::set_provider_api_key(
            &mut client,
            crate::config::ProviderApiKeyEdit::new(api_id.into(), "plan-key".into())
                .for_coding_plan(subscription),
        )
        .unwrap();
        assert_eq!(
            update.plan,
            Some((
                subscription,
                crate::config::PlanStatus {
                    key_saved: true,
                    enabled: true,
                }
            ))
        );
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
        assert_eq!(
            requests[1]["params"]["config"],
            serde_json::to_value(plan).unwrap()
        );
        assert_eq!(requests[2]["params"]["provider"], plan_id);
        assert_eq!(requests[2]["params"]["apiKey"], "plan-key");
        assert_eq!(saved.providers.get(api_id), current.providers.get(api_id));
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

#[test]
fn config_reset_saves_with_revision_and_preserves_other_values() {
    let mut current = empty_config_snapshot();
    current.revision = 7;
    let mut terminal = crate::config::TerminalSettings::default();
    terminal.set_input_mode(crate::thread::composer::ChatInputMode::Vim);
    terminal.set_memory_diagnostics(true);
    current.tui = terminal.write_to_tui(&current.tui).unwrap();
    current
        .tui
        .0
        .insert("other".into(), serde_json::json!(["keep"]));
    let mut editor = crate::config::ConfigEditor::new(crate::config::config_choices(
        &current,
        &ProviderListResult {
            providers: Vec::new(),
        },
        terminal,
        crate::status::StatusLineSettings::default(),
    ));
    let crate::config::ConfigEditorOutcome::Action(
        crate::config::ConfigSelectionAction::SetVimMode(edit),
    ) = editor.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE))
    else {
        panic!("expected reset edit")
    };
    let mut saved = current.clone();
    saved.revision = 8;
    saved.tui = edit
        .status_line
        .write_to_tui(&edit.terminal.write_to_tui(&current.tui).unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        requests: requests.clone(),
        responses: VecDeque::from([
            response(
                1,
                serde_json::json!({"revision":8,"generation":2,"disposition":"updated"}),
            ),
            response(2, serde_json::to_value(&saved).unwrap()),
        ]),
    });
    let crate::config::Event::Updated(result) =
        super::execute(&mut client, super::Command::Edit(edit)).unwrap()
    else {
        panic!("expected refreshed settings")
    };
    assert_eq!(
        result.terminal.input_mode(),
        crate::thread::composer::ChatInputMode::Standard
    );
    assert!(result.terminal.memory_diagnostics());
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["method"], "config/update");
    assert_eq!(requests[1]["method"], "config/read");
    let params = &requests[0]["params"];
    assert_eq!(params["expectedRevision"], 7);
    assert_eq!(params["tui"]["inputMode"], "standard");
    assert_eq!(params["tui"]["memoryDiagnostics"], true);
    assert_eq!(params["tui"]["other"], serde_json::json!(["keep"]));
    assert!(params.get("gui").is_none());
    assert!(params.get("model").is_none());
}

#[test]
fn memories_toggle_updates_backend_features_and_preserves_other_overrides() {
    let mut current = empty_config_snapshot();
    current.features = features::resolve(
        &[
            (features::Feature::Queue, false),
            (features::Feature::Memories, true),
        ]
        .into_iter()
        .collect(),
    );
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        requests: requests.clone(),
        responses: VecDeque::from([
            response(
                1,
                serde_json::json!({"revision":1,"generation":1,"disposition":"updated"}),
            ),
            response(2, serde_json::to_value(&current).unwrap()),
        ]),
    });
    super::set_memories(
        &mut client,
        crate::config::ConfigEdit {
            terminal: Default::default(),
            status_line: Default::default(),
            server_config: current,
            providers: ProviderListResult {
                providers: Vec::new(),
            },
        },
    )
    .unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests[0]["method"], "config/update");
    assert_eq!(
        requests[0]["params"]["features"],
        serde_json::json!({"queue":false,"memories":true})
    );
    assert!(requests[0]["params"].get("tui").is_none());
}

#[test]
fn git_settings_update_only_the_shared_git_section() {
    let mut current = empty_config_snapshot();
    current.revision = 7;
    current.git.autofetch = ash_app_server_protocol::protocol::config::GitAutoFetchModeDto::All;
    current.git.autofetch_period = 300;
    let mut saved = current.clone();
    saved.revision = 8;
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut client = AppServerClient::new(RecordingTransport {
        requests: requests.clone(),
        responses: VecDeque::from([
            response(
                1,
                serde_json::json!({"revision":8,"generation":2,"disposition":"updated"}),
            ),
            response(2, serde_json::to_value(&saved).unwrap()),
        ]),
    });
    let crate::config::Event::Updated(_) = super::execute(
        &mut client,
        super::Command::SetGit(crate::config::ConfigEdit {
            terminal: Default::default(),
            status_line: Default::default(),
            server_config: current,
            providers: ProviderListResult {
                providers: Vec::new(),
            },
        }),
    )
    .unwrap() else {
        panic!("expected refreshed settings");
    };
    let requests = requests.lock().unwrap();
    assert_eq!(requests[0]["method"], "config/update");
    assert_eq!(requests[0]["params"]["expectedRevision"], 7);
    assert_eq!(
        requests[0]["params"]["git"],
        serde_json::json!({"autofetch":"all","autofetchPeriod":300})
    );
    assert!(requests[0]["params"].get("tui").is_none());
}
