use crate::LocalTokenizerError;
use ash_protocol::ContentDigest;
use ash_protocol::ModelRef;
use serde_json::Value;
use std::collections::HashMap;

/// One remotely available immutable tokenizer asset.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteTokenizerAsset {
    source: RemoteTokenizerAssetSource,
    digest: ContentDigest,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RemoteTokenizerAssetSource {
    Http(String),
    Inline { label: String, bytes: Vec<u8> },
}

impl RemoteTokenizerAsset {
    pub fn new(url: impl Into<String>, digest: ContentDigest) -> Result<Self, LocalTokenizerError> {
        let url = url.into();
        if !is_http_url(&url) {
            return Err(LocalTokenizerError::InvalidAssetUrl);
        }
        Ok(Self {
            source: RemoteTokenizerAssetSource::Http(url),
            digest,
        })
    }

    pub fn inline(label: impl Into<String>, bytes: Vec<u8>) -> Self {
        let digest = ContentDigest::sha256(&bytes);
        Self {
            source: RemoteTokenizerAssetSource::Inline {
                label: label.into(),
                bytes,
            },
            digest,
        }
    }

    pub fn url(&self) -> &str {
        match &self.source {
            RemoteTokenizerAssetSource::Http(url) => url,
            RemoteTokenizerAssetSource::Inline { label, .. } => label,
        }
    }

    pub fn digest(&self) -> &ContentDigest {
        &self.digest
    }

    pub(crate) fn inline_bytes(&self) -> Option<&[u8]> {
        match &self.source {
            RemoteTokenizerAssetSource::Http(_) => None,
            RemoteTokenizerAssetSource::Inline { bytes, .. } => Some(bytes),
        }
    }
}

/// Trusted recipe for preparing tokenizer assets for one exact provider/model selection.
///
/// The revision must identify immutable upstream content, normally a repository commit. Asset
/// digests remain authoritative even when a remote server ignores or aliases that revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenizerAssetManifest {
    model: ModelRef,
    revision: String,
    tokenizer: RemoteTokenizerAsset,
    template_source: RemoteTokenizerAsset,
    template_globals: serde_json::Map<String, Value>,
}

impl TokenizerAssetManifest {
    pub fn new(
        model: ModelRef,
        revision: impl Into<String>,
        tokenizer: RemoteTokenizerAsset,
        template_source: RemoteTokenizerAsset,
    ) -> Result<Self, LocalTokenizerError> {
        let revision = revision.into();
        if revision.trim().is_empty() {
            return Err(LocalTokenizerError::MissingRevision);
        }
        Ok(Self {
            model,
            revision,
            tokenizer,
            template_source,
            template_globals: serde_json::Map::new(),
        })
    }

    pub fn with_template_globals(
        mut self,
        template_globals: serde_json::Map<String, Value>,
    ) -> Self {
        self.template_globals = template_globals;
        self
    }

    pub fn model(&self) -> &ModelRef {
        &self.model
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }

    pub fn tokenizer(&self) -> &RemoteTokenizerAsset {
        &self.tokenizer
    }

    pub fn template_source(&self) -> &RemoteTokenizerAsset {
        &self.template_source
    }

    pub fn template_globals(&self) -> &serde_json::Map<String, Value> {
        &self.template_globals
    }
}

/// Immutable model-to-assets lookup used by the on-demand tokenizer manager.
#[derive(Clone, Default)]
pub struct TokenizerAssetCatalog {
    manifests: HashMap<ModelRef, TokenizerAssetManifest>,
}

impl TokenizerAssetCatalog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &mut self,
        manifest: TokenizerAssetManifest,
    ) -> Result<(), LocalTokenizerError> {
        if self.manifests.contains_key(manifest.model()) {
            return Err(LocalTokenizerError::DuplicateManifest(model_label(
                manifest.model(),
            )));
        }
        self.manifests.insert(manifest.model().clone(), manifest);
        Ok(())
    }

    pub fn get(&self, model: &ModelRef) -> Option<&TokenizerAssetManifest> {
        self.manifests.get(model)
    }

    pub fn into_manifests(self) -> impl Iterator<Item = TokenizerAssetManifest> {
        self.manifests.into_values()
    }
}

fn is_http_url(value: &str) -> bool {
    let Some(authority_and_path) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    else {
        return false;
    };
    let authority = authority_and_path.split('/').next().unwrap_or_default();
    !authority.is_empty() && !authority.chars().any(char::is_whitespace)
}

fn model_label(model: &ModelRef) -> String {
    format!("{}/{}", model.provider, model.model)
}
