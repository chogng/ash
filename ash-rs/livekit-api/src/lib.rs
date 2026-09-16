//! LiveKit administration and short-lived participant credentials. No media SDK dependency.

use ash_secrets::SecretValue;
use livekit_sdk_api::access_token::AccessToken;
use livekit_sdk_api::access_token::VideoGrants;
use livekit_sdk_api::services::room::CreateRoomOptions;
use livekit_sdk_api::services::room::RoomClient;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use url::Url;

pub const JOIN_TOKEN_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("invalid LiveKit configuration")]
    Configuration,
    #[error("invalid room or participant identity")]
    Identity,
    #[error("LiveKit administrative request failed")]
    Request,
    #[error("could not issue LiveKit join credential")]
    Token,
}

/// Explicit room-scoped grants. Administration is never granted to room clients.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MediaPermissions {
    pub microphone: bool,
    pub screen: bool,
    pub subscribe: bool,
}

/// A credential is intentionally not Debug, Clone or Serialize; the transport owner exposes it.
pub struct JoinCredential {
    pub server_url: String,
    pub participant_id: String,
    pub expires_at: u64,
    token: SecretValue,
}

impl JoinCredential {
    pub fn token(&self) -> &str {
        std::str::from_utf8(self.token.expose()).expect("JWT is ASCII")
    }
}

pub struct MediaService {
    server_url: String,
    api_key: String,
    secret: SecretValue,
    client: RoomClient,
}

impl MediaService {
    /// The owning domain resolves credentials before constructing this API adapter.
    pub fn new(
        server_url: &str,
        api_url: &str,
        api_key: String,
        secret: SecretValue,
    ) -> Result<Self, ServiceError> {
        validate_url(server_url, &["ws", "wss"])?;
        validate_url(api_url, &["http", "https"])?;
        let value =
            std::str::from_utf8(secret.expose()).map_err(|_| ServiceError::Configuration)?;
        if api_key.is_empty() || value.len() < 32 {
            return Err(ServiceError::Configuration);
        }
        let client = RoomClient::with_api_key(api_url, &api_key, value)
            .with_failover(false)
            .with_request_timeout(Duration::from_secs(10));
        Ok(Self {
            server_url: server_url.into(),
            api_key,
            secret,
            client,
        })
    }

    pub async fn create_room(&self, room: &str) -> Result<(), ServiceError> {
        validate_identity(room)?;
        self.client
            .create_room(
                room,
                CreateRoomOptions {
                    max_participants: 64,
                    empty_timeout: 60,
                    departure_timeout: 20,
                    ..Default::default()
                },
            )
            .await
            .map_err(|_| ServiceError::Request)?;
        Ok(())
    }

    /// Deleting a room disconnects its clients. Old JWTs are not thereby revoked on self-hosting.
    pub async fn delete_room(&self, room: &str) -> Result<(), ServiceError> {
        validate_identity(room)?;
        match self.client.delete_room(room).await {
            Ok(()) => Ok(()),
            Err(livekit_sdk_api::services::ServiceError::Twirp(
                livekit_sdk_api::services::ServerError::Twirp(error),
            )) if error.code == livekit_sdk_api::services::ServerErrorCode::NOT_FOUND => Ok(()),
            Err(_) => Err(ServiceError::Request),
        }
    }

    pub fn issue_join(
        &self,
        room: &str,
        participant: &str,
        permissions: MediaPermissions,
    ) -> Result<JoinCredential, ServiceError> {
        validate_identity(room)?;
        validate_identity(participant)?;
        let secret =
            std::str::from_utf8(self.secret.expose()).map_err(|_| ServiceError::Configuration)?;
        let mut sources = Vec::new();
        if permissions.microphone {
            sources.push("microphone".into());
        }
        if permissions.screen {
            sources.push("screen_share".into());
        }
        let token = AccessToken::with_api_key(&self.api_key, secret)
            .with_ttl(JOIN_TOKEN_TTL)
            .with_identity(participant)
            .with_grants(VideoGrants {
                room_join: true,
                room: room.into(),
                can_publish: permissions.microphone || permissions.screen,
                can_subscribe: permissions.subscribe,
                can_publish_data: false,
                can_publish_sources: sources,
                ..Default::default()
            })
            .to_jwt()
            .map_err(|_| ServiceError::Token)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ServiceError::Token)?
            .as_secs();
        Ok(JoinCredential {
            server_url: self.server_url.clone(),
            participant_id: participant.into(),
            expires_at: now + JOIN_TOKEN_TTL.as_secs(),
            token: SecretValue::new(token.into_bytes()),
        })
    }
}

fn validate_identity(value: &str) -> Result<(), ServiceError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(ServiceError::Identity);
    }
    Ok(())
}

fn validate_url(value: &str, schemes: &[&str]) -> Result<(), ServiceError> {
    let url = Url::parse(value).map_err(|_| ServiceError::Configuration)?;
    let loopback = match url.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if !schemes.contains(&url.scheme())
        || (matches!(url.scheme(), "http" | "ws") && !loopback)
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ServiceError::Configuration);
    }
    Ok(())
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
