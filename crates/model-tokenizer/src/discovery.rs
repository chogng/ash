use crate::LocalTokenizerError;
use crate::TokenizerAssetManifest;
use ash_protocol::ModelRef;

/// Resolves an exact provider/model selection into one immutable asset manifest.
///
/// Implementations may perform network discovery. They must resolve moving aliases to immutable
/// revisions and compute content digests before returning the manifest.
pub trait TokenizerAssetDiscoverer: Send + Sync {
    fn supports(&self, model: &ModelRef) -> bool;

    fn discover(&self, model: &ModelRef) -> Result<TokenizerAssetManifest, LocalTokenizerError>;
}
