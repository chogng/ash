use ash_app_server_client::AppServerEvent;
use ash_app_server_client::AppServerEvents;
use ash_app_server_client::AppServerRequestHandle;
use ash_app_server_client::ProviderApiKeySetRequest;
use ash_app_server_client::ServerNotification;
use ash_app_server_protocol::protocol::account::AccountLoginCancelParams;
use ash_app_server_protocol::protocol::account::AccountLoginCompletionStatusDto;
use ash_app_server_protocol::protocol::account::AccountLoginMethodDto;
use ash_app_server_protocol::protocol::account::AccountLoginStartParams;
use ash_app_server_protocol::protocol::account::AccountLoginStartResult;
use ash_app_server_protocol::protocol::account::AccountLogoutParams;
use ash_app_server_protocol::protocol::account::AccountReadResult;
use clap::Args;
use clap::Subcommand;
use std::io::IsTerminal;
use std::io::Read;
use std::sync::atomic::Ordering;
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;
use std::time::Instant;

use crate::CliError;
use crate::InterruptSignal;
use crate::management;
use crate::print_json;

#[derive(Args)]
pub(super) struct Options {
    #[command(subcommand)]
    command: Option<LoginCommand>,
}

#[derive(Subcommand)]
enum LoginCommand {
    /// Show signed-in accounts as JSON.
    Status,
    /// Sign in with ChatGPT (the default when no subcommand is given).
    Chatgpt {
        /// Use browser OAuth instead of device authorization.
        #[arg(long)]
        browser: bool,
    },
    /// Sign in with a Kimi subscription.
    Kimi,
    /// Sign in with an xAI subscription.
    Xai,
    /// Read an API key from stdin for an existing configured provider.
    ApiKey { provider: String },
}

pub(super) fn run(options: Options) -> Result<(), CliError> {
    let method = match options.command {
        Some(LoginCommand::Status) => {
            return management::with_client(|client| print_json(&client.read_accounts()?));
        }
        Some(LoginCommand::ApiKey { provider }) => return api_key(provider),
        Some(LoginCommand::Chatgpt { browser: true }) => {
            AccountLoginMethodDto::OpenAiChatGptBrowser
        }
        Some(LoginCommand::Chatgpt { browser: false }) | None => {
            AccountLoginMethodDto::OpenAiChatGptDeviceCode
        }
        Some(LoginCommand::Kimi) => AccountLoginMethodDto::KimiDeviceCode,
        Some(LoginCommand::Xai) => AccountLoginMethodDto::XaiDeviceCode,
    };
    let interrupt = InterruptSignal::register()?;
    let mut session = management::connect()?;
    let events = session.take_events().map_err(CliError::failure)?;
    let mut client = session.client();
    let outcome = sign_in(&mut client, &events, method, &interrupt);
    let shutdown = session.shutdown().map_err(CliError::failure);
    outcome.and(shutdown)
}

fn api_key(provider: String) -> Result<(), CliError> {
    let mut stdin = std::io::stdin().lock();
    if stdin.is_terminal() {
        return Err(CliError::usage(
            "pipe the API key into `ash login api-key PROVIDER`",
        ));
    }
    let mut key = String::new();
    stdin.read_to_string(&mut key).map_err(CliError::failure)?;
    key.truncate(key.trim_end().len());
    if key.trim().is_empty() {
        return Err(CliError::usage("stdin did not contain an API key"));
    }
    let request = ProviderApiKeySetRequest::new(provider, key);
    management::with_client(|client| print_json(&client.set_provider_api_key(request)?))
}

pub(super) fn logout(provider: String) -> Result<(), CliError> {
    management::with_client(|client| {
        print_json(&client.logout_account(AccountLogoutParams { provider })?)
    })
}

fn sign_in(
    client: &mut AppServerRequestHandle,
    events: &AppServerEvents,
    method: AccountLoginMethodDto,
    interrupt: &InterruptSignal,
) -> Result<(), CliError> {
    let login_id = match client.start_account_login(AccountLoginStartParams { method })? {
        AccountLoginStartResult::Connected { .. } => return print_json(&client.read_accounts()?),
        AccountLoginStartResult::Browser {
            login_id,
            authorization_url,
        } => {
            eprintln!("Open this URL to sign in:\n{authorization_url}");
            login_id
        }
        AccountLoginStartResult::DeviceCode {
            login_id,
            verification_url,
            user_code,
        } => {
            eprintln!("Open {verification_url} and enter code: {user_code}");
            login_id
        }
    };
    let deadline = Instant::now() + Duration::from_secs(15 * 60);
    loop {
        let cancelled = interrupt.requested.load(Ordering::Relaxed);
        if cancelled || Instant::now() >= deadline {
            client.cancel_account_login(AccountLoginCancelParams { login_id })?;
            return Err(CliError {
                message: if cancelled {
                    "login cancelled"
                } else {
                    "login timed out"
                }
                .into(),
                exit_code: if cancelled { 130 } else { 1 },
            });
        }
        match events.recv_timeout(Duration::from_millis(100)) {
            Ok(event) => {
                if let Some(account) = completed_login(event, &login_id)? {
                    return print_json(&account);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err(CliError::failure(
                    "App Server disconnected before login completed",
                ));
            }
        }
    }
}

fn completed_login(
    event: AppServerEvent,
    login_id: &str,
) -> Result<Option<AccountReadResult>, CliError> {
    match event {
        AppServerEvent::Notification(ServerNotification::AccountLoginCompleted(completed))
            if completed.login_id == login_id =>
        {
            match completed.status {
                AccountLoginCompletionStatusDto::Succeeded => Ok(Some(completed.account)),
                AccountLoginCompletionStatusDto::Failed { failure } => Err(CliError::failure(
                    format!("{}: {}", failure.code, failure.message),
                )),
            }
        }
        AppServerEvent::ConnectionClosed(reason) => Err(CliError::failure(format!(
            "App Server disconnected before login completed: {reason:?}"
        ))),
        _ => Ok(None),
    }
}

#[cfg(test)]
#[path = "login_tests.rs"]
mod tests;
