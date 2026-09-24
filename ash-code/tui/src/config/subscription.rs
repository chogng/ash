use super::ConfigChoices;
use super::ConfigSelectionAction;
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
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum SubscriptionProvider {
    #[default]
    ChatGpt,
    Xai,
}

impl SubscriptionProvider {
    pub(crate) fn index(self) -> usize {
        match self {
            Self::ChatGpt => 0,
            Self::Xai => 1,
        }
    }
    fn id(self) -> &'static str {
        match self {
            Self::ChatGpt => "openai-chatgpt",
            Self::Xai => "xai-subscription",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::ChatGpt => "ChatGPT",
            Self::Xai => "xAI",
        }
    }
    fn title(self) -> &'static str {
        match self {
            Self::ChatGpt => "ChatGPT subscription",
            Self::Xai => "xAI subscription",
        }
    }
    fn method(self) -> AccountLoginMethodDto {
        match self {
            Self::ChatGpt => AccountLoginMethodDto::OpenAiChatGptDeviceCode,
            Self::Xai => AccountLoginMethodDto::XaiDeviceCode,
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
}

/// Keeps a pending sign-in available when the user leaves and reopens Providers.
#[derive(Debug, Default)]
pub(crate) struct Subscription {
    provider: SubscriptionProvider,
    account: Option<AccountReadResult>,
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
        SubscriptionCommand::Read => client.read_accounts().map(SubscriptionEvent::Read),
        SubscriptionCommand::SignIn => client
            .start_account_login(AccountLoginStartParams {
                method: provider.method(),
            })
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
            }),
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
                "Sign in to ChatGPT in Codex, then reconnect here.".into()
            }
            error => error.to_string(),
        })
    })
}

#[cfg(test)]
#[path = "subscription_tests.rs"]
mod tests;
