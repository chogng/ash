use ash_login::AccountSnapshot;
use ash_login::CompleteLogin;
use ash_login::InteractiveLoginDriver;
use ash_login::LoginError;
use ash_login::LoginErrorKind;
use ash_login::LoginId;
use ash_login::extension::AuthenticationEvents;
use ash_login::extension::AuthenticationRequest;
use ash_login::extension::AuthenticationResponse;
use extensions::Extension;
use extensions::ExtensionContext;
use extensions::ExtensionError;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;

use crate::GitHubOAuth;
use crate::services::CoreServices;
use github::GitHubAccountManager;
use github::GitHubAuthenticationRequest;
use github::GitHubAuthenticationResponse;
use github::GitHubCredentialProvider;

#[derive(Default)]
struct Events {
    completions: Mutex<BTreeMap<LoginId, CompleteLogin>>,
}
impl AuthenticationEvents for Events {
    fn complete(&self, completion: CompleteLogin) -> Result<(), LoginError> {
        self.completions
            .lock()
            .map_err(|_| {
                LoginError::new(LoginErrorKind::Unavailable, "completion queue unavailable")
            })?
            .insert(completion.login_id.clone(), completion);
        Ok(())
    }
    fn update_account(&self, _: AccountSnapshot) -> Result<(), LoginError> {
        Ok(())
    }
}

/// One profile-scoped provider. The SDK handles wire quotas, fences and concurrent calls.
#[derive(Default)]
pub struct GitHubAuthenticationExtension {
    driver: Arc<Mutex<Option<Arc<GitHubOAuth>>>>,
    events: Arc<Events>,
}
impl Extension for GitHubAuthenticationExtension {
    fn id(&self) -> &str {
        "ash.github-authentication"
    }
    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let services = Arc::new(CoreServices(
            context.services.clone(),
            context.client.clone(),
        ));
        let configuration = context
            .environment()
            .get("ASH_GITHUB_BROWSER_CONFIG")
            .and_then(Option::as_ref)
            .ok_or_else(|| {
                ExtensionError::new(
                    extensions::HostErrorCode::ActivationFailed,
                    "provider configuration missing",
                )
            })?;
        let configuration = serde_json::from_str(configuration).map_err(|_| {
            ExtensionError::new(
                extensions::HostErrorCode::ActivationFailed,
                "provider configuration invalid",
            )
        })?;
        let oauth = GitHubOAuth::configured(configuration, services.clone(), services.clone())
            .map_err(|_| {
                ExtensionError::new(
                    extensions::HostErrorCode::ActivationFailed,
                    "provider configuration invalid",
                )
            })?;
        oauth.install_events(&(self.events.clone() as Arc<dyn AuthenticationEvents>));
        *self.driver.lock().expect("provider lock") = Some(oauth);
        let driver = self.driver.clone();
        let events = self.events.clone();
        context
            .data_channels
            .register("authentication.github", move |request, token| {
                token.check_cancelled()?;
                let result: Result<GitHubAuthenticationResponse, LoginError> =
                    CoreServices::with_invocation(token.clone(), || {
                        (|| {
                            let driver =
                                driver
                                    .lock()
                                    .expect("provider lock")
                                    .clone()
                                    .ok_or_else(|| {
                                        LoginError::new(
                                            LoginErrorKind::Unavailable,
                                            "provider is not configured",
                                        )
                                    })?;
                            Ok(match request {
                                GitHubAuthenticationRequest::Authentication(request) => {
                                    GitHubAuthenticationResponse::Authentication(match request {
                                        AuthenticationRequest::ReadAccounts => {
                                            AuthenticationResponse::Accounts(
                                                driver.read_accounts()?,
                                            )
                                        }
                                        AuthenticationRequest::Begin(request) => {
                                            AuthenticationResponse::Begun(driver.begin(request)?)
                                        }
                                        AuthenticationRequest::Cancel(id) => {
                                            events
                                                .completions
                                                .lock()
                                                .expect("completion lock")
                                                .remove(&id);
                                            AuthenticationResponse::Cancelled(driver.cancel(&id)?)
                                        }
                                        AuthenticationRequest::Logout(account) => {
                                            driver.logout(&account)?;
                                            AuthenticationResponse::LoggedOut
                                        }
                                        AuthenticationRequest::PollCompletion(id) => {
                                            AuthenticationResponse::Completion(
                                                events
                                                    .completions
                                                    .lock()
                                                    .expect("completion lock")
                                                    .remove(&id),
                                            )
                                        }
                                    })
                                }
                                GitHubAuthenticationRequest::Accounts => {
                                    GitHubAuthenticationResponse::Accounts(driver.accounts()?)
                                }
                                GitHubAuthenticationRequest::ConnectToken {
                                    host,
                                    token: value,
                                } => {
                                    let source = ash_async_utils::CancellationSource::new();
                                    let done = std::sync::atomic::AtomicBool::new(false);
                                    let account = std::thread::scope(|scope| {
                                        let source_ref = &source;
                                        let token_ref = &token;
                                        let done_ref = &done;
                                        scope.spawn(move || {
                                            while !done_ref
                                                .load(std::sync::atomic::Ordering::Acquire)
                                            {
                                                if token_ref.is_cancellation_requested() {
                                                    source_ref.cancel();
                                                    break;
                                                }
                                                std::thread::sleep(
                                                    std::time::Duration::from_millis(10),
                                                );
                                            }
                                        });
                                        let result = driver.connect_token(
                                            &host,
                                            ash_secrets::SecretValue::new(value),
                                            &source.token(),
                                        );
                                        done.store(true, std::sync::atomic::Ordering::Release);
                                        result
                                    })?;
                                    GitHubAuthenticationResponse::Connected(account)
                                }
                                GitHubAuthenticationRequest::Authorization { account_id } => {
                                    GitHubAuthenticationResponse::Authorization(match account_id {
                                        Some(id) => driver.authorization_for(&id)?,
                                        None => driver.authorization()?,
                                    })
                                }
                                GitHubAuthenticationRequest::Token(grant) => {
                                    GitHubAuthenticationResponse::Token(
                                        driver.token(&grant)?.expose().to_vec(),
                                    )
                                }
                            })
                        })()
                    });
                token.check_cancelled()?;
                // Preserve the domain error kind without turning it into a transport failure.
                Ok(result)
            })
    }
    fn deactivate(&mut self) -> Result<(), ExtensionError> {
        if let Some(driver) = self.driver.lock().expect("provider lock").take() {
            driver.stop();
        }
        self.events
            .completions
            .lock()
            .expect("completion lock")
            .clear();
        Ok(())
    }
}
