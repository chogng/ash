use std::io;
use std::io::Write;

use ash_remote_connections::RemoteRuntimeDownloadDisposition;
use ash_remote_connections::RemoteRuntimeDownloadProgress;
use ash_remote_connections::RemoteRuntimeInstallDisposition;
use ash_remote_connections::RemoteRuntimeInstallProgress;

use crate::launch::AppLaunch;
use crate::launch::RemoteRuntimePreparationProgress;

pub(crate) const REMOTE_LAUNCH_PROGRESS_ENV: &str = "APP_REMOTE_LAUNCH_PROGRESS";
const REMOTE_LAUNCH_PROGRESS_FORMAT: &str = "json-lines";
const REMOTE_LAUNCH_PROGRESS_PREFIX: &str = "__APP_REMOTE_LAUNCH__:";
const REMOTE_LAUNCH_ERROR_MAX_BYTES: usize = 4 * 1024;
const REMOTE_LAUNCH_PROGRESS_MAX_LINE_BYTES: usize = 32 * 1024;

/// Bounded child-process progress projected to the Desktop window that requested a Remote launch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RemoteLaunchProgressEvent {
    CheckingRuntime,
    DownloadingCatalog,
    DownloadingArtifact {
        transferred_bytes: u64,
        total_bytes: u64,
    },
    ValidatingDownload,
    Downloaded,
    DownloadReused,
    ValidatingArtifact,
    ProbingPlatform,
    Uploading {
        transferred_bytes: u64,
        total_bytes: u64,
    },
    FinalizingRemoteInstall,
    Installed,
    Reused,
    Ready,
    Failed(String),
}

impl RemoteLaunchProgressEvent {
    pub(crate) fn message(&self) -> String {
        match self {
            Self::CheckingRuntime => "Checking Remote runtime and protocol compatibility…".into(),
            Self::DownloadingCatalog => "Checking the authenticated Remote runtime release…".into(),
            Self::DownloadingArtifact {
                transferred_bytes,
                total_bytes,
            } => {
                let percentage = safe_percentage(*transferred_bytes, *total_bytes);
                format!("Downloading Remote runtime… {percentage}%")
            }
            Self::ValidatingDownload => "Validating the downloaded Remote runtime…".into(),
            Self::Downloaded => "Remote runtime downloaded; preparing installation…".into(),
            Self::DownloadReused => {
                "Cached Remote runtime verified; preparing installation…".into()
            }
            Self::ValidatingArtifact => "Validating the packaged Remote runtime…".into(),
            Self::ProbingPlatform => "Detecting the Remote server platform…".into(),
            Self::Uploading {
                transferred_bytes,
                total_bytes,
            } => {
                let percentage = safe_percentage(*transferred_bytes, *total_bytes);
                format!("Uploading Remote runtime… {percentage}%")
            }
            Self::FinalizingRemoteInstall => "Validating and activating the Remote runtime…".into(),
            Self::Installed => "Remote runtime installed; verifying compatibility…".into(),
            Self::Reused => "Existing Remote runtime verified; checking compatibility…".into(),
            Self::Ready => "Remote runtime ready; opening a new window…".into(),
            Self::Failed(error) => error.clone(),
        }
    }

    pub(crate) fn write_wire(&self, output: &mut dyn Write) -> io::Result<()> {
        let value = match self {
            Self::CheckingRuntime => serde_json::json!({ "phase": "checkingRuntime" }),
            Self::DownloadingCatalog => serde_json::json!({ "phase": "downloadingCatalog" }),
            Self::DownloadingArtifact {
                transferred_bytes,
                total_bytes,
            } => serde_json::json!({
                "phase": "downloadingArtifact",
                "transferredBytes": transferred_bytes,
                "totalBytes": total_bytes,
            }),
            Self::ValidatingDownload => serde_json::json!({ "phase": "validatingDownload" }),
            Self::Downloaded => serde_json::json!({ "phase": "downloaded" }),
            Self::DownloadReused => serde_json::json!({ "phase": "downloadReused" }),
            Self::ValidatingArtifact => serde_json::json!({ "phase": "validatingArtifact" }),
            Self::ProbingPlatform => serde_json::json!({ "phase": "probingPlatform" }),
            Self::Uploading {
                transferred_bytes,
                total_bytes,
            } => serde_json::json!({
                "phase": "uploading",
                "transferredBytes": transferred_bytes,
                "totalBytes": total_bytes,
            }),
            Self::FinalizingRemoteInstall => {
                serde_json::json!({ "phase": "finalizingRemoteInstall" })
            }
            Self::Installed => serde_json::json!({ "phase": "installed" }),
            Self::Reused => serde_json::json!({ "phase": "reused" }),
            Self::Ready => serde_json::json!({ "phase": "ready" }),
            Self::Failed(message) => {
                serde_json::json!({
                    "phase": "failed",
                    "message": bounded_error_message(message),
                })
            }
        };
        writeln!(output, "{REMOTE_LAUNCH_PROGRESS_PREFIX}{value}")?;
        output.flush()
    }

    pub(crate) fn parse_wire(line: &str) -> Result<Option<Self>, String> {
        let Some(document) = line.strip_prefix(REMOTE_LAUNCH_PROGRESS_PREFIX) else {
            return Ok(None);
        };
        if line.len() > REMOTE_LAUNCH_PROGRESS_MAX_LINE_BYTES {
            return Err("Remote launch progress line is too large".into());
        }
        let value: serde_json::Value = serde_json::from_str(document)
            .map_err(|error| format!("invalid Remote launch progress JSON: {error}"))?;
        let object = value
            .as_object()
            .ok_or_else(|| "Remote launch progress must be a JSON object".to_owned())?;
        let phase = object
            .get("phase")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Remote launch progress has no phase".to_owned())?;
        let event = match phase {
            "checkingRuntime" => Self::CheckingRuntime,
            "downloadingCatalog" => Self::DownloadingCatalog,
            "downloadingArtifact" => Self::DownloadingArtifact {
                transferred_bytes: required_u64(object, "transferredBytes")?,
                total_bytes: required_u64(object, "totalBytes")?,
            },
            "validatingDownload" => Self::ValidatingDownload,
            "downloaded" => Self::Downloaded,
            "downloadReused" => Self::DownloadReused,
            "validatingArtifact" => Self::ValidatingArtifact,
            "probingPlatform" => Self::ProbingPlatform,
            "uploading" => Self::Uploading {
                transferred_bytes: required_u64(object, "transferredBytes")?,
                total_bytes: required_u64(object, "totalBytes")?,
            },
            "finalizingRemoteInstall" => Self::FinalizingRemoteInstall,
            "installed" => Self::Installed,
            "reused" => Self::Reused,
            "ready" => Self::Ready,
            "failed" => {
                let message = object
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| "failed Remote launch progress has no message".to_owned())?;
                if message.len() > REMOTE_LAUNCH_ERROR_MAX_BYTES {
                    return Err("Remote launch failure message is too large".into());
                }
                Self::Failed(message.to_owned())
            }
            _ => return Err(format!("unknown Remote launch progress phase `{phase}`")),
        };
        Ok(Some(event))
    }
}

fn safe_percentage(transferred_bytes: u64, total_bytes: u64) -> u64 {
    transferred_bytes
        .saturating_mul(100)
        .checked_div(total_bytes)
        .unwrap_or(0)
        .min(100)
}

fn bounded_error_message(message: &str) -> &str {
    let mut end = message.len().min(REMOTE_LAUNCH_ERROR_MAX_BYTES);
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    &message[..end]
}

impl From<RemoteRuntimeInstallProgress> for RemoteLaunchProgressEvent {
    fn from(progress: RemoteRuntimeInstallProgress) -> Self {
        match progress {
            RemoteRuntimeInstallProgress::ValidatingArtifact => Self::ValidatingArtifact,
            RemoteRuntimeInstallProgress::ProbingPlatform => Self::ProbingPlatform,
            RemoteRuntimeInstallProgress::Uploading {
                transferred_bytes,
                total_bytes,
            } => Self::Uploading {
                transferred_bytes,
                total_bytes: total_bytes.get(),
            },
            RemoteRuntimeInstallProgress::FinalizingRemoteInstall => Self::FinalizingRemoteInstall,
            RemoteRuntimeInstallProgress::Complete { disposition } => match disposition {
                RemoteRuntimeInstallDisposition::Installed => Self::Installed,
                RemoteRuntimeInstallDisposition::Reused => Self::Reused,
            },
        }
    }
}

impl From<RemoteRuntimeDownloadProgress> for RemoteLaunchProgressEvent {
    fn from(progress: RemoteRuntimeDownloadProgress) -> Self {
        match progress {
            RemoteRuntimeDownloadProgress::DownloadingCatalog => Self::DownloadingCatalog,
            RemoteRuntimeDownloadProgress::DownloadingArtifact {
                transferred_bytes,
                total_bytes,
            } => Self::DownloadingArtifact {
                transferred_bytes,
                total_bytes,
            },
            RemoteRuntimeDownloadProgress::ValidatingArtifact => Self::ValidatingDownload,
            RemoteRuntimeDownloadProgress::Complete { disposition } => match disposition {
                RemoteRuntimeDownloadDisposition::Downloaded => Self::Downloaded,
                RemoteRuntimeDownloadDisposition::Reused => Self::DownloadReused,
            },
        }
    }
}

#[derive(Default)]
pub(crate) struct RemoteLaunchProgressProjector {
    last_download_decile: Option<u64>,
    last_upload_decile: Option<u64>,
}

impl RemoteLaunchProgressProjector {
    pub(crate) fn project_preparation(
        &mut self,
        progress: RemoteRuntimePreparationProgress,
    ) -> Option<RemoteLaunchProgressEvent> {
        match progress {
            RemoteRuntimePreparationProgress::Download(progress) => self.project_download(progress),
            RemoteRuntimePreparationProgress::Install(progress) => self.project(progress),
        }
    }

    pub(crate) fn project(
        &mut self,
        progress: RemoteRuntimeInstallProgress,
    ) -> Option<RemoteLaunchProgressEvent> {
        let RemoteRuntimeInstallProgress::Uploading {
            transferred_bytes,
            total_bytes,
        } = progress
        else {
            return Some(progress.into());
        };
        let percentage = safe_percentage(transferred_bytes, total_bytes.get());
        let decile = percentage / 10;
        if self.last_upload_decile == Some(decile) {
            return None;
        }
        self.last_upload_decile = Some(decile);
        Some(RemoteLaunchProgressEvent::Uploading {
            transferred_bytes: total_bytes
                .get()
                .saturating_mul(decile)
                .checked_div(10)
                .unwrap_or(0),
            total_bytes: total_bytes.get(),
        })
    }

    fn project_download(
        &mut self,
        progress: RemoteRuntimeDownloadProgress,
    ) -> Option<RemoteLaunchProgressEvent> {
        let RemoteRuntimeDownloadProgress::DownloadingArtifact {
            transferred_bytes,
            total_bytes,
        } = progress
        else {
            return Some(progress.into());
        };
        let percentage = safe_percentage(transferred_bytes, total_bytes);
        let decile = percentage / 10;
        if self.last_download_decile == Some(decile) {
            return None;
        }
        self.last_download_decile = Some(decile);
        Some(RemoteLaunchProgressEvent::DownloadingArtifact {
            transferred_bytes: total_bytes
                .saturating_mul(decile)
                .checked_div(10)
                .unwrap_or(0),
            total_bytes,
        })
    }
}

#[derive(Default)]
pub(crate) struct RemoteInstallProgressReporter {
    last_download_decile: Option<u64>,
    last_upload_decile: Option<u64>,
}

pub(crate) fn prepare_remote_launch(launch: &mut AppLaunch) -> Result<(), String> {
    let wire_requested = std::env::var_os(REMOTE_LAUNCH_PROGRESS_ENV)
        .is_some_and(|value| value == REMOTE_LAUNCH_PROGRESS_FORMAT);
    let stderr = std::io::stderr();
    let mut human_output = stderr.lock();
    if !wire_requested {
        return prepare_remote_launch_with_outputs(launch, &mut human_output, None);
    }
    let stdout = std::io::stdout();
    let mut wire_output = stdout.lock();
    prepare_remote_launch_with_outputs(launch, &mut human_output, Some(&mut wire_output))
}

pub(crate) fn prepare_remote_launch_with_outputs(
    launch: &mut AppLaunch,
    human_output: &mut dyn Write,
    mut wire_output: Option<&mut dyn Write>,
) -> Result<(), String> {
    let mut reporter = RemoteInstallProgressReporter::default();
    let mut wire_projector = RemoteLaunchProgressProjector::default();
    write_optional_wire(
        &mut wire_output,
        &RemoteLaunchProgressEvent::CheckingRuntime,
    );
    let result = launch.prepare_remote_runtime_with_progress(&mut |progress| {
        let _ = reporter.write_preparation(progress, human_output);
        if let Some(event) = wire_projector.project_preparation(progress) {
            write_optional_wire(&mut wire_output, &event);
        }
    });
    let completion = match &result {
        Ok(()) => RemoteLaunchProgressEvent::Ready,
        Err(error) => RemoteLaunchProgressEvent::Failed(error.clone()),
    };
    write_optional_wire(&mut wire_output, &completion);
    result
}

fn write_optional_wire(output: &mut Option<&mut dyn Write>, event: &RemoteLaunchProgressEvent) {
    if let Some(output) = output.as_deref_mut() {
        let _ = event.write_wire(output);
    }
}

fn required_u64(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<u64, String> {
    object
        .get(field)
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| format!("Remote launch progress has no valid `{field}`"))
}

impl RemoteInstallProgressReporter {
    pub(crate) fn write_preparation(
        &mut self,
        progress: RemoteRuntimePreparationProgress,
        output: &mut dyn Write,
    ) -> io::Result<()> {
        match progress {
            RemoteRuntimePreparationProgress::Download(progress) => {
                self.write_download(progress, output)
            }
            RemoteRuntimePreparationProgress::Install(progress) => self.write(progress, output),
        }
    }

    pub(crate) fn write(
        &mut self,
        progress: RemoteRuntimeInstallProgress,
        output: &mut dyn Write,
    ) -> io::Result<()> {
        match progress {
            RemoteRuntimeInstallProgress::ValidatingArtifact => {
                writeln!(output, "Remote runtime: validating local package")
            }
            RemoteRuntimeInstallProgress::ProbingPlatform => {
                writeln!(output, "Remote runtime: probing server platform")
            }
            RemoteRuntimeInstallProgress::Uploading {
                transferred_bytes,
                total_bytes,
            } => {
                let percentage = transferred_bytes
                    .saturating_mul(100)
                    .checked_div(total_bytes.get())
                    .unwrap_or(0)
                    .min(100);
                let decile = percentage / 10;
                if self.last_upload_decile == Some(decile) {
                    return Ok(());
                }
                self.last_upload_decile = Some(decile);
                writeln!(
                    output,
                    "Remote runtime: uploading {}% ({transferred_bytes}/{total_bytes} bytes)",
                    decile * 10
                )
            }
            RemoteRuntimeInstallProgress::FinalizingRemoteInstall => {
                writeln!(
                    output,
                    "Remote runtime: validating and committing on server"
                )
            }
            RemoteRuntimeInstallProgress::Complete { disposition } => match disposition {
                RemoteRuntimeInstallDisposition::Installed => {
                    writeln!(output, "Remote runtime: installation complete")
                }
                RemoteRuntimeInstallDisposition::Reused => {
                    writeln!(output, "Remote runtime: verified existing installation")
                }
            },
        }
    }

    fn write_download(
        &mut self,
        progress: RemoteRuntimeDownloadProgress,
        output: &mut dyn Write,
    ) -> io::Result<()> {
        match progress {
            RemoteRuntimeDownloadProgress::DownloadingCatalog => {
                writeln!(output, "Remote runtime: downloading authenticated catalog")
            }
            RemoteRuntimeDownloadProgress::DownloadingArtifact {
                transferred_bytes,
                total_bytes,
            } => {
                let decile = safe_percentage(transferred_bytes, total_bytes) / 10;
                if self.last_download_decile == Some(decile) {
                    return Ok(());
                }
                self.last_download_decile = Some(decile);
                writeln!(
                    output,
                    "Remote runtime: downloading {}% ({transferred_bytes}/{total_bytes} bytes)",
                    decile * 10
                )
            }
            RemoteRuntimeDownloadProgress::ValidatingArtifact => {
                writeln!(output, "Remote runtime: validating downloaded package")
            }
            RemoteRuntimeDownloadProgress::Complete { disposition } => match disposition {
                RemoteRuntimeDownloadDisposition::Downloaded => {
                    writeln!(output, "Remote runtime: download complete")
                }
                RemoteRuntimeDownloadDisposition::Reused => {
                    writeln!(output, "Remote runtime: verified cached package")
                }
            },
        }
    }
}
