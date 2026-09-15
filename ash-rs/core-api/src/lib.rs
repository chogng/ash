//! Contracts implemented by Core hosts without depending on the execution runtime.

#![deny(private_bounds, private_interfaces, unreachable_pub)]

mod browser;
mod checkpoint;
mod error;
mod hooks;
mod model;
mod observer;
mod policy;
mod thread;
mod worktree;

pub use browser::BrowserAction;
pub use browser::BrowserActionResult;
pub use browser::BrowserCapability;
pub use browser::BrowserError;
pub use browser::BrowserObservation;
pub use browser::BrowserObserveRequest;
pub use browser::BrowserTargetId;
pub use browser::CreateBrowserTargetRequest;
pub use browser::CreateBrowserTargetResult;
pub use browser::ElementTarget;
pub use browser::MediaResource;
pub use browser::TextInputTarget;
pub use checkpoint::CheckpointCapture;
pub use checkpoint::MessageCheckpointSource;
pub use error::CoreError;
pub use hooks::AfterToolHookRequest;
pub use hooks::BeforeToolHookDecision;
pub use hooks::BeforeToolHookRequest;
pub use hooks::HookExecutionEvent;
pub use hooks::HookExecutionObserver;
pub use hooks::HookOutcome;
pub use hooks::HookService;
pub use hooks::NoHookExecutionObserver;
pub use hooks::TurnCompletedHookRequest;
pub use model::ModelImageInputLimits;
pub use model::ModelImageInputPolicy;
pub use model::ModelSelection;
pub use model::ModelService;
pub use model::ModelStreamSink;
pub use observer::TurnExecutionFinished;
pub use observer::TurnExecutionKind;
pub use observer::TurnExecutionObserver;
pub use observer::TurnExecutionStarted;
pub use observer::TurnExecutionTerminalState;
pub use observer::TurnToolExecutionFinished;
pub use observer::TurnToolExecutionStarted;
pub use policy::ActionPolicyService;
pub use thread::LeaseGuard;
pub use thread::ThreadUpdateSink;
pub use thread::WriterLease;
pub use worktree::ThreadWorktreeBinder;
pub use worktree::ThreadWorktreeBindingRequest;
