//! Closed management protocol shared by the account helper and the privileged service.
//! Caller identity comes from the pipe token, never from serialized request fields.

use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;

pub const SERVICE_NAME: &str = "AshWindowsSandbox";
pub const PIPE_NAME: &str = r"\\.\pipe\AshWindowsSandbox";
pub const PROTOCOL_VERSION: u32 = 3;
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// The client sends this byte after reading and decoding the complete response.
pub const RESPONSE_RECEIVED: u8 = 1;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub version: u32,
    pub request: Request,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Request {
    SetupPlan {
        runner: PathBuf,
        slots: usize,
    },
    Setup {
        runner: PathBuf,
        slots: usize,
        approved: String,
    },
    UpdatePlan {
        runner: PathBuf,
    },
    Update {
        runner: PathBuf,
        approved: String,
    },
    RemovePlan {},
    Remove {
        approved: String,
    },
    Status {},
    Metrics {},
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "result", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Response {
    Completed { data: serde_json::Value },
    Rejected { error: String },
}

/// Fixed machine location. SCM and the installer own the image below this directory.
#[cfg(windows)]
pub fn service_directory() -> Result<PathBuf, String> {
    crate::windows::service::directory()
}

/// Validates the ownership and write authority of service-managed files and directories.
/// Callers must pin the pathname while using this result.
#[cfg(windows)]
pub fn validate_service_path(path: &std::path::Path) -> Result<(), String> {
    crate::windows::win::verify_service_path(path)
}

/// Copies an image into an administrator-owned directory with its final access
/// descriptor present from creation. Copying a user's source ACL would expose a
/// writable SYSTEM image between the copy and a later permissions change.
#[cfg(windows)]
pub fn copy_service_image(
    source: &std::path::Path,
    target: &std::path::Path,
    readers: &[String],
) -> Result<(), String> {
    crate::windows::win::copy_service_image(source, target, readers)
}

/// Dispatches on the authenticated pipe thread while it impersonates the caller.
/// Mutations independently require an elevated administrator token and plan approval.
#[cfg(windows)]
pub fn dispatch(message: Message, metrics: &diagnostics::Metrics) -> Response {
    let result = if message.version == PROTOCOL_VERSION {
        measure(operation(&message.request), metrics, || {
            crate::windows::service::dispatch(message.request, metrics)
        })
    } else {
        Err("unsupported Windows sandbox service protocol".into())
    };
    match result {
        Ok(data) => Response::Completed { data },
        Err(error) => Response::Rejected { error },
    }
}

#[cfg(test)]
#[path = "provisioning_tests.rs"]
mod tests;

#[cfg(any(windows, test))]
fn operation(request: &Request) -> Option<diagnostics::MetricOperation> {
    use diagnostics::MetricOperation;
    match request {
        Request::Setup { .. } => Some(MetricOperation::WindowsSandboxSetup),
        Request::Update { .. } => Some(MetricOperation::WindowsSandboxUpdate),
        Request::Remove { .. } => Some(MetricOperation::WindowsSandboxRemove),
        Request::SetupPlan { .. }
        | Request::UpdatePlan { .. }
        | Request::RemovePlan {}
        | Request::Status {}
        | Request::Metrics {} => None,
    }
}

#[cfg(any(windows, test))]
fn measure<T>(
    operation: Option<diagnostics::MetricOperation>,
    metrics: &diagnostics::Metrics,
    run: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let timer = operation.map(|operation| metrics.start(operation, &[("mode", "service")]));
    let result = run();
    if let Some(timer) = timer {
        // Error bodies may contain account names and paths. Keep a stable category only.
        timer.finish(
            if result.is_ok() {
                diagnostics::MetricOutcome::Succeeded
            } else {
                diagnostics::MetricOutcome::Failed
            },
            result.as_ref().err().map(|_| "provisioning"),
        );
    }
    result
}
