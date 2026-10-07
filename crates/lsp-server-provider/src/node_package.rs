use std::path::Path;
use std::path::PathBuf;

use ash_lsp::LanguageServerCommand;

use crate::LanguageServerDefinition;
use crate::LanguageServerProvider;
use crate::LanguageServerProviderError;
use crate::LspServerLaunch;
use crate::ManagedNodeRuntime;
use crate::provider::canonical_executable;
use crate::provider::canonical_regular_file;

/// A Marketplace-verified Node language-server capability.
pub struct NodePackageLanguageServerProvider {
    id: String,
    languages: Vec<String>,
    entrypoint: PathBuf,
    node: ManagedNodeRuntime,
}

impl NodePackageLanguageServerProvider {
    /// Binds a Manager-verified package entrypoint to its declared language routes.
    pub fn new(
        id: impl Into<String>,
        languages: impl IntoIterator<Item = String>,
        entrypoint: impl AsRef<Path>,
        node: ManagedNodeRuntime,
    ) -> Result<Self, LanguageServerProviderError> {
        let id = id.into();
        let mut languages = languages.into_iter().collect::<Vec<_>>();
        languages.sort();
        languages.dedup();
        if id.trim().is_empty()
            || languages.is_empty()
            || languages.iter().any(|id| id.trim().is_empty())
        {
            return Err(LanguageServerProviderError::InvalidProviderContract(id));
        }
        Ok(Self {
            id,
            languages,
            entrypoint: canonical_regular_file(
                entrypoint.as_ref(),
                "Marketplace language-server entrypoint",
            )?,
            node,
        })
    }

    pub fn entrypoint(&self) -> &Path {
        &self.entrypoint
    }
}

impl LanguageServerProvider for NodePackageLanguageServerProvider {
    fn id(&self) -> &str {
        &self.id
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
                canonical_executable(executable, "explicit packaged language-server executable")?,
            )
            .with_current_dir(dir_root),
        };
        LanguageServerDefinition::new(&self.id, self.languages.iter().cloned(), command)
            .map_err(Into::into)
    }
}
