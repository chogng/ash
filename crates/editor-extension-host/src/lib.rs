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
pub use extension_protocol::ActivateParams;
pub use extension_protocol::ActivateResult;
pub use extension_protocol::CancelParams;
pub use extension_protocol::CancelReason;
pub use extension_protocol::ExtensionCapability;
pub use extension_protocol::ExtensionHostOutputEvent;
pub use extension_protocol::ExtensionHostRequest;
pub use extension_protocol::ExtensionHostResponse;
pub use extension_protocol::ExternalUriScheme;
pub use extension_protocol::HostErrorCode;
pub use extension_protocol::HostEventContext;
pub use extension_protocol::HostFailure;
pub use extension_protocol::HostOutputChannelKind;
pub use extension_protocol::HostOutputOperation;
pub use extension_protocol::HostOutputSeverity;
pub use extension_protocol::HostRequestKind;
pub use extension_protocol::HostResponseKind;
pub use extension_protocol::HostSuccess;
pub use extension_protocol::InitializeParams;
pub use extension_protocol::InitializeResult;
pub use extension_protocol::InvokeParams;
pub use extension_protocol::InvokeResult;
pub use extension_protocol::LanguageProviderOperation;
pub use extension_protocol::PROTOCOL_VERSION;
pub use extension_protocol::PackageBinding;
pub use extension_protocol::RegistrationDescriptor;
pub use extension_protocol::RegistrationKind;
pub use extension_protocol::RequestContext;
pub use extension_protocol::SequencedExtensionHostOutputEvent;
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
pub use supervisor::ExtensionHostSnapshot;
pub use supervisor::ExtensionHostStatus;
pub use supervisor::ExtensionHostSupervisor;
pub use supervisor::ExtensionInvocation;
pub use supervisor::ExtensionInvocationHandle;
pub use supervisor::ExtensionInvocationTarget;
