use crate::RemoteConnectionError;
use crate::RemoteConnectionProfileRecord;
use crate::RemoteConnectionProfileStore;
use crate::RemoteConnectionProfileStoreError;
use crate::SshAppServerConnectionOptions;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_remote::RemoteProfile;
use std::path::Path;

/// An exact runtime whose availability and protocol handshake succeeded on this host.
pub struct VerifiedRemoteProfile {
    profile: RemoteProfile,
}

impl VerifiedRemoteProfile {
    fn new(profile: RemoteProfile) -> Self {
        Self { profile }
    }

    fn profile(&self) -> &RemoteProfile {
        &self.profile
    }

    pub fn into_profile(self) -> RemoteProfile {
        self.profile
    }

    pub fn activate(
        &self,
        store: &RemoteConnectionProfileStore,
    ) -> Result<RemoteConnectionProfileRecord, RemoteConnectionProfileStoreError> {
        store.activate(&self.profile)
    }
}

/// Verifies the previous generation before conditionally swapping the shared runtime history.
pub fn rollback_remote_profile(
    store: &RemoteConnectionProfileStore,
    target: &ash_remote::SshTarget,
    ssh_executable: Option<&Path>,
    client_info: ClientInfo,
    capabilities: ClientCapabilities,
) -> Result<RemoteConnectionProfileRecord, RemoteProfileError> {
    let stored = store
        .connection(target)
        .map_err(RemoteProfileError::Store)?
        .ok_or(RemoteProfileError::NoHistory)?;
    let previous = stored
        .previous_profile()
        .ok_or(RemoteProfileError::NoPrevious)?;
    let mut connection = SshAppServerConnectionOptions::new(previous.clone());
    if let Some(ssh_executable) = ssh_executable {
        connection = connection.with_ssh_executable(ssh_executable);
    }
    let verified = connection
        .verify_profile(client_info, capabilities)
        .map_err(RemoteProfileError::Connection)?;
    store
        .rollback_to_verified(&previous, verified.profile())
        .map_err(RemoteProfileError::Store)?
        .ok_or(RemoteProfileError::ConcurrentModification)
}

impl SshAppServerConnectionOptions {
    /// Probes and handshakes without leaving a live connection behind.
    pub fn verify_profile(
        &self,
        client_info: ClientInfo,
        capabilities: ClientCapabilities,
    ) -> Result<VerifiedRemoteProfile, RemoteConnectionError> {
        let (profile, session) = self.connect_verified(client_info, capabilities)?;
        session
            .shutdown()
            .map_err(|error| RemoteConnectionError::transport(error.to_string()))?;
        Ok(profile)
    }

    /// Gives callers both a live session and the exact profile verified by its handshake.
    pub fn connect_verified(
        &self,
        client_info: ClientInfo,
        capabilities: ClientCapabilities,
    ) -> Result<
        (
            VerifiedRemoteProfile,
            ash_app_server_client::AppServerSession,
        ),
        RemoteConnectionError,
    > {
        let probe = self.probe_runtime()?;
        let profile = RemoteProfile::new(
            self.profile().target().clone(),
            probe.resolved_runtime().clone(),
        );
        let mut connection = Self::new(profile.clone());
        // Preserve host transport selection and timeout while freezing the resolved runtime.
        connection = connection.with_ssh_executable(self.ssh_executable());
        connection = connection.with_connect_timeout_seconds(self.connect_timeout_seconds());
        let session = connection.connect(client_info, capabilities)?;
        Ok((VerifiedRemoteProfile::new(profile), session))
    }
}

/// Failures of verified profile transitions, kept distinct from command presentation.
#[derive(Debug)]
pub enum RemoteProfileError {
    Connection(RemoteConnectionError),
    Store(RemoteConnectionProfileStoreError),
    NoHistory,
    NoPrevious,
    ConcurrentModification,
}

impl std::fmt::Display for RemoteProfileError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connection(error) => error.fmt(formatter),
            Self::Store(error) => error.fmt(formatter),
            Self::NoHistory => formatter.write_str("Remote connection profile has no runtime generation to roll back"),
            Self::NoPrevious => formatter.write_str("Remote connection profile has no previous runtime generation"),
            Self::ConcurrentModification => formatter.write_str("Remote runtime generations changed while rollback was being verified; retry rollback"),
        }
    }
}

impl std::error::Error for RemoteProfileError {}
