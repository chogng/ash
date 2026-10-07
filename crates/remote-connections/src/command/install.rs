use crate::RemoteRuntimeInstallDisposition;
use crate::RemoteRuntimeInstallProgress;
use crate::SshRemoteRuntimeInstaller;
use serde::Serialize;

use super::RemoteInstallOptions;
use super::RemoteInstallProgressFormat;

pub(super) fn run(options: RemoteInstallOptions) -> Result<(), String> {
    let mut installer = SshRemoteRuntimeInstaller::new(options.host);
    if let Some(ssh_executable) = options.ssh_executable {
        installer = installer.with_ssh_executable(ssh_executable);
    }
    if let Some(root) = options.install_root {
        installer = installer.with_install_root(root);
    }
    let installed = match options.progress {
        RemoteInstallProgressFormat::ExecutableOnly => installer.install(&options.artifact),
        RemoteInstallProgressFormat::JsonLines => installer
            .install_with_progress(&options.artifact, |progress| {
                eprintln!("{}", progress_json(progress))
            }),
    }
    .map_err(|error| error.to_string())?;
    println!("{}", installed.runtime().executable());
    Ok(())
}

fn progress_json(progress: RemoteRuntimeInstallProgress) -> String {
    serde_json::to_string(&RemoteRuntimeInstallProgressRecord::from(progress))
        .expect("Remote runtime install progress is always serializable")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteRuntimeInstallProgressRecord {
    kind: &'static str,
    #[serde(flatten)]
    progress: RemoteRuntimeInstallProgressOutput,
}

impl From<RemoteRuntimeInstallProgress> for RemoteRuntimeInstallProgressRecord {
    fn from(progress: RemoteRuntimeInstallProgress) -> Self {
        Self {
            kind: "remoteRuntimeInstallProgress",
            progress: progress.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
enum RemoteRuntimeInstallProgressOutput {
    ValidatingArtifact,
    ProbingPlatform,
    Uploading {
        #[serde(rename = "transferredBytes")]
        transferred_bytes: u64,
        #[serde(rename = "totalBytes")]
        total_bytes: u64,
    },
    FinalizingRemoteInstall,
    Complete {
        disposition: &'static str,
    },
}

impl From<RemoteRuntimeInstallProgress> for RemoteRuntimeInstallProgressOutput {
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
            RemoteRuntimeInstallProgress::Complete { disposition } => Self::Complete {
                disposition: match disposition {
                    RemoteRuntimeInstallDisposition::Installed => "installed",
                    RemoteRuntimeInstallDisposition::Reused => "reused",
                },
            },
        }
    }
}

#[cfg(test)]
#[path = "install_tests.rs"]
mod tests;
