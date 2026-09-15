use crate::LocalTokenizerError;
use crate::RemoteTokenizerAsset;
use crate::TokenizerAssetDownloader;
use crate::TokenizerAssetManifest;
use ash_protocol::ModelRef;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

/// Resolves an exact provider/model selection into one immutable asset manifest.
///
/// Implementations may perform network discovery. They must resolve moving aliases to immutable
/// revisions and compute content digests before returning the manifest.
pub trait TokenizerAssetDiscoverer: Send + Sync {
    fn supports(&self, model: &ModelRef) -> bool;

    fn discover(&self, model: &ModelRef) -> Result<TokenizerAssetManifest, LocalTokenizerError>;
}

pub struct HuggingFaceTokenizerAssetDiscoverer {
    downloader: Arc<dyn TokenizerAssetDownloader>,
}

impl HuggingFaceTokenizerAssetDiscoverer {
    pub fn new(downloader: Arc<dyn TokenizerAssetDownloader>) -> Self {
        Self { downloader }
    }
}

impl TokenizerAssetDiscoverer for HuggingFaceTokenizerAssetDiscoverer {
    fn supports(&self, model: &ModelRef) -> bool {
        model.provider.as_str() == "huggingface" && valid_repository(model.model.as_str())
    }

    fn discover(&self, model: &ModelRef) -> Result<TokenizerAssetManifest, LocalTokenizerError> {
        if !self.supports(model) {
            return Err(LocalTokenizerError::Discovery(
                "model is not a public Hugging Face repository ID".into(),
            ));
        }
        let repository = model.model.as_str();
        let metadata_url = format!("https://huggingface.co/api/models/{repository}/revision/main");
        let metadata = self.downloader.fetch(&metadata_url)?;
        let metadata: ModelMetadata = serde_json::from_slice(&metadata).map_err(|error| {
            LocalTokenizerError::Discovery(format!("invalid Hugging Face model metadata: {error}"))
        })?;
        if metadata.sha.len() != 40 || !metadata.sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(LocalTokenizerError::Discovery(
                "Hugging Face metadata did not return a commit SHA".into(),
            ));
        }

        let tokenizer_url = resolve_url(repository, &metadata.sha, "tokenizer.json");
        let tokenizer_bytes = self.downloader.fetch(&tokenizer_url)?;
        let config_url = resolve_url(repository, &metadata.sha, "tokenizer_config.json");
        let config_bytes = self.downloader.fetch(&config_url)?;
        let template_source = template_source(
            repository,
            &metadata.sha,
            config_bytes,
            self.downloader.as_ref(),
        )?;
        TokenizerAssetManifest::new(
            model.clone(),
            metadata.sha,
            RemoteTokenizerAsset::inline(tokenizer_url, tokenizer_bytes),
            RemoteTokenizerAsset::inline(config_url, template_source),
        )
    }
}

fn template_source(
    repository: &str,
    revision: &str,
    config_bytes: Vec<u8>,
    downloader: &dyn TokenizerAssetDownloader,
) -> Result<Vec<u8>, LocalTokenizerError> {
    let mut config: Value = serde_json::from_slice(&config_bytes).map_err(|error| {
        LocalTokenizerError::Discovery(format!("invalid tokenizer_config.json: {error}"))
    })?;
    let standalone_url = resolve_url(repository, revision, "chat_template.jinja");
    match downloader.fetch(&standalone_url) {
        Ok(bytes) => {
            let template = String::from_utf8(bytes).map_err(|error| {
                LocalTokenizerError::Discovery(format!("invalid chat_template.jinja: {error}"))
            })?;
            let object = config.as_object_mut().ok_or_else(|| {
                LocalTokenizerError::Discovery(
                    "tokenizer_config.json must contain a JSON object".into(),
                )
            })?;
            object.insert("chat_template".into(), Value::String(template));
        }
        Err(LocalTokenizerError::DownloadStatus { status: 404, .. }) => {}
        Err(error) => return Err(error),
    }
    let parsed = serde_json::from_value::<hf_chat_template::TokenizerConfig>(config.clone())
        .map_err(|error| {
            LocalTokenizerError::Discovery(format!(
                "tokenizer config does not contain a supported chat template: {error}"
            ))
        })?;
    if parsed.chat_template.is_none() {
        return Err(LocalTokenizerError::Discovery(
            "tokenizer config does not contain a chat template".into(),
        ));
    }
    serde_json::to_vec(&config).map_err(|error| LocalTokenizerError::Discovery(error.to_string()))
}

#[derive(Deserialize)]
struct ModelMetadata {
    sha: String,
}

fn valid_repository(repository: &str) -> bool {
    let mut parts = repository.split('/');
    let Some(owner) = parts.next() else {
        return false;
    };
    let Some(name) = parts.next() else {
        return false;
    };
    !owner.is_empty()
        && !name.is_empty()
        && parts.next().is_none()
        && repository
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
}

fn resolve_url(repository: &str, revision: &str, file: &str) -> String {
    format!("https://huggingface.co/{repository}/resolve/{revision}/{file}")
}

#[cfg(test)]
#[path = "discovery_tests.rs"]
mod tests;
