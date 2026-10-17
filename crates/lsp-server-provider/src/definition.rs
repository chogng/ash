use ash_lsp::{LanguageServerCommand, LanguageServerName, LanguageServerRoute};
use serde_json::Value;

use crate::LspServerResolverError;

/// One trusted and fully resolved language-server launch definition.
///
/// Resolvers construct this value only after selecting and validating an executable.
/// Runtime consumers should pass its command directly to the protocol runtime without performing
/// another PATH lookup or changing its route.
#[derive(Clone, Debug)]
pub struct LanguageServerDefinition {
    route: LanguageServerRoute,
    command: LanguageServerCommand,
    initialization_options: Option<Value>,
    settings: std::collections::BTreeMap<String, Value>,
    // A manager configuration and its server definitions retain the exact package generation
    // through launch, retries and shutdown. Discovery alone does not acquire a package lease.
    lease: Option<std::sync::Arc<DefinitionLease>>,
}

struct DefinitionLease {
    _resource: Box<dyn Send + Sync>,
}

impl std::fmt::Debug for DefinitionLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("<language-server resource lease>")
    }
}

impl LanguageServerDefinition {
    pub fn new<I, S>(
        name: impl Into<String>,
        language_ids: I,
        command: LanguageServerCommand,
    ) -> Result<Self, LspServerResolverError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let name = LanguageServerName::new(name)?;
        let route = LanguageServerRoute::new(name, language_ids)?;
        Ok(Self {
            route,
            command,
            initialization_options: None,
            settings: Default::default(),
            lease: None,
        })
    }

    pub fn with_initialization_options(mut self, options: Value) -> Self {
        self.initialization_options = Some(options);
        self
    }

    /// Applies normalized profile launch options while preserving a managed runtime's script
    /// prefix, clean environment policy and resource lease.
    pub fn with_launch_options(
        mut self,
        args: &[String],
        environment: &std::collections::BTreeMap<String, String>,
    ) -> Self {
        self.command = self.command.with_arguments(args);
        for (key, value) in environment {
            self.command = self.command.with_environment(key, value);
        }
        self
    }

    pub fn with_language_ids(mut self, ids: &[String]) -> Result<Self, LspServerResolverError> {
        self.route = LanguageServerRoute::new(self.route.name().clone(), ids.iter().cloned())?;
        Ok(self)
    }

    pub fn with_settings(mut self, settings: std::collections::BTreeMap<String, Value>) -> Self {
        self.settings = settings;
        self
    }

    pub fn settings(&self) -> &std::collections::BTreeMap<String, Value> {
        &self.settings
    }

    /// Retains the package/runtime authority until the last definition owner has shut down.
    pub fn with_lease(mut self, lease: impl Send + Sync + 'static) -> Self {
        self.lease = Some(std::sync::Arc::new(DefinitionLease {
            _resource: Box::new(lease),
        }));
        self
    }

    pub fn name(&self) -> &LanguageServerName {
        self.route.name()
    }

    pub fn language_ids(&self) -> impl Iterator<Item = &str> {
        self.route.language_ids()
    }

    pub fn into_launch_parts(self) -> (LanguageServerRoute, LanguageServerCommand, Option<Value>) {
        (self.route, self.command, self.initialization_options)
    }
}
