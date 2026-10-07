use std::fmt;
use zeroize::Zeroize;

/// An HTTP header whose debug output redacts its value.
#[derive(Clone, Eq, PartialEq)]
pub struct HttpHeader {
    name: String,
    value: String,
}

impl HttpHeader {
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
        }
    }

    /// Checks HTTP header syntax without exposing its value in diagnostics.
    pub fn validate(&self) -> Result<(), crate::HttpClientError> {
        if self.name.is_empty()
            || !self
                .name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
            || self.value.bytes().any(|byte| {
                byte == b'\r' || byte == b'\n' || byte == 127 || byte < 32 && byte != b'\t'
            })
        {
            return Err(crate::HttpClientError::InvalidRequest(
                "invalid HTTP header".into(),
            ));
        }
        Ok(())
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn value(&self) -> &str {
        &self.value
    }
}

impl fmt::Debug for HttpHeader {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HttpHeader")
            .field("name", &self.name)
            .field("value", &"[REDACTED]")
            .finish()
    }
}

impl Drop for HttpHeader {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}
