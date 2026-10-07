//! External account definitions, connection lifecycle, catalogs, and authentication services.

mod auth;
mod authority;
mod catalog;
mod command;
mod connection;
mod definition;
mod device_oauth;
mod error;
mod github;
mod github_broker;
mod github_device;
mod identity;
mod oauth;
mod snapshot;

pub use connection::ConnectorAccount;
pub use connection::ConnectorConnection;
pub use connection::ConnectorConnectionState;
pub use connection::ConnectorConnectionUpdate;
pub use definition::ConnectorDefinition;
pub use definition::ConnectorDefinitionDigest;
pub use definition::ConnectorRuntimeBinding;
pub use error::ConnectorError;
pub use error::ConnectorErrorKind;
pub use identity::ConnectorAccountId;
pub use identity::ConnectorConnectionGeneration;
pub use identity::ConnectorCredentialRef;
pub use identity::ConnectorId;
pub use identity::ConnectorSnapshotGeneration;
pub use snapshot::ConnectorEntry;
pub use snapshot::ConnectorSnapshot;

pub use auth::ConnectorApiTokenConnectRequest;
pub use auth::ConnectorCredentialCleanup;
pub use auth::ConnectorCredentialService;
pub use auth::ConnectorCredentialServiceError;
pub use auth::ConnectorCredentialServiceErrorKind;
pub use auth::ConnectorDisconnectResult;
pub use auth::project_runtime_credential;
pub use authority::ConnectorAuthority;
pub use authority::ConnectorAuthoritySubscription;
pub use catalog::ConnectorCatalog;
pub use catalog::ConnectorCatalogError;
pub use command::ConnectorAuthorityCommand;
pub use command::ConnectorAuthorityError;
pub use command::ConnectorAuthorityErrorKind;
pub use command::ConnectorCommandDisposition;
pub use command::ConnectorCommandId;
pub use command::ConnectorCommandRequest;
pub use command::ConnectorCommandResult;
pub use device_oauth::ConnectorDeviceOAuthAuthorization;
pub use device_oauth::ConnectorDeviceOAuthGrant;
pub use device_oauth::ConnectorDeviceOAuthPoll;
pub use device_oauth::ConnectorDeviceOAuthPollRequest;
pub use device_oauth::ConnectorDeviceOAuthPollResult;
pub use device_oauth::ConnectorDeviceOAuthProvider;
pub use device_oauth::ConnectorDeviceOAuthService;
pub use device_oauth::ConnectorDeviceOAuthStartRequest;
pub use github::GitHubOAuthConfig;
pub use github::GitHubOAuthProvider;
pub use github_broker::GitHubBrokeredOAuthConfig;
pub use github_broker::GitHubBrokeredOAuthProvider;
pub use github_device::GitHubDeviceOAuthConfig;
pub use github_device::GitHubDeviceOAuthProvider;
pub use oauth::ConnectorOAuthAuthorization;
pub use oauth::ConnectorOAuthChallenge;
pub use oauth::ConnectorOAuthCompleteRequest;
pub use oauth::ConnectorOAuthCredential;
pub use oauth::ConnectorOAuthCredentialReplacement;
pub use oauth::ConnectorOAuthError;
pub use oauth::ConnectorOAuthErrorKind;
pub use oauth::ConnectorOAuthExchangeRequest;
pub use oauth::ConnectorOAuthFlowId;
pub use oauth::ConnectorOAuthProvider;
pub use oauth::ConnectorOAuthRefreshRequest;
pub use oauth::ConnectorOAuthRevokeRequest;
pub use oauth::ConnectorOAuthService;
pub use oauth::ConnectorOAuthStartRequest;

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod catalog_tests;

#[cfg(test)]
#[path = "connector_tests.rs"]
mod connector_tests;

#[cfg(test)]
#[path = "authority_tests.rs"]
mod authority_tests;

#[cfg(test)]
#[path = "auth_tests.rs"]
mod auth_tests;

mod declaration;
pub use declaration::ConnectorDeclaration;
pub use declaration::load_connector_declaration;
