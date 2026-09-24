//! Copyable icon asset values.

use super::{IconDefinition, IconId};

/// A semantic identity paired with immutable artwork.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Icon {
    id: IconId,
    definition: IconDefinition,
}

impl Icon {
    /// Creates an icon asset from an identity and artwork definition.
    pub const fn new(id: IconId, definition: IconDefinition) -> Self {
        Self { id, definition }
    }

    /// Returns the semantic asset identity.
    pub const fn id(self) -> IconId {
        self.id
    }

    /// Returns the immutable artwork definition.
    pub const fn definition(self) -> IconDefinition {
        self.definition
    }
}
