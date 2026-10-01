//! Model operations never acquire the microphone. Packages are immutable once published.
use crate::DictationManager;
use crate::LocalSpeechMode;
use crate::model_package::ModelPackage;
use async_utils::CancellationSource;
use async_utils::CancellationToken;
use http_client::OutboundNetworkSnapshot;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModelProgress {
    Checking,
    Downloading { file: String, downloaded_bytes: u64 },
    Loading,
    Ready,
    Cancelled,
    Failed { error: String },
}

pub enum ModelOperation {
    Prepare { network: OutboundNetworkSnapshot },
    Import { source: PathBuf },
}

pub struct ModelRequest {
    pub model_root: PathBuf,
    pub model_id: String,
    pub operation: ModelOperation,
}

struct Operation {
    model_id: String,
    cancellation: Arc<CancellationSource>,
    worker: thread::JoinHandle<()>,
}

impl Operation {
    fn stop(self) -> Result<(), String> {
        self.cancellation.cancel();
        self.worker
            .join()
            .map_err(|_| "Dictation model worker failed".into())
    }
}

/// Model preparation belongs to the process; connections only own their progress delivery.
#[derive(Default)]
pub struct DictationModelManager {
    operations: Mutex<HashMap<(u64, String), Operation>>,
    progress: Arc<Mutex<HashMap<String, ModelProgress>>>,
}

impl DictationModelManager {
    pub fn progress(&self, model_id: &str) -> Option<ModelProgress> {
        self.progress
            .lock()
            .expect("dictation model progress")
            .get(model_id)
            .cloned()
    }

    pub fn cancel_model(&self, model_id: &str) -> Result<(), String> {
        ModelPackage::validate_id(model_id)?;
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| "Dictation model state unavailable")?;
        let key = operations
            .iter()
            .find(|(_, operation)| {
                operation.model_id == model_id && !operation.worker.is_finished()
            })
            .map(|(key, _)| key.clone());
        if let Some(key) = key {
            // Keep the model reserved until the worker has stopped and cleaned its staging files.
            let operation = operations.remove(&key).expect("selected operation");
            operation.stop()?;
        }
        Ok(())
    }

    pub fn list(&self, root: &std::path::Path) -> Result<Vec<String>, String> {
        let mut models =
            std::collections::BTreeSet::from([crate::model_package::DEFAULT_MODEL_ID.to_owned()]);
        if root.exists() {
            for entry in std::fs::read_dir(root).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                if entry
                    .file_type()
                    .map_err(|error| error.to_string())?
                    .is_dir()
                    && entry.path().join("dictation-model.json").is_file()
                {
                    let id = entry.file_name().to_string_lossy().into_owned();
                    ModelPackage::validate_id(&id)?;
                    models.insert(id);
                }
            }
        }
        models.extend(
            self.progress
                .lock()
                .expect("dictation model progress")
                .keys()
                .cloned(),
        );
        Ok(models.into_iter().collect())
    }

    pub fn remove(&self, root: &std::path::Path, model_id: &str) -> Result<(), String> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| "Dictation model state unavailable")?;
        if operations
            .values()
            .any(|operation| operation.model_id == model_id && !operation.worker.is_finished())
        {
            return Err("Stop model preparation before deleting the model".into());
        }
        ModelPackage::remove(root, model_id)?;
        self.progress
            .lock()
            .expect("dictation model progress")
            .remove(model_id);
        Ok(())
    }

    pub fn size_bytes(root: &std::path::Path, model_id: &str) -> Result<u64, String> {
        ModelPackage::validate_id(model_id)?;
        let directory = root.join(model_id);
        if !directory.join("dictation-model.json").is_file() {
            return Ok(0);
        }
        [
            "encoder.onnx",
            "decoder.onnx",
            "tokens.txt",
            "dictation-model.json",
        ]
        .iter()
        .try_fold(0, |size, name| {
            std::fs::metadata(directory.join(name))
                .map(|metadata| size + metadata.len())
                .map_err(|error| error.to_string())
        })
    }
    /// Availability describes an installed package, not a currently loaded recognizer.
    pub fn is_available(root: &std::path::Path, model_id: &str) -> Result<bool, String> {
        ModelPackage::validate_id(model_id)?;
        let directory = root.join(model_id);
        if !directory.join("dictation-model.json").is_file() {
            return Ok(false);
        }
        ModelPackage::read(&directory).map(|_| true)
    }

    pub fn start(
        &self,
        owner: u64,
        resource_id: String,
        request: ModelRequest,
        on_progress: impl Fn(ModelProgress) + Send + Sync + 'static,
    ) -> Result<(), String> {
        DictationManager::validate_resource_id(&resource_id)?;
        ModelPackage::validate_id(&request.model_id)?;
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| "Dictation model state unavailable")?;
        let key = (owner, resource_id);
        if operations.contains_key(&key) {
            return Err("Dictation model resource already exists".into());
        }
        if operations.values().any(|operation| {
            operation.model_id == request.model_id && !operation.worker.is_finished()
        }) {
            return Err("Dictation model is already being prepared".into());
        }
        // Completed workers have already published their snapshot; connection lifetime must not retain them.
        let completed: Vec<_> = operations
            .iter()
            .filter(|(_, operation)| operation.worker.is_finished())
            .map(|(key, _)| key.clone())
            .collect();
        for key in completed {
            operations
                .remove(&key)
                .expect("completed operation")
                .worker
                .join()
                .map_err(|_| "Dictation model worker failed")?;
        }
        let model_id = request.model_id.clone();
        let progress_model = model_id.clone();
        let snapshots = Arc::clone(&self.progress);
        snapshots
            .lock()
            .expect("dictation model progress")
            .insert(model_id.clone(), ModelProgress::Checking);
        let cancellation = Arc::new(CancellationSource::new());
        let token = cancellation.token();
        let on_progress: Arc<dyn Fn(ModelProgress) + Send + Sync> = Arc::new(move |progress| {
            snapshots
                .lock()
                .expect("dictation model progress")
                .insert(progress_model.clone(), progress.clone());
            on_progress(progress);
        });
        let worker = thread::Builder::new()
            .name("ash-dictation-model".into())
            .spawn(move || {
                let result = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| error.to_string())
                    .and_then(|runtime| {
                        runtime.block_on(run(request, &token, Arc::clone(&on_progress)))
                    });
                // Exactly one terminal event; stop joins this worker before acknowledging release.
                on_progress(match result {
                    Ok(()) => ModelProgress::Ready,
                    Err(_) if token.is_cancelled() => ModelProgress::Cancelled,
                    Err(error) => ModelProgress::Failed { error },
                });
            })
            .map_err(|error| error.to_string())?;
        operations.insert(
            key,
            Operation {
                model_id,
                cancellation,
                worker,
            },
        );
        Ok(())
    }

    /// Repeated release is idempotent, including a release after normal completion.
    pub fn stop(&self, owner: u64, resource_id: &str) -> Result<(), String> {
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| "Dictation model state unavailable")?;
        let operation = operations.remove(&(owner, resource_id.to_owned()));
        if let Some(operation) = operation {
            operation.stop()?;
        }
        Ok(())
    }
}

impl Drop for DictationModelManager {
    fn drop(&mut self) {
        for (_, operation) in self
            .operations
            .get_mut()
            .expect("dictation model state")
            .drain()
        {
            let _ = operation.stop();
        }
    }
}

async fn run(
    request: ModelRequest,
    token: &CancellationToken,
    progress: Arc<dyn Fn(ModelProgress) + Send + Sync>,
) -> Result<(), String> {
    let package = match request.operation {
        ModelOperation::Prepare { network } => {
            ModelPackage::resolve(
                &request.model_root,
                &request.model_id,
                network,
                token,
                Arc::clone(&progress),
            )
            .await?
        }
        ModelOperation::Import { source } => {
            return ModelPackage::import(
                &request.model_root,
                &request.model_id,
                &source,
                token,
                progress.as_ref(),
            )
            .await;
        }
    };
    token.check().map_err(|error| error.to_string())?;
    progress(ModelProgress::Loading);
    let _recognizer = package.recognizer(LocalSpeechMode::Dictation)?;
    token.check().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
#[path = "models_tests.rs"]
mod tests;
