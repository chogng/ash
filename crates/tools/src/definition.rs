use crate::{ToolDefinitionError, ToolInputSchema, ToolName, ToolSchema};
use sha2::{Digest, Sha256};
use std::fmt;

const MAX_DESCRIPTION_BYTES: usize = 16 * 1024;

/// Determines whether a provider should request strict validation for a function tool.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolSchemaMode {
    ProviderDefault,
    Strict,
}

/// Determines whether a callable tool is visible initially or must be found through search.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolLoading {
    Eager,
    Deferred,
}

/// The model-call syntax supported by a host-side tool definition.
#[derive(Clone, Debug, PartialEq)]
pub enum ToolInvocationKind {
    Function { input_schema: ToolInputSchema },
    Freeform { format: FreeformFormat },
}

/// Grammar metadata for a freeform model tool.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FreeformFormat {
    syntax: String,
    definition: String,
}

impl FreeformFormat {
    pub fn new(
        syntax: impl Into<String>,
        definition: impl Into<String>,
    ) -> Result<Self, ToolDefinitionError> {
        let syntax = syntax.into();
        if syntax.trim().is_empty() {
            return Err(ToolDefinitionError::EmptyFreeformSyntax);
        }
        let definition = definition.into();
        if definition.trim().is_empty() {
            return Err(ToolDefinitionError::EmptyFreeformDefinition);
        }
        Ok(Self { syntax, definition })
    }

    pub fn syntax(&self) -> &str {
        &self.syntax
    }

    pub fn definition(&self) -> &str {
        &self.definition
    }
}

/// Optional schema describing a structured tool output.
#[derive(Clone, Debug, PartialEq)]
pub enum ToolOutputSchema {
    Unspecified,
    Schema(ToolSchema),
}

/// Stable digest of the model-visible portion of a validated tool definition.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ToolDefinitionDigest(String);

impl ToolDefinitionDigest {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ToolDefinitionDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Validated metadata for one callable host-side tool.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolDefinition {
    name: ToolName,
    description: String,
    invocation: ToolInvocationKind,
    output_schema: ToolOutputSchema,
    schema_mode: ToolSchemaMode,
    loading: ToolLoading,
}

impl ToolDefinition {
    pub fn function(
        name: ToolName,
        description: impl Into<String>,
        input_schema: ToolInputSchema,
        output_schema: ToolOutputSchema,
        schema_mode: ToolSchemaMode,
        loading: ToolLoading,
    ) -> Result<Self, ToolDefinitionError> {
        Self::new(
            name,
            description,
            ToolInvocationKind::Function { input_schema },
            output_schema,
            schema_mode,
            loading,
        )
    }

    pub fn freeform(
        name: ToolName,
        description: impl Into<String>,
        format: FreeformFormat,
        output_schema: ToolOutputSchema,
        schema_mode: ToolSchemaMode,
        loading: ToolLoading,
    ) -> Result<Self, ToolDefinitionError> {
        Self::new(
            name,
            description,
            ToolInvocationKind::Freeform { format },
            output_schema,
            schema_mode,
            loading,
        )
    }

    pub fn name(&self) -> &ToolName {
        &self.name
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn invocation(&self) -> &ToolInvocationKind {
        &self.invocation
    }

    pub fn output_schema(&self) -> &ToolOutputSchema {
        &self.output_schema
    }

    pub fn schema_mode(&self) -> ToolSchemaMode {
        self.schema_mode
    }

    pub fn loading(&self) -> ToolLoading {
        self.loading
    }

    pub fn digest(&self) -> ToolDefinitionDigest {
        let mut hasher = Sha256::new();
        update_string(&mut hasher, self.name.as_str());
        update_string(&mut hasher, &self.description);
        match &self.invocation {
            ToolInvocationKind::Function { input_schema } => {
                hasher.update([0]);
                update_string(&mut hasher, input_schema.as_schema().digest().as_str());
            }
            ToolInvocationKind::Freeform { format } => {
                hasher.update([1]);
                update_string(&mut hasher, format.syntax());
                update_string(&mut hasher, format.definition());
            }
        }
        match &self.output_schema {
            ToolOutputSchema::Unspecified => hasher.update([0]),
            ToolOutputSchema::Schema(schema) => {
                hasher.update([1]);
                update_string(&mut hasher, schema.digest().as_str());
            }
        }
        hasher.update([match self.schema_mode {
            ToolSchemaMode::ProviderDefault => 0,
            ToolSchemaMode::Strict => 1,
        }]);
        hasher.update([match self.loading {
            ToolLoading::Eager => 0,
            ToolLoading::Deferred => 1,
        }]);
        ToolDefinitionDigest(format!("{:x}", hasher.finalize()))
    }

    fn new(
        name: ToolName,
        description: impl Into<String>,
        invocation: ToolInvocationKind,
        output_schema: ToolOutputSchema,
        schema_mode: ToolSchemaMode,
        loading: ToolLoading,
    ) -> Result<Self, ToolDefinitionError> {
        let description = description.into();
        if description.trim().is_empty() {
            return Err(ToolDefinitionError::EmptyDescription);
        }
        if description.len() > MAX_DESCRIPTION_BYTES {
            return Err(ToolDefinitionError::DescriptionTooLarge {
                actual: description.len(),
                maximum: MAX_DESCRIPTION_BYTES,
            });
        }
        Ok(Self {
            name,
            description,
            invocation,
            output_schema,
            schema_mode,
            loading,
        })
    }
}

fn update_string(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value.as_bytes());
}

#[cfg(test)]
#[path = "definition_tests.rs"]
mod tests;
