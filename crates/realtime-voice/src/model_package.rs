use crate::LocalSpeechMode;
use crate::ModelProgress;
use async_utils::CancellationToken;
use http_client::HttpBodySink;
use http_client::HttpClient;
use http_client::HttpClientError;
use http_client::HttpMethod;
use http_client::HttpRequest;
use http_client::OutboundNetworkSnapshot;
use http_client::ReqwestHttpClient;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::HashSet;
use std::io::Write;
use std::num::NonZeroUsize;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::LazyLock;
use tokio::fs;
use tokio::io::AsyncWriteExt;

/// Revision of the prepared Sherpa Paraformer package format accepted by this backend.
pub const MODEL_PACKAGE_FORMAT_VERSION: u32 = 1;
const FORMAT: &str = "sherpa-online-paraformer-v1";

pub(crate) static BUILTIN_MODELS: LazyLock<Vec<BuiltinModel>> = LazyLock::new(|| {
    let catalog = include_str!("../models/dictation.json");
    #[cfg(debug_assertions)]
    let catalog_override = std::env::var_os("ASH_DEV_RUNTIME_ROOT")
        .and_then(|_| std::env::var_os("ASH_DEV_DICTATION_CATALOG"))
        .map(|path| {
            let path = Path::new(&path);
            assert!(
                path.is_absolute(),
                "dictation catalog path must be absolute"
            );
            std::fs::read_to_string(path).expect("could not read development dictation catalog")
        });
    #[cfg(debug_assertions)]
    let catalog = catalog_override.as_deref().unwrap_or(catalog);
    let models: Vec<BuiltinModel> =
        serde_json::from_str(catalog).expect("invalid dictation model catalog");
    let mut ids = HashSet::new();
    for model in &models {
        assert!(
            ModelPackage::validate_id(&model.id).is_ok(),
            "invalid built-in dictation model ID: {}",
            model.id
        );
        assert!(
            ids.insert(&model.id),
            "duplicate dictation model ID: {}",
            model.id
        );
    }
    models
});

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BuiltinModel {
    pub id: String,
    pub recommended_language: String,
    base_url: String,
    paraformer: ParaformerMetadata,
    files: DownloadFiles,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ParaformerMetadata {
    vocab_size: NonZeroUsize,
    lfr_window_size: NonZeroUsize,
    lfr_window_shift: NonZeroUsize,
    encoder_output_size: NonZeroUsize,
    decoder_num_blocks: NonZeroUsize,
    decoder_kernel_size: NonZeroUsize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DownloadFiles {
    encoder: DownloadFile,
    decoder: DownloadFile,
    tokens: DownloadFile,
    cmvn: DownloadFile,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DownloadFile {
    name: String,
    sha256: String,
    size_bytes: u64,
}

impl BuiltinModel {
    fn downloads(&self) -> [(&DownloadFile, &'static str); 4] {
        [
            (&self.files.encoder, "encoder.onnx.download"),
            (&self.files.decoder, "decoder.onnx.download"),
            (&self.files.tokens, "tokens.json"),
            (&self.files.cmvn, "am.mvn"),
        ]
    }

    pub(crate) fn download_size_bytes(&self) -> u64 {
        self.downloads()
            .iter()
            .map(|(file, _)| file.size_bytes)
            .sum()
    }
}

pub(crate) struct ModelPackage {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub tokens: PathBuf,
}

impl ModelPackage {
    pub(crate) fn remove(root: &Path, model_id: &str) -> Result<(), String> {
        Self::validate_id(model_id)?;
        let directory = root.join(model_id);
        let _installation = Installation::new(root, model_id)?;
        let metadata = std::fs::symlink_metadata(&directory).map_err(|error| error.to_string())?;
        if metadata.is_symlink()
            || !metadata.is_dir()
            || !directory
                .canonicalize()
                .map_err(|error| error.to_string())?
                .starts_with(root.canonicalize().map_err(|error| error.to_string())?)
        {
            return Err("Dictation model must be inside the model directory".into());
        }
        let names = [
            "encoder.onnx",
            "decoder.onnx",
            "tokens.txt",
            "dictation-model.json",
        ];
        for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if !names.iter().any(|name| entry.file_name() == *name)
                || !entry
                    .file_type()
                    .map_err(|error| error.to_string())?
                    .is_file()
            {
                return Err("Dictation model contains files outside the model package".into());
            }
        }
        for name in names {
            match std::fs::remove_file(directory.join(name)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        std::fs::remove_dir(directory).map_err(|error| error.to_string())
    }

    pub(crate) fn validate_id(model_id: &str) -> Result<(), String> {
        if model_id.is_empty()
            || model_id.len() > 128
            || !model_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("Invalid local dictation model ID".into());
        }
        Ok(())
    }

    pub async fn resolve(
        home: &std::path::Path,
        media_network: &OutboundNetworkSnapshot,
        cache_root: &Path,
        model_id: &str,
        network: OutboundNetworkSnapshot,
        cancellation: &CancellationToken,
        progress: Arc<dyn Fn(ModelProgress) + Send + Sync>,
    ) -> Result<Self, String> {
        Self::validate_id(model_id)?;
        cancellation.check().map_err(|error| error.to_string())?;
        progress(ModelProgress::Checking);
        let directory = cache_root.join(model_id);
        if let Some(model) = BUILTIN_MODELS.iter().find(|model| model.id == model_id)
            && !directory.join("dictation-model.json").is_file()
        {
            let install = Installation::new(cache_root, model_id)?;
            // Recheck after acquiring the cross-process lock: another client may have published it.
            if !directory.join("dictation-model.json").is_file() {
                Installation::require_absent_destination(&directory)?;
                prepare_download(
                    model,
                    &install.staging,
                    network,
                    cancellation,
                    Arc::clone(&progress),
                )
                .await?;
                progress(ModelProgress::Loading);
                let package = Self::read(&install.staging)?;
                let recognizer =
                    package.recognizer(home, media_network, LocalSpeechMode::Dictation)?;
                drop(recognizer);
                cancellation.check().map_err(|error| error.to_string())?;
                install.publish(&directory)?;
            }
        }
        Self::read(&directory)
    }

    pub(crate) fn read(directory: &Path) -> Result<Self, String> {
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.join("dictation-model.json"))
                .map_err(|error| format!("Could not read dictation model package: {error}"))?,
        )
        .map_err(|error| format!("Invalid dictation model package: {error}"))?;
        if manifest.get("format").and_then(|value| value.as_str()) != Some(FORMAT) {
            return Err("Unsupported dictation model format".into());
        }
        let package = Self {
            encoder: directory.join("encoder.onnx"),
            decoder: directory.join("decoder.onnx"),
            tokens: directory.join("tokens.txt"),
        };
        for file in [&package.encoder, &package.decoder, &package.tokens] {
            if !file.is_file() {
                return Err(format!(
                    "Dictation model file is missing: {}",
                    file.display()
                ));
            }
        }
        Ok(package)
    }

    pub(crate) fn recognizer(
        &self,
        home: &std::path::Path,
        media_network: &OutboundNetworkSnapshot,
        mode: LocalSpeechMode,
    ) -> Result<crate::recognizer::Recognizer, String> {
        let executable = crate::recognizer::executable(home, media_network)?;
        crate::recognizer::Recognizer::open(
            &executable,
            &self.encoder,
            &self.decoder,
            &self.tokens,
            match mode {
                LocalSpeechMode::Dictation => crate::recognizer::RecognitionMode::Dictation,
                LocalSpeechMode::Conversation => crate::recognizer::RecognitionMode::Conversation,
            },
        )
        .map_err(|error| error.to_string())
    }

    pub(crate) async fn import(
        home: &std::path::Path,
        media_network: &OutboundNetworkSnapshot,
        root: &Path,
        model_id: &str,
        source: &Path,
        cancellation: &CancellationToken,
        progress: &(dyn Fn(ModelProgress) + Send + Sync),
    ) -> Result<(), String> {
        Self::validate_id(model_id)?;
        if !source.is_absolute() {
            return Err("Dictation model source must be an absolute directory".into());
        }
        let install = Installation::new(root, model_id)?;
        let destination = root.join(model_id);
        Installation::require_absent_destination(&destination)?;
        progress(ModelProgress::Checking);
        Self::read(source)?;
        for name in [
            "encoder.onnx",
            "decoder.onnx",
            "tokens.txt",
            "dictation-model.json",
        ] {
            cancellation.check().map_err(|error| error.to_string())?;
            let mut input = fs::File::open(source.join(name))
                .await
                .map_err(|error| error.to_string())?;
            let mut output = fs::File::create(install.staging.join(name))
                .await
                .map_err(|error| error.to_string())?;
            // Chunked copy observes cancellation between reads, without abandoning an active writer.
            use tokio::io::AsyncReadExt;
            let mut bytes = vec![0; 64 * 1024];
            loop {
                cancellation.check().map_err(|error| error.to_string())?;
                let count = input
                    .read(&mut bytes)
                    .await
                    .map_err(|error| error.to_string())?;
                if count == 0 {
                    break;
                }
                output
                    .write_all(&bytes[..count])
                    .await
                    .map_err(|error| error.to_string())?;
            }
            output.sync_all().await.map_err(|error| error.to_string())?;
        }
        progress(ModelProgress::Loading);
        let package = Self::read(&install.staging)?;
        let recognizer = package.recognizer(home, media_network, LocalSpeechMode::Dictation)?;
        drop(recognizer);
        cancellation.check().map_err(|error| error.to_string())?;
        install.publish(&destination)
    }
}

struct Installation {
    staging: PathBuf,
    _lock: std::fs::File,
}

impl Installation {
    fn new(root: &Path, model_id: &str) -> Result<Self, String> {
        std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join(format!(".{model_id}.lock")))
            .map_err(|error| error.to_string())?;
        lock.try_lock().map_err(|error| {
            format!("Dictation model is being prepared by another operation: {error}")
        })?;
        // Only this lock holder owns this staging directory, including leftovers from a crash.
        let staging = root.join(format!(".{model_id}.installing"));
        if staging.exists() {
            std::fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
        }
        std::fs::create_dir(&staging).map_err(|error| error.to_string())?;
        Ok(Self {
            staging,
            _lock: lock,
        })
    }

    fn require_absent_destination(destination: &Path) -> Result<(), String> {
        match std::fs::symlink_metadata(destination) {
            Ok(_) => Err(format!(
                "Dictation model destination already exists: {}",
                destination.display()
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    fn publish(&self, destination: &Path) -> Result<(), String> {
        Self::require_absent_destination(destination)?;
        std::fs::rename(&self.staging, destination).map_err(|error| error.to_string())
    }
}

impl Drop for Installation {
    fn drop(&mut self) {
        if self.staging.exists() {
            let _ = std::fs::remove_dir_all(&self.staging);
        }
    }
}

async fn prepare_download(
    model: &'static BuiltinModel,
    directory: &Path,
    network: OutboundNetworkSnapshot,
    cancellation: &CancellationToken,
    progress: Arc<dyn Fn(ModelProgress) + Send + Sync>,
) -> Result<(), String> {
    fs::create_dir_all(directory)
        .await
        .map_err(|error| format!("Could not create dictation model directory: {error}"))?;
    let client = ReqwestHttpClient::with_network(network).map_err(|error| error.to_string())?;
    let mut completed_bytes = 0;
    for (file, name) in model.downloads() {
        download(
            &client,
            &model.base_url,
            file,
            directory.join(name),
            cancellation,
            completed_bytes,
            Arc::clone(&progress),
        )
        .await?;
        completed_bytes += file.size_bytes;
    }
    let tokens: Vec<String> = serde_json::from_slice(
        &fs::read(directory.join("tokens.json"))
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Invalid Paraformer vocabulary: {error}"))?;
    let metadata = &model.paraformer;
    if tokens.len() != metadata.vocab_size.get() {
        return Err("Unexpected Paraformer vocabulary size".into());
    }
    let vocabulary = tokens
        .iter()
        .enumerate()
        .map(|(index, token)| format!("{token} {index}\n"))
        .collect::<String>();
    fs::write(directory.join("tokens.txt.download"), vocabulary)
        .await
        .map_err(|error| error.to_string())?;
    fs::rename(
        directory.join("tokens.txt.download"),
        directory.join("tokens.txt"),
    )
    .await
    .map_err(|error| error.to_string())?;
    let cmvn = fs::read_to_string(directory.join("am.mvn"))
        .await
        .map_err(|error| error.to_string())?;
    let cmvn_dimensions = metadata
        .lfr_window_size
        .get()
        .checked_mul(80)
        .ok_or("Invalid Paraformer CMVN dimensions")?;
    let (neg_mean, inv_stddev) = parse_cmvn(&cmvn, cmvn_dimensions)?;
    let mut encoder = fs::OpenOptions::new()
        .append(true)
        .open(directory.join("encoder.onnx.download"))
        .await
        .map_err(|error| error.to_string())?;
    // ONNX ModelProto field 14 is repeated metadata_props. Appending valid protobuf
    // entries preserves the original graph bytes and supplies sherpa's frontend metadata.
    for (key, value) in [
        ("vocab_size", metadata.vocab_size.to_string()),
        ("lfr_window_size", metadata.lfr_window_size.to_string()),
        ("lfr_window_shift", metadata.lfr_window_shift.to_string()),
        (
            "encoder_output_size",
            metadata.encoder_output_size.to_string(),
        ),
        (
            "decoder_num_blocks",
            metadata.decoder_num_blocks.to_string(),
        ),
        (
            "decoder_kernel_size",
            metadata.decoder_kernel_size.to_string(),
        ),
        ("neg_mean", neg_mean),
        ("inv_stddev", inv_stddev),
    ] {
        encoder
            .write_all(&metadata_entry(key, &value))
            .await
            .map_err(|error| error.to_string())?;
    }
    encoder.flush().await.map_err(|error| error.to_string())?;
    drop(encoder);
    fs::rename(
        directory.join("encoder.onnx.download"),
        directory.join("encoder.onnx"),
    )
    .await
    .map_err(|error| error.to_string())?;
    fs::rename(
        directory.join("decoder.onnx.download"),
        directory.join("decoder.onnx"),
    )
    .await
    .map_err(|error| error.to_string())?;
    for name in ["tokens.json", "am.mvn"] {
        fs::remove_file(directory.join(name))
            .await
            .map_err(|error| error.to_string())?;
    }
    // This marker is written last, so an interrupted install is never treated as usable.
    fs::write(
        directory.join("dictation-model.json"),
        format!("{{\"format\":\"{FORMAT}\"}}"),
    )
    .await
    .map_err(|error| error.to_string())
}

async fn download(
    client: &ReqwestHttpClient,
    base_url: &str,
    file: &'static DownloadFile,
    path: PathBuf,
    cancellation: &CancellationToken,
    completed_bytes: u64,
    progress: Arc<dyn Fn(ModelProgress) + Send + Sync>,
) -> Result<(), String> {
    let client = client.clone();
    let name = file.name.as_str();
    let url = format!("{base_url}/{name}");
    let cancellation = cancellation.clone();
    tokio::task::spawn_blocking(move || {
        struct FileSink {
            file: std::fs::File,
            digest: Sha256,
            downloaded_bytes: u64,
            reported_bytes: u64,
            completed_bytes: u64,
            progress: Arc<dyn Fn(ModelProgress) + Send + Sync>,
            name: String,
        }
        impl FileSink {
            fn report_progress(&self) {
                (self.progress)(ModelProgress::Downloading {
                    file: self.name.clone(),
                    downloaded_bytes: self.downloaded_bytes,
                    package_downloaded_bytes: self.completed_bytes + self.downloaded_bytes,
                });
            }
        }
        impl HttpBodySink for FileSink {
            fn emit(&mut self, chunk: &[u8]) -> Result<(), HttpClientError> {
                self.file
                    .write_all(chunk)
                    .map_err(|error| HttpClientError::Transport(error.to_string()))?;
                self.digest.update(chunk);
                self.downloaded_bytes += chunk.len() as u64;
                if self.downloaded_bytes - self.reported_bytes >= 1024 * 1024 {
                    self.reported_bytes = self.downloaded_bytes;
                    self.report_progress();
                }
                Ok(())
            }
        }
        let request = HttpRequest::new(
            HttpMethod::Get,
            url,
            // ModelScope rejects requests with an empty User-Agent at its CDN.
            vec![http_client::HttpHeader::new(
                "User-Agent",
                concat!("Ash/", env!("CARGO_PKG_VERSION")),
            )],
            vec![],
        )
        .map_err(|error| error.to_string())?;
        let mut sink = FileSink {
            file: std::fs::File::create(path).map_err(|error| error.to_string())?,
            digest: Sha256::new(),
            downloaded_bytes: 0,
            reported_bytes: 0,
            completed_bytes,
            progress: Arc::clone(&progress),
            name: name.into(),
        };
        sink.report_progress();
        let response = client
            .execute_streaming_with_cancellation(&request, &cancellation, &mut sink)
            .map_err(|error| format!("Could not download dictation model {name}: {error}"))?;
        if response.status() != 200 {
            return Err(format!(
                "Could not download dictation model {name}: HTTP {}",
                response.status()
            ));
        }
        sink.file.sync_all().map_err(|error| error.to_string())?;
        sink.report_progress();
        progress(ModelProgress::Checking);
        if sink.downloaded_bytes != file.size_bytes {
            return Err(format!("Dictation model {name} has an unexpected size"));
        }
        if format!("{:x}", sink.digest.finalize()) != file.sha256 {
            return Err(format!(
                "Dictation model {name} failed SHA-256 verification"
            ));
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn parse_cmvn(cmvn: &str, dimensions: usize) -> Result<(String, String), String> {
    fn values(cmvn: &str, marker: &str, dimensions: usize) -> Result<String, String> {
        let section = cmvn
            .split_once(marker)
            .and_then(|(_, rest)| rest.split_once('['))
            .and_then(|(_, rest)| rest.split_once(']'))
            .map(|(values, _)| values)
            .ok_or("Invalid Paraformer CMVN")?;
        let numbers = section.split_whitespace().collect::<Vec<_>>();
        if numbers.len() != dimensions
            || numbers.iter().any(|number| number.parse::<f32>().is_err())
        {
            return Err("Invalid Paraformer CMVN dimensions".into());
        }
        Ok(numbers.join(","))
    }
    Ok((
        values(cmvn, "<AddShift>", dimensions)?,
        values(cmvn, "<Rescale>", dimensions)?,
    ))
}

fn metadata_entry(key: &str, value: &str) -> Vec<u8> {
    fn varint(mut number: usize, output: &mut Vec<u8>) {
        while number >= 128 {
            output.push((number as u8 & 0x7f) | 0x80);
            number >>= 7;
        }
        output.push(number as u8);
    }
    fn string_field(field: u8, value: &str, output: &mut Vec<u8>) {
        output.push(field << 3 | 2);
        varint(value.len(), output);
        output.extend_from_slice(value.as_bytes());
    }
    let mut entry = Vec::new();
    string_field(1, key, &mut entry);
    string_field(2, value, &mut entry);
    let mut output = vec![14 << 3 | 2];
    varint(entry.len(), &mut output);
    output.extend(entry);
    output
}

#[cfg(test)]
#[path = "model_package_tests.rs"]
mod tests;
