//! Process-isolated execution contracts for authorized Editor Extension runtimes.
//!
//! This crate owns the Ash-specific host protocol, activation authority gate, bounded restart
//! policy, and process supervisor. It does not implement the VS Code Extension API and it does not
//! discover, install, grant, or select extension packages.

mod authority;
mod error;
mod limits;
mod process;
mod protocol;
mod restart;
mod supervisor;

pub use authority::ActivationAuthority;
pub use authority::ActivationLease;
pub use authority::ExtensionActivationSpec;
pub use error::ExtensionHostError;
pub use limits::ExtensionHostLimits;
pub use limits::HardResourceLimits;
pub use limits::ProcessIsolationPolicy;
pub use process::ExtensionHostLauncher;
pub use process::ExtensionHostProcess;
pub use process::ExtensionLaunchCommand;
pub use process::PendingHostRequest;
pub use process::TrustedDevelopmentLauncher;
pub use protocol::ActivateParams;
pub use protocol::ActivateResult;
pub use protocol::CancelParams;
pub use protocol::CancelReason;
pub use protocol::ExtensionCapability;
pub use protocol::ExtensionHostOutputEvent;
pub use protocol::ExtensionHostRequest;
pub use protocol::ExtensionHostResponse;
pub use protocol::ExternalUriScheme;
pub use protocol::HostErrorCode;
pub use protocol::HostEventContext;
pub use protocol::HostFailure;
pub use protocol::HostOutputChannelKind;
pub use protocol::HostOutputOperation;
pub use protocol::HostOutputSeverity;
pub use protocol::HostRequestKind;
pub use protocol::HostResponseKind;
pub use protocol::HostSuccess;
pub use protocol::InitializeParams;
pub use protocol::InitializeResult;
pub use protocol::InvokeParams;
pub use protocol::InvokeResult;
pub use protocol::LanguageProviderOperation;
pub use protocol::PROTOCOL_VERSION;
pub use protocol::PackageBinding;
pub use protocol::RegistrationDescriptor;
pub use protocol::RegistrationKind;
pub use protocol::RequestContext;
pub use protocol::SequencedExtensionHostOutputEvent;
pub use restart::RestartDecision;
pub use restart::RestartPolicy;
pub use restart::RestartTracker;
pub use supervisor::ExtensionHostSnapshot;
pub use supervisor::ExtensionHostStatus;
pub use supervisor::ExtensionHostSupervisor;
pub use supervisor::ExtensionInvocation;
pub use supervisor::ExtensionInvocationHandle;
pub use supervisor::ExtensionInvocationTarget;
