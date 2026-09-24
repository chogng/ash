use std::error::Error;
use std::fmt;

/// Validated, normalized URL scheme accepted by an application.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProtocolScheme(String);

impl ProtocolScheme {
    /// Creates an RFC-compatible scheme such as `ash` or `com.example.app`.
    pub fn new(value: impl Into<String>) -> Result<Self, ProtocolSchemeError> {
        let value = value.into().to_ascii_lowercase();
        let mut characters = value.chars();
        if !characters
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic())
            || !characters.all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
            })
        {
            return Err(ProtocolSchemeError);
        }
        Ok(Self(value))
    }

    /// Returns the normalized lowercase scheme.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Invalid custom protocol scheme.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProtocolSchemeError;

impl fmt::Display for ProtocolSchemeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "protocol scheme must start with an ASCII letter and contain only letters, digits, +, -, or .",
        )
    }
}

impl Error for ProtocolSchemeError {}

/// Parsed URL delivered through the application lifecycle without exposing the URL backend.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProtocolUrl {
    serialized: String,
    scheme: ProtocolScheme,
}

impl ProtocolUrl {
    /// Parses an absolute URL with a syntactically valid scheme.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, ProtocolUrlError> {
        let parsed = url::Url::parse(value.as_ref()).map_err(|error| ProtocolUrlError {
            message: error.to_string(),
        })?;
        let scheme = ProtocolScheme::new(parsed.scheme()).map_err(|error| ProtocolUrlError {
            message: error.to_string(),
        })?;
        Ok(Self {
            serialized: parsed.into(),
            scheme,
        })
    }

    /// Returns the normalized scheme.
    pub const fn scheme(&self) -> &ProtocolScheme {
        &self.scheme
    }

    /// Returns the serialized absolute URL.
    pub fn as_str(&self) -> &str {
        &self.serialized
    }
}

/// Invalid absolute URL supplied to the application protocol lifecycle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolUrlError {
    message: String,
}

impl fmt::Display for ProtocolUrlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid application URL: {}", self.message)
    }
}

impl Error for ProtocolUrlError {}

pub(crate) fn urls_from_arguments(
    accepted: &[ProtocolScheme],
    arguments: impl IntoIterator<Item = std::ffi::OsString>,
) -> Vec<ProtocolUrl> {
    arguments
        .into_iter()
        .filter_map(|argument| argument.into_string().ok())
        .filter_map(|argument| ProtocolUrl::parse(argument).ok())
        .filter(|url| accepted.contains(url.scheme()))
        .collect()
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
