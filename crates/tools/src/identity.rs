use std::fmt;

/// Reports invalid opaque identities owned by the host-side tool layer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolIdentityError {
    Empty { kind: &'static str },
}

impl fmt::Display for ToolIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty { kind } => write!(formatter, "{kind} must not be empty"),
        }
    }
}

impl std::error::Error for ToolIdentityError {}

macro_rules! opaque_tool_identity {
    ($name:ident, $description:literal, $kind:literal) => {
        #[doc = $description]
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, ToolIdentityError> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err(ToolIdentityError::Empty { kind: $kind });
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

opaque_tool_identity!(
    ToolBindingId,
    "Snapshot-scoped identity that binds one model-visible tool name to one host runtime.",
    "tool binding ID"
);
opaque_tool_identity!(
    ToolRuntimeKey,
    "Opaque host-router key for a concrete executor; it never enters durable transcript state.",
    "tool runtime key"
);
opaque_tool_identity!(
    ToolOperationId,
    "Host-generated identity for one concrete tool execution attempt.",
    "tool operation ID"
);
/// Monotonic generation assigned to one immutable host tool registry snapshot.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ToolRegistryGeneration(u64);

impl ToolRegistryGeneration {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl fmt::Display for ToolRegistryGeneration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod tests;
