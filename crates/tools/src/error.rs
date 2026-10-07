use std::fmt;

/// Reports why an untrusted tool schema cannot become a validated Ash schema.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolSchemaError {
    Serialization(String),
    TooLarge { actual: usize, maximum: usize },
    TooDeep { maximum: usize },
    TooManyNodes { maximum: usize },
    UnsupportedReference,
    InvalidProperties,
    InvalidRequired,
    DuplicateRequiredProperty(String),
    RequiredPropertyMissing(String),
    InputRootMustBeObject,
}

impl fmt::Display for ToolSchemaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Serialization(error) => {
                write!(formatter, "could not serialize tool schema: {error}")
            }
            Self::TooLarge { actual, maximum } => {
                write!(
                    formatter,
                    "tool schema is {actual} bytes, exceeding {maximum} bytes"
                )
            }
            Self::TooDeep { maximum } => {
                write!(formatter, "tool schema exceeds depth limit {maximum}")
            }
            Self::TooManyNodes { maximum } => {
                write!(formatter, "tool schema exceeds node limit {maximum}")
            }
            Self::UnsupportedReference => {
                write!(formatter, "tool schema references are not supported")
            }
            Self::InvalidProperties => {
                write!(formatter, "tool schema properties must be an object")
            }
            Self::InvalidRequired => write!(
                formatter,
                "tool schema required must be an array of strings"
            ),
            Self::DuplicateRequiredProperty(name) => {
                write!(
                    formatter,
                    "tool schema required contains duplicate property {name}"
                )
            }
            Self::RequiredPropertyMissing(name) => {
                write!(
                    formatter,
                    "tool schema required property {name} is not declared"
                )
            }
            Self::InputRootMustBeObject => {
                write!(formatter, "tool input schema root must have type object")
            }
        }
    }
}

impl std::error::Error for ToolSchemaError {}

/// Reports violations in host-side tool metadata after its schema is validated.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolDefinitionError {
    EmptyDescription,
    DescriptionTooLarge { actual: usize, maximum: usize },
    EmptyFreeformSyntax,
    EmptyFreeformDefinition,
}

impl fmt::Display for ToolDefinitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyDescription => write!(formatter, "tool description must not be empty"),
            Self::DescriptionTooLarge { actual, maximum } => {
                write!(
                    formatter,
                    "tool description is {actual} bytes, exceeding {maximum} bytes"
                )
            }
            Self::EmptyFreeformSyntax => {
                write!(formatter, "freeform tool syntax must not be empty")
            }
            Self::EmptyFreeformDefinition => {
                write!(
                    formatter,
                    "freeform tool grammar definition must not be empty"
                )
            }
        }
    }
}

impl std::error::Error for ToolDefinitionError {}

/// Reports failures while adapting a protocol dynamic tool into a host definition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DynamicToolAdapterError {
    Schema(ToolSchemaError),
    Definition(ToolDefinitionError),
}

impl fmt::Display for DynamicToolAdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Schema(error) => write!(formatter, "invalid dynamic tool schema: {error}"),
            Self::Definition(error) => {
                write!(formatter, "invalid dynamic tool definition: {error}")
            }
        }
    }
}

impl std::error::Error for DynamicToolAdapterError {}

/// Reports failures while adapting a validated MCP descriptor projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum McpToolAdapterError {
    EmptyRemoteName,
    Schema(ToolSchemaError),
    Definition(ToolDefinitionError),
}

impl fmt::Display for McpToolAdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyRemoteName => write!(formatter, "MCP tool remote name must not be empty"),
            Self::Schema(error) => write!(formatter, "invalid MCP tool schema: {error}"),
            Self::Definition(error) => write!(formatter, "invalid MCP tool definition: {error}"),
        }
    }
}

impl std::error::Error for McpToolAdapterError {}

/// Reports when a host-side tool cannot be represented by the current canonical model contract.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProtocolToolAdapterError {
    FreeformToolsUnsupported,
    Schema(ToolSchemaError),
    Definition(ToolDefinitionError),
}

impl fmt::Display for ProtocolToolAdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FreeformToolsUnsupported => {
                write!(
                    formatter,
                    "canonical model tool definitions do not support freeform tools"
                )
            }
            Self::Schema(error) => write!(formatter, "invalid protocol tool schema: {error}"),
            Self::Definition(error) => {
                write!(formatter, "invalid protocol tool definition: {error}")
            }
        }
    }
}

impl std::error::Error for ProtocolToolAdapterError {}

/// Reports why a set of validated tool registrations cannot become one immutable snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolRegistryError {
    DuplicateName(String),
    ReservedName(String),
    LoadingExposureMismatch { name: String },
    EmptySearchMetadata,
    SearchMetadataTooLarge { actual: usize, maximum: usize },
}

impl fmt::Display for ToolRegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateName(name) => {
                write!(
                    formatter,
                    "tool registry contains duplicate model name '{name}'"
                )
            }
            Self::ReservedName(name) => {
                write!(
                    formatter,
                    "tool registry name '{name}' is reserved by the host"
                )
            }
            Self::LoadingExposureMismatch { name } => write!(
                formatter,
                "tool '{name}' loading mode does not match its registry exposure"
            ),
            Self::EmptySearchMetadata => {
                formatter.write_str("tool search metadata must not be empty")
            }
            Self::SearchMetadataTooLarge { actual, maximum } => write!(
                formatter,
                "tool search metadata is {actual} bytes, exceeding {maximum} bytes"
            ),
        }
    }
}

impl std::error::Error for ToolRegistryError {}

/// Reports invalid bounded queries against one immutable tool registry snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolSearchError {
    EmptyQuery,
    QueryTooLarge { actual: usize, maximum: usize },
    InvalidLimit { actual: usize, maximum: usize },
    InvalidRegex(String),
}

impl fmt::Display for ToolSearchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyQuery => formatter.write_str("tool search query must not be empty"),
            Self::QueryTooLarge { actual, maximum } => write!(
                formatter,
                "tool search query is {actual} bytes, exceeding {maximum} bytes"
            ),
            Self::InvalidLimit { actual, maximum } => write!(
                formatter,
                "tool search limit {actual} must be between 1 and {maximum}"
            ),
            Self::InvalidRegex(error) => write!(formatter, "invalid tool search regex: {error}"),
        }
    }
}

impl std::error::Error for ToolSearchError {}
