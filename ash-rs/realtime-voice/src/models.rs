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

/// Connection-owned operations with explicit release; closing one owner cannot stop another.
#[derive(Default)]
pub struct DictationModelManager {
    operations: Mutex<HashMap<(u64, String), Operation>>,
}

impl DictationModelManager {
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
        let cancellation = Arc::new(CancellationSource::new());
        let token = cancellation.token();
        let on_progress: Arc<dyn Fn(ModelProgress) + Send + Sync> = Arc::new(on_progress);
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
                cancellation,
                worker,
            },
        );
        Ok(())
    }

    /// Repeated release is idempotent, including a release after normal completion.
    pub fn stop(&self, owner: u64, resource_id: &str) -> Result<(), String> {
        let operation = self
            .operations
            .lock()
            .map_err(|_| "Dictation model state unavailable")?
            .remove(&(owner, resource_id.to_owned()));
        if let Some(operation) = operation {
            operation.stop()?;
        }
        Ok(())
    }

    pub fn close(&self, owner: u64) {
        let operations = {
            let mut operations = self.operations.lock().expect("dictation model state");
            let keys = operations
                .keys()
                .filter(|(id, _)| *id == owner)
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .map(|key| operations.remove(&key).expect("owned operation"))
                .collect::<Vec<_>>()
        };
        for operation in &operations {
            operation.cancellation.cancel();
        }
        for operation in operations {
            let _ = operation.stop();
        }
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
