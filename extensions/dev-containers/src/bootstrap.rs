//! Installs a compatible runtime using the distribution's authenticated Remote catalog.
//! Platform probing, artifact validation and extraction receipts stay with shared Remote IO.

use super::container_command;
use super::output;
use super::output_with_archive;
use ash_remote::RemotePlatform;
use ash_remote_connections::RemoteRuntimeArtifact;
use ash_remote_connections::RemoteRuntimeArtifactIntegrity;
use ash_remote_connections::RemoteRuntimeCatalog;
use ash_remote_connections::RemoteRuntimeInstallLocation;
use ash_remote_connections::RemoteRuntimeVersion;
use external_ext_sdk::CancellationToken;
use serde::Deserialize;
use std::io;
use std::num::NonZeroU64;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

pub(super) fn install(workspace: &Path, token: &CancellationToken) -> io::Result<()> {
    let probe = ash_remote_connections::remote_platform_probe_command();
    let stdout = output(
        container_command(workspace).args(["sh", "-c", &probe]),
        token,
    )?;
    let platform = ash_remote_connections::parse_remote_platform(
        std::str::from_utf8(&stdout).map_err(io::Error::other)?,
    )
    .ok_or_else(|| io::Error::other("unsupported container runtime platform"))?;
    if !matches!(platform, RemotePlatform::Linux { .. }) {
        return Err(io::Error::other(
            "Docker runtime requires a supported Linux container",
        ));
    }
    let artifact = artifact(platform, token)?;
    let archive = artifact.open_verified().map_err(io::Error::other)?;
    let install = ash_remote_connections::remote_runtime_install_command(
        &artifact,
        &RemoteRuntimeInstallLocation::UserData,
    );
    let result = output_with_archive(
        container_command(workspace).args(["sh", "-c", &install]),
        token,
        Some(archive),
    )?;
    let installed = ash_remote_connections::parse_install_receipt(
        std::str::from_utf8(&result).map_err(io::Error::other)?,
        &artifact,
    )
    .map_err(io::Error::other)?
    .ok_or_else(|| io::Error::other("container runtime has no verified installation receipt"))?;
    // Publish only the immutable runtime path, atomically, under the container's selected user.
    // This marker owns installation selection; the host keeps no competing container catalog.
    const SELECT: &str = "set -eu; directory=\"$HOME/.local/share/ash\"; mkdir -p \"$directory\"; temporary=$(mktemp \"$directory/runtime.XXXXXX\"); trap 'rm -f \"$temporary\"' EXIT; printf '%s\\n' \"$1\" > \"$temporary\"; mv \"$temporary\" \"$directory/dev-container-runtime\"";
    output(
        container_command(workspace).args([
            "sh",
            "-c",
            SELECT,
            "--",
            installed.runtime().executable(),
        ]),
        token,
    )?;
    Ok(())
}

fn artifact(
    platform: RemotePlatform,
    token: &CancellationToken,
) -> io::Result<RemoteRuntimeArtifact> {
    let installation = ash_install_context::InstallContext::current();
    let package = installation.package_layout().ok_or_else(|| {
        io::Error::other("Ash Remote runtime catalog is unavailable in this installation")
    })?;
    let metadata = std::fs::symlink_metadata(package.metadata_file())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err(io::Error::other("invalid product runtime metadata"));
    }
    let identity: serde_json::Value =
        serde_json::from_slice(&std::fs::read(package.metadata_file())?)
            .map_err(io::Error::other)?;
    let binding = identity.get("remoteRuntimeCatalog").ok_or_else(|| {
        io::Error::other("this product has no authenticated Remote runtime catalog")
    })?;
    if binding
        .get("trustBinding")
        .and_then(serde_json::Value::as_str)
        != Some("signedProductPackage")
    {
        return Err(io::Error::other(
            "Remote catalog lacks product authorization",
        ));
    }
    let digest = binding
        .get("sha256")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("Remote catalog lacks integrity metadata"))?;
    if binding.get("path").and_then(serde_json::Value::as_str)
        == Some("ash-remote-runtimes/catalog.json")
        && binding.get("url").is_none()
    {
        let catalog = RemoteRuntimeCatalog::load_verified(
            package
                .package_directory()
                .join("ash-remote-runtimes/catalog.json"),
            digest,
        )
        .map_err(io::Error::other)?;
        return catalog
            .artifact_for(platform)
            .cloned()
            .ok_or_else(|| io::Error::other("Remote catalog has no compatible container runtime"));
    }
    let url = binding
        .get("url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("Remote catalog has no source"))?;
    if binding.get("path").is_some() {
        return Err(io::Error::other("ambiguous Remote catalog source"));
    }
    // The existing helper enforces download integrity/DNS policy. Its process tree belongs to
    // this cancellable invocation, so a long download cannot outlive cancelled preparation.
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("runtime cache has no user directory"))?;
    let cache = home.join(".cache/ash/dev-container-runtimes");
    let helper = package
        .binary_directory()
        .join(format!("ash-remote{}", std::env::consts::EXE_SUFFIX));
    let bytes = output(
        Command::new(helper)
            .args([
                "fetch-runtime",
                "--catalog-url",
                url,
                "--catalog-sha256",
                digest,
                "--target",
                platform.target_triple(),
                "--cache-root",
            ])
            .arg(cache),
        token,
    )?;
    let downloaded: Artifact = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    if downloaded.target != platform.target_triple() {
        return Err(io::Error::other(
            "Remote helper returned a different platform",
        ));
    }
    Ok(RemoteRuntimeArtifact::new(
        downloaded.archive_path,
        RemoteRuntimeVersion::parse(downloaded.version).map_err(io::Error::other)?,
        platform,
        RemoteRuntimeArtifactIntegrity::new(
            NonZeroU64::new(downloaded.archive_size)
                .ok_or_else(|| io::Error::other("empty runtime archive"))?,
            NonZeroU64::new(downloaded.unpacked_size)
                .ok_or_else(|| io::Error::other("empty runtime package"))?,
            downloaded.sha256,
        )
        .map_err(io::Error::other)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Artifact {
    archive_path: PathBuf,
    version: String,
    target: String,
    archive_size: u64,
    unpacked_size: u64,
    sha256: String,
}
