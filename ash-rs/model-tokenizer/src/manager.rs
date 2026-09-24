use crate::LocalTokenizationOutcome;
use crate::LocalTokenizerBinding;
use crate::LocalTokenizerError;
use crate::LocalTokenizerService;
use crate::PinnedTokenizerAsset;
use crate::RemoteTokenizerAsset;
use crate::TokenizerAssetCatalog;
use crate::TokenizerAssetDiscoverer;
use crate::TokenizerAssetDownloader;
use crate::registry::LoadedTokenizer;
use ash_protocol::ContentDigest;
use ash_protocol::ModelRef;
use ash_protocol::ModelRequest;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MemoryTokenizerCapacity(NonZeroUsize);

impl MemoryTokenizerCapacity {
    pub const fn new(value: NonZeroUsize) -> Self {
        Self(value)
    }

    pub const fn get(self) -> usize {
        self.0.get()
    }
}

impl Default for MemoryTokenizerCapacity {
    fn default() -> Self {
        Self(NonZeroUsize::new(4).expect("four is non-zero"))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TokenizerPreparationStatus {
    Unregistered,
    NotPrepared,
    Preparing,
    ReadyOnDisk,
    Loaded,
    Failed,
}

/// On-demand tokenizer service with immutable disk assets and bounded in-memory instances.
///
/// A cache miss starts at most one background preparation per model and returns `Preparing` to the
/// caller. Successful assets remain on disk across process restarts. The in-memory cache evicts
/// the least recently used tokenizer when its configured capacity is exceeded.
pub struct ManagedLocalTokenizerService {
    cache_root: PathBuf,
    catalog: Arc<TokenizerAssetCatalog>,
    discoverer: Option<Arc<dyn TokenizerAssetDiscoverer>>,
    downloader: Arc<dyn TokenizerAssetDownloader>,
    capacity: MemoryTokenizerCapacity,
    state: Arc<Mutex<ManagerState>>,
}

impl ManagedLocalTokenizerService {
    pub fn new(
        cache_root: impl Into<PathBuf>,
        catalog: TokenizerAssetCatalog,
        downloader: Arc<dyn TokenizerAssetDownloader>,
        capacity: MemoryTokenizerCapacity,
    ) -> Result<Self, LocalTokenizerError> {
        let cache_root = cache_root.into();
        if cache_root.as_os_str().is_empty() {
            return Err(LocalTokenizerError::InvalidCacheRoot);
        }
        Ok(Self {
            cache_root,
            catalog: Arc::new(catalog),
            discoverer: None,
            downloader,
            capacity,
            state: Arc::new(Mutex::new(ManagerState::default())),
        })
    }

    pub fn with_discoverer(mut self, discoverer: Arc<dyn TokenizerAssetDiscoverer>) -> Self {
        self.discoverer = Some(discoverer);
        self
    }

    pub fn status(&self, model: &ModelRef) -> TokenizerPreparationStatus {
        if !self.supports(model) {
            return TokenizerPreparationStatus::Unregistered;
        }
        let state = self.state.lock().expect("tokenizer manager lock poisoned");
        if state.loaded.contains_key(model) {
            TokenizerPreparationStatus::Loaded
        } else if state.preparing.contains_key(model) {
            TokenizerPreparationStatus::Preparing
        } else if state.failed.contains_key(model) {
            TokenizerPreparationStatus::Failed
        } else if resolved_manifest(&self.cache_root, &self.catalog, &state, model)
            .is_some_and(|manifest| cached_binding(&self.cache_root, &manifest).is_ok())
        {
            TokenizerPreparationStatus::ReadyOnDisk
        } else {
            TokenizerPreparationStatus::NotPrepared
        }
    }

    fn load_cached(
        &self,
        model: &ModelRef,
    ) -> Result<Option<Arc<LoadedTokenizer>>, LocalTokenizerError> {
        let manifest = {
            let state = self.state.lock().expect("tokenizer manager lock poisoned");
            resolved_manifest(&self.cache_root, &self.catalog, &state, model)
        };
        let Some(manifest) = manifest else {
            return Ok(None);
        };
        let binding = match cached_binding(&self.cache_root, &manifest) {
            Ok(binding) => binding,
            Err(LocalTokenizerError::ReadAsset { source, .. })
                if source.kind() == std::io::ErrorKind::NotFound =>
            {
                return Ok(None);
            }
            Err(LocalTokenizerError::DigestMismatch { .. }) => return Ok(None),
            Err(error) => return Err(error),
        };
        Ok(Some(Arc::new(LoadedTokenizer::load(&binding)?)))
    }

    fn insert_loaded(&self, model: ModelRef, tokenizer: Arc<LoadedTokenizer>) {
        let mut state = self.state.lock().expect("tokenizer manager lock poisoned");
        state.clock = state.clock.saturating_add(1);
        let last_used = state.clock;
        state.loaded.insert(
            model,
            LoadedEntry {
                tokenizer,
                last_used,
            },
        );
        while state.loaded.len() > self.capacity.get() {
            let Some(evicted) = state
                .loaded
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(model, _)| model.clone())
            else {
                break;
            };
            state.loaded.remove(&evicted);
        }
    }

    fn loaded(&self, model: &ModelRef) -> Option<Arc<LoadedTokenizer>> {
        let mut state = self.state.lock().expect("tokenizer manager lock poisoned");
        state.clock = state.clock.saturating_add(1);
        let last_used = state.clock;
        let entry = state.loaded.get_mut(model)?;
        entry.last_used = last_used;
        Some(entry.tokenizer.clone())
    }

    fn ensure_preparing(&self, model: &ModelRef) {
        {
            let mut state = self.state.lock().expect("tokenizer manager lock poisoned");
            if state.preparing.contains_key(model) {
                return;
            }
            state.preparing.insert(model.clone(), ());
            state.failed.remove(model);
        }
        let cache_root = self.cache_root.clone();
        let catalog = self.catalog.clone();
        let discoverer = self.discoverer.clone();
        let downloader = self.downloader.clone();
        let state = self.state.clone();
        let model = model.clone();
        thread::spawn(move || {
            let manifest = catalog
                .get(&model)
                .cloned()
                .map(Ok)
                .or_else(|| discoverer.map(|discoverer| discoverer.discover(&model)))
                .unwrap_or_else(|| {
                    Err(LocalTokenizerError::Discovery(
                        "no tokenizer asset manifest or discoverer".into(),
                    ))
                });
            let result = manifest.and_then(|manifest| {
                prepare_manifest(&cache_root, &manifest, downloader.as_ref())?;
                publish_manifest_receipt(&cache_root, &manifest)?;
                state
                    .lock()
                    .expect("tokenizer manager lock poisoned")
                    .discovered
                    .insert(model.clone(), manifest);
                Ok(())
            });
            let mut state = state.lock().expect("tokenizer manager lock poisoned");
            state.preparing.remove(&model);
            match result {
                Ok(()) => {
                    state.failed.remove(&model);
                }
                Err(error) => {
                    state.failed.insert(model, error.to_string());
                }
            }
        });
    }
}

impl LocalTokenizerService for ManagedLocalTokenizerService {
    fn supports(&self, model: &ModelRef) -> bool {
        self.catalog.get(model).is_some()
            || self
                .discoverer
                .as_ref()
                .is_some_and(|discoverer| discoverer.supports(model))
    }

    fn count_input_tokens(
        &self,
        model: &ModelRef,
        request: &ModelRequest,
    ) -> Result<LocalTokenizationOutcome, LocalTokenizerError> {
        if !self.supports(model) {
            return Ok(LocalTokenizationOutcome::UnsupportedRequest);
        }
        if let Some(tokenizer) = self.loaded(model) {
            return tokenizer.count(request);
        }
        if let Some(tokenizer) = self.load_cached(model)? {
            self.insert_loaded(model.clone(), tokenizer.clone());
            return tokenizer.count(request);
        }
        if self
            .state
            .lock()
            .expect("tokenizer manager lock poisoned")
            .failed
            .contains_key(model)
        {
            return Ok(LocalTokenizationOutcome::Unavailable);
        }
        self.ensure_preparing(model);
        Ok(LocalTokenizationOutcome::Preparing)
    }
}

#[derive(Default)]
struct ManagerState {
    clock: u64,
    loaded: HashMap<ModelRef, LoadedEntry>,
    preparing: HashMap<ModelRef, ()>,
    failed: HashMap<ModelRef, String>,
    discovered: HashMap<ModelRef, crate::TokenizerAssetManifest>,
}

struct LoadedEntry {
    tokenizer: Arc<LoadedTokenizer>,
    last_used: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestReceipt {
    provider: String,
    model: String,
    revision: String,
    tokenizer_url: String,
    tokenizer_digest: String,
    template_digest: String,
    template_globals: serde_json::Map<String, serde_json::Value>,
}

fn manifest_from_state(
    catalog: &TokenizerAssetCatalog,
    state: &ManagerState,
    model: &ModelRef,
) -> Option<crate::TokenizerAssetManifest> {
    catalog
        .get(model)
        .cloned()
        .or_else(|| state.discovered.get(model).cloned())
}

fn resolved_manifest(
    cache_root: &Path,
    catalog: &TokenizerAssetCatalog,
    state: &ManagerState,
    model: &ModelRef,
) -> Option<crate::TokenizerAssetManifest> {
    manifest_from_state(catalog, state, model)
        .or_else(|| load_manifest_receipt(cache_root, model).ok())
}

fn prepare_manifest(
    cache_root: &Path,
    manifest: &crate::TokenizerAssetManifest,
    downloader: &dyn TokenizerAssetDownloader,
) -> Result<(), LocalTokenizerError> {
    let directory = cache_directory(cache_root, manifest);
    let tokenizer_path = directory.join("tokenizer.json");
    let template_path = directory.join("tokenizer_config.json");
    prepare_asset(&tokenizer_path, manifest.tokenizer(), downloader)?;
    prepare_asset(&template_path, manifest.template_source(), downloader)?;
    let binding = cached_binding(cache_root, manifest)?;
    LoadedTokenizer::load(&binding)?;
    Ok(())
}

fn publish_manifest_receipt(
    cache_root: &Path,
    manifest: &crate::TokenizerAssetManifest,
) -> Result<(), LocalTokenizerError> {
    let receipt = ManifestReceipt {
        provider: manifest.model().provider.as_str().into(),
        model: manifest.model().model.as_str().into(),
        revision: manifest.revision().into(),
        tokenizer_url: manifest.tokenizer().url().into(),
        tokenizer_digest: manifest.tokenizer().digest().to_string(),
        template_digest: manifest.template_source().digest().to_string(),
        template_globals: manifest.template_globals().clone(),
    };
    let bytes = serde_json::to_vec_pretty(&receipt)
        .map_err(|error| LocalTokenizerError::Discovery(error.to_string()))?;
    let path = manifest_receipt_path(cache_root, manifest.model());
    ash_utils_path::write_atomically(&path, &bytes)
        .map_err(|source| LocalTokenizerError::PublishAsset { path, source })
}

fn load_manifest_receipt(
    cache_root: &Path,
    model: &ModelRef,
) -> Result<crate::TokenizerAssetManifest, LocalTokenizerError> {
    let path = manifest_receipt_path(cache_root, model);
    let bytes = std::fs::read(&path).map_err(|source| LocalTokenizerError::ReadAsset {
        path: path.clone(),
        source,
    })?;
    let receipt: ManifestReceipt = serde_json::from_slice(&bytes)
        .map_err(|error| LocalTokenizerError::Discovery(error.to_string()))?;
    if receipt.provider != model.provider.as_str() || receipt.model != model.model.as_str() {
        return Err(LocalTokenizerError::Discovery(
            "cached tokenizer manifest model identity does not match its path".into(),
        ));
    }
    let tokenizer_digest = ContentDigest::new(receipt.tokenizer_digest)
        .map_err(|error| LocalTokenizerError::Discovery(error.to_string()))?;
    let template_digest = ContentDigest::new(receipt.template_digest)
        .map_err(|error| LocalTokenizerError::Discovery(error.to_string()))?;
    let directory = cache_directory_for(cache_root, model, &receipt.revision);
    let template_path = directory.join("tokenizer_config.json");
    let template =
        std::fs::read(&template_path).map_err(|source| LocalTokenizerError::ReadAsset {
            path: template_path.clone(),
            source,
        })?;
    let actual_template_digest = ContentDigest::sha256(&template);
    if actual_template_digest != template_digest {
        return Err(LocalTokenizerError::DigestMismatch {
            path: template_path,
            expected: template_digest,
            actual: actual_template_digest,
        });
    }
    crate::TokenizerAssetManifest::new(
        model.clone(),
        receipt.revision,
        RemoteTokenizerAsset::new(receipt.tokenizer_url, tokenizer_digest)?,
        RemoteTokenizerAsset::inline("cached chat template", template),
    )
    .map(|manifest| manifest.with_template_globals(receipt.template_globals))
}

fn prepare_asset(
    path: &Path,
    asset: &RemoteTokenizerAsset,
    downloader: &dyn TokenizerAssetDownloader,
) -> Result<(), LocalTokenizerError> {
    if let Ok(bytes) = std::fs::read(path)
        && ContentDigest::sha256(&bytes) == *asset.digest()
    {
        return Ok(());
    }
    let bytes = downloader.download(asset)?;
    let actual = ContentDigest::sha256(&bytes);
    if &actual != asset.digest() {
        return Err(LocalTokenizerError::DigestMismatch {
            path: path.to_path_buf(),
            expected: asset.digest().clone(),
            actual,
        });
    }
    ash_utils_path::write_atomically(path, &bytes).map_err(|source| {
        LocalTokenizerError::PublishAsset {
            path: path.to_path_buf(),
            source,
        }
    })
}

fn cached_binding(
    cache_root: &Path,
    manifest: &crate::TokenizerAssetManifest,
) -> Result<LocalTokenizerBinding, LocalTokenizerError> {
    let directory = cache_directory(cache_root, manifest);
    let tokenizer = pinned_cached_asset(
        directory.join("tokenizer.json"),
        manifest.revision(),
        manifest.tokenizer().digest().clone(),
    )?;
    let template_source = pinned_cached_asset(
        directory.join("tokenizer_config.json"),
        manifest.revision(),
        manifest.template_source().digest().clone(),
    )?;
    Ok(
        LocalTokenizerBinding::new(manifest.model().clone(), tokenizer, template_source)
            .with_template_globals(manifest.template_globals().clone()),
    )
}

fn pinned_cached_asset(
    path: PathBuf,
    revision: &str,
    digest: ContentDigest,
) -> Result<PinnedTokenizerAsset, LocalTokenizerError> {
    let bytes = std::fs::read(&path).map_err(|source| LocalTokenizerError::ReadAsset {
        path: path.clone(),
        source,
    })?;
    let actual = ContentDigest::sha256(&bytes);
    if actual != digest {
        return Err(LocalTokenizerError::DigestMismatch {
            path,
            expected: digest,
            actual,
        });
    }
    PinnedTokenizerAsset::new(path, revision, actual)
}

fn cache_directory(cache_root: &Path, manifest: &crate::TokenizerAssetManifest) -> PathBuf {
    cache_directory_for(cache_root, manifest.model(), manifest.revision())
}

fn cache_directory_for(cache_root: &Path, model: &ModelRef, revision: &str) -> PathBuf {
    let identity = serde_json::to_vec(&(model.provider.as_str(), model.model.as_str(), revision))
        .expect("tokenizer cache identity always serializes");
    cache_root.join(digest_directory(&identity))
}

fn digest_directory(bytes: &[u8]) -> String {
    ContentDigest::sha256(bytes)
        .as_str()
        .trim_start_matches("sha256:")
        .into()
}

fn manifest_receipt_path(cache_root: &Path, model: &ModelRef) -> PathBuf {
    cache_root
        .join("manifests")
        .join(digest_directory(model.provider.as_str().as_bytes()))
        .join(format!(
            "{}.json",
            digest_directory(model.model.as_str().as_bytes())
        ))
}
