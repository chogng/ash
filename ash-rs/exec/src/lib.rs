//! Headless Agent execution through the canonical App Server contract.

mod connection;
mod model;
mod output;
mod run_id;
mod run_loop;
mod runner;
mod turn_outcome;

pub use model::EXEC_EVENT_SCHEMA_VERSION;
pub use model::ExecEntry;
pub use model::ExecEvent;
pub use model::ExecEventKind;
pub use model::ExecExitCode;
pub use model::ExecFailure;
pub use model::ExecFinalOutput;
pub use model::ExecInteractionKind;
pub use model::ExecInterruptionReason;
pub use model::ExecOrigin;
pub use model::ExecOutcome;
pub use model::ExecRequiredInteraction;
pub use model::ExecRunRequest;
pub use model::ExecUnknownReason;
pub use model::HeadlessApprovalMode;
pub use output::DiscardExecEventSink;
pub use output::ExecEventSink;
pub use output::ExecSinkError;
pub use output::JsonLinesExecEventSink;
pub use run_id::ExecRunId;
pub use run_id::InvalidExecRunId;
pub use runner::ExecCancellation;
pub use runner::ExecError;
pub use runner::ExecRunner;
pub use runner::ExecRunnerOptions;
