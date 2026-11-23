//! Provider-independent context contributions shared by Core and extension APIs.

/// Whether Core may omit a fragment under context budget pressure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FragmentRetention {
    Required,
    BestEffort,
}

/// Stable provenance used for diagnostics and context reproducibility.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FragmentSource {
    kind: String,
    identity: String,
    revision: String,
    item_count: Option<u64>,
}

impl FragmentSource {
    pub fn new(
        kind: impl Into<String>,
        identity: impl Into<String>,
        revision: impl Into<String>,
    ) -> Self {
        Self {
            kind: kind.into(),
            identity: identity.into(),
            revision: revision.into(),
            item_count: None,
        }
    }

    /// Number of entries represented by a catalog, including entries omitted by its byte limit.
    /// This is diagnostic metadata and does not change the fragment's stable identity.
    pub fn with_item_count(mut self, item_count: u64) -> Self {
        self.item_count = Some(item_count);
        self
    }

    pub fn item_count(&self) -> Option<u64> {
        self.item_count
    }

    pub fn kind(&self) -> &str {
        &self.kind
    }

    pub fn identity(&self) -> &str {
        &self.identity
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }
}

/// Text contributed before context planning. The producer's layer type determines
/// which placements it can request. Core resolves the final position and message role.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextFragment<Layer> {
    source: FragmentSource,
    registered_contributor: Option<&'static str>,
    layer: Layer,
    retention: FragmentRetention,
    body: String,
}

impl<Layer> ContextFragment<Layer> {
    pub fn new(
        source: FragmentSource,
        layer: Layer,
        retention: FragmentRetention,
        body: impl Into<String>,
    ) -> Self {
        Self {
            source,
            registered_contributor: None,
            layer,
            retention,
            body: body.into(),
        }
    }

    pub fn source(&self) -> &FragmentSource {
        &self.source
    }

    /// The collector binds this identity from its registration before forwarding a fragment.
    pub fn with_registered_contributor(mut self, contributor: &'static str) -> Self {
        self.registered_contributor = Some(contributor);
        self
    }

    pub const fn registered_contributor(&self) -> Option<&'static str> {
        self.registered_contributor
    }

    pub const fn layer(&self) -> Layer
    where
        Layer: Copy,
    {
        self.layer
    }

    pub const fn retention(&self) -> FragmentRetention {
        self.retention
    }

    pub fn body(&self) -> &str {
        &self.body
    }

    /// Maps a contributed layer to a resolved placement while preserving the original payload.
    pub fn map_layer<Mapped>(self, map: impl FnOnce(Layer) -> Mapped) -> ContextFragment<Mapped> {
        ContextFragment {
            source: self.source,
            registered_contributor: self.registered_contributor,
            layer: map(self.layer),
            retention: self.retention,
            body: self.body,
        }
    }
}

/// One bounded, revision-bound piece of untrusted evidence supplied to model context.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextEvidence {
    pub source: String,
    pub reference: String,
    pub revision: String,
    pub body: String,
}
