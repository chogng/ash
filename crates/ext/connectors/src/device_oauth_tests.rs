use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use crate::ConnectorAccountId;
use crate::ConnectorConnectionGeneration;
use crate::ConnectorConnectionState;
use crate::ConnectorDefinition;
use crate::ConnectorId;
use crate::ConnectorRuntimeBinding;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretValue;

use super::*;
use crate::ConnectorAuthority;
use crate::ConnectorOAuthCredential;
use crate::ConnectorOAuthCredentialReplacement;
use crate::ConnectorOAuthRefreshRequest;
use crate::ConnectorOAuthRevokeRequest;

struct TestDeviceProvider {
    polls: Mutex<Vec<ConnectorDeviceOAuthPoll>>,
}

impl ConnectorDeviceOAuthProvider for TestDeviceProvider {
    fn start(
        &self,
        _: &ConnectorDefinition,
    ) -> Result<ConnectorDeviceOAuthGrant, ConnectorOAuthError> {
        Ok(ConnectorDeviceOAuthGrant {
            device_code: SecretValue::new(b"device-code".to_vec()),
            user_code: "ABCD-EFGH".into(),
            verification_uri: "https://github.com/login/device".into(),
            expires_in: Duration::from_secs(60),
            poll_interval: Duration::from_millis(1),
        })
    }

    fn poll(
        &self,
        _: &ConnectorDefinition,
        request: ConnectorDeviceOAuthPollRequest<'_>,
    ) -> Result<ConnectorDeviceOAuthPoll, ConnectorOAuthError> {
        assert_eq!(request.device_code.expose(), b"device-code");
        Ok(self.polls.lock().unwrap().remove(0))
    }

    fn refresh(
        &self,
        _: &ConnectorDefinition,
        _: ConnectorOAuthRefreshRequest,
    ) -> Result<ConnectorOAuthCredentialReplacement, ConnectorOAuthError> {
        Ok(ConnectorOAuthCredentialReplacement {
            runtime_secret: SecretValue::new(b"new-access".to_vec()),
            secret: SecretValue::new(b"new-lifecycle".to_vec()),
        })
    }

    fn revoke(
        &self,
        _: &ConnectorDefinition,
        _: ConnectorOAuthRevokeRequest,
    ) -> Result<(), ConnectorOAuthError> {
        Ok(())
    }

    fn supports_remote_revoke(&self) -> bool {
        true
    }
}

fn fixture(polls: Vec<ConnectorDeviceOAuthPoll>) -> (ConnectorDeviceOAuthService, ConnectorId) {
    let connector_id = ConnectorId::new("acme/github:connector:account").unwrap();
    let definition = ConnectorDefinition::new(
        connector_id.clone(),
        "GitHub",
        "Connect GitHub.",
        ConnectorRuntimeBinding::mcp_server("plugin:acme/github:mcp:github").unwrap(),
    )
    .unwrap();
    let authority = ConnectorAuthority::in_memory([definition]).unwrap();
    let credentials = Arc::new(ConnectorCredentialService::new(
        authority,
        Arc::new(MemorySecretStore::default()),
    ));
    let provider: Arc<dyn ConnectorDeviceOAuthProvider> = Arc::new(TestDeviceProvider {
        polls: Mutex::new(polls),
    });
    let service = ConnectorDeviceOAuthService::new(credentials, [(connector_id.clone(), provider)]);
    (service, connector_id)
}

fn start(
    service: &ConnectorDeviceOAuthService,
    connector_id: ConnectorId,
) -> ConnectorDeviceOAuthAuthorization {
    service
        .start(ConnectorDeviceOAuthStartRequest {
            command_id: ConnectorCommandId::new("device-command").unwrap(),
            expected_generation: service.credentials.authority().snapshot().generation(),
            connector_id,
            connection_generation: ConnectorConnectionGeneration::new(2),
        })
        .unwrap()
}

#[test]
fn device_poll_obeys_provider_slow_down_and_connects_exact_account() {
    let credential = ConnectorOAuthCredential {
        account_id: ConnectorAccountId::new("42").unwrap(),
        account_display_name: "Octocat".into(),
        runtime_secret: SecretValue::new(b"access-token".to_vec()),
        secret: SecretValue::new(b"lifecycle-bundle".to_vec()),
    };
    let (service, connector_id) = fixture(vec![ConnectorDeviceOAuthPoll::Complete(credential)]);
    let authorization = start(&service, connector_id.clone());
    assert_eq!(authorization.user_code, "ABCD-EFGH");
    assert_eq!(authorization.poll_interval_seconds, 1);

    thread::sleep(Duration::from_millis(2));
    assert!(matches!(
        service.poll(&authorization.flow_id).unwrap(),
        ConnectorDeviceOAuthPollResult::Connected(_)
    ));
    let snapshot = service.credentials.authority().snapshot();
    assert!(matches!(
        snapshot.entry(&connector_id).unwrap().connection().state(),
        ConnectorConnectionState::Connected(account) if account.account_id().as_str() == "42"
    ));
}

#[test]
fn provider_slow_down_increases_the_next_poll_by_five_seconds() {
    let (service, connector_id) = fixture(vec![ConnectorDeviceOAuthPoll::SlowDown]);
    let authorization = start(&service, connector_id);
    thread::sleep(Duration::from_millis(2));
    assert_eq!(
        service.poll(&authorization.flow_id).unwrap(),
        ConnectorDeviceOAuthPollResult::Pending {
            retry_after_seconds: 6,
        }
    );
}

#[test]
fn cancel_removes_device_flow_and_leaves_connector_unavailable() {
    let (service, connector_id) = fixture(Vec::new());
    let authorization = start(&service, connector_id.clone());
    service.cancel(&authorization.flow_id).unwrap();
    assert!(matches!(
        service
            .credentials
            .authority()
            .snapshot()
            .entry(&connector_id)
            .unwrap()
            .connection()
            .state(),
        ConnectorConnectionState::Unavailable { .. }
    ));
}
