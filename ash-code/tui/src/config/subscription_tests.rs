use super::*;
use crate::widgets::list_selection::ListSelectionState;
use ash_app_server_client::ClientError;
use ash_app_server_protocol::protocol::account::AccountDto;
use ash_app_server_protocol::protocol::account::AccountLoginFailureDto;
use std::collections::VecDeque;

fn account(revision: u64) -> AccountReadResult {
    AccountReadResult {
        revision,
        accounts: vec![AccountDto {
            provider: PROVIDER.into(),
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

fn started() -> AccountLoginStartResult {
    AccountLoginStartResult::DeviceCode {
        login_id: "login-1".into(),
        verification_url: "https://auth.openai.com/codex/device".into(),
        user_code: "ABCD-1234".into(),
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
fn login_waits_without_blocking_and_completion_shows_account_and_plan() {
    let mut subscription = Subscription::default();
    subscription.update(SubscriptionEvent::Read(AccountReadResult {
        revision: 1,
        accounts: vec![],
    }));
    assert!(labels(&subscription).contains(&"Sign in with ChatGPT".into()));
    assert!(subscription.begin(&SubscriptionCommand::SignIn));
    assert!(!subscription.begin(&SubscriptionCommand::SignIn));
    subscription.update(SubscriptionEvent::Started(started()));
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
    subscription.update(SubscriptionEvent::Started(started()));
    assert!(labels(&subscription).contains(&"Signed in".into()));
    assert!(!labels(&subscription).contains(&"Cancel sign-in".into()));
}

#[test]
fn failed_login_and_request_errors_allow_retry() {
    let mut subscription = Subscription::default();
    subscription.begin(&SubscriptionCommand::SignIn);
    subscription.update(SubscriptionEvent::Failed("Service unavailable".into()));
    assert!(subscription.begin(&SubscriptionCommand::SignIn));
    subscription.update(SubscriptionEvent::Started(started()));
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
    subscription.update(SubscriptionEvent::Read(AccountReadResult {
        revision: 4,
        accounts: vec![],
    }));
    subscription.update(SubscriptionEvent::Started(started()));
    let mut other = completion();
    other.login_id = "another-login".into();
    subscription.update(SubscriptionEvent::Completed(other));
    assert!(labels(&subscription).contains(&"Signed in".into()));
    assert!(labels(&subscription).contains(&"Cancel sign-in".into()));
}

#[test]
fn cancellation_after_completion_preserves_the_successful_account() {
    let mut subscription = Subscription::default();
    subscription.update(SubscriptionEvent::Started(started()));
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
        ]),
    });
    assert_eq!(
        execute(&mut client, SubscriptionCommand::SignIn),
        SubscriptionEvent::Read(account(2))
    );
    let requests = client.into_transport().requests;
    assert_eq!(
        requests
            .iter()
            .map(|request| request["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["account/login/start", "account/read"]
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
            serde_json::to_value(started()).unwrap(),
            serde_json::json!({ "status": "cancelled" }),
            serde_json::json!({ "status": "loggedOut" }),
            serde_json::json!({ "revision": 2, "accounts": [] }),
        ]),
    });
    assert!(matches!(
        execute(&mut client, SubscriptionCommand::Read),
        SubscriptionEvent::Read(_)
    ));
    assert_eq!(
        execute(&mut client, SubscriptionCommand::SignIn),
        SubscriptionEvent::Started(started())
    );
    assert_eq!(
        execute(
            &mut client,
            SubscriptionCommand::Cancel {
                login_id: "login-1".into()
            }
        ),
        SubscriptionEvent::Cancelled {
            login_id: "login-1".into()
        }
    );
    assert_eq!(
        execute(&mut client, SubscriptionCommand::SignOut),
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
            serde_json::json!({ "method": "account/login/start", "params": { "method": { "type": "openAiChatGptDeviceCode" } } }),
            serde_json::json!({ "method": "account/login/cancel", "params": { "loginId": "login-1" } }),
            serde_json::json!({ "method": "account/logout", "params": { "provider": "openai-chatgpt" } }),
            serde_json::json!({ "method": "account/read", "params": {} }),
        ]
    );
}
