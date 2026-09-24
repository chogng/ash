//! Stable icon asset identities.

/// Stable lowercase kebab-case identity for one icon asset.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct IconId(&'static str);

impl IconId {
    /// Creates a stable lowercase kebab-case ASCII icon identifier.
    ///
    /// # Panics
    ///
    /// Panics when `value` is empty or is not lowercase kebab-case ASCII.
    pub const fn new(value: &'static str) -> Self {
        assert!(
            valid_icon_id(value),
            "icon ID must be lowercase kebab-case ASCII"
        );
        Self(value)
    }

    /// Returns the persisted textual identity.
    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

const fn valid_icon_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_lowercase() {
        return false;
    }
    let mut index = 1;
    while index < bytes.len() {
        let byte = bytes[index];
        if !(byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || (byte == b'-' && bytes[index - 1] == b'-')
        {
            return false;
        }
        index += 1;
    }
    bytes[bytes.len() - 1] != b'-'
}
