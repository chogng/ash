use crate::LocalTokenizerError;
use ash_protocol::ContentDigest;
use ash_protocol::ModelRef;
use std::path::PathBuf;

/// One immutable local tokenizer file with both upstream revision provenance and byte identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PinnedTokenizerAsset {
    path: PathBuf,
    revision: String,
    digest: ContentDigest,
}

impl PinnedTokenizerAsset {
    pub fn new(
        path: impl Into<PathBuf>,
        revision: impl Into<String>,
        digest: ContentDigest,
    ) -> Result<Self, LocalTokenizerError> {
        let revision = revision.into();
        if revision.trim().is_empty() {
            return Err(LocalTokenizerError::MissingRevision);
        }
        Ok(Self {
            path: path.into(),
            revision,
            digest,
        })
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }

    pub fn digest(&self) -> &ContentDigest {
        &self.digest
    }
}

/// Exact model binding for one tokenizer and one chat-template asset.
///
/// Hosts construct bindings only from already installed files. The registry verifies both file
/// digests before loading them; it never downloads assets or resolves a moving Hub branch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalTokenizerBinding {
    model: ModelRef,
    tokenizer: PinnedTokenizerAsset,
    template_source: PinnedTokenizerAsset,
    template_globals: serde_json::Map<String, serde_json::Value>,
}

impl LocalTokenizerBinding {
    pub fn new(
        model: ModelRef,
        tokenizer: PinnedTokenizerAsset,
        template_source: PinnedTokenizerAsset,
    ) -> Self {
        Self {
            model,
            tokenizer,
            template_source,
            template_globals: serde_json::Map::new(),
        }
    }

    pub fn with_template_globals(
        mut self,
        globals: serde_json::Map<String, serde_json::Value>,
    ) -> Self {
        self.template_globals = globals;
        self
    }

    pub fn model(&self) -> &ModelRef {
        &self.model
    }

    pub fn tokenizer(&self) -> &PinnedTokenizerAsset {
        &self.tokenizer
    }

    pub fn template_source(&self) -> &PinnedTokenizerAsset {
        &self.template_source
    }

    pub fn template_globals(&self) -> &serde_json::Map<String, serde_json::Value> {
        &self.template_globals
    }
}
