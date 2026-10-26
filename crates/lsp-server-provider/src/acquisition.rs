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
use crate::LanguageServerProvider;
use crate::LspServerLaunch;
use crate::ManagedNodeRuntime;
use crate::NodePackageLanguageServerProvider;
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
    #[error(transparent)]
    Provider(#[from] crate::LanguageServerProviderError),
}

/// A product extension owns executable selection and acquisition policy. Only trusted built-in
/// packages may supply this declaration; discovery does not execute probes or download assets.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerAcquisition {
    pub id: String,
    pub languages: Vec<String>,
    #[serde(flatten)]
    launch: AcquisitionLaunch,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum AcquisitionLaunch {
    Executable(ExecutableAcquisition),
    BundledNode(BundledNodeAcquisition),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecutableAcquisition {
    executable: String,
    probe_args: Vec<String>,
    #[serde(default)]
    environment: BTreeMap<String, String>,
    // Accept legacy v1 declarations without letting project markers affect activation or
    // launch identity. Current declarations omit this metadata.
    #[serde(default, skip_serializing)]
    workspace_files: Vec<String>,
    releases: Vec<ExecutableRelease>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundledNodeAcquisition {
    runtime: BundledRuntime,
    entrypoint: String,
    #[serde(default)]
    runtime_packages: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    initialization_options: Option<serde_json::Value>,
    #[serde(default)]
    settings: BTreeMap<String, serde_json::Value>,
    #[serde(skip)]
    bound_entrypoint: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum BundledRuntime {
    Node,
}

impl LanguageServerAcquisition {
    /// Compares normalized declarations, including every pinned release and launch option.
    pub fn same_policy(&self, other: &Self) -> bool {
        match (serde_json::to_value(self), serde_json::to_value(other)) {
            (Ok(left), Ok(right)) => {
                left == right && self.bound_entrypoint() == other.bound_entrypoint()
            }
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
        if !matches!(contribution.version, 1 | 2)
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
                || !ids.insert(&server.id)
                || server.languages.is_empty()
                || server.languages.len() > 32
                || server.languages.iter().any(|id| !valid_name(id))
            {
                return Err(ManagedLanguageServerError::Installation(
                    "invalid language-server contribution".into(),
                ));
            }
            let valid_launch = match &server.launch {
                AcquisitionLaunch::Executable(recipe) => {
                    contribution.version == 1
                        && valid_name(&recipe.executable)
                        && !recipe.probe_args.is_empty()
                        && recipe.probe_args.len() <= 16
                        && !recipe
                            .probe_args
                            .iter()
                            .any(|arg| arg.len() > 1024 || arg.contains('\0'))
                        && recipe.environment.len() <= 32
                        && !recipe.environment.iter().any(|(key, value)| {
                            key.is_empty()
                                || key.contains(['=', '\0'])
                                || value.contains('\0')
                                || value.len() > 4096
                        })
                        && recipe.workspace_files.len() <= 16
                        && !recipe.workspace_files.iter().any(|name| {
                            name.is_empty()
                                || name.contains(['/', '\\', '\0'])
                                || name == "."
                                || name == ".."
                        })
                        && !recipe.releases.is_empty()
                        && recipe.releases.len() <= 32
                }
                AcquisitionLaunch::BundledNode(recipe) => {
                    contribution.version == 2
                        && !recipe.entrypoint.is_empty()
                        && recipe.entrypoint.len() <= 1024
                        && !recipe.entrypoint.contains(['\\', ':', '\0'])
                        && recipe
                            .entrypoint
                            .split('/')
                            .all(|part| !matches!(part, "" | "." | ".."))
                        && recipe.runtime_packages.len() <= 16
                        && recipe.runtime_packages.iter().all(|name| {
                            !name.is_empty()
                                && name.len() <= 128
                                && !name.contains("..")
                                && name.bytes().all(|b| {
                                    b.is_ascii_lowercase()
                                        || b.is_ascii_digit()
                                        || b"@/._-".contains(&b)
                                })
                        })
                }
            };
            if !valid_launch {
                return Err(ManagedLanguageServerError::Installation(
                    "invalid language-server contribution".into(),
                ));
            }
        }
        Ok(contribution.servers)
    }

    /// Binds a bundled script to the immutable, product-owned package selected by discovery.
    pub fn bind_package(&mut self, package_root: &Path) -> Result<(), ManagedLanguageServerError> {
        if let AcquisitionLaunch::BundledNode(recipe) = &mut self.launch {
            let root = package_root
                .canonicalize()
                .map_err(|error| ManagedLanguageServerError::Installation(error.to_string()))?;
            let entrypoint = crate::provider::canonical_regular_file(
                &root.join(&recipe.entrypoint),
                "bundled language server",
            )?;
            if !entrypoint.starts_with(&root) {
                return Err(ManagedLanguageServerError::Unavailable(entrypoint));
            }
            recipe.bound_entrypoint = Some(entrypoint);
        }
        Ok(())
    }

    fn bound_entrypoint(&self) -> Option<&Path> {
        match &self.launch {
            AcquisitionLaunch::Executable(_) => None,
            AcquisitionLaunch::BundledNode(recipe) => recipe.bound_entrypoint.as_deref(),
        }
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
        node_runtime: impl FnOnce() -> Result<ManagedNodeRuntime, ManagedLanguageServerError>,
    ) -> Result<ManagedLanguageServer, ManagedLanguageServerError> {
        let recipe = match &self.launch {
            AcquisitionLaunch::Executable(recipe) => recipe,
            AcquisitionLaunch::BundledNode(recipe) => {
                let entrypoint = recipe.bound_entrypoint.as_ref().ok_or_else(|| {
                    ManagedLanguageServerError::Installation(
                        "bundled language server has no package binding".into(),
                    )
                })?;
                let provider = NodePackageLanguageServerProvider::new(
                    &self.id,
                    self.languages.iter().cloned(),
                    entrypoint,
                    node_runtime()?,
                )?;
                let mut definition = provider.definition(
                    dir_root,
                    explicit.map_or(
                        LspServerLaunch::Packaged,
                        LspServerLaunch::ExplicitExecutable,
                    ),
                )?;
                if let Some(options) = &recipe.initialization_options {
                    definition = definition.with_initialization_options(options.clone());
                }
                definition = definition.with_settings(recipe.settings.clone());
                return Ok(ManagedLanguageServer {
                    definition: definition.with_launch_options(&[], environment),
                });
            }
        };
        // User overrides have the same precedence during probing and the eventual launch.
        let mut effective_environment = recipe.environment.clone();
        effective_environment.extend(environment.clone());
        let paths = match explicit {
            Some(path) => vec![path.to_path_buf()],
            None => candidates.candidates(&recipe.executable)?,
        };
        for path in paths {
            if let Some(definition) = self.probe(recipe, &path, dir_root, &effective_environment) {
                return Ok(ManagedLanguageServer { definition });
            }
        }
        if let Some(path) = explicit {
            return Err(ManagedLanguageServerError::Unavailable(path.to_path_buf()));
        }
        let installed = install()?;
        let definition = self
            .probe(recipe, &installed.path, dir_root, &effective_environment)
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
        let AcquisitionLaunch::Executable(recipe) = &self.launch else {
            return Err(ManagedLanguageServerError::Installation(
                "bundled language servers do not require acquisition".into(),
            ));
        };
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
        let release = recipe
            .releases
            .iter()
            .find(|release| release.target == target)
            .ok_or_else(|| {
                ManagedLanguageServerError::Installation(format!("unsupported target {target}"))
            })?;
        Ok(ash_package_store::install_executable(
            home,
            &self.id,
            &recipe.executable,
            release,
            http,
            on_download,
        )?)
    }

    fn probe(
        &self,
        recipe: &ExecutableAcquisition,
        path: &Path,
        dir_root: &Path,
        environment: &BTreeMap<String, String>,
    ) -> Option<LanguageServerDefinition> {
        crate::provider::canonical_executable(path, "language server").ok()?;
        let path = std::path::absolute(path).ok()?;
        // Preserve the invocation name for toolchain proxies that dispatch using argv[0].
        let mut child = Command::new(&path)
            .args(&recipe.probe_args)
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
