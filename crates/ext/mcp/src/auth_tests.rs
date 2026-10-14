use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use ash_config::McpCredentialBinding;
use ash_config::McpServerConfig;
use ash_config::McpServerEnablement;
use ash_config::McpServerId;
use ash_config::McpTransportConfig;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use url::Url;

use super::*;

#[derive(Default)]
struct TestProvider {
    verifier: Mutex<Option<String>>,
    refreshes: Mutex<usize>,
    revocations: Mutex<usize>,
    fail_revocation: Mutex<bool>,
    exchange_entered: Mutex<Option<std::sync::mpsc::SyncSender<()>>>,
    exchange_resume: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}

impl McpOAuthProvider for TestProvider {
    fn authorization_url(
        &self,
        _: &McpOAuthTarget,
        challenge: McpOAuthChallenge<'_>,
    ) -> Result<String, McpOAuthError> {
        let mut url = Url::parse("https://accounts.example.test/authorize").unwrap();
        url.query_pairs_mut()
            .append_pair("state", challenge.state)
            .append_pair("code_challenge", challenge.code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("redirect_uri", challenge.redirect_uri)
            .append_pair("resource", challenge.resource.as_str());
        Ok(url.to_string())
    }

    fn exchange(
        &self,
        _: &McpOAuthTarget,
        request: McpOAuthExchangeRequest<'_>,
    ) -> Result<McpOAuthCredential, McpOAuthError> {
        assert_eq!(request.authorization_code.expose(), b"authorization-code");
        assert_eq!(request.redirect_uri, "http://127.0.0.1:49152/callback");
        assert_eq!(request.resource.as_str(), "https://mcp.example.test/rpc");
        if let Some(entered) = self.exchange_entered.lock().unwrap().as_ref() {
            entered.send(()).unwrap();
        }
        if let Some(resume) = self.exchange_resume.lock().unwrap().as_ref() {
            resume.recv().unwrap();
        }
        *self.verifier.lock().unwrap() = Some(request.pkce_verifier.to_string());
        Ok(McpOAuthCredential {
            runtime_secret: SecretValue::new(b"access-token".to_vec()),
            lifecycle_secret: SecretValue::new(b"refresh-token".to_vec()),
        })
    }

    fn refresh(
        &self,
        _: &McpOAuthTarget,
        request: McpOAuthRefreshRequest<'_>,
    ) -> Result<McpOAuthCredentialReplacement, McpOAuthError> {
        assert_eq!(request.credential.expose(), b"refresh-token");
        assert_eq!(request.resource.as_str(), "https://mcp.example.test/rpc");
        *self.refreshes.lock().unwrap() += 1;
        Ok(McpOAuthCredentialReplacement {
            runtime_secret: SecretValue::new(b"refreshed-access-token".to_vec()),
            lifecycle_secret: SecretValue::new(b"refreshed-refresh-token".to_vec()),
        })
    }

    fn revoke(
        &self,
        _: &McpOAuthTarget,
        request: McpOAuthRevokeRequest<'_>,
    ) -> Result<(), McpOAuthError> {
        assert!(matches!(
            request.credential.expose(),
            b"refresh-token" | b"refreshed-refresh-token"
        ));
        assert_eq!(request.resource.as_str(), "https://mcp.example.test/rpc");
        *self.revocations.lock().unwrap() += 1;
        if *self.fail_revocation.lock().unwrap() {
            return Err(McpOAuthError::new(
                McpOAuthErrorKind::ProviderFailure,
                "redacted provider failure",
            ));
        }
        Ok(())
    }
}

fn config(endpoint: &str) -> McpServerConfig {
    McpServerConfig {
        id: McpServerId::new("user:mcp:calendar").unwrap(),
        display_name: "Calendar".into(),
        transport: McpTransportConfig::StreamableHttp {
            url: endpoint.into(),
        },
        credential: McpCredentialBinding::Reference {
            credential_ref: "user:credential:mcp-calendar".into(),
        },
        enablement: McpServerEnablement::Enabled,
    }
}

fn fixture() -> (
    McpOAuthService,
    McpOAuthTarget,
    Arc<MemorySecretStore>,
    Arc<TestProvider>,
) {
    let target = McpOAuthTarget::from_config(&config("https://mcp.example.test/rpc")).unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let provider = Arc::new(TestProvider::default());
    let provider_port: Arc<dyn McpOAuthProvider> = provider.clone();
    let oauth = McpOAuthService::new(
        secrets.clone(),
        [(target.server_id().clone(), provider_port)],
    );
    (oauth, target, secrets, provider)
}

fn callback_state(authorization_url: &str) -> SecretValue {
    let url = Url::parse(authorization_url).unwrap();
    let state = url
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
        .unwrap();
    SecretValue::new(state.into_bytes())
}

#[test]
fn oauth_pkce_callback_stores_an_envelope_but_projects_only_the_runtime_token() {
    let (oauth, target, secrets, provider) = fixture();
    let authorization = oauth
        .start(McpOAuthStartRequest {
            owner: 0,
            options: Default::default(),
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    assert_eq!(
        oauth.pending_server_id(&authorization.flow_id),
        Some(target.server_id().clone())
    );
    let state = callback_state(&authorization.authorization_url);
    oauth
        .complete(McpOAuthCompleteRequest {
            owner: 0,
            issuer: None,
            flow_id: authorization.flow_id,
            state,
            authorization_code: SecretValue::new(b"authorization-code".to_vec()),
            current_target: target.clone(),
        })
        .unwrap();

    let stored = secrets.load(target.credential_key()).unwrap().unwrap();
    assert_ne!(stored.expose(), b"access-token");
    assert_eq!(
        project_runtime_credential(stored).unwrap().expose(),
        b"access-token"
    );
    assert_eq!(
        provider.verifier.lock().unwrap().as_ref().unwrap().len(),
        43
    );
}

#[test]
fn callback_rejects_a_target_changed_while_the_browser_flow_was_open() {
    let (oauth, target, secrets, _) = fixture();
    let authorization = oauth
        .start(McpOAuthStartRequest {
            owner: 0,
            options: Default::default(),
            target,
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    let state = callback_state(&authorization.authorization_url);
    let changed = McpOAuthTarget::from_config(&config("https://mcp.example.test/changed")).unwrap();
    let error = oauth
        .complete(McpOAuthCompleteRequest {
            owner: 0,
            issuer: None,
            flow_id: authorization.flow_id,
            state,
            authorization_code: SecretValue::new(b"authorization-code".to_vec()),
            current_target: changed.clone(),
        })
        .unwrap_err();

    assert_eq!(error.kind(), McpOAuthErrorKind::InvalidRequest);
    assert!(secrets.load(changed.credential_key()).unwrap().is_none());
}

#[test]
fn refresh_rotates_both_credential_parts_and_revoke_deletes_the_envelope() {
    let (oauth, target, secrets, provider) = fixture();
    let authorization = oauth
        .start(McpOAuthStartRequest {
            owner: 0,
            options: Default::default(),
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    let state = callback_state(&authorization.authorization_url);
    oauth
        .complete(McpOAuthCompleteRequest {
            owner: 0,
            issuer: None,
            flow_id: authorization.flow_id,
            state,
            authorization_code: SecretValue::new(b"authorization-code".to_vec()),
            current_target: target.clone(),
        })
        .unwrap();

    oauth.refresh(&target).unwrap();
    let stored = secrets.load(target.credential_key()).unwrap().unwrap();
    assert_eq!(
        project_runtime_credential(stored).unwrap().expose(),
        b"refreshed-access-token"
    );
    assert_eq!(*provider.refreshes.lock().unwrap(), 1);

    assert_eq!(oauth.revoke(&target).unwrap(), DeleteSecretOutcome::Deleted);
    assert!(secrets.load(target.credential_key()).unwrap().is_none());
    assert_eq!(*provider.revocations.lock().unwrap(), 1);
}

#[test]
fn raw_bearer_credentials_remain_backward_compatible() {
    let credential = SecretValue::new(b"existing-bearer".to_vec());
    assert_eq!(
        project_runtime_credential(credential).unwrap().expose(),
        b"existing-bearer"
    );
}

#[test]
fn failed_remote_revoke_keeps_the_local_lifecycle_credential_for_retry() {
    let (oauth, target, secrets, provider) = fixture();
    let authorization = oauth
        .start(McpOAuthStartRequest {
            owner: 0,
            options: Default::default(),
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    let state = callback_state(&authorization.authorization_url);
    oauth
        .complete(McpOAuthCompleteRequest {
            owner: 0,
            issuer: None,
            flow_id: authorization.flow_id,
            state,
            authorization_code: SecretValue::new(b"authorization-code".to_vec()),
            current_target: target.clone(),
        })
        .unwrap();
    *provider.fail_revocation.lock().unwrap() = true;

    let error = oauth.revoke(&target).unwrap_err();
    assert_eq!(error.kind(), McpOAuthErrorKind::ProviderFailure);
    assert!(secrets.load(target.credential_key()).unwrap().is_some());
}

#[test]
fn expired_flow_keeps_its_target_available_for_typed_callback_expiry() {
    let (oauth, target, _, _) = fixture();
    let authorization = oauth
        .start(McpOAuthStartRequest {
            owner: 0,
            options: Default::default(),
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    let state = callback_state(&authorization.authorization_url);
    oauth
        .pending
        .lock()
        .unwrap()
        .get_mut(&authorization.flow_id)
        .unwrap()
        .started_at = Instant::now() - FLOW_LIFETIME - Duration::from_secs(1);

    assert_eq!(
        oauth.pending_server_id(&authorization.flow_id),
        Some(target.server_id().clone())
    );
    let error = oauth
        .complete(McpOAuthCompleteRequest {
            owner: 0,
            issuer: None,
            flow_id: authorization.flow_id,
            state,
            authorization_code: SecretValue::new(b"authorization-code".to_vec()),
            current_target: target,
        })
        .unwrap_err();
    assert_eq!(error.kind(), McpOAuthErrorKind::Expired);
}

#[test]
fn pending_oauth_flows_are_bounded() {
    let (oauth, target, _, _) = fixture();
    for _ in 0..MAX_PENDING_OAUTH_FLOWS {
        oauth
            .start(McpOAuthStartRequest {
                owner: 0,
                options: Default::default(),
                target: target.clone(),
                redirect_uri: "http://127.0.0.1:49152/callback".into(),
            })
            .unwrap();
    }

    let error = oauth
        .start(McpOAuthStartRequest {
            owner: 0,
            options: Default::default(),
            target,
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap_err();
    assert_eq!(error.kind(), McpOAuthErrorKind::ProviderFailure);
}

#[test]
fn logout_invalidates_pending_callbacks_and_old_transports_and_is_idempotent() {
    let (oauth, target, secrets, _) = fixture();
    let oauth = Arc::new(oauth);
    let first = oauth
        .start(McpOAuthStartRequest {
            owner: 0,
            options: Default::default(),
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    let state = callback_state(&first.authorization_url);
    oauth
        .complete(McpOAuthCompleteRequest {
            owner: 0,
            issuer: None,
            flow_id: first.flow_id,
            state,
            authorization_code: SecretValue::new(b"authorization-code".to_vec()),
            current_target: target.clone(),
        })
        .unwrap();
    let transport = oauth.authorization(target.clone()).unwrap();
    assert_eq!(transport.bearer(None).unwrap(), "access-token");
    let pending = oauth
        .start(McpOAuthStartRequest {
            owner: 0,
            options: Default::default(),
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    let state = callback_state(&pending.authorization_url);
    oauth.logout(&target).unwrap();
    oauth.logout(&target).unwrap();
    assert!(transport.bearer(None).is_err());
    assert!(
        oauth
            .complete(McpOAuthCompleteRequest {
                owner: 0,
                issuer: None,
                flow_id: pending.flow_id,
                state,
                authorization_code: SecretValue::new(b"authorization-code".to_vec()),
                current_target: target.clone()
            })
            .is_err()
    );
    assert!(secrets.load(target.credential_key()).unwrap().is_none());
}

#[test]
fn rejected_bearer_refreshes_once_and_other_requests_adopt_the_winner() {
    let (oauth, target, _, provider) = fixture();
    let oauth = Arc::new(oauth);
    let started = oauth
        .start(McpOAuthStartRequest {
            owner: 0,
            options: Default::default(),
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    let state = callback_state(&started.authorization_url);
    oauth
        .complete(McpOAuthCompleteRequest {
            owner: 0,
            issuer: None,
            flow_id: started.flow_id,
            state,
            authorization_code: SecretValue::new(b"authorization-code".to_vec()),
            current_target: target.clone(),
        })
        .unwrap();
    let transport = oauth.authorization(target).unwrap();
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let transport = Arc::clone(&transport);
            scope.spawn(move || {
                assert_eq!(
                    transport.bearer(Some("access-token")).unwrap(),
                    "refreshed-access-token"
                )
            });
        }
    });
    assert_eq!(*provider.refreshes.lock().unwrap(), 1);
}

#[test]
fn another_runtime_logout_invalidates_a_callback_even_when_its_pending_map_is_separate() {
    let (oauth, target, secrets, provider) = fixture();
    let second = McpOAuthService::new(
        secrets.clone(),
        [(
            target.server_id().clone(),
            provider as Arc<dyn McpOAuthProvider>,
        )],
    );
    let started = oauth
        .start(McpOAuthStartRequest {
            owner: 0,
            options: Default::default(),
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    let state = callback_state(&started.authorization_url);
    second.logout(&target).unwrap();
    assert!(
        oauth
            .complete(McpOAuthCompleteRequest {
                owner: 0,
                issuer: None,
                flow_id: started.flow_id,
                state,
                authorization_code: SecretValue::new(b"authorization-code".to_vec()),
                current_target: target.clone()
            })
            .is_err()
    );
    assert!(secrets.load(target.credential_key()).unwrap().is_none());
}

#[test]
fn logout_waits_for_refresh_persistence_then_removes_the_rotated_token() {
    struct BlockingProvider {
        inner: TestProvider,
        entered: std::sync::mpsc::SyncSender<()>,
        resume: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl McpOAuthProvider for BlockingProvider {
        fn authorization_url(
            &self,
            target: &McpOAuthTarget,
            challenge: McpOAuthChallenge<'_>,
        ) -> Result<String, McpOAuthError> {
            self.inner.authorization_url(target, challenge)
        }
        fn exchange(
            &self,
            target: &McpOAuthTarget,
            request: McpOAuthExchangeRequest<'_>,
        ) -> Result<McpOAuthCredential, McpOAuthError> {
            self.inner.exchange(target, request)
        }
        fn refresh(
            &self,
            target: &McpOAuthTarget,
            request: McpOAuthRefreshRequest<'_>,
        ) -> Result<McpOAuthCredentialReplacement, McpOAuthError> {
            self.entered.send(()).unwrap();
            self.resume.lock().unwrap().recv().unwrap();
            self.inner.refresh(target, request)
        }
        fn revoke(
            &self,
            target: &McpOAuthTarget,
            request: McpOAuthRevokeRequest<'_>,
        ) -> Result<(), McpOAuthError> {
            self.inner.revoke(target, request)
        }
    }
    let (_, target, secrets, _) = fixture();
    let (entered, entered_receiver) = std::sync::mpsc::sync_channel(1);
    let (resume, resume_receiver) = std::sync::mpsc::sync_channel(1);
    let provider = Arc::new(BlockingProvider {
        inner: TestProvider::default(),
        entered,
        resume: Mutex::new(resume_receiver),
    });
    let oauth = Arc::new(McpOAuthService::new(
        secrets.clone(),
        [(
            target.server_id().clone(),
            provider as Arc<dyn McpOAuthProvider>,
        )],
    ));
    let started = oauth
        .start(McpOAuthStartRequest {
            owner: 0,
            options: Default::default(),
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    let state = callback_state(&started.authorization_url);
    oauth
        .complete(McpOAuthCompleteRequest {
            owner: 0,
            issuer: None,
            flow_id: started.flow_id,
            state,
            authorization_code: SecretValue::new(b"authorization-code".to_vec()),
            current_target: target.clone(),
        })
        .unwrap();
    std::thread::scope(|scope| {
        let refresh = scope.spawn(|| oauth.refresh(&target).unwrap());
        entered_receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        let logout = scope.spawn(|| oauth.logout(&target).unwrap());
        resume.send(()).unwrap();
        refresh.join().unwrap();
        logout.join().unwrap();
    });
    assert!(secrets.load(target.credential_key()).unwrap().is_none());
}

#[test]
fn cancelling_during_code_exchange_prevents_the_late_credential_commit() {
    let (oauth, target, secrets, provider) = fixture();
    let (entered, entered_receiver) = std::sync::mpsc::sync_channel(1);
    let (resume, resume_receiver) = std::sync::mpsc::sync_channel(1);
    *provider.exchange_entered.lock().unwrap() = Some(entered);
    *provider.exchange_resume.lock().unwrap() = Some(resume_receiver);
    let started = oauth
        .start(McpOAuthStartRequest {
            owner: 7,
            options: Default::default(),
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    let state = callback_state(&started.authorization_url);
    std::thread::scope(|scope| {
        let flow = started.flow_id.clone();
        let completing = scope.spawn(|| {
            oauth.complete(McpOAuthCompleteRequest {
                owner: 7,
                issuer: None,
                flow_id: started.flow_id,
                state,
                authorization_code: SecretValue::new(b"authorization-code".to_vec()),
                current_target: target.clone(),
            })
        });
        entered_receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        oauth.cancel(&flow, 7);
        resume.send(()).unwrap();
        assert!(completing.join().unwrap().is_err());
    });
    assert!(secrets.load(target.credential_key()).unwrap().is_none());
}

#[test]
fn a_failed_local_delete_keeps_the_credential_closed_after_runtime_restart() {
    struct DeleteFails(Arc<MemorySecretStore>);
    impl SecretStore for DeleteFails {
        fn load(
            &self,
            key: &ash_secrets::SecretKey,
        ) -> Result<Option<SecretValue>, ash_secrets::SecretStoreError> {
            self.0.load(key)
        }
        fn store(
            &self,
            key: &ash_secrets::SecretKey,
            value: &SecretValue,
        ) -> Result<(), ash_secrets::SecretStoreError> {
            self.0.store(key, value)
        }
        fn delete(
            &self,
            _: &ash_secrets::SecretKey,
        ) -> Result<ash_secrets::DeleteSecretOutcome, ash_secrets::SecretStoreError> {
            Err(ash_secrets::SecretStoreError::new(
                ash_secrets::SecretStoreErrorKind::BackendUnavailable,
                "fixture deletion unavailable",
            ))
        }
    }
    let (_, target, secrets, provider) = fixture();
    secrets
        .store(
            target.credential_key(),
            &encode_oauth_credential(
                SecretValue::new(b"access".to_vec()),
                SecretValue::new(b"refresh".to_vec()),
            )
            .unwrap(),
        )
        .unwrap();
    let store: Arc<dyn SecretStore> = Arc::new(DeleteFails(secrets.clone()));
    let provider: Arc<dyn McpOAuthProvider> = provider;
    let oauth = Arc::new(McpOAuthService::new(
        store.clone(),
        [(target.server_id().clone(), provider.clone())],
    ));
    assert!(oauth.logout(&target).is_err());
    assert!(secrets.load(target.credential_key()).unwrap().is_some());
    let restarted = Arc::new(McpOAuthService::new(
        store,
        [(target.server_id().clone(), provider)],
    ));
    assert!(restarted.authorization(target).is_err());
}

#[test]
fn failed_login_persistence_does_not_reactivate_an_old_credential_after_restart() {
    struct CredentialWriteFails {
        inner: Arc<MemorySecretStore>,
        credential_key: ash_secrets::SecretKey,
    }
    impl SecretStore for CredentialWriteFails {
        fn load(
            &self,
            key: &ash_secrets::SecretKey,
        ) -> Result<Option<SecretValue>, ash_secrets::SecretStoreError> {
            self.inner.load(key)
        }
        fn store(
            &self,
            key: &ash_secrets::SecretKey,
            value: &SecretValue,
        ) -> Result<(), ash_secrets::SecretStoreError> {
            if key == &self.credential_key {
                return Err(ash_secrets::SecretStoreError::new(
                    ash_secrets::SecretStoreErrorKind::BackendUnavailable,
                    "fixture write unavailable",
                ));
            }
            self.inner.store(key, value)
        }
        fn delete(
            &self,
            key: &ash_secrets::SecretKey,
        ) -> Result<ash_secrets::DeleteSecretOutcome, ash_secrets::SecretStoreError> {
            self.inner.delete(key)
        }
    }
    let (_, target, secrets, provider) = fixture();
    secrets
        .store(
            target.credential_key(),
            &encode_oauth_credential(
                SecretValue::new(b"old-access".to_vec()),
                SecretValue::new(b"old-refresh".to_vec()),
            )
            .unwrap(),
        )
        .unwrap();
    let store: Arc<dyn SecretStore> = Arc::new(CredentialWriteFails {
        inner: secrets.clone(),
        credential_key: target.credential_key().clone(),
    });
    let provider: Arc<dyn McpOAuthProvider> = provider;
    let oauth = McpOAuthService::new(
        store.clone(),
        [(target.server_id().clone(), provider.clone())],
    );
    let started = oauth
        .start(McpOAuthStartRequest {
            owner: 0,
            options: Default::default(),
            target: target.clone(),
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        })
        .unwrap();
    assert!(
        oauth
            .complete(McpOAuthCompleteRequest {
                owner: 0,
                issuer: None,
                state: callback_state(&started.authorization_url),
                flow_id: started.flow_id,
                authorization_code: SecretValue::new(b"authorization-code".to_vec()),
                current_target: target.clone()
            })
            .is_err()
    );
    assert_eq!(
        project_runtime_credential(secrets.load(target.credential_key()).unwrap().unwrap())
            .unwrap()
            .expose(),
        b"old-access"
    );
    let restarted = Arc::new(McpOAuthService::new(
        store,
        [(target.server_id().clone(), provider)],
    ));
    assert!(restarted.authorization(target).is_err());
}
