use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use crate::LanguageServerDefinition;

/// Selects the package-managed server or one authoritative host executable override.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LspServerLaunch<'a> {
    Packaged,
    ExplicitExecutable(&'a Path),
}

/// Resolves one installed language-server integration into a canonical launch definition.
///
/// Implementations validate their immutable package/runtime inputs when constructed. Each call
/// must preserve the provider's stable language route and may only vary directory-local launch
/// context or an explicit executable override selected by the configuration authority.
pub trait LanguageServerProvider: Send + Sync {
    /// Returns the stable server identity used by Config and the process supervisor.
    fn id(&self) -> &str;

    /// Returns the complete stable language route owned by this provider.
    fn languages(&self) -> &[String];

    /// Produces one directory-rooted launch definition without starting the process.
    fn definition(
        &self,
        dir_root: &Path,
        launch: LspServerLaunch<'_>,
    ) -> Result<LanguageServerDefinition, LanguageServerProviderError>;
}

/// Frozen product registry of installed language-server providers.
#[derive(Clone, Default)]
pub struct LspServerProviders {
    providers: BTreeMap<String, Arc<dyn LanguageServerProvider>>,
    activation_enabled: std::collections::BTreeSet<String>,
}

impl LspServerProviders {
    /// Creates an empty product composition registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers one uniquely identified provider.
    pub fn register<P>(&mut self, provider: P) -> Result<(), LanguageServerProviderError>
    where
        P: LanguageServerProvider + 'static,
    {
        self.register_shared(Arc::new(provider))
    }

    /// Registers an installed package provider and enables its packaged launch by default.
    pub fn register_packaged<P>(&mut self, provider: P) -> Result<(), LanguageServerProviderError>
    where
        P: LanguageServerProvider + 'static,
    {
        let id = provider.id().to_owned();
        self.register(provider)?;
        self.activation_enabled.insert(id);
        Ok(())
    }

    /// Registers one shared provider while retaining its exact runtime identity.
    pub fn register_shared(
        &mut self,
        provider: Arc<dyn LanguageServerProvider>,
    ) -> Result<(), LanguageServerProviderError> {
        let id = provider.id().to_owned();
        if id.is_empty() || provider.languages().is_empty() {
            return Err(LanguageServerProviderError::InvalidProviderContract(id));
        }
        if self.providers.contains_key(&id) {
            return Err(LanguageServerProviderError::DuplicateProvider(id));
        }
        self.providers.insert(id, provider);
        Ok(())
    }

    /// Merges another frozen composition, rejecting duplicate provider identities.
    pub fn merge(&mut self, other: Self) -> Result<(), LanguageServerProviderError> {
        self.activation_enabled.extend(other.activation_enabled);
        for provider in other.providers.into_values() {
            self.register_shared(provider)?;
        }
        Ok(())
    }

    /// Returns whether an exact provider identity is installed.
    pub fn contains(&self, id: &str) -> bool {
        self.providers.contains_key(id)
    }

    /// Returns the number of installed provider identities.
    pub fn len(&self) -> usize {
        self.providers.len()
    }

    /// Returns whether no provider is installed.
    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }

    /// Iterates stable installed provider identities in deterministic order.
    pub fn ids(&self) -> impl Iterator<Item = &str> + '_ {
        self.providers.keys().map(String::as_str)
    }

    /// Returns whether a durable user activation enables this packaged provider without Config.
    pub fn activation_enables(&self, id: &str) -> bool {
        self.activation_enabled.contains(id)
    }

    /// Resolves a provider definition, returning `None` for an unknown identity.
    pub fn definition(
        &self,
        id: &str,
        dir_root: &Path,
        launch: LspServerLaunch<'_>,
    ) -> Result<Option<LanguageServerDefinition>, LanguageServerProviderError> {
        self.providers
            .get(id)
            .map(|provider| provider.definition(dir_root, launch))
            .transpose()
    }

    /// Compares registries by exact shared provider identity for composition option equality.
    pub fn ptr_eq(&self, other: &Self) -> bool {
        self.providers.len() == other.providers.len()
            && self.activation_enabled == other.activation_enabled
            && self.providers.iter().all(|(id, provider)| {
                other
                    .providers
                    .get(id)
                    .is_some_and(|other| Arc::ptr_eq(provider, other))
            })
    }
}

impl fmt::Debug for LspServerProviders {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LspServerProviders")
            .field("provider_ids", &self.providers.keys().collect::<Vec<_>>())
            .field("activation_enabled", &self.activation_enabled)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LanguageServerProviderError {
    #[error("the Ash package does not contain a managed Node runtime")]
    ManagedNodeUnavailable,
    #[error("invalid {kind} at {path}: {reason}")]
    InvalidFile {
        kind: &'static str,
        path: PathBuf,
        reason: &'static str,
    },
    #[error("language-server provider '{0}' has an empty identity or language route")]
    InvalidProviderContract(String),
    #[error("language-server provider '{0}' is registered more than once")]
    DuplicateProvider(String),
    #[error(transparent)]
    InvalidDefinition(Box<crate::LspServerResolverError>),
}

impl From<crate::LspServerResolverError> for LanguageServerProviderError {
    fn from(error: crate::LspServerResolverError) -> Self {
        Self::InvalidDefinition(Box::new(error))
    }
}

pub(crate) fn canonical_regular_file(
    path: &Path,
    kind: &'static str,
) -> Result<PathBuf, LanguageServerProviderError> {
    let canonical =
        fs::canonicalize(path).map_err(|_| LanguageServerProviderError::InvalidFile {
            kind,
            path: path.to_path_buf(),
            reason: "path cannot be canonicalized",
        })?;
    let metadata =
        fs::metadata(&canonical).map_err(|_| LanguageServerProviderError::InvalidFile {
            kind,
            path: canonical.clone(),
            reason: "metadata is unavailable",
        })?;
    if !metadata.is_file() {
        return Err(LanguageServerProviderError::InvalidFile {
            kind,
            path: canonical,
            reason: "path is not a regular file",
        });
    }
    Ok(canonical)
}

pub(crate) fn canonical_executable(
    path: &Path,
    kind: &'static str,
) -> Result<PathBuf, LanguageServerProviderError> {
    let canonical = canonical_regular_file(path, kind)?;
    if !has_executable_permission(&fs::metadata(&canonical).map_err(|_| {
        LanguageServerProviderError::InvalidFile {
            kind,
            path: canonical.clone(),
            reason: "metadata is unavailable",
        }
    })?) {
        return Err(LanguageServerProviderError::InvalidFile {
            kind,
            path: canonical,
            reason: "path is not executable",
        });
    }
    Ok(canonical)
}

#[cfg(unix)]
fn has_executable_permission(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn has_executable_permission(_metadata: &fs::Metadata) -> bool {
    true
}
