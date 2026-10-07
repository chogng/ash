//! Ash-owned ChatGPT plan registrations. Codex credentials are never consulted.

mod authorization;
mod storage;

use crate::ChatGptError;
use ash_async_utils::CancellationSource;
use ash_client::OperationClient;
use ash_client::RequestBinding;
use ash_client::RequestIdentity;
use ash_client::RequestPurpose;
use ash_client::ResolvedApiTarget;
use ash_http_client::HttpHeader;
use ash_login::AccountMultiplicity;
use ash_login::AccountRef;
use ash_login::AccountSnapshot;
use ash_login::BeginLogin;
use ash_login::BeginLoginRequest;
use ash_login::CancelLoginOutcome;
use ash_login::CompleteLogin;
use ash_login::InteractiveLoginDriver;
use ash_login::LoginCompletionOutcome;
use ash_login::LoginError;
use ash_login::LoginErrorKind;
use ash_login::LoginFailure;
use ash_login::LoginId;
use ash_login::LoginMethod;
use ash_login::LoginService;
use ash_secrets::SecretStore;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use storage::PlanStore;
use storage::Registration;

pub const CHATGPT_PLAN_PROVIDER_ID: &str = "chatgpt-plan";
const RESOURCE: &str = "https://api.openai.com/v1";
const ISSUER: &str = "https://auth.openai.com";
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";

/// Owns Ash's direct plan authorization, selected registration and renewable sessions.
/// One profile runtime is one agent host; its persisted host ID survives restart and logout.
pub struct ChatGptPlanOAuth {
    authorization: authorization::Client,
    store: PlanStore,
    self_weak: Weak<Self>,
    service: Mutex<Weak<LoginService>>,
    attempts: Mutex<BTreeMap<LoginId, LoginAttempt>>,
}

struct LoginAttempt {
    cancellation: CancellationSource,
    selection_revision: u64,
}

impl ChatGptPlanOAuth {
    pub fn with_client(
        secrets: Arc<dyn SecretStore>,
        lock_path: PathBuf,
        client: Arc<dyn OperationClient>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|self_weak| Self {
            authorization: authorization::Client::new(client),
            store: PlanStore::new(secrets, lock_path),
            self_weak: self_weak.clone(),
            service: Mutex::new(Weak::new()),
            attempts: Mutex::new(BTreeMap::new()),
        })
    }

    pub fn install_login_service(&self, service: &Arc<LoginService>) -> Result<(), LoginError> {
        *self.service.lock().map_err(lock_error)? = Arc::downgrade(service);
        Ok(())
    }

    /// Identity includes the issued client because each registration is workspace-bound.
    pub fn account_id(&self) -> Result<Option<String>, ChatGptError> {
        let _guard = self.store.lock()?;
        let state = self.store.load()?;
        Ok(state
            .active
            .filter(|id| state.accounts.get(id).is_some_and(Registration::ready)))
    }

    /// Resolves only the selected Ash credential; rotating refreshes are serialized across processes.
    pub fn api_target(&self) -> Result<ResolvedApiTarget, ChatGptError> {
        let _guard = self.store.lock()?;
        let mut state = self.store.load()?;
        let id = state
            .active
            .clone()
            .ok_or_else(|| failure("ChatGPT plan is not connected"))?;
        let registration = state
            .accounts
            .get_mut(&id)
            .ok_or_else(|| failure("ChatGPT plan registration is missing"))?;
        let tokens = registration
            .tokens
            .as_ref()
            .ok_or_else(|| failure("Continue with ChatGPT to renew this account"))?;
        if tokens.expires_at <= storage::now() + 300 && tokens.earliest_refresh_at <= storage::now()
        {
            match self.authorization.refresh(registration) {
                Ok(()) => self.store.save(&state)?,
                Err(error) => {
                    // Only a confirmed terminal grant rejection clears credentials. Network failures
                    // preserve the rotating refresh token and the registration's account mapping.
                    if registration.tokens.is_none() {
                        self.store.save(&state)?;
                    }
                    return Err(error);
                }
            }
        }
        let registration = &state.accounts[&id];
        let tokens = registration
            .tokens
            .as_ref()
            .ok_or_else(|| failure("ChatGPT plan is signed out"))?;
        if tokens.expires_at <= storage::now() || !tokens.has_plan_scope() {
            return Err(failure(
                "ChatGPT plan authorization has expired or is not enabled",
            ));
        }
        Ok(ResolvedApiTarget::new(
            RESOURCE,
            vec![HttpHeader::new(
                "Authorization",
                format!("Bearer {}", tokens.access_token),
            )],
            RequestBinding::new(
                RequestPurpose::Model,
                RequestIdentity::account(CHATGPT_PLAN_PROVIDER_ID, id, registration.revision),
            ),
        ))
    }

    fn finish(
        &self,
        login_id: LoginId,
        result: Result<Registration, ChatGptError>,
        expected_revision: Option<u64>,
    ) {
        // Cancellation and persistence share this lock: a cancelled callback cannot activate an account.
        let Ok(mut attempts) = self.attempts.lock() else {
            return;
        };
        let Some(attempt) = attempts.remove(&login_id) else {
            return;
        };
        if attempt.cancellation.token().is_cancelled() {
            return;
        }
        let result = result.and_then(|registration| {
            let _guard = self.store.lock()?;
            let mut state = self.store.load()?;
            // Account activation is profile-wide. Another login or logout, including
            // from another process, supersedes the selection observed at sign-in start.
            if state.selection_revision != attempt.selection_revision {
                return Err(failure("ChatGPT registration changed during authorization"));
            }
            let id = registration.id();
            if state.accounts.get(&id).map(|account| account.revision) != expected_revision {
                return Err(failure("ChatGPT registration changed during authorization"));
            }
            let snapshot = registration.snapshot();
            state.accounts.insert(id.clone(), registration);
            state.active = Some(id);
            state.selection_revision += 1;
            self.store.save(&state)?;
            Ok(snapshot)
        });
        drop(attempts);
        let outcome = match result {
            Ok(account) => LoginCompletionOutcome::Succeeded { account },
            Err(error) => LoginCompletionOutcome::Failed {
                failure: LoginFailure {
                    code: "chatgptPlanAuthorizationFailed".into(),
                    message: error.to_string(),
                },
            },
        };
        if let Ok(service) = self.service.lock()
            && let Some(service) = service.upgrade()
        {
            let _ = service.complete(CompleteLogin { login_id, outcome });
        }
    }
}

impl InteractiveLoginDriver for ChatGptPlanOAuth {
    fn provider_id(&self) -> &'static str {
        CHATGPT_PLAN_PROVIDER_ID
    }
    fn account_multiplicity(&self) -> AccountMultiplicity {
        AccountMultiplicity::Multiple
    }

    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
        let _guard = self.store.lock().map_err(login_error)?;
        let state = self.store.load().map_err(login_error)?;
        Ok(state
            .active
            .and_then(|id| state.accounts.get(&id).map(Registration::snapshot)))
    }

    fn read_accounts(&self) -> Result<Vec<AccountSnapshot>, LoginError> {
        let _guard = self.store.lock().map_err(login_error)?;
        Ok(self
            .store
            .load()
            .map_err(login_error)?
            .accounts
            .values()
            .map(Registration::snapshot)
            .collect())
    }

    fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
        let LoginMethod::ChatGptPlanBrowser { account_id } = request.method else {
            return Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "Unsupported ChatGPT plan login method",
            ));
        };
        let (host, selected, selection_revision) = {
            let _guard = self.store.lock().map_err(login_error)?;
            let mut state = self.store.load().map_err(login_error)?;
            if state.host_id.is_empty() {
                state.host_id = storage::new_host_id().map_err(login_error)?;
                self.store.save(&state).map_err(login_error)?;
            }
            let selected = account_id
                .map(|id| {
                    state
                        .accounts
                        .get(&id)
                        .cloned()
                        .ok_or_else(|| failure("ChatGPT plan account was not found"))
                })
                .transpose()
                .map_err(login_error)?;
            (state.host_id, selected, state.selection_revision)
        };
        let grant = authorization::Grant::new(&host, selected).map_err(login_error)?;
        let authorization_url = grant.url.clone();
        let expected_revision = grant.selected.as_ref().map(|account| account.revision);
        let source = CancellationSource::new();
        let token = source.token();
        self.attempts.lock().map_err(lock_error)?.insert(
            request.login_id.clone(),
            LoginAttempt {
                cancellation: source,
                selection_revision,
            },
        );
        // The worker owns only transport and callback resources. It must not keep
        // the credential owner alive after its profile backend has shut down.
        let this = self.self_weak.clone();
        let authorization = self.authorization.clone();
        let login_id = request.login_id.clone();
        std::thread::spawn(move || {
            let result = authorization.authorize(grant, &token);
            if let Some(this) = this.upgrade() {
                this.finish(login_id, result, expected_revision);
            }
        });
        Ok(BeginLogin::Browser {
            login_id: request.login_id,
            authorization_url,
        })
    }

    fn cancel(&self, login_id: &LoginId) -> Result<CancelLoginOutcome, LoginError> {
        let attempt = self.attempts.lock().map_err(lock_error)?.remove(login_id);
        Ok(match attempt {
            Some(attempt) => {
                attempt.cancellation.cancel();
                CancelLoginOutcome::Cancelled
            }
            None => CancelLoginOutcome::NotFound,
        })
    }

    fn logout(&self, account: &AccountRef) -> Result<(), LoginError> {
        if account.provider != CHATGPT_PLAN_PROVIDER_ID {
            return Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "ChatGPT plan account provider mismatch",
            ));
        }
        // Stop new requests while revocation is pending. The lock also prevents a refresh from
        // recreating credentials after logout. Retain the mapping for returning authorization.
        let _guard = self.store.lock().map_err(login_error)?;
        let mut state = self.store.load().map_err(login_error)?;
        let Some(registration) = state.accounts.get_mut(&account.account_id) else {
            return Ok(());
        };
        let revoked = self.authorization.revoke(registration);
        registration.tokens = None;
        registration.revision += 1;
        state.selection_revision += 1;
        if state.active.as_deref() == Some(&account.account_id) {
            state.active = None;
        }
        self.store.save(&state).map_err(login_error)?;
        revoked.map_err(login_error)
    }
}

impl Drop for ChatGptPlanOAuth {
    fn drop(&mut self) {
        if let Ok(attempts) = self.attempts.get_mut() {
            for attempt in attempts.values() {
                attempt.cancellation.cancel();
            }
        }
    }
}

fn failure(message: &str) -> ChatGptError {
    ChatGptError::new(message)
}
fn login_error(error: ChatGptError) -> LoginError {
    LoginError::new(LoginErrorKind::Driver, error.to_string())
}
fn lock_error<T>(_: std::sync::PoisonError<T>) -> LoginError {
    LoginError::new(
        LoginErrorKind::Unavailable,
        "ChatGPT plan state is unavailable",
    )
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
