use std::collections::BTreeSet;
use std::fmt;
use std::net::SocketAddr;
use std::path::Path;
use std::path::PathBuf;

/// Runtime configuration for one authenticated remote collaboration host.
#[derive(Clone)]
pub struct CollaborationServerOptions {
    listen_address: SocketAddr,
    database_path: PathBuf,
    bearer_token: String,
    allowed_origins: BTreeSet<String>,
    maximum_connections: usize,
    pub(crate) media_service: Option<std::sync::Arc<livekit_api::MediaService>>,
}

impl CollaborationServerOptions {
    pub fn new(
        listen_address: SocketAddr,
        database_path: impl Into<PathBuf>,
        bearer_token: impl Into<String>,
    ) -> Self {
        Self {
            listen_address,
            database_path: database_path.into(),
            bearer_token: bearer_token.into(),
            allowed_origins: BTreeSet::new(),
            maximum_connections: 64,
            media_service: None,
        }
    }

    pub fn with_allowed_origin(mut self, origin: impl Into<String>) -> Self {
        self.allowed_origins.insert(origin.into());
        self
    }

    /// Supplies an explicitly configured media deployment. Credentials stay in the server.
    pub fn with_media_service(mut self, service: livekit_api::MediaService) -> Self {
        self.media_service = Some(std::sync::Arc::new(service));
        self
    }

    pub fn with_maximum_connections(mut self, maximum: usize) -> Self {
        self.maximum_connections = maximum;
        self
    }

    pub fn listen_address(&self) -> SocketAddr {
        self.listen_address
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub(crate) fn bearer_token(&self) -> &str {
        &self.bearer_token
    }

    pub(crate) fn allowed_origins(&self) -> &BTreeSet<String> {
        &self.allowed_origins
    }

    pub(crate) fn maximum_connections(&self) -> usize {
        self.maximum_connections
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.database_path.as_os_str().is_empty() {
            return Err("Collaboration database path must not be empty".into());
        }
        if self.bearer_token.len() < 32
            || !self
                .bearer_token
                .bytes()
                .all(|byte| byte.is_ascii_graphic())
        {
            return Err(
                "Collaboration bearer token must contain at least 32 visible ASCII bytes".into(),
            );
        }
        if self.maximum_connections == 0 {
            return Err("Maximum collaboration connections must be greater than zero".into());
        }
        if self
            .allowed_origins
            .iter()
            .any(|origin| origin.is_empty() || !origin.is_ascii())
        {
            return Err("Allowed collaboration origins must be non-empty ASCII values".into());
        }
        Ok(())
    }
}

impl fmt::Debug for CollaborationServerOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CollaborationServerOptions")
            .field("listen_address", &self.listen_address)
            .field("database_path", &self.database_path)
            .field("bearer_token", &"[redacted]")
            .field("allowed_origins", &self.allowed_origins)
            .field("maximum_connections", &self.maximum_connections)
            .finish()
    }
}
