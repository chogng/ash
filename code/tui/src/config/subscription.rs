use super::ConfigChoices;
use super::ConfigSelectionAction;
use super::editor::ApiKeyTarget;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::account::AccountLoginCancelParams;
use ash_app_server_protocol::protocol::account::AccountLoginCompleted;
use ash_app_server_protocol::protocol::account::AccountLoginCompletionStatusDto;
use ash_app_server_protocol::protocol::account::AccountLoginMethodDto;
use ash_app_server_protocol::protocol::account::AccountLoginStartParams;
use ash_app_server_protocol::protocol::account::AccountLoginStartResult;
use ash_app_server_protocol::protocol::account::AccountLogoutParams;
use ash_app_server_protocol::protocol::account::AccountReadResult;
use ash_app_server_protocol::protocol::account::AccountStatusDto;
use ash_app_server_protocol::protocol::config::ConfigReadResult;
use ash_app_server_protocol::protocol::config::ProviderConfigDto;
use ash_app_server_protocol::protocol::config::ProviderConfigureParams;
use ash_app_server_protocol::protocol::provider::ProviderListResult;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum SubscriptionProvider {
    #[default]
    ChatGpt,
    Xai,
    Kimi,
    Zai,
}

impl SubscriptionProvider {
    pub(crate) fn index(self) -> usize {
        match self {
            Self::ChatGpt => 0,
            Self::Xai => 1,
            Self::Kimi => 2,
            Self::Zai => 3,
        }
    }
    fn id(self) -> &'static str {
        match self {
            Self::ChatGpt => "chatgpt-subscription",
            Self::Xai => "xai-subscription",
            Self::Kimi => "kimi-subscription",
            Self::Zai => "zai-subscription",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::ChatGpt => "ChatGPT",
            Self::Xai => "Super Grok",
            Self::Kimi => "Kimi",
            Self::Zai => "BigModel",
        }
    }
    fn title(self) -> &'static str {
        match self {
            Self::ChatGpt => "ChatGPT subscription",
            Self::Xai => "Super Grok",
            Self::Kimi => "Kimi",
            Self::Zai => "BigModel",
        }
    }
    /// The device-code login surface. Z.AI authorizes its Coding Plan with an API key.
    fn method(self) -> Option<AccountLoginMethodDto> {
        match self {
            Self::ChatGpt => Some(AccountLoginMethodDto::OpenAiChatGptDeviceCode),
            Self::Xai => Some(AccountLoginMethodDto::XaiDeviceCode),
            Self::Kimi => Some(AccountLoginMethodDto::KimiDeviceCode),
            Self::Zai => None,
        }
    }
    fn account_login(self) -> bool {
        self.method().is_some()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SubscriptionCommand {
    Read,
    SignIn,
    Cancel { login_id: String },
    SignOut,
    SetPlan { enabled: bool },
}

/// One snapshot of the GLM Coding Plan's local credential and endpoint state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PlanStatus {
    pub(crate) key_saved: bool,
    pub(crate) enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SubscriptionEvent {
    Read(AccountReadResult),
    Started {
        login: AccountLoginStartResult,
        browser_error: Option<String>,
    },
    Cancelled {
        login_id: String,
    },
    SignedOut(AccountReadResult),
    Failed(String),
    Updated(AccountReadResult),
    Completed(AccountLoginCompleted),
    Plan(PlanStatus),
}

/// Keeps a pending sign-in available when the user leaves and reopens Providers.
#[derive(Debug, Default)]
pub(crate) struct Subscription {
    provider: SubscriptionProvider,
    account: Option<AccountReadResult>,
    plan: Option<PlanStatus>,
    login: Option<AccountLoginStartResult>,
    browser_error: Option<String>,
    pending: Option<SubscriptionCommand>,
    message: Option<String>,
    early_completions: BTreeMap<String, AccountLoginCompleted>,
}

impl Subscription {
    pub(crate) fn new(provider: SubscriptionProvider) -> Self {
        Self {
            provider,
            ..Self::default()
        }
    }

    pub(crate) fn begin(&mut self, command: &SubscriptionCommand) -> bool {
        if self.pending.is_some()
            || (self.login.is_some()
                && matches!(
                    command,
                    SubscriptionCommand::SignIn | SubscriptionCommand::SignOut
                ))
        {
            return false;
        }
        self.pending = Some(command.clone());
        self.message = None;
        true
    }

    pub(crate) fn update(&mut self, event: SubscriptionEvent) {
        match event {
            SubscriptionEvent::Updated(account) => self.update_account(account),
            SubscriptionEvent::Plan(plan) => {
                self.pending = None;
                self.message = None;
                self.plan = Some(plan);
            }
            SubscriptionEvent::Completed(completed) => {
                self.update_account(completed.account.clone());
                if self
                    .login
                    .as_ref()
                    .is_some_and(|login| login_id(login) == completed.login_id)
                {
                    self.finish(completed);
                } else if matches!(self.pending, Some(SubscriptionCommand::SignIn)) {
                    self.early_completions
                        .insert(completed.login_id.clone(), completed);
                }
            }
            event => {
                self.pending = None;
                match event {
                    SubscriptionEvent::Read(account) => {
                        self.early_completions.clear();
                        self.update_account(account);
                    }
                    SubscriptionEvent::Started {
                        login,
                        browser_error,
                    } => {
                        if matches!(login, AccountLoginStartResult::Connected { .. }) {
                            self.login = None;
                            self.browser_error = None;
                            self.early_completions.clear();
                            return;
                        }
                        if let Some(completed) = self.early_completions.remove(login_id(&login)) {
                            self.finish(completed);
                        } else {
                            self.login = Some(login);
                            self.browser_error = browser_error;
                        }
                        self.early_completions.clear();
                    }
                    SubscriptionEvent::Cancelled {
                        login_id: cancelled,
                    } => {
                        if self
                            .login
                            .as_ref()
                            .is_some_and(|login| login_id(login) == cancelled)
                        {
                            self.login = None;
                            self.browser_error = None;
                            self.message = Some("Sign-in cancelled".into());
                        }
                    }
                    SubscriptionEvent::SignedOut(account) => {
                        self.update_account(account);
                        self.message =
                            Some(format!("Disconnected from {} in Ash", self.provider.name()));
                    }
                    SubscriptionEvent::Failed(message) => {
                        self.early_completions.clear();
                        self.message = Some(message);
                    }
                    _ => unreachable!("notifications are handled above"),
                }
            }
        }
    }

    fn update_account(&mut self, account: AccountReadResult) {
        if self
            .account
            .as_ref()
            .is_none_or(|current| account.revision >= current.revision)
        {
            self.account = Some(account);
        }
    }

    fn finish(&mut self, completed: AccountLoginCompleted) {
        self.login = None;
        self.browser_error = None;
        self.message = Some(match completed.status {
            AccountLoginCompletionStatusDto::Succeeded => {
                format!("Signed in to {}", self.provider.name())
            }
            AccountLoginCompletionStatusDto::Failed { failure } => failure.message,
        });
    }

    pub(crate) fn choices(&self) -> ConfigChoices {
        if !self.provider.account_login() {
            return self.plan_choices();
        }
        let mut actions = BTreeMap::new();
        let mut items = Vec::new();
        let account = self.account.as_ref().and_then(|result| {
            result
                .accounts
                .iter()
                .find(|account| account.provider == self.provider.id())
        });
        if let Some(account) = account {
            let status = match account.status {
                AccountStatusDto::Ready => "Signed in",
                AccountStatusDto::ReauthenticationRequired => "Sign in again",
                AccountStatusDto::Unavailable => "Unavailable",
            };
            items.push(ListSelectionItem::new(status));
            if let Some(email) = &account.email {
                items.push(ListSelectionItem::new("Account").with_description(email));
            }
            if let Some(plan) = &account.plan {
                items.push(ListSelectionItem::new("Plan").with_description(plan));
            }
        } else {
            items.push(ListSelectionItem::new(if self.account.is_some() {
                "Not signed in"
            } else {
                "Account not loaded"
            }));
        }
        if let Some(message) = &self.message {
            items.push(ListSelectionItem::new(message));
        }
        if let Some(login) = &self.login {
            if let Some(error) = &self.browser_error {
                items
                    .push(ListSelectionItem::new("Could not open browser").with_description(error));
            }
            match login {
                AccountLoginStartResult::Connected { .. } => {}
                AccountLoginStartResult::DeviceCode {
                    verification_url,
                    user_code,
                    ..
                } => {
                    items.push(
                        ListSelectionItem::new(if self.browser_error.is_some() {
                            "Open in your browser"
                        } else {
                            "Browser opened"
                        })
                        .with_description(verification_url),
                    );
                    items.push(ListSelectionItem::new("Enter code").with_description(user_code));
                }
                AccountLoginStartResult::Browser {
                    authorization_url, ..
                } => {
                    items.push(
                        ListSelectionItem::new(if self.browser_error.is_some() {
                            "Open in your browser"
                        } else {
                            "Browser opened"
                        })
                        .with_description(authorization_url),
                    );
                }
            }
        }
        if self.pending.is_some() {
            items.push(ListSelectionItem::new("Working…"));
        } else if let Some(login) = &self.login {
            add_action(
                &mut items,
                &mut actions,
                "Cancel sign-in",
                SubscriptionCommand::Cancel {
                    login_id: login_id(login).into(),
                },
            );
        } else {
            if account.is_none_or(|account| account.status != AccountStatusDto::Ready) {
                add_action(
                    &mut items,
                    &mut actions,
                    &format!("Sign in with {}", self.provider.name()),
                    SubscriptionCommand::SignIn,
                );
            }
            if account.is_some() {
                add_action(
                    &mut items,
                    &mut actions,
                    "Disconnect from Ash",
                    SubscriptionCommand::SignOut,
                );
            }
        }
        ConfigChoices {
            model: ListSelectionModel::new(
                self.provider.title(),
                vec![ListSelectionGroup::new("Account", items)],
            )
            .with_dismiss(crate::keymap::bindings::RETURN_LIST),
            actions,
        }
    }

    /// Builds the Z.AI view from the saved credential and selected endpoint.
    fn plan_choices(&self) -> ConfigChoices {
        let mut actions = BTreeMap::new();
        let mut items = Vec::new();
        let status = self.plan.as_ref();
        items.push(ListSelectionItem::new(
            if status.is_some_and(|plan| plan.key_saved) {
                "API key saved"
            } else {
                "API key not saved"
            },
        ));
        if status.is_some_and(|plan| plan.key_saved || plan.enabled) {
            items.push(ListSelectionItem::new(
                if status.is_some_and(|plan| plan.enabled) {
                    "Coding plan enabled"
                } else {
                    "Coding plan not enabled"
                },
            ));
        }
        if let Some(message) = &self.message {
            items.push(ListSelectionItem::new(message));
        }
        if self.pending.is_some() {
            items.push(ListSelectionItem::new("Working…"));
        } else {
            if !status.is_some_and(|plan| plan.key_saved) {
                let label = "Sign in with BigModel";
                let id = ListSelectionItemId::new(label);
                items.push(ListSelectionItem::new(label).with_id(id.clone()));
                actions.insert(
                    id,
                    ConfigSelectionAction::OpenProviderApiKey {
                        provider: "zai".into(),
                        display_name: "BigModel".into(),
                        target: ApiKeyTarget::ZaiCodingPlan,
                    },
                );
            } else {
                let enabled = status.is_some_and(|plan| plan.enabled);
                add_action(
                    &mut items,
                    &mut actions,
                    if enabled {
                        "Disable BigModel"
                    } else {
                        "Enable BigModel"
                    },
                    SubscriptionCommand::SetPlan { enabled: !enabled },
                );
            }
        }
        ConfigChoices {
            model: ListSelectionModel::new(
                self.provider.title(),
                vec![ListSelectionGroup::new("Status", items)],
            )
            .with_dismiss(crate::keymap::bindings::RETURN_LIST),
            actions,
        }
    }
}

fn add_action(
    items: &mut Vec<ListSelectionItem>,
    actions: &mut BTreeMap<ListSelectionItemId, ConfigSelectionAction>,
    label: &str,
    command: SubscriptionCommand,
) {
    let id = ListSelectionItemId::new(label);
    items.push(ListSelectionItem::new(label).with_id(id.clone()));
    actions.insert(id, ConfigSelectionAction::Subscription(command));
}

fn login_id(login: &AccountLoginStartResult) -> &str {
    match login {
        AccountLoginStartResult::Connected { login_id }
        | AccountLoginStartResult::Browser { login_id, .. }
        | AccountLoginStartResult::DeviceCode { login_id, .. } => login_id,
    }
}

pub(crate) fn execute<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    provider: SubscriptionProvider,
    command: SubscriptionCommand,
) -> SubscriptionEvent {
    execute_with_browser(client, provider, command, crate::host::browser::open_url)
}

fn execute_with_browser<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    provider: SubscriptionProvider,
    command: SubscriptionCommand,
    open_browser: impl FnOnce(&str) -> Result<(), String>,
) -> SubscriptionEvent {
    if !provider.account_login() {
        return match command {
            SubscriptionCommand::Read => read_plan_status(client).map(SubscriptionEvent::Plan),
            SubscriptionCommand::SetPlan { enabled } => {
                set_plan(client, enabled).map(SubscriptionEvent::Plan)
            }
            _ => Ok(SubscriptionEvent::Failed(format!(
                "{} does not use account sign-in",
                provider.name()
            ))),
        }
        .unwrap_or_else(|error| SubscriptionEvent::Failed(error.to_string()));
    }
    let result = match command {
        SubscriptionCommand::Read => client.read_accounts().map(SubscriptionEvent::Read),
        SubscriptionCommand::SignIn => {
            let method = provider
                .method()
                .expect("account providers declare a method");
            client
                .start_account_login(AccountLoginStartParams { method })
                .and_then(|started| match started {
                    AccountLoginStartResult::Connected { .. } => {
                        client.read_accounts().map(SubscriptionEvent::Read)
                    }
                    challenge => {
                        let url = match &challenge {
                            AccountLoginStartResult::DeviceCode {
                                verification_url, ..
                            } => verification_url,
                            AccountLoginStartResult::Browser {
                                authorization_url, ..
                            } => authorization_url,
                            AccountLoginStartResult::Connected { .. } => unreachable!(),
                        };
                        Ok(SubscriptionEvent::Started {
                            browser_error: open_browser(url).err(),
                            login: challenge,
                        })
                    }
                })
        }
        SubscriptionCommand::Cancel { login_id } => client
            .cancel_account_login(AccountLoginCancelParams {
                login_id: login_id.clone(),
            })
            .map(|_| SubscriptionEvent::Cancelled { login_id }),
        SubscriptionCommand::SignOut => client
            .logout_account(AccountLogoutParams {
                provider: provider.id().into(),
            })
            .and_then(|_| client.read_accounts())
            .map(SubscriptionEvent::SignedOut),
        SubscriptionCommand::SetPlan { .. } => {
            unreachable!("plan toggles only exist for key-scoped subscriptions")
        }
    };
    result.unwrap_or_else(|error| {
        SubscriptionEvent::Failed(match error {
            ClientError::Server { message, .. } if message == "AccountExternalLoginRequired" => {
                "Sign in to ChatGPT in Codex, then reconnect here.".into()
            }
            error => error.to_string(),
        })
    })
}

/// Reads the Z.AI Coding Plan state from the saved provider connection and stored key.
fn read_plan_status<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
) -> Result<PlanStatus, ClientError> {
    let config = client.read_config()?;
    let providers = client.list_providers()?;
    Ok(plan_status(&config, &providers))
}

fn plan_status(config: &ConfigReadResult, providers: &ProviderListResult) -> PlanStatus {
    let key_saved = providers
        .providers
        .iter()
        .any(|entry| entry.provider == "zai" && entry.api_key_configured);
    let enabled = config
        .providers
        .get("zai")
        .and_then(|entry| entry.base_url.as_deref())
        .is_some_and(coding_plan_endpoint);
    PlanStatus { key_saved, enabled }
}

/// Mirrors the backend's connection selection: the plan is the connection whose endpoint is the
/// coding gateway, compared with the same trimming the backend applies to configured URLs.
fn coding_plan_endpoint(base_url: &str) -> bool {
    base_url.trim().trim_end_matches('/') == ash_model_provider_config::ZAI_CODING_PLAN_BASE_URL
}

fn set_plan<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    enabled: bool,
) -> Result<PlanStatus, ClientError> {
    let config = client.read_config()?;
    let mut provider = config
        .providers
        .get("zai")
        .cloned()
        .unwrap_or_else(|| ProviderConfigDto {
            provider: "zai".into(),
            custom: None,
            base_url: None,
            max_output_tokens: None,
            model_context: BTreeMap::new(),
        });
    provider.base_url =
        enabled.then(|| ash_model_provider_config::ZAI_CODING_PLAN_BASE_URL.to_owned());
    client.configure_provider(ProviderConfigureParams {
        command_id: crate::client::new_command_id("zai-plan"),
        expected_revision: config.revision,
        config: provider,
    })?;
    read_plan_status(client)
}

#[cfg(test)]
#[path = "subscription_tests.rs"]
mod tests;
