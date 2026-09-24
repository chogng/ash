use super::*;
use ash_protocol::ContentDigest;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ModelRequest;
use ash_protocol::ProviderId;
use std::collections::HashMap;
use std::fs;
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::time::Duration;
use tempfile::TempDir;
use tokenizers::Tokenizer;
use tokenizers::models::wordlevel::WordLevel;
use tokenizers::pre_tokenizers::whitespace::WhitespaceSplit;

#[test]
fn first_use_downloads_once_and_later_service_reuses_disk_cache() {
    let fixture = ManagedFixture::new();
    let downloader = Arc::new(FixtureDownloader::new(fixture.assets()));
    let service = fixture.service(downloader.clone(), 2);

    assert_eq!(
        service
            .count(&fixture.model, &ModelRequest::text("hello"))
            .unwrap(),
        LocalTokenizationOutcome::Preparing
    );
    downloader.wait_for_downloads(2);
    wait_until(|| service.status(&fixture.model) == TokenizerPreparationStatus::ReadyOnDisk);

    let LocalTokenizationOutcome::Count(count) = service
        .count(&fixture.model, &ModelRequest::text("hello"))
        .unwrap()
    else {
        panic!("prepared assets should load and count");
    };
    assert_eq!(count.tokens(), 3);
    assert_eq!(downloader.download_count(), 2);

    let restarted = fixture.service(downloader.clone(), 2);
    let LocalTokenizationOutcome::Count(_) = restarted
        .count(&fixture.model, &ModelRequest::text("hello"))
        .unwrap()
    else {
        panic!("a restarted service should reuse disk assets");
    };
    assert_eq!(downloader.download_count(), 2);
}

#[cfg(windows)]
#[test]
fn tokenizer_cache_under_a_long_root_survives_restart() {
    use std::os::windows::ffi::OsStrExt;

    let fixture = ManagedFixture::new();
    let cache_root = fixture
        .cache
        .path()
        .join("a".repeat(110))
        .join("b".repeat(110));
    assert!(cache_root.as_os_str().encode_wide().count() >= 260);
    let mut catalog = TokenizerAssetCatalog::new();
    catalog
        .register(fixture.manifest(fixture.model.clone()))
        .unwrap();
    let downloader = Arc::new(FixtureDownloader::new(fixture.assets()));
    let service = ManagedLocalTokenizerService::new(
        &cache_root,
        catalog.clone(),
        downloader.clone(),
        MemoryTokenizerCapacity::default(),
    )
    .unwrap();

    prepare_and_load(&service, &fixture.model, &downloader, 2);

    let restarted = ManagedLocalTokenizerService::new(
        &cache_root,
        catalog,
        Arc::new(FailingDownloader::default()),
        MemoryTokenizerCapacity::default(),
    )
    .unwrap();
    assert!(matches!(
        restarted.count(&fixture.model, &ModelRequest::text("hello")),
        Ok(LocalTokenizationOutcome::Count(_))
    ));
}

#[test]
fn concurrent_cache_misses_share_one_background_preparation() {
    let fixture = ManagedFixture::new();
    let downloader = Arc::new(FixtureDownloader::new(fixture.assets()));
    let service = fixture.service(downloader.clone(), 2);

    assert_eq!(
        service
            .count(&fixture.model, &ModelRequest::text("one"))
            .unwrap(),
        LocalTokenizationOutcome::Preparing
    );
    assert_eq!(
        service
            .count(&fixture.model, &ModelRequest::text("two"))
            .unwrap(),
        LocalTokenizationOutcome::Preparing
    );
    downloader.wait_for_downloads(2);
    wait_until(|| service.status(&fixture.model) == TokenizerPreparationStatus::ReadyOnDisk);
    assert_eq!(downloader.download_count(), 2);
}

#[test]
fn failed_download_stays_unavailable_instead_of_retrying_every_request() {
    let fixture = ManagedFixture::new();
    let downloader = Arc::new(FailingDownloader::default());
    let service = fixture.service(downloader.clone(), 2);

    assert_eq!(
        service
            .count(&fixture.model, &ModelRequest::text("hello"))
            .unwrap(),
        LocalTokenizationOutcome::Preparing
    );
    wait_until(|| service.status(&fixture.model) == TokenizerPreparationStatus::Failed);
    assert_eq!(
        service
            .count(&fixture.model, &ModelRequest::text("hello"))
            .unwrap(),
        LocalTokenizationOutcome::Unavailable
    );
    assert_eq!(downloader.attempts(), 1);
}

#[test]
fn lru_evicts_only_memory_and_reloads_the_disk_asset_without_downloading() {
    let fixture = ManagedFixture::new();
    let second_model = model_ref("huggingface", "org/second");
    let mut catalog = TokenizerAssetCatalog::new();
    catalog
        .register(fixture.manifest(fixture.model.clone()))
        .unwrap();
    catalog
        .register(fixture.manifest(second_model.clone()))
        .unwrap();
    let downloader = Arc::new(FixtureDownloader::new(fixture.assets()));
    let service = ManagedLocalTokenizerService::new(
        fixture.cache.path(),
        catalog,
        downloader.clone(),
        MemoryTokenizerCapacity::new(NonZeroUsize::new(1).unwrap()),
    )
    .unwrap();

    prepare_and_load(&service, &fixture.model, &downloader, 2);
    prepare_and_load(&service, &second_model, &downloader, 4);
    assert_eq!(
        service.status(&fixture.model),
        TokenizerPreparationStatus::ReadyOnDisk
    );
    assert_eq!(
        service.status(&second_model),
        TokenizerPreparationStatus::Loaded
    );

    let LocalTokenizationOutcome::Count(_) = service
        .count(&fixture.model, &ModelRequest::text("hello"))
        .unwrap()
    else {
        panic!("evicted tokenizer should reload from disk");
    };
    assert_eq!(downloader.download_count(), 4);
    assert_eq!(
        service.status(&fixture.model),
        TokenizerPreparationStatus::Loaded
    );
    assert_eq!(
        service.status(&second_model),
        TokenizerPreparationStatus::ReadyOnDisk
    );
}

#[test]
fn discovered_manifest_survives_restart_without_network_discovery() {
    let fixture = ManagedFixture::new();
    let downloader = Arc::new(FixtureDownloader::new(fixture.assets()));
    let discoverer = Arc::new(FixtureDiscoverer::new(
        fixture.manifest(fixture.model.clone()),
    ));
    let service = ManagedLocalTokenizerService::new(
        fixture.cache.path(),
        TokenizerAssetCatalog::new(),
        downloader.clone(),
        MemoryTokenizerCapacity::default(),
    )
    .unwrap()
    .with_discoverer(discoverer.clone());

    assert_eq!(
        service
            .count_input_tokens(&fixture.model, &ModelRequest::text("hello"))
            .unwrap(),
        LocalTokenizationOutcome::Preparing
    );
    downloader.wait_for_downloads(2);
    wait_until(|| service.status(&fixture.model) == TokenizerPreparationStatus::ReadyOnDisk);
    assert_eq!(discoverer.discoveries(), 1);

    let restarted = ManagedLocalTokenizerService::new(
        fixture.cache.path(),
        TokenizerAssetCatalog::new(),
        Arc::new(FailingDownloader::default()),
        MemoryTokenizerCapacity::default(),
    )
    .unwrap()
    .with_discoverer(Arc::new(FixtureDiscoverer::new(
        fixture.manifest(fixture.model.clone()),
    )));
    assert!(matches!(
        restarted
            .count_input_tokens(&fixture.model, &ModelRequest::text("hello"))
            .unwrap(),
        LocalTokenizationOutcome::Count(_)
    ));
}

fn prepare_and_load(
    service: &ManagedLocalTokenizerService,
    model: &ModelRef,
    downloader: &FixtureDownloader,
    expected_downloads: usize,
) {
    assert_eq!(
        service.count(model, &ModelRequest::text("hello")).unwrap(),
        LocalTokenizationOutcome::Preparing
    );
    downloader.wait_for_downloads(expected_downloads);
    wait_until(|| service.status(model) == TokenizerPreparationStatus::ReadyOnDisk);
    assert!(matches!(
        service.count(model, &ModelRequest::text("hello")).unwrap(),
        LocalTokenizationOutcome::Count(_)
    ));
}

struct ManagedFixture {
    cache: TempDir,
    model: ModelRef,
    tokenizer: Vec<u8>,
    template: Vec<u8>,
}

impl ManagedFixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let tokenizer_path = directory.path().join("tokenizer.json");
        let vocab = [
            ("<unk>".to_string(), 0),
            ("user".to_string(), 1),
            ("hello".to_string(), 2),
            ("assistant".to_string(), 3),
        ]
        .into_iter()
        .collect();
        let model = WordLevel::builder()
            .vocab(vocab)
            .unk_token("<unk>".into())
            .build()
            .unwrap();
        let mut tokenizer = Tokenizer::new(model);
        tokenizer.with_pre_tokenizer(Some(WhitespaceSplit));
        tokenizer.save(&tokenizer_path, false).unwrap();
        let tokenizer = fs::read(&tokenizer_path).unwrap();
        let template = serde_json::to_vec(&serde_json::json!({
            "chat_template": "{% for message in messages %}{{ message.role }} {{ message.content }} {% endfor %}{% if add_generation_prompt %}assistant{% endif %}"
        }))
        .unwrap();
        Self {
            cache: tempfile::tempdir().unwrap(),
            model: model_ref("huggingface", "org/model"),
            tokenizer,
            template,
        }
    }

    fn assets(&self) -> HashMap<String, Vec<u8>> {
        HashMap::from([
            (
                "https://assets.test/tokenizer.json".into(),
                self.tokenizer.clone(),
            ),
            (
                "https://assets.test/chat_template.jinja".into(),
                self.template.clone(),
            ),
        ])
    }

    fn manifest(&self, model: ModelRef) -> TokenizerAssetManifest {
        TokenizerAssetManifest::new(
            model,
            "commit-123",
            RemoteTokenizerAsset::new(
                "https://assets.test/tokenizer.json",
                ContentDigest::sha256(&self.tokenizer),
            )
            .unwrap(),
            RemoteTokenizerAsset::new(
                "https://assets.test/chat_template.jinja",
                ContentDigest::sha256(&self.template),
            )
            .unwrap(),
        )
        .unwrap()
    }

    fn service(
        &self,
        downloader: Arc<dyn TokenizerAssetDownloader>,
        capacity: usize,
    ) -> ManagedLocalTokenizerService {
        let mut catalog = TokenizerAssetCatalog::new();
        catalog.register(self.manifest(self.model.clone())).unwrap();
        ManagedLocalTokenizerService::new(
            self.cache.path(),
            catalog,
            downloader,
            MemoryTokenizerCapacity::new(NonZeroUsize::new(capacity).unwrap()),
        )
        .unwrap()
    }
}

struct FixtureDownloader {
    assets: HashMap<String, Vec<u8>>,
    state: Mutex<usize>,
    changed: Condvar,
}

struct FixtureDiscoverer {
    manifest: TokenizerAssetManifest,
    discoveries: Mutex<usize>,
}

impl FixtureDiscoverer {
    fn new(manifest: TokenizerAssetManifest) -> Self {
        Self {
            manifest,
            discoveries: Mutex::new(0),
        }
    }

    fn discoveries(&self) -> usize {
        *self.discoveries.lock().unwrap()
    }
}

impl TokenizerAssetDiscoverer for FixtureDiscoverer {
    fn supports(&self, model: &ModelRef) -> bool {
        self.manifest.model() == model
    }

    fn discover(&self, model: &ModelRef) -> Result<TokenizerAssetManifest, LocalTokenizerError> {
        assert!(self.supports(model));
        *self.discoveries.lock().unwrap() += 1;
        Ok(self.manifest.clone())
    }
}

impl FixtureDownloader {
    fn new(assets: HashMap<String, Vec<u8>>) -> Self {
        Self {
            assets,
            state: Mutex::new(0),
            changed: Condvar::new(),
        }
    }

    fn download_count(&self) -> usize {
        *self.state.lock().unwrap()
    }

    fn wait_for_downloads(&self, expected: usize) {
        let state = self.state.lock().unwrap();
        let (state, timeout) = self
            .changed
            .wait_timeout_while(state, Duration::from_secs(2), |count| *count < expected)
            .unwrap();
        assert!(!timeout.timed_out(), "downloads did not finish");
        assert_eq!(*state, expected);
    }
}

impl TokenizerAssetDownloader for FixtureDownloader {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, LocalTokenizerError> {
        let bytes = self
            .assets
            .get(url)
            .cloned()
            .ok_or_else(|| LocalTokenizerError::Download("missing fixture asset".into()))?;
        *self.state.lock().unwrap() += 1;
        self.changed.notify_all();
        Ok(bytes)
    }
}

#[derive(Default)]
struct FailingDownloader(Mutex<usize>);

impl FailingDownloader {
    fn attempts(&self) -> usize {
        *self.0.lock().unwrap()
    }
}

impl TokenizerAssetDownloader for FailingDownloader {
    fn fetch(&self, _: &str) -> Result<Vec<u8>, LocalTokenizerError> {
        *self.0.lock().unwrap() += 1;
        Err(LocalTokenizerError::Download("offline".into()))
    }
}

fn wait_until(predicate: impl Fn() -> bool) {
    for _ in 0..200 {
        if predicate() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("condition did not become true");
}

fn model_ref(provider: &str, model: &str) -> ModelRef {
    ModelRef::new(
        ProviderId::new(provider).unwrap(),
        ModelId::new(model).unwrap(),
    )
}
