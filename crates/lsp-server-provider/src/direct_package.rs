use std::path::Path;
use std::path::PathBuf;

use ash_lsp::LanguageServerCommand;

use crate::LanguageServerDefinition;
use crate::LanguageServerProvider;
use crate::LanguageServerProviderError;
use crate::LspServerLaunch;
use crate::provider::canonical_executable;

/// A Marketplace-verified self-launching language-server capability.
pub struct DirectPackageLanguageServerProvider {
    id: String,
    languages: Vec<String>,
    executable: PathBuf,
}

impl DirectPackageLanguageServerProvider {
    /// Binds a Manager-verified executable to its declared language routes.
    pub fn new(
        id: impl Into<String>,
        languages: impl IntoIterator<Item = String>,
        executable: impl AsRef<Path>,
    ) -> Result<Self, LanguageServerProviderError> {
        let id = id.into();
        let mut languages = languages.into_iter().collect::<Vec<_>>();
        languages.sort();
        languages.dedup();
        if id.trim().is_empty()
            || languages.is_empty()
            || languages.iter().any(|language| language.trim().is_empty())
        {
            return Err(LanguageServerProviderError::InvalidProviderContract(id));
        }
        Ok(Self {
            id,
            languages,
            executable: canonical_executable(
                executable.as_ref(),
                "Marketplace language-server executable",
            )?,
        })
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }
}

impl LanguageServerProvider for DirectPackageLanguageServerProvider {
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
        let executable = match launch {
            LspServerLaunch::Packaged => self.executable.clone(),
            LspServerLaunch::ExplicitExecutable(executable) => {
                canonical_executable(executable, "explicit language-server executable")?
            }
        };
        let command = LanguageServerCommand::new(executable).with_current_dir(dir_root);
        LanguageServerDefinition::new(&self.id, self.languages.iter().cloned(), command)
            .map_err(Into::into)
    }
}
