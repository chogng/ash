use super::*;
use crate::widgets::list_selection::ListSelectionState;
use ash_app_server_client::ClientError;
use ash_app_server_protocol::protocol::account::AccountDto;
use ash_app_server_protocol::protocol::account::AccountLoginFailureDto;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_protocol::ModelId;
use ash_protocol::ModelInfo;
use ash_protocol::ModelOutputTransport;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use std::collections::VecDeque;

fn account(revision: u64) -> AccountReadResult {
    AccountReadResult {
        revision,
        accounts: vec![AccountDto {
            provider: SubscriptionProvider::ChatGpt.id().into(),
            account_id: "account-1".into(),
            email: Some("person@example.com".into()),
            display_name: Some("ChatGPT".into()),
            organization: None,
            plan: Some("pro".into()),
            status: AccountStatusDto::Ready,
            credential_revision: 1,
        }],
    }
}

fn model(provider: &str, id: &str, name: &str, access: ModelAccess) -> ModelCatalogEntry {
    let model = ModelRef::new(
        ProviderId::new(provider).unwrap(),
        ModelId::new(id).unwrap(),
    );
    let mut info = ModelInfo::new(model.model.clone(), name);
    info.access = access;
    ModelCatalogEntry::from_info(model, &info, ModelOutputTransport::Unary)
}

fn started() -> AccountLoginStartResult {
    AccountLoginStartResult::DeviceCode {
        login_id: "login-1".into(),
        verification_url: "https://auth.openai.com/codex/device".into(),
        user_code: "ABCD-1234".into(),
    }
}

fn started_event() -> SubscriptionEvent {
    SubscriptionEvent::Started {
        login: started(),
        browser_error: None,
    }
}

fn completion() -> AccountLoginCompleted {
    AccountLoginCompleted {
        login_id: "login-1".into(),
        status: AccountLoginCompletionStatusDto::Succeeded,
        account: account(2),
    }
}

fn labels(subscription: &Subscription) -> Vec<String> {
    ListSelectionState::new(subscription.choices().model)
        .visible_items()
        .iter()
        .map(|item| item.label().into())
        .collect()
}

#[test]
fn signed_in_account_shows_only_its_discovered_subscription_models() {
    let mut subscription = Subscription::default();
    subscription.update(SubscriptionEvent::Read {
        account: account(1),
        models: Some(Ok(vec![
            model("openai", "gpt-ash", "GPT Ash", ModelAccess::Subscription),
            model("openai", "gpt-new", "GPT New", ModelAccess::Subscription),
        ])),
    });
    let rows = labels(&subscription);
    assert!(rows.contains(&"Models".into()));
    assert!(rows.contains(&"GPT Ash".into()));
    assert!(rows.contains(&"GPT New".into()));
    assert!(!rows.contains(&"Loading models…".into()));
    let state = ListSelectionState::new(subscription.choices().model);
    assert!(state
        .visible_items()
        .iter()
        .filter(|item| item.label() == "GPT Ash" || item.label() == "GPT New")
        .all(|item| item.description().is_none()));

    subscription.update(SubscriptionEvent::Updated(AccountReadResult {
        revision: 2,
        accounts: vec![],
    }));
    assert!(!labels(&subscription).contains(&"GPT Ash".into()));
    subscription.update(SubscriptionEvent::Read {
        account: account(1),
        models: Some(Ok(vec![model(
            "openai",
            "stale",
            "Stale",
            ModelAccess::Subscription,
        )])),
    });
    assert!(!labels(&subscription).contains(&"Stale".into()));
}

#[test]
fn credential_rotation_during_model_fetch_does_not_start_another_fetch() {
    let mut subscription = Subscription::default();
    let mut rotated = account(2);
    rotated.accounts[0].credential_revision = 2;
    subscription.update(SubscriptionEvent::Updated(rotated));
    assert!(subscription.needs_model_refresh());

    subscription.update(SubscriptionEvent::Read {
        account: account(1),
        models: Some(Ok(vec![model(
            "openai",
            "gpt-ash",
            "GPT Ash",
            ModelAccess::Subscription,
        )])),
    });
    assert!(labels(&subscription).contains(&"GPT Ash".into()));
    assert!(!subscription.needs_model_refresh());

    let mut rotated_again = account(3);
    rotated_again.accounts[0].credential_revision = 3;
    subscription.update(SubscriptionEvent::Updated(rotated_again));
    assert!(labels(&subscription).contains(&"GPT Ash".into()));
    assert!(!subscription.needs_model_refresh());
}

#[test]
fn model_catalog_failure_keeps_account_visible_and_reports_error() {
    let mut subscription = Subscription::default();
    subscription.update(SubscriptionEvent::Read {
        account: account(1),
        models: Some(Err("catalog unavailable".into())),
    });
    let state = ListSelectionState::new(subscription.choices().model);
    assert!(labels(&subscription).contains(&"Signed in".into()));
    assert!(state.visible_items().iter().any(|item| {
        item.label() == "Could not load models" && item.description() == Some("catalog unavailable")
    }));
}

#[test]
fn login_waits_without_blocking_and_completion_shows_account_and_plan() {
    let mut subscription = Subscription::default();
    subscription.update(SubscriptionEvent::Read {
        account: AccountReadResult {
            revision: 1,
            accounts: vec![],
        },
        models: None,
    });
    assert!(labels(&subscription).contains(&"Sign in with ChatGPT".into()));
    assert!(subscription.begin(&SubscriptionCommand::SignIn));
    assert!(!subscription.begin(&SubscriptionCommand::SignIn));
    subscription.update(started_event());
    assert!(!subscription.begin(&SubscriptionCommand::SignIn));
    let state = ListSelectionState::new(subscription.choices().model);
    assert!(
        state
            .visible_items()
            .iter()
            .any(|item| item.description() == Some("ABCD-1234"))
    );
    assert!(labels(&subscription).contains(&"Cancel sign-in".into()));
    subscription.update(SubscriptionEvent::Completed(completion()));
    assert!(labels(&subscription).contains(&"Signed in".into()));
    let state = ListSelectionState::new(subscription.choices().model);
    assert!(
        state
            .visible_items()
            .iter()
            .any(|item| item.description() == Some("pro"))
    );
    assert!(!labels(&subscription).contains(&"Cancel sign-in".into()));
}

#[test]
fn completion_before_start_response_does_not_restore_a_finished_login() {
    let mut subscription = Subscription::default();
    subscription.begin(&SubscriptionCommand::SignIn);
    subscription.update(SubscriptionEvent::Completed(completion()));
    let mut other = completion();
    other.login_id = "another-provider-login".into();
    subscription.update(SubscriptionEvent::Completed(other));
    subscription.update(started_event());
    assert!(labels(&subscription).contains(&"Signed in".into()));
    assert!(!labels(&subscription).contains(&"Cancel sign-in".into()));
}

#[test]
fn failed_login_and_request_errors_allow_retry() {
    let mut subscription = Subscription::default();
    subscription.begin(&SubscriptionCommand::SignIn);
    subscription.update(SubscriptionEvent::Failed("Service unavailable".into()));
    assert!(subscription.begin(&SubscriptionCommand::SignIn));
    subscription.update(started_event());
    let mut completed = completion();
    completed.account.accounts.clear();
    completed.status = AccountLoginCompletionStatusDto::Failed {
        failure: AccountLoginFailureDto {
            code: "expired".into(),
            message: "Code expired".into(),
        },
    };
    subscription.update(SubscriptionEvent::Completed(completed));
    assert!(labels(&subscription).contains(&"Code expired".into()));
    assert!(subscription.begin(&SubscriptionCommand::SignIn));
}

#[test]
fn older_account_reads_and_unrelated_completions_cannot_replace_current_state() {
    let mut subscription = Subscription::default();
    subscription.update(SubscriptionEvent::Updated(account(5)));
    subscription.update(SubscriptionEvent::Read {
        account: AccountReadResult {
            revision: 4,
            accounts: vec![],
        },
        models: None,
    });
    subscription.update(started_event());
    let mut other = completion();
    other.login_id = "another-login".into();
    subscription.update(SubscriptionEvent::Completed(other));
    assert!(labels(&subscription).contains(&"Signed in".into()));
    assert!(labels(&subscription).contains(&"Cancel sign-in".into()));
}

#[test]
fn cancellation_after_completion_preserves_the_successful_account() {
    let mut subscription = Subscription::default();
    subscription.update(started_event());
    subscription.begin(&SubscriptionCommand::Cancel {
        login_id: "login-1".into(),
    });
    subscription.update(SubscriptionEvent::Completed(completion()));
    subscription.update(SubscriptionEvent::Cancelled {
        login_id: "login-1".into(),
    });
    assert!(labels(&subscription).contains(&"Signed in to ChatGPT".into()));
    assert!(!labels(&subscription).contains(&"Sign-in cancelled".into()));
}

struct Transport {
    requests: Vec<serde_json::Value>,
    results: VecDeque<serde_json::Value>,
}

#[test]
fn reconnecting_existing_codex_credentials_reads_the_account_without_a_challenge() {
    let mut client = AppServerClient::new(Transport {
        requests: Vec::new(),
        results: VecDeque::from([
            serde_json::json!({"type":"connected","loginId":"login-1"}),
            serde_json::to_value(account(2)).unwrap(),
            serde_json::to_value(ModelListResult {
                models: vec![
                    model("openai", "gpt-ash", "GPT Ash", ModelAccess::Subscription),
                    model("xai", "grok-ash", "Grok Ash", ModelAccess::Subscription),
                    model("openai", "api-model", "API Model", ModelAccess::ApiKey),
                ],
            })
            .unwrap(),
        ]),
    });
    assert_eq!(
        execute_with_browser(
            &mut client,
            SubscriptionProvider::ChatGpt,
            SubscriptionCommand::SignIn,
            |_| panic!("an existing login must not open a browser"),
        ),
        SubscriptionEvent::Read {
            account: account(2),
            models: Some(Ok(vec![model(
                "openai",
                "gpt-ash",
                "GPT Ash",
                ModelAccess::Subscription
            )])),
        }
    );
    let requests = client.into_transport().requests;
    assert_eq!(
        requests
            .iter()
            .map(|request| request["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["account/login/start", "account/read", "model/list"]
    );
}

impl JsonRpcTransport for Transport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        let request: serde_json::Value = serde_json::from_str(request).unwrap();
        let response = serde_json::json!({ "jsonrpc": "2.0", "id": request["id"], "result": self.results.pop_front().unwrap() });
        self.requests.push(request);
        Ok(response.to_string())
    }
}

#[test]
fn account_actions_use_only_redacted_account_rpcs_and_logout_refreshes() {
    let mut client = AppServerClient::new(Transport {
        requests: Vec::new(),
        results: VecDeque::from([
            serde_json::to_value(account(1)).unwrap(),
            serde_json::json!({ "models": [] }),
            serde_json::to_value(started()).unwrap(),
            serde_json::json!({ "status": "cancelled" }),
            serde_json::json!({ "status": "loggedOut" }),
            serde_json::json!({ "revision": 2, "accounts": [] }),
        ]),
    });
    assert!(matches!(
        execute(
            &mut client,
            SubscriptionProvider::ChatGpt,
            SubscriptionCommand::Read
        ),
        SubscriptionEvent::Read { .. }
    ));
    assert_eq!(
        execute_with_browser(
            &mut client,
            SubscriptionProvider::ChatGpt,
            SubscriptionCommand::SignIn,
            |url| {
                assert_eq!(url, "https://auth.openai.com/codex/device");
                Ok(())
            },
        ),
        started_event()
    );
    assert_eq!(
        execute(
            &mut client,
            SubscriptionProvider::ChatGpt,
            SubscriptionCommand::Cancel {
                login_id: "login-1".into()
            }
        ),
        SubscriptionEvent::Cancelled {
            login_id: "login-1".into()
        }
    );
    assert_eq!(
        execute(
            &mut client,
            SubscriptionProvider::ChatGpt,
            SubscriptionCommand::SignOut
        ),
        SubscriptionEvent::SignedOut(AccountReadResult {
            revision: 2,
            accounts: vec![]
        })
    );
    let requests = client.into_transport().requests;
    let calls: Vec<_> = requests.iter().map(|request| serde_json::json!({ "method": request["method"], "params": request["params"] })).collect();
    assert_eq!(
        calls,
        vec![
            serde_json::json!({ "method": "account/read", "params": {} }),
            serde_json::json!({ "method": "model/list", "params": { "view": "discovered" } }),
            serde_json::json!({ "method": "account/login/start", "params": { "method": { "type": "openAiChatGptDeviceCode" } } }),
            serde_json::json!({ "method": "account/login/cancel", "params": { "loginId": "login-1" } }),
            serde_json::json!({ "method": "account/logout", "params": { "provider": "chatgpt-subscription" } }),
            serde_json::json!({ "method": "account/read", "params": {} }),
        ]
    );
}

#[test]
fn xai_subscription_commands_select_xai_device_authorization_and_logout() {
    let mut client = AppServerClient::new(Transport {
        requests: Vec::new(),
        results: VecDeque::from([
            serde_json::json!({"type":"deviceCode","loginId":"xai-login","verificationUrl":"https://auth.x.ai/device","userCode":"XAI-1234"}),
            serde_json::json!({"status":"loggedOut"}),
            serde_json::json!({"revision":2,"accounts":[]}),
        ]),
    });
    assert!(matches!(
        execute_with_browser(
            &mut client,
            SubscriptionProvider::Xai,
            SubscriptionCommand::SignIn,
            |url| {
                assert_eq!(url, "https://auth.x.ai/device");
                Ok(())
            }
        ),
        SubscriptionEvent::Started {
            login: AccountLoginStartResult::DeviceCode { login_id, .. },
            browser_error: None,
        } if login_id == "xai-login"
    ));
    assert!(matches!(
        execute(
            &mut client,
            SubscriptionProvider::Xai,
            SubscriptionCommand::SignOut
        ),
        SubscriptionEvent::SignedOut(_)
    ));
    let requests = client.into_transport().requests;
    assert_eq!(
        requests[0]["params"],
        serde_json::json!({"method":{"type":"xaiDeviceCode"}})
    );
    assert_eq!(
        requests[1]["params"],
        serde_json::json!({"provider":"xai-subscription"})
    );
}

#[test]
fn browser_open_failure_keeps_the_device_challenge_available() {
    let mut client = AppServerClient::new(Transport {
        requests: Vec::new(),
        results: VecDeque::from([serde_json::to_value(started()).unwrap()]),
    });
    let event = execute_with_browser(
        &mut client,
        SubscriptionProvider::ChatGpt,
        SubscriptionCommand::SignIn,
        |url| {
            assert_eq!(url, "https://auth.openai.com/codex/device");
            Err("could not open browser".into())
        },
    );
    assert_eq!(
        event,
        SubscriptionEvent::Started {
            login: started(),
            browser_error: Some("could not open browser".into()),
        }
    );
    let mut subscription = Subscription::default();
    subscription.update(event);
    let state = ListSelectionState::new(subscription.choices().model);
    assert!(labels(&subscription).contains(&"Could not open browser".into()));
    assert!(labels(&subscription).contains(&"Open in your browser".into()));
    assert!(
        state
            .visible_items()
            .iter()
            .any(|item| { item.description() == Some("https://auth.openai.com/codex/device") })
    );
    assert!(labels(&subscription).contains(&"Cancel sign-in".into()));
}

#[test]
fn kimi_subscription_selects_the_kimi_device_code_login() {
    let mut client = AppServerClient::new(Transport {
        requests: Vec::new(),
        results: VecDeque::from([
            serde_json::json!({"type":"deviceCode","loginId":"kimi-login","verificationUrl":"https://auth.kimi.com/device","userCode":"KIMI-1234"}),
            serde_json::json!({"revision":2,"accounts":[]}),
        ]),
    });
    assert!(matches!(
        execute_with_browser(
            &mut client,
            SubscriptionProvider::Kimi,
            SubscriptionCommand::SignIn,
            |url| {
                assert_eq!(url, "https://auth.kimi.com/device");
                Ok(())
            }
        ),
        SubscriptionEvent::Started {
            login: AccountLoginStartResult::DeviceCode { login_id, .. },
            browser_error: None,
        } if login_id == "kimi-login"
    ));
    assert_eq!(
        client.into_transport().requests[0]["params"],
        serde_json::json!({"method":{"type":"kimiDeviceCode"}})
    );
}

fn zai_providers(
    key_configured: bool,
) -> ash_app_server_protocol::protocol::provider::ProviderListResult {
    ash_app_server_protocol::protocol::provider::ProviderListResult {
        providers: vec![
            ash_app_server_protocol::protocol::provider::ProviderCatalogEntryDto {
                provider: "zai".into(),
                display_name: "zAI".into(),
                api_key_policy:
                    ash_app_server_protocol::protocol::provider::ProviderApiKeyPolicyDto::Required,
                api_key_configured: key_configured,
            },
        ],
    }
}

#[test]
fn zai_plan_panel_shows_subscription_status_and_the_matching_action() {
    let mut subscription = Subscription::new(SubscriptionProvider::Zai);
    assert_eq!(labels(&subscription), vec!["Sign in with BigModel"]);
    let choices = subscription.choices();
    assert!(matches!(
        choices
            .actions
            .get(&ListSelectionItemId::new("Sign in with BigModel")),
        Some(ConfigSelectionAction::OpenProviderApiKey {
            target: ApiKeyTarget::ZaiCodingPlan,
            ..
        })
    ));

    subscription.update(SubscriptionEvent::Plan(PlanStatus {
        key_saved: false,
        enabled: true,
    }));
    assert!(labels(&subscription).contains(&"Coding plan enabled".into()));
    assert!(labels(&subscription).contains(&"Sign in with BigModel".into()));

    subscription.update(SubscriptionEvent::Plan(PlanStatus {
        key_saved: true,
        enabled: true,
    }));
    assert!(!labels(&subscription).iter().any(|label| label.contains("API key")));
    assert!(labels(&subscription).contains(&"Disable BigModel".into()));

    subscription.update(SubscriptionEvent::Plan(PlanStatus {
        key_saved: true,
        enabled: false,
    }));
    assert!(labels(&subscription).contains(&"Coding plan not enabled".into()));
    assert!(labels(&subscription).contains(&"Enable BigModel".into()));
}

#[test]
fn subscription_sign_in_actions_are_localized_in_chinese() {
    for (provider, expected) in [
        (SubscriptionProvider::Zai, "使用 BigModel 登录"),
        (SubscriptionProvider::Xai, "使用 Super Grok 登录"),
    ] {
        let subscription = Subscription::new(provider);
        let mut choices = subscription.choices();
        choices.model.localize(crate::nls::Language::Chinese);
        let state = ListSelectionState::new(choices.model);
        if provider == SubscriptionProvider::Zai {
            assert_eq!(
                state
                    .visible_items()
                    .iter()
                    .map(|item| item.label())
                    .collect::<Vec<_>>(),
                vec!["使用 BigModel 登录"]
            );
        }
        assert!(
            state
                .visible_items()
                .iter()
                .any(|item| item.label() == expected)
        );
    }
}

#[test]
fn zai_plan_read_derives_status_from_config_and_provider_catalog() {
    let mut client = AppServerClient::new(Transport {
        requests: Vec::new(),
        results: VecDeque::from([
            serde_json::to_value(crate::test_support::empty_config_snapshot()).unwrap(),
            serde_json::to_value(zai_providers(true)).unwrap(),
        ]),
    });
    assert_eq!(
        execute(
            &mut client,
            SubscriptionProvider::Zai,
            SubscriptionCommand::Read
        ),
        SubscriptionEvent::Plan(PlanStatus {
            key_saved: true,
            enabled: false,
        })
    );
}

#[test]
fn zai_plan_toggle_writes_the_coding_endpoint_and_rereads_status() {
    let mut config = crate::test_support::empty_config_snapshot();
    config.providers.insert(
        "zai".into(),
        ash_app_server_protocol::protocol::config::ProviderConfigDto {
            provider: "zai".into(),
            custom: None,
            base_url: Some(ash_model_provider_config::ZAI_CODING_PLAN_BASE_URL.into()),
            max_output_tokens: None,
            model_context: BTreeMap::new(),
        },
    );
    let configured = serde_json::to_value(config).unwrap();
    let mut client = AppServerClient::new(Transport {
        requests: Vec::new(),
        results: VecDeque::from([
            serde_json::to_value(crate::test_support::empty_config_snapshot()).unwrap(),
            serde_json::json!({"revision": 2, "generation": 1, "disposition": "updated"}),
            configured,
            serde_json::to_value(zai_providers(true)).unwrap(),
        ]),
    });
    assert_eq!(
        execute(
            &mut client,
            SubscriptionProvider::Zai,
            SubscriptionCommand::SetPlan { enabled: true }
        ),
        SubscriptionEvent::Plan(PlanStatus {
            key_saved: true,
            enabled: true,
        })
    );
    let requests = client.into_transport().requests;
    assert_eq!(requests[1]["method"], "provider/configure");
    assert_eq!(requests[1]["params"]["config"]["provider"], "zai");
    assert_eq!(
        requests[1]["params"]["config"]["baseUrl"],
        ash_model_provider_config::ZAI_CODING_PLAN_BASE_URL
    );
}
