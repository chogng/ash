use super::*;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

#[derive(Default)]
struct FakeDriver {
    account: Mutex<Option<AccountSnapshot>>,
    active: Mutex<Vec<LoginId>>,
    reads: AtomicUsize,
    read_gate: Mutex<Option<ReadGate>>,
}

struct ReadGate {
    entered: std::sync::mpsc::SyncSender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

#[derive(Default)]
struct FakeKimiDriver {
    account: Mutex<Option<AccountSnapshot>>,
}

struct UnavailableDriver;

impl InteractiveLoginDriver for FakeKimiDriver {
    fn provider_id(&self) -> &'static str {
        "kimi"
    }

    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
        Ok(self.account.lock().unwrap().clone())
    }

    fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
        assert_eq!(request.method, LoginMethod::KimiDeviceCode);
        Ok(BeginLogin::DeviceCode {
            login_id: request.login_id,
            verification_url: "https://kimi.example.test/device".into(),
            user_code: "KIMI-CODE".into(),
        })
    }

    fn cancel(&self, _: &LoginId) -> Result<CancelLoginOutcome, LoginError> {
        Ok(CancelLoginOutcome::Cancelled)
    }

    fn logout(&self, _: &AccountRef) -> Result<(), LoginError> {
        *self.account.lock().unwrap() = None;
        Ok(())
    }
}

impl InteractiveLoginDriver for UnavailableDriver {
    fn provider_id(&self) -> &'static str {
        "openai-chatgpt"
    }

    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
        Err(LoginError::new(
            LoginErrorKind::Unavailable,
            "provider is unavailable",
        ))
    }

    fn begin(&self, _: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
        Err(LoginError::new(
            LoginErrorKind::Unavailable,
            "provider is unavailable",
        ))
    }

    fn cancel(&self, _: &LoginId) -> Result<CancelLoginOutcome, LoginError> {
        Ok(CancelLoginOutcome::NotFound)
    }

    fn logout(&self, _: &AccountRef) -> Result<(), LoginError> {
        Ok(())
    }
}

impl InteractiveLoginDriver for FakeDriver {
    fn provider_id(&self) -> &'static str {
        "openai-chatgpt"
    }

    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
        self.reads.fetch_add(1, Ordering::Relaxed);
        let account = self.account.lock().unwrap().clone();
        let gate = self.read_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.entered.send(()).unwrap();
            gate.release
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
        }
        Ok(account)
    }

    fn begin(&self, request: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
        self.active.lock().unwrap().push(request.login_id.clone());
        Ok(match request.method {
            LoginMethod::OpenAiChatGptBrowser => BeginLogin::Browser {
                login_id: request.login_id,
                authorization_url: "https://auth.example.test/start".into(),
            },
            LoginMethod::OpenAiChatGptDeviceCode => BeginLogin::DeviceCode {
                login_id: request.login_id,
                verification_url: "https://auth.example.test/device".into(),
                user_code: "ABCD-EFGH".into(),
            },
            LoginMethod::KimiDeviceCode | LoginMethod::XaiDeviceCode => unreachable!(),
        })
    }

    fn cancel(&self, login_id: &LoginId) -> Result<CancelLoginOutcome, LoginError> {
        let mut active = self.active.lock().unwrap();
        let Some(index) = active.iter().position(|candidate| candidate == login_id) else {
            return Ok(CancelLoginOutcome::NotFound);
        };
        active.remove(index);
        Ok(CancelLoginOutcome::Cancelled)
    }

    fn logout(&self, _: &AccountRef) -> Result<(), LoginError> {
        *self.account.lock().unwrap() = None;
        Ok(())
    }
}

#[derive(Default)]
struct RecordedEvents {
    completions: Mutex<Vec<LoginCompletion>>,
    accounts: Mutex<Vec<AccountState>>,
}

impl LoginEvents for RecordedEvents {
    fn login_completed(&self, completion: LoginCompletion) {
        self.completions.lock().unwrap().push(completion);
    }

    fn account_updated(&self, state: AccountState) {
        self.accounts.lock().unwrap().push(state);
    }
}

fn account() -> AccountSnapshot {
    AccountSnapshot {
        account: AccountRef {
            provider: "openai-chatgpt".into(),
            account_id: "acct_redacted".into(),
        },
        email: Some("person@example.test".into()),
        display_name: Some("Person".into()),
        organization: None,
        plan: Some("plus".into()),
        status: AccountStatus::Ready,
        credential_revision: 4,
    }
}

#[test]
fn browser_login_completion_updates_redacted_state_and_emits_events() {
    let driver = Arc::new(FakeDriver::default());
    let service = LoginService::new(driver).unwrap();
    let events = Arc::new(RecordedEvents::default());
    service.install_events(events.clone()).unwrap();

    let started = service.begin(LoginMethod::OpenAiChatGptBrowser).unwrap();
    let login_id = started.login_id().clone();
    service
        .complete(CompleteLogin {
            login_id,
            outcome: LoginCompletionOutcome::Succeeded { account: account() },
        })
        .unwrap();

    let state = service.read().unwrap();
    assert_eq!(state.revision, 1);
    assert_eq!(state.accounts, vec![account()]);
    assert_eq!(events.completions.lock().unwrap().len(), 1);
    assert_eq!(events.accounts.lock().unwrap().as_slice(), &[state]);
}

#[test]
fn cancellation_is_scoped_to_one_active_login() {
    let service = LoginService::new(Arc::new(FakeDriver::default())).unwrap();
    let started = service.begin(LoginMethod::OpenAiChatGptDeviceCode).unwrap();

    assert_eq!(
        service.cancel(started.login_id()).unwrap(),
        CancelLoginOutcome::Cancelled
    );
    assert_eq!(
        service.cancel(started.login_id()).unwrap(),
        CancelLoginOutcome::NotFound
    );
}

#[test]
fn deferred_service_reads_the_provider_once_before_using_its_projection() {
    let driver = Arc::new(FakeDriver::default());
    *driver.account.lock().unwrap() = Some(account());
    let service = LoginService::deferred(driver.clone());

    assert_eq!(driver.reads.load(Ordering::Relaxed), 0);
    assert_eq!(service.read_or_refresh().unwrap().accounts, vec![account()]);
    assert_eq!(service.read_or_refresh().unwrap().accounts, vec![account()]);
    assert_eq!(driver.reads.load(Ordering::Relaxed), 1);
}

#[test]
fn multiple_provider_drivers_keep_independent_accounts_and_route_by_method() {
    let openai: Arc<dyn InteractiveLoginDriver> = Arc::new(FakeDriver::default());
    let kimi: Arc<dyn InteractiveLoginDriver> = Arc::new(FakeKimiDriver::default());
    let service = LoginService::new_with_drivers([openai, kimi]).unwrap();
    assert_eq!(
        service.logout_provider("openai-chatgpt").unwrap(),
        LogoutOutcome::AlreadyLoggedOut
    );

    let started = service.begin(LoginMethod::KimiDeviceCode).unwrap();
    let kimi_account = AccountSnapshot {
        account: AccountRef {
            provider: "kimi".into(),
            account_id: "current".into(),
        },
        email: None,
        display_name: Some("Kimi Code".into()),
        organization: None,
        plan: None,
        status: AccountStatus::Ready,
        credential_revision: 1,
    };
    service
        .complete(CompleteLogin {
            login_id: started.login_id().clone(),
            outcome: LoginCompletionOutcome::Succeeded {
                account: kimi_account.clone(),
            },
        })
        .unwrap();

    assert_eq!(service.read().unwrap().accounts, vec![kimi_account]);
    assert_eq!(
        service.logout_provider("kimi").unwrap(),
        LogoutOutcome::LoggedOut
    );
    assert!(service.read().unwrap().accounts.is_empty());
}

#[test]
fn one_unavailable_provider_does_not_hide_another_provider_account() {
    let kimi = Arc::new(FakeKimiDriver::default());
    let kimi_account = AccountSnapshot {
        account: AccountRef {
            provider: "kimi".into(),
            account_id: "current".into(),
        },
        email: None,
        display_name: Some("Kimi Code".into()),
        organization: None,
        plan: Some("subscription".into()),
        status: AccountStatus::Ready,
        credential_revision: 2,
    };
    *kimi.account.lock().unwrap() = Some(kimi_account.clone());
    let unavailable: Arc<dyn InteractiveLoginDriver> = Arc::new(UnavailableDriver);
    let kimi_driver: Arc<dyn InteractiveLoginDriver> = kimi;
    let service = LoginService::deferred_with_drivers([unavailable, kimi_driver]).unwrap();

    assert_eq!(
        service.read_or_refresh().unwrap().accounts,
        vec![kimi_account]
    );
}

fn delayed_refresh(
    driver: &FakeDriver,
    service: &Arc<LoginService>,
) -> (
    std::sync::mpsc::SyncSender<()>,
    std::thread::JoinHandle<AccountState>,
) {
    let (entered, waiting) = std::sync::mpsc::sync_channel(1);
    let (release, receiver) = std::sync::mpsc::sync_channel(1);
    *driver.read_gate.lock().unwrap() = Some(ReadGate {
        entered,
        release: receiver,
    });
    let service = Arc::clone(service);
    let read = std::thread::spawn(move || service.refresh().unwrap());
    waiting
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    (release, read)
}

#[test]
fn refresh_started_before_login_cannot_erase_the_completed_account() {
    let driver = Arc::new(FakeDriver::default());
    let service = Arc::new(LoginService::new(driver.clone()).unwrap());
    let events = Arc::new(RecordedEvents::default());
    service.install_events(events.clone()).unwrap();
    let started = service.begin(LoginMethod::OpenAiChatGptDeviceCode).unwrap();
    let (release, read) = delayed_refresh(&driver, &service);
    *driver.account.lock().unwrap() = Some(account());
    service
        .complete(CompleteLogin {
            login_id: started.login_id().clone(),
            outcome: LoginCompletionOutcome::Succeeded { account: account() },
        })
        .unwrap();
    let completed = service.read().unwrap();
    release.send(()).unwrap();
    assert_eq!(read.join().unwrap(), completed);
    assert_eq!(events.accounts.lock().unwrap().as_slice(), &[completed]);
}

#[test]
fn refresh_started_before_logout_cannot_restore_the_account() {
    let driver = Arc::new(FakeDriver::default());
    *driver.account.lock().unwrap() = Some(account());
    let service = Arc::new(LoginService::new(driver.clone()).unwrap());
    let (release, read) = delayed_refresh(&driver, &service);
    assert_eq!(service.logout().unwrap(), LogoutOutcome::LoggedOut);
    let logged_out = service.read().unwrap();
    release.send(()).unwrap();
    assert_eq!(read.join().unwrap(), logged_out);
    assert!(logged_out.accounts.is_empty());
}

#[test]
fn refresh_cannot_overwrite_a_later_read_or_provider_update() {
    for update in [false, true] {
        let driver = Arc::new(FakeDriver::default());
        let service = Arc::new(LoginService::new(driver.clone()).unwrap());
        let (release, read) = delayed_refresh(&driver, &service);
        *driver.account.lock().unwrap() = Some(account());
        let current = if update {
            service.update_account(account()).unwrap()
        } else {
            service.refresh().unwrap()
        };
        release.send(()).unwrap();
        assert_eq!(read.join().unwrap(), current);
    }
}

#[test]
fn refresh_discards_only_the_provider_changed_during_the_read() {
    let driver = Arc::new(FakeDriver::default());
    let kimi = Arc::new(FakeKimiDriver::default());
    let service = Arc::new(
        LoginService::new_with_drivers([
            driver.clone() as Arc<dyn InteractiveLoginDriver>,
            kimi.clone() as Arc<dyn InteractiveLoginDriver>,
        ])
        .unwrap(),
    );
    let mut kimi_account = account();
    kimi_account.account.provider = "kimi".into();
    *kimi.account.lock().unwrap() = Some(kimi_account.clone());
    let (release, read) = delayed_refresh(&driver, &service);
    let updated = service.update_account(account()).unwrap();
    release.send(()).unwrap();
    let result = read.join().unwrap();
    assert_eq!(result.accounts, vec![kimi_account, account()]);
    assert_eq!(result.revision, updated.revision + 1);
}
