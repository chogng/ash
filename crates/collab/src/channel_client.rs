//! Outbound channel client and the local user's saved connection. The remote store owns all channels.
use crate::channels::*;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::OutboundNetworkPolicy;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::RedirectPolicy;
use ash_http_client::ReqwestHttpClient;
use ash_http_client::Timeout;
use ash_http_client::TransportTimeouts;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use ash_secrets::UnavailableSecretStore;
use serde::Deserialize;
use serde::Serialize;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

struct ChannelClient {
    url: String,
    credential: ChannelCredential,
    http: Arc<dyn HttpClient>,
}
impl ChannelClient {
    fn new(
        url: &str,
        credential: ChannelCredential,
        http: Arc<dyn HttpClient>,
    ) -> Result<Self, ChannelError> {
        let parsed = url::Url::parse(url).map_err(|_| ChannelError::Invalid)?;
        let loopback = match parsed.host() {
            Some(url::Host::Domain("localhost")) => true,
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
        if parsed.host().is_none()
            || !matches!(parsed.scheme(), "http" | "https")
            || (parsed.scheme() == "http" && !loopback)
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.path() != "/"
        {
            return Err(ChannelError::Invalid);
        }
        Ok(Self {
            url: parsed.as_str().trim_end_matches('/').into(),
            credential,
            http,
        })
    }
    fn read(&self) -> Result<ChannelSnapshot, ChannelError> {
        self.snapshot("read", self.credential.expose(), None)
    }
    fn create(
        &self,
        administrator: &str,
        name: &str,
        member_name: &str,
    ) -> Result<ChannelSnapshot, ChannelError> {
        self.snapshot(
            "create",
            administrator,
            Some(
                serde_json::to_value(ChannelCreate {
                    name: name.into(),
                    member_name: member_name.into(),
                    credential: self.credential.expose().into(),
                })
                .map_err(|_| ChannelError::Invalid)?,
            ),
        )
    }
    fn edit(&self, edit: ChannelEditParams) -> Result<ChannelSnapshot, ChannelError> {
        self.snapshot(
            "edit",
            self.credential.expose(),
            Some(serde_json::to_value(edit).map_err(|_| ChannelError::Invalid)?),
        )
    }
    fn invite(&self, invite: ChannelInvite) -> Result<ChannelSnapshot, ChannelError> {
        self.snapshot(
            "invite",
            self.credential.expose(),
            Some(serde_json::to_value(invite).map_err(|_| ChannelError::Invalid)?),
        )
    }
    fn snapshot(
        &self,
        action: &str,
        token: &str,
        body: Option<serde_json::Value>,
    ) -> Result<ChannelSnapshot, ChannelError> {
        let snapshot = self.request(action, token, body)?;
        crate::channels::validate_snapshot(&snapshot).map_err(|_| ChannelError::Transport)?;
        Ok(snapshot)
    }
    fn request<T: serde::de::DeserializeOwned>(
        &self,
        action: &str,
        token: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T, ChannelError> {
        let request = HttpRequest::new(
            if body.is_some() {
                HttpMethod::Post
            } else {
                HttpMethod::Get
            },
            format!("{}/v1/channels/{action}", self.url),
            vec![
                HttpHeader::new("Authorization", format!("Bearer {token}")),
                HttpHeader::new("Content-Type", "application/json"),
            ],
            body.map(|b| serde_json::to_vec(&b))
                .transpose()
                .map_err(|_| ChannelError::Invalid)?
                .unwrap_or_default(),
        )
        .map_err(|_| ChannelError::Invalid)?;
        let response = self
            .http
            .execute(&request)
            .map_err(|_| ChannelError::Transport)?;
        match response.status() {
            200 => serde_json::from_slice(response.body()).map_err(|_| ChannelError::Transport),
            400 => Err(ChannelError::Invalid),
            401 | 403 => Err(ChannelError::Denied),
            409 => Err(ChannelError::Conflict),
            500 => Err(ChannelError::Storage),
            _ => Err(ChannelError::Transport),
        }
    }
}

/// One saved identity per local Ash profile, shared by its windows. Secrets use the configured
/// secret facility; neither bootstrap credentials nor member tokens enter ordinary settings.
pub struct ChannelAccount {
    store: Arc<dyn SecretStore>,
    network: OutboundNetworkPolicy,
    operations: Mutex<()>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SavedConnection {
    url: String,
    credential: String,
}
impl Default for ChannelAccount {
    fn default() -> Self {
        Self {
            store: Arc::new(UnavailableSecretStore),
            network: OutboundNetworkPolicy::default(),
            operations: Mutex::new(()),
        }
    }
}
impl ChannelAccount {
    pub fn set_secret_store(&mut self, store: Arc<dyn SecretStore>) {
        self.store = store;
    }
    pub fn set_network_policy(&mut self, policy: OutboundNetworkPolicy) {
        self.network = policy;
    }
    pub fn read(&self) -> Result<Option<ChannelConnection>, ChannelError> {
        let _operation = self.operations.lock().map_err(|_| ChannelError::Storage)?;
        let Some(client) = self.load()? else {
            return Ok(None);
        };
        Ok(Some(ChannelConnection {
            server_url: client.url.clone(),
            snapshot: client.read()?,
        }))
    }
    pub fn connect(&self, params: ChannelConnectParams) -> Result<ChannelConnection, ChannelError> {
        let _operation = self.operations.lock().map_err(|_| ChannelError::Storage)?;
        let client = match params {
            ChannelConnectParams::Join {
                server_url,
                credential,
            } => self.client(&server_url, ChannelCredential::parse(credential)?)?,
            ChannelConnectParams::Create {
                server_url,
                administrator,
                name,
                member_name,
            } => {
                crate::channels::validate_name(&name)?;
                crate::channels::validate_name(&member_name)?;
                let client = self.client(&server_url, ChannelCredential::generate()?)?;
                // Save before sending so a lost create response can be recovered by Refresh after restart.
                // A definitive rejection restores the previous account; an uncertain network outcome does not replay writes.
                let previous = self.store.load(&key()).map_err(|_| ChannelError::Storage)?;
                self.save(&client)?;
                if let Err(error) = client.create(&administrator, &name, &member_name) {
                    if error != ChannelError::Transport {
                        if let Some(previous) = previous {
                            self.store
                                .store(&key(), &previous)
                                .map_err(|_| ChannelError::Storage)?;
                        } else {
                            self.store
                                .delete(&key())
                                .map_err(|_| ChannelError::Storage)?;
                        }
                    }
                    return Err(error);
                }
                client
            }
        };
        let snapshot = client.read()?;
        self.save(&client)?;
        Ok(ChannelConnection {
            server_url: client.url,
            snapshot,
        })
    }
    pub fn edit(&self, params: ChannelEditParams) -> Result<ChannelConnection, ChannelError> {
        let _operation = self.operations.lock().map_err(|_| ChannelError::Storage)?;
        let client = self.load()?.ok_or(ChannelError::Denied)?;
        let snapshot = client.edit(params)?;
        Ok(ChannelConnection {
            server_url: client.url,
            snapshot,
        })
    }
    pub fn invite(&self, params: ChannelInviteParams) -> Result<ChannelInvitation, ChannelError> {
        let _operation = self.operations.lock().map_err(|_| ChannelError::Storage)?;
        let client = self.load()?.ok_or(ChannelError::Denied)?;
        let credential = ChannelCredential::generate()?;
        client.invite(ChannelInvite {
            params,
            credential: credential.expose().into(),
        })?;
        Ok(ChannelInvitation {
            server_url: client.url,
            credential: credential.expose().into(),
        })
    }
    /// Explicit backup for reconnecting as the same member; regular snapshots never expose it.
    pub fn sign_in_key(&self) -> Result<ChannelInvitation, ChannelError> {
        let _operation = self.operations.lock().map_err(|_| ChannelError::Storage)?;
        let client = self.load()?.ok_or(ChannelError::Denied)?;
        client.read()?;
        Ok(ChannelInvitation {
            server_url: client.url,
            credential: client.credential.expose().into(),
        })
    }

    pub fn resource(
        &self,
        params: ChannelResourceParams,
        kind: ChannelResourceKind,
    ) -> Result<ChannelResourceAccess, ChannelError> {
        let _operation = self.operations.lock().map_err(|_| ChannelError::Storage)?;
        let client = self.load()?.ok_or(ChannelError::Denied)?;
        let action = match kind {
            ChannelResourceKind::Notes => "notes",
            ChannelResourceKind::Call => "call",
        };
        let expected_resource = format!("{}{}", kind.prefix(), params.channel_id);
        let mut result: ChannelResourceAccess = client.request(
            action,
            client.credential.expose(),
            Some(serde_json::to_value(params).map_err(|_| ChannelError::Invalid)?),
        )?;
        ChannelCredential::parse(result.credential.clone()).map_err(|_| ChannelError::Transport)?;
        if result.resource_id != expected_resource {
            return Err(ChannelError::Transport);
        }
        result.server_url = client.url;
        Ok(result)
    }

    pub fn disconnect(&self) -> Result<(), ChannelError> {
        let _operation = self.operations.lock().map_err(|_| ChannelError::Storage)?;
        self.store
            .delete(&key())
            .map_err(|_| ChannelError::Storage)?;
        Ok(())
    }
    fn load(&self) -> Result<Option<ChannelClient>, ChannelError> {
        self.store
            .load(&key())
            .map_err(|_| ChannelError::Storage)?
            .map(|value| {
                let saved: SavedConnection =
                    serde_json::from_slice(value.expose()).map_err(|_| ChannelError::Storage)?;
                self.client(&saved.url, ChannelCredential::parse(saved.credential)?)
            })
            .transpose()
    }
    fn save(&self, client: &ChannelClient) -> Result<(), ChannelError> {
        let bytes = serde_json::to_vec(&SavedConnection {
            url: client.url.clone(),
            credential: client.credential.expose().into(),
        })
        .map_err(|_| ChannelError::Storage)?;
        self.store
            .store(&key(), &SecretValue::new(bytes))
            .map_err(|_| ChannelError::Storage)
    }
    fn client(
        &self,
        url: &str,
        credential: ChannelCredential,
    ) -> Result<ChannelClient, ChannelError> {
        let timeout = Timeout::After(Duration::from_secs(10));
        let config = HttpClientConfig::default()
            .with_redirect_policy(RedirectPolicy::Reject)
            .with_timeouts(TransportTimeouts::new(
                timeout,
                timeout,
                Timeout::Disabled,
                timeout,
            ));
        let network = OutboundNetworkSnapshot::with_policy(config, self.network.clone())
            .map_err(|_| ChannelError::Transport)?;
        let http = ReqwestHttpClient::with_network(network).map_err(|_| ChannelError::Transport)?;
        ChannelClient::new(url, credential, Arc::new(http))
    }
}
fn key() -> SecretKey {
    SecretKey::new("collaboration.channels.account.v1").expect("fixed secret key")
}
