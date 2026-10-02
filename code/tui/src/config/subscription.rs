use super::ConfigChoices;
use super::ConfigSelectionAction;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::account::AccountDto;
use ash_app_server_protocol::protocol::account::AccountLoginCancelParams;
use ash_app_server_protocol::protocol::account::AccountLoginCompleted;
use ash_app_server_protocol::protocol::account::AccountLoginCompletionStatusDto;
use ash_app_server_protocol::protocol::account::AccountLoginMethodDto;
use ash_app_server_protocol::protocol::account::AccountLoginStartParams;
use ash_app_server_protocol::protocol::account::AccountLoginStartResult;
use ash_app_server_protocol::protocol::account::AccountLogoutParams;
use ash_app_server_protocol::protocol::account::AccountReadResult;
use ash_app_server_protocol::protocol::account::AccountStatusDto;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_app_server_protocol::protocol::provider::ProviderModelsListResult;
use ash_app_server_protocol::protocol::provider::ProviderModelsUpdated;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum SubscriptionProvider {
    #[default]
    ChatGpt,
    Xai,
    Kimi,
    BigModel,
    Zai,
    BigModelStartPlan,
    ZaiStartPlan,
}

impl SubscriptionProvider {
    pub(crate) fn index(self) -> usize {
        match self {
            Self::ChatGpt => 0,
            Self::Xai => 1,
            Self::Kimi => 2,
            Self::BigModel => 3,
            Self::Zai => 4,
            Self::BigModelStartPlan => 5,
            Self::ZaiStartPlan => 6,
        }
    }
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::ChatGpt => "chatgpt-subscription",
            Self::Xai => "xai-subscription",
            Self::Kimi => "kimi-subscription",
            Self::BigModel => "bigmodel-coding-plan",
            Self::Zai => "zai-coding-plan",
            Self::BigModelStartPlan => "bigmodel-start-plan",
            Self::ZaiStartPlan => "zai-start-plan",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::ChatGpt => "ChatGPT",
            Self::Xai => "Super Grok",
            Self::Kimi => "Kimi",
            Self::BigModel => "BigModel",
            Self::Zai => "Z.AI",
            Self::BigModelStartPlan => "BigModel Start Plan",
            Self::ZaiStartPlan => "Z.AI Start Plan",
        }
    }
    fn title(self) -> &'static str {
        match self {
            Self::ChatGpt => "ChatGPT subscription",
            Self::Xai => "Super Grok",
            Self::Kimi => "Kimi",
            Self::BigModel => "BigModel",
            Self::Zai => "Z.AI",
            Self::BigModelStartPlan => "BigModel Start Plan",
            Self::ZaiStartPlan => "Z.AI Start Plan",
        }
    }
    fn method(self) -> AccountLoginMethodDto {
        match self {
            Self::ChatGpt => AccountLoginMethodDto::OpenAiChatGptDeviceCode,
            Self::Xai => AccountLoginMethodDto::XaiDeviceCode,
            Self::Kimi => AccountLoginMethodDto::KimiDeviceCode,
            Self::BigModel => AccountLoginMethodDto::BigModelBrowser,
            Self::Zai => AccountLoginMethodDto::ZaiBrowser,
            Self::BigModelStartPlan => AccountLoginMethodDto::BigModelStartPlanBrowser,
            Self::ZaiStartPlan => AccountLoginMethodDto::ZaiStartPlanBrowser,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SubscriptionCommand {
    Read,
    SignIn,
    Cancel { login_id: String },
    SignOut,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum SignOutAvailability {
    #[default]
    Unavailable,
    Available,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SubscriptionEvent {
    Read {
        account: AccountReadResult,
        models: Option<Result<Vec<ModelCatalogEntry>, String>>,
    },
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
    ModelsUpdated(ProviderModelsUpdated),
    Completed(AccountLoginCompleted),
}

/// Keeps a pending sign-in available when the user leaves and reopens Providers.
#[derive(Debug, Default)]
pub(crate) struct Subscription {
    provider: SubscriptionProvider,
    account: Option<AccountReadResult>,
    models: Option<Result<Vec<ModelCatalogEntry>, String>>,
    login: Option<AccountLoginStartResult>,
    browser_error: Option<String>,
    pending: Option<SubscriptionCommand>,
    // The first page read may complete after the server has published newer models.
    models_notified_during_read: bool,
    early_completions: BTreeMap<String, AccountLoginCompleted>,
}

impl Subscription {
    pub(crate) fn new(provider: SubscriptionProvider) -> Self {
        Self {
            provider,
            ..Self::default()
        }
    }

    pub(crate) fn error_dialog(&self, event: &SubscriptionEvent) -> Option<(&'static str, String)> {
        match event {
            SubscriptionEvent::Failed(message) => Some(("Error", message.clone())),
            SubscriptionEvent::Completed(completed)
                if self
                    .login
                    .as_ref()
                    .is_some_and(|login| login_id(login) == completed.login_id) =>
            {
                match &completed.status {
                    AccountLoginCompletionStatusDto::Failed { failure } => {
                        Some(("Error", failure.message.clone()))
                    }
                    AccountLoginCompletionStatusDto::Succeeded => None,
                }
            }
            SubscriptionEvent::Started {
                login,
                browser_error,
            } => {
                if let Some(completed) = self.early_completions.get(login_id(login)) {
                    match &completed.status {
                        AccountLoginCompletionStatusDto::Failed { failure } => {
                            Some(("Error", failure.message.clone()))
                        }
                        AccountLoginCompletionStatusDto::Succeeded => None,
                    }
                } else {
                    browser_error
                        .as_ref()
                        .map(|error| ("Could not open browser", error.clone()))
                }
            }
            SubscriptionEvent::Read {
                account,
                models: Some(Err(error)),
                ..
            } if self.accepts_read(account) && !self.models_notified_during_read => {
                Some(("Could not load models", error.clone()))
            }
            _ => None,
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
        if matches!(command, SubscriptionCommand::Read) {
            self.models_notified_during_read = false;
        }
        true
    }

    pub(crate) fn update(&mut self, event: SubscriptionEvent) {
        match event {
            SubscriptionEvent::Updated(account) => {
                self.update_account(account);
            }
            SubscriptionEvent::ModelsUpdated(updated) => {
                let account = self
                    .account
                    .as_ref()
                    .and_then(|result| account_for(result, self.provider));
                if updated.connection == self.provider.id()
                    && account.is_some_and(|account| {
                        account.status == AccountStatusDto::Ready
                            && account.account_id == updated.account_id
                            && account.organization == updated.organization
                            && account.plan == updated.plan
                    })
                {
                    self.models = Some(match updated.result {
                        ProviderModelsListResult::Models { models } => Ok(models),
                        ProviderModelsListResult::Empty => Ok(Vec::new()),
                        ProviderModelsListResult::Failed { failure } => {
                            Err(format!("{:?}", failure.code))
                        }
                    });
                    if matches!(self.pending, Some(SubscriptionCommand::Read)) {
                        self.models_notified_during_read = true;
                    }
                }
            }
            SubscriptionEvent::Completed(completed) => {
                self.update_account(completed.account.clone());
                if self
                    .login
                    .as_ref()
                    .is_some_and(|login| login_id(login) == completed.login_id)
                {
                    self.finish();
                } else if matches!(self.pending, Some(SubscriptionCommand::SignIn)) {
                    self.early_completions
                        .insert(completed.login_id.clone(), completed);
                }
            }
            event => {
                self.pending = None;
                match event {
                    SubscriptionEvent::Read { account, models } => {
                        self.early_completions.clear();
                        let accepted = self.accepts_read(&account);
                        self.update_account(account);
                        if accepted && !self.models_notified_during_read {
                            self.models = models;
                        }
                        self.models_notified_during_read = false;
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
                        if self.early_completions.remove(login_id(&login)).is_some() {
                            self.finish();
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
                        }
                    }
                    SubscriptionEvent::SignedOut(account) => {
                        self.update_account(account);
                    }
                    SubscriptionEvent::Failed(_) => {
                        self.early_completions.clear();
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
            let before = self
                .account
                .as_ref()
                .and_then(|current| account_for(current, self.provider));
            let after = account_for(&account, self.provider);
            if !same_catalog_account(before, after) {
                self.models = None;
            }
            self.account = Some(account);
        }
    }

    fn accepts_read(&self, account: &AccountReadResult) -> bool {
        self.account.as_ref().is_none_or(|current| {
            account.revision >= current.revision
                // Catalog fetching may rotate the same account's credential and advance
                // its revision. The fetched models still belong to that account.
                || same_catalog_account(
                    account_for(current, self.provider),
                    account_for(account, self.provider),
                )
        })
    }

    pub(crate) fn needs_initial_read(&self) -> bool {
        self.account.is_none()
    }

    fn finish(&mut self) {
        self.login = None;
        self.browser_error = None;
    }

    pub(crate) fn choices(&self) -> ConfigChoices {
        let mut actions = BTreeMap::new();
        let mut items = Vec::new();
        let account = self
            .account
            .as_ref()
            .and_then(|result| account_for(result, self.provider));
        let ready_account = account.filter(|account| account.status == AccountStatusDto::Ready);
        if let Some(account) = ready_account {
            if let Some(email) = &account.email {
                items.push(ListSelectionItem::new("Account").with_description(email));
            }
            if let Some(plan) = &account.plan {
                items.push(ListSelectionItem::new("Plan").with_description(plan));
            }
            items.push(ListSelectionItem::new("Models").as_section_divider());
            match &self.models {
                Some(Ok(models)) if models.is_empty() => {
                    items.push(ListSelectionItem::new("No models available"));
                }
                Some(Ok(models)) => {
                    items.extend(models.iter().map(|model| {
                        ListSelectionItem::new(crate::nls::Text::literal(
                            model.display_name.clone(),
                        ))
                    }));
                }
                Some(Err(_)) => items.push(ListSelectionItem::new("Could not load models")),
                None => items.push(ListSelectionItem::new("Loading models…")),
            }
        }
        if let Some(login) = &self.login {
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
            if ready_account.is_none() {
                add_action(
                    &mut items,
                    &mut actions,
                    &format!("Sign in to {}", self.provider.name()),
                    SubscriptionCommand::SignIn,
                );
            }
        }
        let mut model = ListSelectionModel::new(
            self.provider.title(),
            vec![ListSelectionGroup::new("Account", items)],
        )
        .without_tab_bar()
        .with_dismiss(crate::keymap::bindings::RETURN_LIST);
        if self.sign_out_availability() == SignOutAvailability::Available {
            model = model.with_key_hint_action(crate::keymap::bindings::SUBSCRIPTION_SIGN_OUT);
        }
        ConfigChoices {
            model,
            actions,
            language: crate::nls::Language::English,
        }
    }

    pub(crate) fn sign_out_availability(&self) -> SignOutAvailability {
        if self.pending.is_some() {
            return SignOutAvailability::Unavailable;
        }
        if self.login.is_none()
            && self
                .account
                .as_ref()
                .and_then(|result| account_for(result, self.provider))
                .is_some_and(|account| account.status == AccountStatusDto::Ready)
        {
            SignOutAvailability::Available
        } else {
            SignOutAvailability::Unavailable
        }
    }
}

fn account_for(result: &AccountReadResult, provider: SubscriptionProvider) -> Option<&AccountDto> {
    result
        .accounts
        .iter()
        .find(|account| account.provider == provider.id())
}

// Credential rotation changes the account revision without changing the model entitlement.
fn same_catalog_account(before: Option<&AccountDto>, after: Option<&AccountDto>) -> bool {
    match (before, after) {
        (Some(before), Some(after)) => {
            before.account_id == after.account_id
                && before.status == after.status
                && before.organization == after.organization
                && before.plan == after.plan
        }
        (None, None) => true,
        _ => false,
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
    let result = match command {
        SubscriptionCommand::Read => read_account_and_models(client, provider),
        SubscriptionCommand::SignIn => {
            let method = provider.method();
            client
                .start_account_login(AccountLoginStartParams { method })
                .and_then(|started| match started {
                    AccountLoginStartResult::Connected { .. } => {
                        read_account_and_models(client, provider)
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
    };
    result.unwrap_or_else(|error| {
        SubscriptionEvent::Failed(match error {
            ClientError::Server { message, .. } if message == "AccountExternalLoginRequired" => {
                match provider {
                    SubscriptionProvider::BigModelStartPlan
                    | SubscriptionProvider::ZaiStartPlan => {
                        "Sign out of this Start Plan account in ZCode.".into()
                    }
                    SubscriptionProvider::BigModel | SubscriptionProvider::Zai => {
                        "Sign out of this Coding Plan account in ZCode.".into()
                    }
                    _ => "Sign in to ChatGPT in Codex, then reconnect here.".into(),
                }
            }
            error => error.to_string(),
        })
    })
}

fn read_account_and_models<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    provider: SubscriptionProvider,
) -> Result<SubscriptionEvent, ClientError> {
    let account = client.read_accounts()?;
    let ready = account
        .accounts
        .iter()
        .any(|entry| entry.provider == provider.id() && entry.status == AccountStatusDto::Ready);
    let models = ready.then(|| {
        client
            .list_provider_models(provider.id().into())
            .map(|catalog| match catalog {
                ProviderModelsListResult::Models { models } => Ok(models),
                ProviderModelsListResult::Empty => Ok(Vec::new()),
                ProviderModelsListResult::Failed { failure } => Err(format!("{:?}", failure.code)),
            })
            .unwrap_or_else(|error| Err(error.to_string()))
    });
    Ok(SubscriptionEvent::Read { account, models })
}

#[cfg(test)]
#[path = "subscription_tests.rs"]
mod tests;
