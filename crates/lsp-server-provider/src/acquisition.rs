use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use ash_http_client::HttpClient;
use ash_lsp::LanguageServerCommand;
use ash_package_store::ExecutableRelease;
use ash_package_store::InstalledExecutable;

use crate::LanguageServerDefinition;
use crate::LanguageServerExecutableCandidates;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;

/// One verified launch and, for managed binaries, its package lifetime.
pub struct ManagedLanguageServer {
    definition: LanguageServerDefinition,
}

#[derive(Debug, thiserror::Error)]
pub enum ManagedLanguageServerError {
    #[error("language server is not runnable at {0}")]
    Unavailable(PathBuf),
    #[error("language-server installation is unavailable: {0}")]
    Installation(String),
    #[error(transparent)]
    Package(#[from] ash_package_store::CapabilityInstallError),
    #[error(transparent)]
    Definition(#[from] crate::LspServerResolverError),
}

/// A product extension owns executable selection and acquisition policy. Only trusted built-in
/// packages may supply this declaration; discovery does not execute probes or download assets.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageServerAcquisition {
    pub id: String,
    pub languages: Vec<String>,
    executable: String,
    probe_args: Vec<String>,
    #[serde(default)]
    environment: BTreeMap<String, String>,
    pub workspace_files: Vec<String>,
    releases: Vec<ExecutableRelease>,
}

impl LanguageServerAcquisition {
    /// Compares normalized declarations, including every pinned release and launch option.
    pub fn same_policy(&self, other: &Self) -> bool {
        match (serde_json::to_value(self), serde_json::to_value(other)) {
            (Ok(left), Ok(right)) => left == right,
            _ => false,
        }
    }

    /// Decodes and validates the versioned contribution at the extension package boundary.
    pub fn from_contribution(
        value: serde_json::Value,
    ) -> Result<Vec<Self>, ManagedLanguageServerError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Contribution {
            version: u32,
            servers: Vec<LanguageServerAcquisition>,
        }
        let contribution: Contribution = serde_json::from_value(value)
            .map_err(|error| ManagedLanguageServerError::Installation(error.to_string()))?;
        let valid_name = |name: &str| {
            !name.is_empty()
                && name.len() <= 128
                && name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        };
        if contribution.version != 1
            || contribution.servers.is_empty()
            || contribution.servers.len() > 32
        {
            return Err(ManagedLanguageServerError::Installation(
                "unsupported language-server contribution".into(),
            ));
        }
        let mut ids = std::collections::BTreeSet::new();
        for server in &contribution.servers {
            if !valid_name(&server.id)
                || !valid_name(&server.executable)
                || !ids.insert(&server.id)
                || server.languages.is_empty()
                || server.languages.len() > 32
                || server.languages.iter().any(|id| !valid_name(id))
                || server.probe_args.is_empty()
                || server.probe_args.len() > 16
                || server
                    .probe_args
                    .iter()
                    .any(|arg| arg.len() > 1024 || arg.contains('\0'))
                || server.environment.len() > 32
                || server.environment.iter().any(|(key, value)| {
                    key.is_empty()
                        || key.contains(['=', '\0'])
                        || value.contains('\0')
                        || value.len() > 4096
                })
                || server.workspace_files.len() > 16
                || server.workspace_files.iter().any(|name| {
                    name.is_empty()
                        || name.contains(['/', '\\', '\0'])
                        || name == "."
                        || name == ".."
                })
                || server.releases.is_empty()
                || server.releases.len() > 32
            {
                return Err(ManagedLanguageServerError::Installation(
                    "invalid language-server contribution".into(),
                ));
            }
        }
        Ok(contribution.servers)
    }

    /// Explicit overrides are authoritative. Otherwise probe PATH in the workspace's toolchain
    /// context before invoking the managed installer. Merely listing languages never calls this.
    pub fn resolve(
        &self,
        dir_root: &Path,
        explicit: Option<&Path>,
        candidates: &dyn LanguageServerExecutableCandidates,
        environment: &BTreeMap<String, String>,
        install: impl FnOnce() -> Result<InstalledExecutable, ManagedLanguageServerError>,
    ) -> Result<ManagedLanguageServer, ManagedLanguageServerError> {
        // User overrides have the same precedence during probing and the eventual launch.
        let mut effective_environment = self.environment.clone();
        effective_environment.extend(environment.clone());
        let paths = match explicit {
            Some(path) => vec![path.to_path_buf()],
            None => candidates.candidates(&self.executable)?,
        };
        for path in paths {
            if let Some(definition) = self.probe(&path, dir_root, &effective_environment) {
                return Ok(ManagedLanguageServer { definition });
            }
        }
        if let Some(path) = explicit {
            return Err(ManagedLanguageServerError::Unavailable(path.to_path_buf()));
        }
        let installed = install()?;
        let definition = self
            .probe(&installed.path, dir_root, &effective_environment)
            .ok_or_else(|| ManagedLanguageServerError::Unavailable(installed.path.clone()))?;
        Ok(ManagedLanguageServer {
            definition: definition.with_lease(installed.lease),
        })
    }

    /// Uses a product-pinned upstream release, with no GitHub API or latest-version lookup.
    /// Cache reuse is silent; `on_download` runs only when the store must fetch the release.
    pub fn install(
        &self,
        home: &Path,
        http: &dyn HttpClient,
        on_download: impl FnOnce(),
    ) -> Result<InstalledExecutable, ManagedLanguageServerError> {
        let suffix = match std::env::consts::OS {
            "macos" => "apple-darwin",
            "linux" => "unknown-linux-gnu",
            "windows" => "pc-windows-msvc",
            _ => {
                return Err(ManagedLanguageServerError::Installation(
                    "unsupported operating system".into(),
                ));
            }
        };
        let target = format!("{}-{suffix}", std::env::consts::ARCH);
        let release = self
            .releases
            .iter()
            .find(|release| release.target == target)
            .ok_or_else(|| {
                ManagedLanguageServerError::Installation(format!("unsupported target {target}"))
            })?;
        Ok(ash_package_store::install_executable(
            home,
            &self.id,
            &self.executable,
            release,
            http,
            on_download,
        )?)
    }

    fn probe(
        &self,
        path: &Path,
        dir_root: &Path,
        environment: &BTreeMap<String, String>,
    ) -> Option<LanguageServerDefinition> {
        crate::provider::canonical_executable(path, "language server").ok()?;
        let path = std::path::absolute(path).ok()?;
        // Preserve the invocation name for toolchain proxies that dispatch using argv[0].
        let mut child = Command::new(&path)
            .args(&self.probe_args)
            .current_dir(dir_root)
            .envs(environment)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let success = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                Ok(None) | Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
            }
        };
        if !success {
            return None;
        }
        let canonical = path.canonicalize().ok()?;
        let mut command = LanguageServerCommand::new(canonical).with_current_dir(dir_root);
        for (key, value) in environment {
            command = command.with_environment(key, value);
        }
        #[cfg(unix)]
        let command = command.with_argv0(path);
        LanguageServerDefinition::new(&self.id, self.languages.iter().cloned(), command).ok()
    }
}

impl ManagedLanguageServer {
    pub fn definition(&self) -> &LanguageServerDefinition {
        &self.definition
    }
}

#[cfg(test)]
#[path = "acquisition_tests.rs"]
mod tests;
