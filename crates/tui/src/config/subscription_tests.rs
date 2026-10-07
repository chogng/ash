use super::*;
use crate::widgets::list_selection::ListSelectionState;
use ash_app_server_client::ClientError;
use ash_app_server_protocol::protocol::account::AccountDto;
use ash_app_server_protocol::protocol::account::AccountLoginFailureDto;
use ash_app_server_protocol::protocol::provider::ProviderModelsListFailureCodeDto;
use ash_app_server_protocol::protocol::provider::ProviderModelsListFailureDto;
use ash_app_server_protocol::protocol::provider::ProviderModelsListResult;
use ash_app_server_protocol::protocol::provider::ProviderModelsUpdated;
use ash_protocol::ModelAccess;
use ash_protocol::ModelId;
use ash_protocol::ModelInfo;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use std::collections::VecDeque;
use unicode_width::UnicodeWidthStr;

fn account(revision: u64) -> AccountReadResult {
    AccountReadResult {
        revision: revision.to_string(),
        accounts: vec![AccountDto {
            provider: SubscriptionProvider::ChatGpt.id().into(),
            account_id: "account-1".into(),
            email: Some("person@example.com".into()),
            display_name: Some("ChatGPT".into()),
            organization: None,
            plan: Some("pro".into()),
            status: AccountStatusDto::Ready,
            credential_revision: 1.to_string(),
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
    ModelCatalogEntry::from_info(model, &info)
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
    assert!(
        state
            .visible_items()
            .iter()
            .filter(|item| item.label() == "GPT Ash" || item.label() == "GPT New")
            .all(|item| item.description().is_none())
    );

    subscription.update(SubscriptionEvent::Updated(AccountReadResult {
        revision: 2.to_string(),
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
fn model_notifications_replace_models_for_the_current_account() {
    let mut subscription = Subscription::default();
    subscription.update(SubscriptionEvent::Read {
        account: account(1),
        models: Some(Ok(vec![model(
            "openai",
            "old",
            "Old model",
            ModelAccess::Subscription,
        )])),
    });
    let updated = ProviderModelsUpdated {
        connection: SubscriptionProvider::ChatGpt.id().into(),
        account_id: "account-1".into(),
        organization: None,
        plan: Some("pro".into()),
        result: ProviderModelsListResult::Models {
            models: vec![model(
                "openai",
                "new",
                "New model",
                ModelAccess::Subscription,
            )],
        },
    };
    assert!(subscription.begin(&SubscriptionCommand::Read));
    subscription.update(SubscriptionEvent::ModelsUpdated(updated.clone()));
    subscription.update(SubscriptionEvent::Read {
        account: account(1),
        models: Some(Ok(vec![model(
            "openai",
            "old",
            "Old model",
            ModelAccess::Subscription,
        )])),
    });
    assert!(labels(&subscription).contains(&"New model".into()));
    assert!(!labels(&subscription).contains(&"Old model".into()));
    assert!(!subscription.needs_initial_read());

    let mut stale = updated;
    stale.account_id = "previous-account".into();
    stale.result = ProviderModelsListResult::Models {
        models: vec![model(
            "openai",
            "stale",
            "Stale model",
            ModelAccess::Subscription,
        )],
    };
    subscription.update(SubscriptionEvent::ModelsUpdated(stale));
    assert!(!labels(&subscription).contains(&"Stale model".into()));
}

#[test]
fn failed_model_observation_replaces_loading_state() {
    let mut subscription = Subscription::default();
    subscription.update(SubscriptionEvent::Updated(account(1)));
    assert!(labels(&subscription).contains(&"Loading models…".into()));

    subscription.update(SubscriptionEvent::ModelsUpdated(ProviderModelsUpdated {
        connection: SubscriptionProvider::ChatGpt.id().into(),
        account_id: "account-1".into(),
        organization: None,
        plan: Some("pro".into()),
        result: ProviderModelsListResult::Failed {
            failure: ProviderModelsListFailureDto {
                code: ProviderModelsListFailureCodeDto::Unreachable,
            },
        },
    }));
    assert!(labels(&subscription).contains(&"Could not load models".into()));
    assert!(!labels(&subscription).contains(&"Loading models…".into()));
}

#[test]
fn credential_rotation_during_model_fetch_does_not_start_another_fetch() {
    let mut subscription = Subscription::default();
    let mut rotated = account(2);
    rotated.accounts[0].credential_revision = 2.to_string();
    subscription.update(SubscriptionEvent::Updated(rotated));
    assert!(labels(&subscription).contains(&"Loading models…".into()));

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
    assert!(!labels(&subscription).contains(&"Loading models…".into()));

    let mut rotated_again = account(3);
    rotated_again.accounts[0].credential_revision = 3.to_string();
    subscription.update(SubscriptionEvent::Updated(rotated_again));
    assert!(labels(&subscription).contains(&"GPT Ash".into()));
    assert!(!labels(&subscription).contains(&"Loading models…".into()));
}

#[test]
fn model_catalog_failure_keeps_account_visible_and_reports_error() {
    let mut subscription = Subscription::default();
    let event = SubscriptionEvent::Read {
        account: account(1),
        models: Some(Err("catalog unavailable".into())),
    };
    assert_eq!(
        subscription.error_dialog(&event),
        Some(("Could not load models", "catalog unavailable".into()))
    );
    subscription.update(event);
    let state = ListSelectionState::new(subscription.choices().model);
    assert!(!labels(&subscription).contains(&"Signed in".into()));
    assert!(
        state
            .visible_items()
            .iter()
            .any(|item| item.label() == "Account")
    );
    assert!(labels(&subscription).contains(&"Could not load models".into()));
}

#[test]
fn login_waits_without_blocking_and_completion_shows_account_and_plan() {
    let mut subscription = Subscription::default();
    subscription.update(SubscriptionEvent::Read {
        account: AccountReadResult {
            revision: 1.to_string(),
            accounts: vec![],
        },
        models: None,
    });
    assert!(labels(&subscription).contains(&"Sign in to ChatGPT".into()));
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
    assert!(!labels(&subscription).contains(&"Signed in".into()));
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
    assert!(!labels(&subscription).contains(&"Signed in".into()));
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
    let event = SubscriptionEvent::Completed(completed);
    assert_eq!(
        subscription.error_dialog(&event),
        Some(("Error", "Code expired".into()))
    );
    subscription.update(event);
    assert!(!labels(&subscription).contains(&"Code expired".into()));
    assert!(subscription.begin(&SubscriptionCommand::SignIn));
}

#[test]
fn failed_completion_before_start_response_opens_error_when_login_is_matched() {
    let mut subscription = Subscription::default();
    assert!(subscription.begin(&SubscriptionCommand::SignIn));
    let mut completed = completion();
    completed.account.accounts.clear();
    completed.status = AccountLoginCompletionStatusDto::Failed {
        failure: AccountLoginFailureDto {
            code: "expired".into(),
            message: "Code expired".into(),
        },
    };
    let completion = SubscriptionEvent::Completed(completed);
    assert_eq!(subscription.error_dialog(&completion), None);
    subscription.update(completion);
    let started = started_event();
    assert_eq!(
        subscription.error_dialog(&started),
        Some(("Error", "Code expired".into()))
    );
    subscription.update(started);
    assert_eq!(labels(&subscription), vec!["Sign in to ChatGPT"]);
}

#[test]
fn older_account_reads_and_unrelated_completions_cannot_replace_current_state() {
    let mut subscription = Subscription::default();
    subscription.update(SubscriptionEvent::Updated(account(5)));
    subscription.update(SubscriptionEvent::Read {
        account: AccountReadResult {
            revision: 4.to_string(),
            accounts: vec![],
        },
        models: None,
    });
    subscription.update(started_event());
    let mut other = completion();
    other.login_id = "another-login".into();
    subscription.update(SubscriptionEvent::Completed(other));
    assert!(!labels(&subscription).contains(&"Signed in".into()));
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
    assert_eq!(
        subscription.sign_out_availability(),
        SignOutAvailability::Available
    );
    assert!(
        !labels(&subscription)
            .iter()
            .any(|label| label.contains("Signed in"))
    );
    assert!(!labels(&subscription).contains(&"Cancel sign-in".into()));
}

#[test]
fn cancelled_login_returns_to_the_sign_in_action() {
    let mut subscription = Subscription::default();
    subscription.update(started_event());
    assert!(subscription.begin(&SubscriptionCommand::Cancel {
        login_id: "login-1".into(),
    }));
    subscription.update(SubscriptionEvent::Cancelled {
        login_id: "login-1".into(),
    });
    assert_eq!(
        labels(&subscription),
        vec!["Sign in to ChatGPT".to_string()]
    );
    assert_eq!(
        subscription.sign_out_availability(),
        SignOutAvailability::Unavailable
    );
}

#[test]
fn unusable_accounts_show_only_the_sign_in_action_for_every_subscription() {
    for provider in [
        SubscriptionProvider::ChatGpt,
        SubscriptionProvider::Xai,
        SubscriptionProvider::Kimi,
        SubscriptionProvider::BigModel,
        SubscriptionProvider::Zai,
        SubscriptionProvider::BigModelStartPlan,
        SubscriptionProvider::ZaiStartPlan,
    ] {
        for status in [
            AccountStatusDto::ReauthenticationRequired,
            AccountStatusDto::Unavailable,
        ] {
            let mut account = account(1);
            account.accounts[0].provider = provider.id().into();
            account.accounts[0].status = status;
            let mut subscription = Subscription::new(provider);
            subscription.update(SubscriptionEvent::Read {
                account,
                models: None,
            });
            assert_eq!(
                labels(&subscription),
                vec![format!("Sign in to {}", provider.name())]
            );
            assert_eq!(
                subscription.sign_out_availability(),
                SignOutAvailability::Unavailable
            );
        }
    }
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
            serde_json::to_value(ProviderModelsListResult::Models {
                models: vec![model(
                    "openai",
                    "gpt-ash",
                    "GPT Ash",
                    ModelAccess::Subscription,
                )],
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
        vec![
            "account/login/start",
            "account/read",
            "provider/models/list"
        ]
    );
    assert_eq!(
        requests[2]["params"],
        serde_json::json!({"connection":"chatgpt-subscription"})
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
fn external_coding_plan_logout_points_to_zcode() {
    struct ExternalLoginRequired;
    impl JsonRpcTransport for ExternalLoginRequired {
        fn round_trip(&mut self, _: &str) -> Result<String, ClientError> {
            Err(ClientError::Server {
                code: -32030,
                message: "AccountExternalLoginRequired".into(),
            })
        }
    }
    for provider in [SubscriptionProvider::BigModel, SubscriptionProvider::Zai] {
        let mut client = AppServerClient::new(ExternalLoginRequired);
        assert_eq!(
            execute(&mut client, provider, SubscriptionCommand::SignOut),
            SubscriptionEvent::Failed("Sign out of this Coding Plan account in ZCode.".into())
        );
    }
}

#[test]
fn account_actions_use_only_redacted_account_rpcs_and_logout_refreshes() {
    let mut client = AppServerClient::new(Transport {
        requests: Vec::new(),
        results: VecDeque::from([
            serde_json::to_value(account(1)).unwrap(),
            serde_json::to_value(ProviderModelsListResult::Empty).unwrap(),
            serde_json::to_value(started()).unwrap(),
            serde_json::json!({ "status": "cancelled" }),
            serde_json::json!({ "status": "loggedOut" }),
            serde_json::json!({ "revision":"2", "accounts": [] }),
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
            revision: 2.to_string(),
            accounts: vec![]
        })
    );
    let requests = client.into_transport().requests;
    let calls: Vec<_> = requests.iter().map(|request| serde_json::json!({ "method": request["method"], "params": request["params"] })).collect();
    assert_eq!(
        calls,
        vec![
            serde_json::json!({ "method": "account/read", "params": {} }),
            serde_json::json!({ "method": "provider/models/list", "params": {"connection":"chatgpt-subscription"} }),
            serde_json::json!({ "method": "account/login/start", "params": { "method": { "type": "openAiChatGptDeviceCode" } } }),
            serde_json::json!({ "method": "account/login/cancel", "params": { "loginId": "login-1" } }),
            serde_json::json!({ "method": "account/logout", "params": { "provider": "chatgpt-subscription" } }),
            serde_json::json!({ "method": "account/read", "params": {} }),
        ]
    );
}

#[test]
fn xai_account_reads_its_connection_catalog_and_reports_discovery_failure() {
    let mut xai_account = account(1);
    xai_account.accounts[0].provider = SubscriptionProvider::Xai.id().into();
    let mut client = AppServerClient::new(Transport {
        requests: Vec::new(),
        results: VecDeque::from([
            serde_json::to_value(&xai_account).unwrap(),
            serde_json::to_value(ProviderModelsListResult::Failed {
                failure: ProviderModelsListFailureDto {
                    code: ProviderModelsListFailureCodeDto::Authentication,
                },
            })
            .unwrap(),
        ]),
    });
    assert_eq!(
        execute(
            &mut client,
            SubscriptionProvider::Xai,
            SubscriptionCommand::Read
        ),
        SubscriptionEvent::Read {
            account: xai_account,
            models: Some(Err("Authentication".into())),
        }
    );
    let requests = client.into_transport().requests;
    assert_eq!(requests[1]["method"], "provider/models/list");
    assert_eq!(
        requests[1]["params"],
        serde_json::json!({"connection":"xai-subscription"})
    );
}

#[test]
fn xai_subscription_commands_select_xai_device_authorization_and_logout() {
    let mut client = AppServerClient::new(Transport {
        requests: Vec::new(),
        results: VecDeque::from([
            serde_json::json!({"type":"deviceCode","loginId":"xai-login","verificationUrl":"https://auth.x.ai/device","userCode":"XAI-1234"}),
            serde_json::json!({"status":"loggedOut"}),
            serde_json::json!({"revision":"2","accounts":[]}),
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
    assert_eq!(
        subscription.error_dialog(&event),
        Some(("Could not open browser", "could not open browser".into()))
    );
    subscription.update(event);
    let state = ListSelectionState::new(subscription.choices().model);
    assert!(!labels(&subscription).contains(&"Could not open browser".into()));
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
            serde_json::json!({"revision":"2","accounts":[]}),
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

#[test]
fn glm_subscription_panels_use_account_login_for_both_regions() {
    for (provider, method) in [
        (
            SubscriptionProvider::BigModel,
            AccountLoginMethodDto::BigModelBrowser,
        ),
        (SubscriptionProvider::Zai, AccountLoginMethodDto::ZaiBrowser),
        (
            SubscriptionProvider::BigModelStartPlan,
            AccountLoginMethodDto::BigModelStartPlanBrowser,
        ),
        (
            SubscriptionProvider::ZaiStartPlan,
            AccountLoginMethodDto::ZaiStartPlanBrowser,
        ),
    ] {
        let mut subscription = Subscription::new(provider);
        assert_eq!(
            labels(&subscription),
            vec![format!("Sign in to {}", provider.name())]
        );
        assert!(matches!(
            subscription
                .choices()
                .actions
                .get(&ListSelectionItemId::new(format!(
                    "Sign in to {}",
                    provider.name()
                ))),
            Some(ConfigSelectionAction::Subscription(
                SubscriptionCommand::SignIn
            ))
        ));
        let mut connected = account(1);
        connected.accounts[0].provider = provider.id().into();
        subscription.update(SubscriptionEvent::Read {
            account: connected,
            models: Some(Ok(vec![])),
        });
        assert_eq!(
            subscription.sign_out_availability(),
            SignOutAvailability::Available
        );
        assert!(
            !labels(&subscription)
                .iter()
                .any(|label| label.contains("API key"))
        );
        assert_eq!(provider.method(), method);
    }
}

#[test]
fn glm_browser_login_starts_account_authorization() {
    for (provider, expected_method) in [
        (SubscriptionProvider::BigModel, "bigModelBrowser"),
        (SubscriptionProvider::Zai, "zaiBrowser"),
        (
            SubscriptionProvider::BigModelStartPlan,
            "bigModelStartPlanBrowser",
        ),
        (SubscriptionProvider::ZaiStartPlan, "zaiStartPlanBrowser"),
    ] {
        let mut client = AppServerClient::new(Transport {
            requests: Vec::new(),
            results: VecDeque::from([serde_json::json!({
                "type": "browser",
                "loginId": "glm-login",
                "authorizationUrl": "https://zcode.z.ai/authorize",
            })]),
        });
        let event =
            execute_with_browser(&mut client, provider, SubscriptionCommand::SignIn, |_| {
                Ok(())
            });
        assert!(matches!(event, SubscriptionEvent::Started { .. }));
        let requests = client.into_transport().requests;
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["method"], "account/login/start");
        assert_eq!(requests[0]["params"]["method"]["type"], expected_method);
    }
}

#[test]
fn subscription_sign_in_actions_are_localized_in_chinese() {
    for (provider, expected) in [
        (SubscriptionProvider::ChatGpt, "登录 ChatGPT"),
        (SubscriptionProvider::Xai, "登录 Super Grok"),
        (SubscriptionProvider::Kimi, "登录 Kimi"),
        (SubscriptionProvider::BigModel, "登录 BigModel"),
        (SubscriptionProvider::Zai, "登录 Z.AI"),
        (
            SubscriptionProvider::BigModelStartPlan,
            "登录 BigModel Start Plan",
        ),
        (SubscriptionProvider::ZaiStartPlan, "登录 Z.AI Start Plan"),
    ] {
        let mut choices = Subscription::new(provider).choices();
        choices.model.localize(crate::nls::Language::Chinese);
        let state = ListSelectionState::new(choices.model);
        assert_eq!(
            state
                .visible_items()
                .iter()
                .map(|item| item.label())
                .collect::<Vec<_>>(),
            vec![expected]
        );
    }
}

#[test]
fn start_plan_sign_in_panels_show_separate_region_actions_in_chinese() {
    for (provider, expected) in [
        (
            SubscriptionProvider::BigModelStartPlan,
            "登录 BigModel Start Plan",
        ),
        (SubscriptionProvider::ZaiStartPlan, "登录 Z.AI Start Plan"),
    ] {
        let subscription = Subscription::new(provider);
        let mut choices = subscription.choices();
        choices.model.localize(crate::nls::Language::Chinese);
        let state = ListSelectionState::new(choices.model);
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 5)).unwrap();
        terminal
            .draw(|frame| {
                crate::widgets::list_selection::draw_body_with_pointer(
                    frame,
                    frame.area(),
                    &state,
                    None,
                    None,
                    crate::render::test_context().with_language(crate::nls::Language::Chinese),
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        let text = (0..5)
            .map(|row| {
                let mut text = String::new();
                let mut column = 0;
                while column < 60 {
                    let symbol = buffer[(column, row)].symbol();
                    text.push_str(symbol);
                    column += u16::try_from(UnicodeWidthStr::width(symbol).max(1)).unwrap();
                }
                text.trim_end().to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains(expected));
        crate::tui_assert_snapshot!(format!("{}_sign_in_chinese", provider.id()), text);
    }
}
