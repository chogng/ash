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
        })
    }

    pub fn with_initialization_options(mut self, options: Value) -> Self {
        self.initialization_options = Some(options);
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
