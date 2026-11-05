use crate::CatalogScopeKey;
use crate::DiscoveredCatalog;
use crate::merge::CatalogRecord;
use crate::source::CatalogNotModified;
use ash_protocol::ModelId;
use ash_protocol::ProviderId;
use ash_protocol::ReasoningEffort;
use fs2::FileExt;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::Write;
use std::path::PathBuf;

// Version 4 names catalog defaults explicitly; earlier observations must be refreshed.
const SCHEMA_VERSION: u32 = 4;

/// Ash-owned catalog files, one per provider and multiple account scopes per file.
pub(crate) struct DiskCatalogCache {
    directory: PathBuf,
}

#[derive(Default, Deserialize, Serialize)]
struct CacheDocument {
    schema_version: u32,
    catalogs: Vec<CachedCatalog>,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct CachedCatalog {
    #[serde(flatten)]
    pub(crate) observation: DiscoveredCatalog,
    // Defaults can be temporarily absent from the current list of supported efforts.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) reasoning_defaults: BTreeMap<ModelId, ReasoningEffort>,
}

impl CachedCatalog {
    pub(crate) fn new(
        mut observation: DiscoveredCatalog,
        records: &BTreeMap<ModelId, CatalogRecord>,
    ) -> Self {
        let reasoning_defaults = observation
            .models
            .iter_mut()
            .filter_map(|model| {
                let effort = records
                    .get(&model.id)?
                    .retain_observed_reasoning(&mut model.metadata)?;
                Some((model.id.clone(), effort))
            })
            .collect();
        Self {
            observation,
            reasoning_defaults,
        }
    }
}

impl DiskCatalogCache {
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    pub(crate) fn load(&self, scope: &CatalogScopeKey) -> io::Result<Option<CachedCatalog>> {
        if !self.directory.exists() {
            return Ok(None);
        }
        let path = self.path_for(scope.provider());
        let lock = Self::lock_file(&path)?;
        lock.lock_shared()?;
        let document = Self::read_document(&path, scope.provider())?;
        Ok(document
            .catalogs
            .into_iter()
            .find(|catalog| &catalog.observation.scope == scope))
    }

    pub(crate) fn store(&self, catalog: CachedCatalog) -> io::Result<()> {
        std::fs::create_dir_all(&self.directory)?;
        let path = self.path_for(catalog.observation.scope.provider());
        let lock = Self::lock_file(&path)?;
        lock.lock_exclusive()?;
        let mut document = Self::read_document(&path, catalog.observation.scope.provider())?;
        document
            .catalogs
            .retain(|entry| entry.observation.scope != catalog.observation.scope);
        document.catalogs.push(catalog);
        document.schema_version = SCHEMA_VERSION;
        self.write_document(&path, &document)
    }

    pub(crate) fn touch(&self, observation: &CatalogNotModified) -> io::Result<()> {
        if !self.directory.exists() {
            return Ok(());
        }
        let path = self.path_for(observation.scope.provider());
        let lock = Self::lock_file(&path)?;
        lock.lock_exclusive()?;
        let mut document = Self::read_document(&path, observation.scope.provider())?;
        let Some(catalog) = document
            .catalogs
            .iter_mut()
            .map(|entry| &mut entry.observation)
            .find(|entry| entry.scope == observation.scope)
        else {
            return Ok(());
        };
        catalog.observed_at = observation.observed_at;
        catalog.cache_hint = observation.cache_hint;
        if let Some(validator) = &observation.validator {
            catalog.validator = Some(validator.clone());
        }
        self.write_document(&path, &document)
    }

    fn path_for(&self, provider: &ProviderId) -> PathBuf {
        let mut name = String::new();
        for byte in provider.as_str().bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_') {
                name.push(char::from(byte));
            } else {
                name.push_str(&format!("%{byte:02X}"));
            }
        }
        self.directory.join(format!("{name}.json"))
    }

    fn lock_file(path: &std::path::Path) -> io::Result<File> {
        let lock_path = path.with_extension("lock");
        OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(lock_path)
    }

    fn read_document(path: &std::path::Path, provider: &ProviderId) -> io::Result<CacheDocument> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(CacheDocument::default());
            }
            Err(error) => return Err(error),
        };
        let document: CacheDocument = match serde_json::from_slice(&bytes) {
            Ok(document) => document,
            Err(error) => {
                log::warn!("discarding invalid model catalog cache: {error}");
                return Ok(CacheDocument::default());
            }
        };
        if document.schema_version != SCHEMA_VERSION {
            return Ok(CacheDocument::default());
        }
        Ok(CacheDocument {
            catalogs: document
                .catalogs
                .into_iter()
                .filter(|catalog| {
                    catalog.observation.scope.provider() == provider
                        && catalog
                            .observation
                            .models
                            .iter()
                            .all(|model| model.metadata.validate().is_ok())
                })
                .collect(),
            ..document
        })
    }

    fn write_document(&self, path: &std::path::Path, document: &CacheDocument) -> io::Result<()> {
        let mut temporary = tempfile::NamedTempFile::new_in(&self.directory)?;
        serde_json::to_writer(&mut temporary, document)?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        temporary.persist(path).map_err(|error| error.error)?;
        Ok(())
    }
}
