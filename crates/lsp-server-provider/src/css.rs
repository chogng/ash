use std::path::Path;

use ash_lsp::LanguageServerCommand;

use crate::CSS_LANGUAGE_SERVER_ID;
use crate::LanguageServerDefinition;
use crate::LanguageServerProvider;
use crate::LanguageServerProviderError;
use crate::LspServerLaunch;
use crate::ManagedNodeRuntime;
use crate::provider::canonical_executable;
use crate::provider::canonical_regular_file;

const CSS_LANGUAGE_IDS: &[&str] = &["css", "less", "scss"];

/// Provider for the verified Marketplace CSS package executed by Ash's managed Node runtime.
pub struct CssLanguageServerProvider {
    entrypoint: std::path::PathBuf,
    node: ManagedNodeRuntime,
    languages: Vec<String>,
}

impl CssLanguageServerProvider {
    /// Binds one Manager-verified CSS entrypoint to the shared managed Node runtime.
    pub fn new(
        entrypoint: impl AsRef<Path>,
        node: ManagedNodeRuntime,
    ) -> Result<Self, LanguageServerProviderError> {
        Ok(Self {
            entrypoint: canonical_regular_file(
                entrypoint.as_ref(),
                "installed CSS language-server entrypoint",
            )?,
            node,
            languages: CSS_LANGUAGE_IDS.iter().map(|id| (*id).to_owned()).collect(),
        })
    }

    /// Returns the canonical installed JavaScript entrypoint.
    pub fn entrypoint(&self) -> &Path {
        &self.entrypoint
    }

    /// Returns the exact Node runtime used for packaged launches.
    pub fn node_runtime(&self) -> &ManagedNodeRuntime {
        &self.node
    }
}

impl LanguageServerProvider for CssLanguageServerProvider {
    fn id(&self) -> &str {
        CSS_LANGUAGE_SERVER_ID
    }

    fn languages(&self) -> &[String] {
        &self.languages
    }

    fn definition(
        &self,
        dir_root: &Path,
        launch: LspServerLaunch<'_>,
    ) -> Result<LanguageServerDefinition, LanguageServerProviderError> {
        let command = match launch {
            LspServerLaunch::Packaged => {
                self.node.command_for_script(&self.entrypoint, dir_root)?
            }
            LspServerLaunch::ExplicitExecutable(executable) => LanguageServerCommand::new(
                canonical_executable(executable, "explicit CSS language-server executable")?,
            )
            .with_current_dir(dir_root),
        };
        LanguageServerDefinition::new(
            CSS_LANGUAGE_SERVER_ID,
            CSS_LANGUAGE_IDS.iter().copied(),
            command,
        )
        .map_err(Into::into)
    }
}
