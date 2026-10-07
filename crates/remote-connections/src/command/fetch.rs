use std::path::Path;

use crate::RemoteRuntimeArtifact;
use crate::RemoteRuntimeCatalogUpdater;
use crate::RemoteRuntimeDownloadDisposition;
use crate::RemoteRuntimeDownloadProgress;
use ash_remote::RemotePlatform;
use serde::Serialize;

use super::RemoteFetchOptions;
use super::RemoteFetchProgressFormat;

pub(super) fn run(options: RemoteFetchOptions) -> Result<(), String> {
    let updater = RemoteRuntimeCatalogUpdater::new(options.release, options.cache);
    let artifact = match options.progress {
        RemoteFetchProgressFormat::ArtifactOnly => updater.fetch_for(options.platform, |_| {}),
        RemoteFetchProgressFormat::JsonLines => updater.fetch_for(options.platform, |progress| {
            eprintln!("{}", progress_json(progress))
        }),
    }
    .map_err(|error| error.to_string())?;
    println!(
        "{}",
        serde_json::to_string(&RemoteRuntimeArtifactOutput::from(&artifact))
            .map_err(|error| error.to_string())?
    );
    Ok(())
}

fn progress_json(progress: RemoteRuntimeDownloadProgress) -> String {
    serde_json::to_string(&RemoteRuntimeDownloadProgressRecord::from(progress))
        .expect("Remote runtime download progress is always serializable")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteRuntimeArtifactOutput<'a> {
    archive_path: &'a Path,
    version: &'a str,
    target: &'a str,
    archive_size: u64,
    unpacked_size: u64,
    sha256: &'a str,
}

impl<'a> From<&'a RemoteRuntimeArtifact> for RemoteRuntimeArtifactOutput<'a> {
    fn from(artifact: &'a RemoteRuntimeArtifact) -> Self {
        Self {
            archive_path: artifact.archive(),
            version: artifact.version().as_str(),
            target: platform_target(artifact.platform()),
            archive_size: artifact.integrity().archive_size().get(),
            unpacked_size: artifact.integrity().unpacked_size().get(),
            sha256: artifact.integrity().sha256(),
        }
    }
}

fn platform_target(platform: RemotePlatform) -> &'static str {
    platform.target_triple()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteRuntimeDownloadProgressRecord {
    kind: &'static str,
    #[serde(flatten)]
    progress: RemoteRuntimeDownloadProgressOutput,
}

impl From<RemoteRuntimeDownloadProgress> for RemoteRuntimeDownloadProgressRecord {
    fn from(progress: RemoteRuntimeDownloadProgress) -> Self {
        Self {
            kind: "remoteRuntimeDownloadProgress",
            progress: progress.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
enum RemoteRuntimeDownloadProgressOutput {
    DownloadingCatalog,
    DownloadingArtifact {
        #[serde(rename = "transferredBytes")]
        transferred_bytes: u64,
        #[serde(rename = "totalBytes")]
        total_bytes: u64,
    },
    ValidatingArtifact,
    Complete {
        disposition: &'static str,
    },
}

impl From<RemoteRuntimeDownloadProgress> for RemoteRuntimeDownloadProgressOutput {
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
            RemoteRuntimeDownloadProgress::ValidatingArtifact => Self::ValidatingArtifact,
            RemoteRuntimeDownloadProgress::Complete { disposition } => Self::Complete {
                disposition: match disposition {
                    RemoteRuntimeDownloadDisposition::Downloaded => "downloaded",
                    RemoteRuntimeDownloadDisposition::Reused => "reused",
                },
            },
        }
    }
}

#[cfg(test)]
#[path = "fetch_tests.rs"]
mod tests;
