/// Stable identity for one mounted UI object across presentation rebuilds.
///
/// Component hosts allocate the scope and local value. Dynamic consumers such as file trees,
/// editors, interaction nodes, and retained scene fragments should keep the same identity while
/// the represented object remains mounted.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ElementId(u64);

impl ElementId {
    /// Creates an identity from its stable packed representation.
    pub const fn from_raw(value: u64) -> Self {
        Self(value)
    }

    pub const fn scoped(scope: u32, local: u32) -> Self {
        Self(((scope as u64) << 32) | local as u64)
    }

    /// Returns the stable packed representation.
    pub const fn into_raw(self) -> u64 {
        self.0
    }
}
