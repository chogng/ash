//! Process-isolated execution contracts for authorized Editor Extension runtimes.
//!
//! This crate consumes the shared extension protocol and owns the activation authority gate, bounded restart
//! policy, and process supervisor. It does not implement the VS Code Extension API and it does not
//! discover, install, grant, or select extension packages.

mod authority;
mod error;
mod limits;
mod process;
mod restart;
mod supervisor;

pub use authority::ActivationAuthority;
pub use authority::ActivationLease;
pub use authority::ExtensionActivationSpec;
pub use error::ExtensionHostError;
pub use external_ext_protocol::ActivateParams;
pub use external_ext_protocol::ActivateResult;
pub use external_ext_protocol::CancelParams;
pub use external_ext_protocol::CancelReason;
pub use external_ext_protocol::ExtensionCapability;
pub use external_ext_protocol::ExtensionHostOutputEvent;
pub use external_ext_protocol::ExtensionHostRequest;
pub use external_ext_protocol::ExtensionHostResponse;
pub use external_ext_protocol::ExternalUriScheme;
pub use external_ext_protocol::HostErrorCode;
pub use external_ext_protocol::HostEventContext;
pub use external_ext_protocol::HostFailure;
pub use external_ext_protocol::HostOutputChannelKind;
pub use external_ext_protocol::HostOutputOperation;
pub use external_ext_protocol::HostOutputSeverity;
pub use external_ext_protocol::HostRequestKind;
pub use external_ext_protocol::HostResponseKind;
pub use external_ext_protocol::HostSuccess;
pub use external_ext_protocol::InitializeParams;
pub use external_ext_protocol::InitializeResult;
pub use external_ext_protocol::InvokeParams;
pub use external_ext_protocol::InvokeResult;
pub use external_ext_protocol::LanguageProviderOperation;
pub use external_ext_protocol::PROTOCOL_VERSION;
pub use external_ext_protocol::PackageBinding;
pub use external_ext_protocol::RegistrationDescriptor;
pub use external_ext_protocol::RegistrationKind;
pub use external_ext_protocol::RequestContext;
pub use external_ext_protocol::SequencedExtensionHostOutputEvent;
pub use limits::ExtensionHostLimits;
pub use limits::HardResourceLimits;
pub use limits::JavaScriptMemoryLimits;
pub use limits::ProcessIsolationPolicy;
pub use process::ExtensionHostLauncher;
pub use process::ExtensionHostProcess;
pub use process::ExtensionLaunchCommand;
pub use process::PendingHostRequest;
pub use process::ProductJavaScriptLauncher;
pub use process::TrustedDevelopmentLauncher;
pub use restart::RestartDecision;
pub use restart::RestartPolicy;
pub use restart::RestartTracker;
pub use supervisor::ExtensionBackgroundClientHandler;
pub use supervisor::ExtensionHostSnapshot;
pub use supervisor::ExtensionHostStatus;
pub use supervisor::ExtensionHostSupervisor;
pub use supervisor::ExtensionInvocation;
pub use supervisor::ExtensionInvocationHandle;
pub use supervisor::ExtensionInvocationTarget;
