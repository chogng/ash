use crate::AccountMetadataRefresher;
use crate::AccountMultiplicity;
use crate::AccountRef;
use crate::AccountSnapshot;
use crate::AccountState;
use crate::AccountStatus;
use crate::BeginLogin;
use crate::BeginLoginRequest;
use crate::CancelLoginOutcome;
use crate::CompleteLogin;
use crate::InteractiveLoginDriver;
use crate::LoginCompletion;
use crate::LoginCompletionOutcome;
use crate::LoginError;
use crate::LoginErrorKind;
use crate::LoginEvents;
use crate::LoginId;
use crate::LoginMethod;
use crate::LogoutOutcome;
use ash_async_utils::CancellationToken;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

/// Coordinates provider-scoped drivers, stable login identities, and revisioned redacted state.
pub struct LoginService {
    drivers: BTreeMap<String, Arc<dyn InteractiveLoginDriver>>,
    metadata_refreshers: BTreeMap<String, Arc<dyn AccountMetadataRefresher>>,
    next_login_id: AtomicU64,
    state: Mutex<LoginServiceState>,
    events: Mutex<Option<Arc<dyn LoginEvents>>>,
}

struct LoginServiceState {
    account: AccountState,
    active_logins: BTreeMap<LoginId, String>,
    initialized_providers: BTreeSet<String>,
    provider_revisions: BTreeMap<String, u64>,
}

impl LoginServiceState {
    fn advance_provider(&mut self, provider: &str) {
        let revision = self
            .provider_revisions
            .get_mut(provider)
            .expect("account provider was registered");
        *revision += 1;
    }
}

impl LoginService {
    pub fn new(driver: Arc<dyn InteractiveLoginDriver>) -> Result<Self, LoginError> {
        Self::new_with_drivers([driver])
    }

    pub fn new_with_drivers(
        drivers: impl IntoIterator<Item = Arc<dyn InteractiveLoginDriver>>,
    ) -> Result<Self, LoginError> {
        Self::from_drivers(drivers, true)
    }

    /// Creates a control plane without performing provider I/O during composition.
    ///
    /// Product hosts should use this for lazy process-backed drivers and call
    /// [`Self::read_or_refresh`] when the first account projection is requested.
    pub fn deferred(driver: Arc<dyn InteractiveLoginDriver>) -> Self {
        Self::deferred_with_drivers([driver]).expect("one driver cannot have a duplicate provider")
    }

    pub fn deferred_with_drivers(
        drivers: impl IntoIterator<Item = Arc<dyn InteractiveLoginDriver>>,
    ) -> Result<Self, LoginError> {
        Self::from_drivers(drivers, false)
    }

    fn from_drivers(
        drivers: impl IntoIterator<Item = Arc<dyn InteractiveLoginDriver>>,
        initialize: bool,
    ) -> Result<Self, LoginError> {
        let mut registered = BTreeMap::new();
        let mut accounts = Vec::new();
        let mut initialized_providers = BTreeSet::new();
        for driver in drivers {
            let provider = driver.provider_id();
            if provider.trim().is_empty() || provider.chars().any(char::is_whitespace) {
                return Err(LoginError::new(
                    LoginErrorKind::InvalidInput,
                    "login driver provider ID is invalid",
                ));
            }
            if registered.contains_key(provider) {
                return Err(LoginError::new(
                    LoginErrorKind::Conflict,
                    format!("multiple login drivers own provider '{provider}'"),
                ));
            }
            if initialize {
                let catalog = driver.read_accounts()?;
                validate_catalog(provider, &catalog)?;
                accounts.extend(catalog);
                initialized_providers.insert(provider.to_owned());
            }
            registered.insert(provider.to_owned(), driver);
        }
        sort_accounts(&mut accounts);
        let provider_revisions = registered
            .keys()
            .map(|provider| (provider.clone(), 0))
            .collect();
        Ok(Self {
            drivers: registered,
            metadata_refreshers: BTreeMap::new(),
            next_login_id: AtomicU64::new(1),
            state: Mutex::new(LoginServiceState {
                account: AccountState {
                    revision: u64::from(!accounts.is_empty()),
                    accounts,
                },
                active_logins: BTreeMap::new(),
                initialized_providers,
                provider_revisions,
            }),
            events: Mutex::new(None),
        })
    }

    /// Installs remote metadata readers for providers already registered with this service.
    pub fn with_account_metadata_refreshers(
        mut self,
        refreshers: impl IntoIterator<Item = Arc<dyn AccountMetadataRefresher>>,
    ) -> Result<Self, LoginError> {
        for refresher in refreshers {
            let provider = refresher.provider_id();
            if !self.drivers.contains_key(provider) {
                return Err(LoginError::new(
                    LoginErrorKind::InvalidInput,
                    format!("metadata refresher provider '{provider}' has no login driver"),
                ));
            }
            if self
                .metadata_refreshers
                .insert(provider.to_owned(), refresher)
                .is_some()
            {
                return Err(LoginError::new(
                    LoginErrorKind::Conflict,
                    format!("multiple metadata refreshers own provider '{provider}'"),
                ));
            }
        }
        Ok(self)
    }

    /// Reports whether this provider can refresh remote account display metadata.
    pub fn has_account_metadata_refresher(&self, provider: &str) -> bool {
        self.metadata_refreshers.contains_key(provider)
    }

    /// Refreshes display metadata only while the requested account is still current.
    pub fn refresh_account_metadata(
        &self,
        provider: &str,
        account_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<AccountState, LoginError> {
        let refresher = self.metadata_refreshers.get(provider).ok_or_else(|| {
            LoginError::new(
                LoginErrorKind::Unavailable,
                format!("metadata refresher for '{provider}' is unavailable"),
            )
        })?;
        let state = self.read_or_refresh()?;
        if !state.accounts.iter().any(|account| {
            account.account.provider == provider
                && account.account.account_id == account_id
                && account.status == AccountStatus::Ready
        }) {
            return Err(LoginError::new(
                LoginErrorKind::NotFound,
                "subscription account is no longer ready",
            ));
        }
        refresher.refresh_account(account_id, cancellation)?;
        self.refresh()
    }

    pub fn install_events(&self, events: Arc<dyn LoginEvents>) -> Result<(), LoginError> {
        *self.events.lock().map_err(lock_error)? = Some(events);
        Ok(())
    }

    pub fn read(&self) -> Result<AccountState, LoginError> {
        Ok(self.state.lock().map_err(lock_error)?.account.clone())
    }

    /// Reads the canonical projection, performing deferred provider I/O once.
    pub fn read_or_refresh(&self) -> Result<AccountState, LoginError> {
        if self
            .state
            .lock()
            .map_err(lock_error)?
            .initialized_providers
            .len()
            == self.drivers.len()
        {
            self.read()
        } else {
            self.refresh()
        }
    }

    pub fn begin(&self, method: LoginMethod) -> Result<BeginLogin, LoginError> {
        self.begin_with_identity(method, |_| Ok(()))
    }

    /// Registers the caller's routing before a driver can complete synchronously.
    /// The caller must retire that routing if starting the driver fails.
    pub fn begin_with_identity(
        &self,
        method: LoginMethod,
        register: impl FnOnce(&LoginId) -> Result<(), LoginError>,
    ) -> Result<BeginLogin, LoginError> {
        let provider = method.provider_id();
        let driver = self.drivers.get(provider).ok_or_else(|| {
            LoginError::new(
                LoginErrorKind::Unavailable,
                format!("login provider '{provider}' is unavailable"),
            )
        })?;
        let sequence = self.next_login_id.fetch_add(1, Ordering::Relaxed);
        let login_id = LoginId::new(format!("login-{sequence:016x}"))?;
        self.state
            .lock()
            .map_err(lock_error)?
            .active_logins
            .insert(login_id.clone(), provider.to_owned());
        if let Err(error) = register(&login_id) {
            self.state
                .lock()
                .map_err(lock_error)?
                .active_logins
                .remove(&login_id);
            return Err(error);
        }
        let started = match driver.begin(BeginLoginRequest {
            login_id: login_id.clone(),
            method,
        }) {
            Ok(started) => started,
            Err(error) => {
                self.state
                    .lock()
                    .map_err(lock_error)?
                    .active_logins
                    .remove(&login_id);
                return Err(error);
            }
        };
        if started.login_id() != &login_id {
            let _ = driver.cancel(&login_id);
            self.state
                .lock()
                .map_err(lock_error)?
                .active_logins
                .remove(&login_id);
            return Err(LoginError::new(
                LoginErrorKind::Driver,
                "interactive login driver changed the assigned login ID",
            ));
        }
        if let BeginLogin::Connected { login_id, account } = &started {
            self.complete(CompleteLogin {
                login_id: login_id.clone(),
                outcome: LoginCompletionOutcome::Succeeded {
                    account: account.clone(),
                },
            })?;
        }
        Ok(started)
    }

    pub fn cancel(&self, login_id: &LoginId) -> Result<CancelLoginOutcome, LoginError> {
        let provider = self
            .state
            .lock()
            .map_err(lock_error)?
            .active_logins
            .get(login_id)
            .cloned();
        let Some(provider) = provider else {
            return Ok(CancelLoginOutcome::NotFound);
        };
        let driver = self
            .drivers
            .get(&provider)
            .expect("active login provider was registered");
        let outcome = driver.cancel(login_id)?;
        if matches!(
            outcome,
            CancelLoginOutcome::Cancelled | CancelLoginOutcome::NotFound
        ) {
            self.state
                .lock()
                .map_err(lock_error)?
                .active_logins
                .remove(login_id);
        }
        Ok(outcome)
    }

    pub fn complete(&self, completion: CompleteLogin) -> Result<(), LoginError> {
        let event = {
            let mut state = self.state.lock().map_err(lock_error)?;
            let Some(provider) = state.active_logins.remove(&completion.login_id) else {
                return Err(LoginError::new(
                    LoginErrorKind::NotFound,
                    "login attempt is not active",
                ));
            };
            if let LoginCompletionOutcome::Succeeded { account } = &completion.outcome {
                validate_account_provider(&provider, account)?;
                state.advance_provider(&provider);
                upsert_account(
                    &mut state.account.accounts,
                    account.clone(),
                    self.drivers[&provider].account_multiplicity(),
                );
                state.account.revision = state.account.revision.saturating_add(1);
            }
            state.initialized_providers.insert(provider);
            LoginCompletion {
                login_id: completion.login_id,
                outcome: completion.outcome,
                account_state: state.account.clone(),
            }
        };
        if let Some(events) = self.events()? {
            events.login_completed(event.clone());
            if matches!(event.outcome, LoginCompletionOutcome::Succeeded { .. }) {
                events.account_updated(event.account_state);
            }
        }
        Ok(())
    }

    pub fn refresh(&self) -> Result<AccountState, LoginError> {
        let revisions = self
            .state
            .lock()
            .map_err(lock_error)?
            .provider_revisions
            .clone();
        let mut observed = Vec::with_capacity(self.drivers.len());
        for (provider, driver) in &self.drivers {
            let account = driver.read_accounts().and_then(|accounts| {
                validate_catalog(provider, &accounts)?;
                Ok(accounts)
            });
            observed.push((provider.clone(), account));
        }
        let updated = {
            let mut state = self.state.lock().map_err(lock_error)?;
            // Driver I/O may overlap completion, logout, or another read. Only
            // observations of the unchanged provider state may commit.
            observed
                .retain(|(provider, _)| state.provider_revisions[provider] == revisions[provider]);
            if observed.iter().all(|(_, result)| result.is_err())
                && let Some(error) = observed
                    .iter()
                    .find_map(|(_, result)| result.as_ref().err())
            {
                return Err(error.clone());
            }
            let before = state.account.accounts.clone();
            for (provider, result) in observed {
                state.advance_provider(&provider);
                match result {
                    Ok(account) => {
                        replace_provider_accounts(&mut state.account.accounts, &provider, account);
                        state.initialized_providers.insert(provider);
                    }
                    Err(_) => {
                        state.initialized_providers.remove(&provider);
                        for account in state
                            .account
                            .accounts
                            .iter_mut()
                            .filter(|account| account.account.provider == provider)
                        {
                            account.status = crate::AccountStatus::Unavailable;
                        }
                    }
                }
            }
            if state.account.accounts == before {
                None
            } else {
                state.account.revision = state.account.revision.saturating_add(1);
                Some(state.account.clone())
            }
        };
        if let Some(updated) = updated {
            if let Some(events) = self.events()? {
                events.account_updated(updated.clone());
            }
            Ok(updated)
        } else {
            self.read()
        }
    }

    /// Accepts a provider-owned account projection after an internal credential rotation.
    pub fn update_account(&self, account: AccountSnapshot) -> Result<AccountState, LoginError> {
        let provider = account.account.provider.clone();
        if !self.drivers.contains_key(&provider) {
            return Err(LoginError::new(
                LoginErrorKind::Unavailable,
                format!("login provider '{provider}' is unavailable"),
            ));
        }
        validate_account_provider(&provider, &account)?;
        let updated = {
            let mut state = self.state.lock().map_err(lock_error)?;
            state.advance_provider(&provider);
            let before = state.account.accounts.clone();
            upsert_account(
                &mut state.account.accounts,
                account,
                self.drivers[&provider].account_multiplicity(),
            );
            state.initialized_providers.insert(provider);
            if state.account.accounts == before {
                return Ok(state.account.clone());
            }
            state.account.revision = state.account.revision.saturating_add(1);
            state.account.clone()
        };
        if let Some(events) = self.events()? {
            events.account_updated(updated.clone());
        }
        Ok(updated)
    }

    pub fn logout_provider(&self, provider: &str) -> Result<LogoutOutcome, LoginError> {
        let driver = self.drivers.get(provider).ok_or_else(|| {
            LoginError::new(
                LoginErrorKind::Unavailable,
                format!("login provider '{provider}' is unavailable"),
            )
        })?;
        let accounts: Vec<_> = self
            .read_or_refresh()?
            .accounts
            .into_iter()
            .filter(|account| account.account.provider == provider)
            .collect();
        if accounts.is_empty() {
            return Ok(LogoutOutcome::AlreadyLoggedOut);
        }
        for account in accounts {
            driver.logout(&account.account)?;
        }
        let updated = {
            let mut state = self.state.lock().map_err(lock_error)?;
            state.advance_provider(provider);
            let before = state.account.accounts.len();
            replace_provider_accounts(&mut state.account.accounts, provider, Vec::new());
            if state.account.accounts.len() == before {
                return Ok(LogoutOutcome::LoggedOut);
            }
            state.account.revision = state.account.revision.saturating_add(1);
            state.account.clone()
        };
        if let Some(events) = self.events()? {
            events.account_updated(updated);
        }
        Ok(LogoutOutcome::LoggedOut)
    }

    /// Removes one exact account without disturbing other accounts owned by its provider.
    pub fn logout_account(&self, account: &AccountRef) -> Result<LogoutOutcome, LoginError> {
        let driver = self.drivers.get(&account.provider).ok_or_else(|| {
            LoginError::new(
                LoginErrorKind::Unavailable,
                "account provider is unavailable",
            )
        })?;
        if !self
            .read_or_refresh()?
            .accounts
            .iter()
            .any(|entry| entry.account == *account)
        {
            return Ok(LogoutOutcome::AlreadyLoggedOut);
        }
        driver.logout(account)?;
        let updated = {
            let mut state = self.state.lock().map_err(lock_error)?;
            state.advance_provider(&account.provider);
            state
                .account
                .accounts
                .retain(|entry| entry.account != *account);
            state.account.revision = state.account.revision.saturating_add(1);
            state.account.clone()
        };
        if let Some(events) = self.events()? {
            events.account_updated(updated);
        }
        Ok(LogoutOutcome::LoggedOut)
    }

    /// Logs out the only registered provider for compatibility with single-driver hosts.
    pub fn logout(&self) -> Result<LogoutOutcome, LoginError> {
        if self.drivers.len() != 1 {
            return Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "provider is required when multiple login drivers are registered",
            ));
        }
        self.logout_provider(
            self.drivers
                .keys()
                .next()
                .expect("single driver has a provider"),
        )
    }

    fn events(&self) -> Result<Option<Arc<dyn LoginEvents>>, LoginError> {
        Ok(self.events.lock().map_err(lock_error)?.clone())
    }
}

fn replace_provider_accounts(
    accounts: &mut Vec<AccountSnapshot>,
    provider: &str,
    catalog: Vec<AccountSnapshot>,
) {
    accounts.retain(|candidate| candidate.account.provider != provider);
    accounts.extend(catalog);
    sort_accounts(accounts);
}

fn upsert_account(
    accounts: &mut Vec<AccountSnapshot>,
    account: AccountSnapshot,
    multiplicity: AccountMultiplicity,
) {
    accounts.retain(|candidate| {
        candidate.account.provider != account.account.provider
            || (multiplicity == AccountMultiplicity::Multiple
                && candidate.account.account_id != account.account.account_id)
    });
    accounts.push(account);
    sort_accounts(accounts);
}

fn sort_accounts(accounts: &mut [AccountSnapshot]) {
    accounts.sort_by(|left, right| {
        (&left.account.provider, &left.account.account_id)
            .cmp(&(&right.account.provider, &right.account.account_id))
    });
}

fn validate_catalog(provider: &str, accounts: &[AccountSnapshot]) -> Result<(), LoginError> {
    let mut identities = BTreeSet::new();
    for account in accounts {
        validate_account_provider(provider, account)?;
        if account.account.account_id.is_empty() || !identities.insert(&account.account.account_id)
        {
            return Err(LoginError::new(
                LoginErrorKind::Driver,
                "login driver returned duplicate or empty account identities",
            ));
        }
    }
    Ok(())
}

fn validate_account_provider(provider: &str, account: &AccountSnapshot) -> Result<(), LoginError> {
    if account.account.provider == provider {
        Ok(())
    } else {
        Err(LoginError::new(
            LoginErrorKind::Driver,
            "login driver returned an account for a different provider",
        ))
    }
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> LoginError {
    LoginError::new(LoginErrorKind::Unavailable, "login state lock poisoned")
}
