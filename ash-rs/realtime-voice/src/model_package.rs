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
use sha2::Digest;
use sha2::Sha256;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;
use tokio::io::AsyncWriteExt;

pub const DEFAULT_MODEL_ID: &str = "paraformer-large-online-ec6a3c64";
const FORMAT: &str = "sherpa-online-paraformer-v1";
const BASE_URL: &str = "https://modelscope.cn/models/iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx/resolve/master";

pub(crate) struct ModelPackage {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub tokens: PathBuf,
}

impl ModelPackage {
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
        if model_id == DEFAULT_MODEL_ID && !directory.join("dictation-model.json").is_file() {
            let install = Installation::new(cache_root, model_id)?;
            // Recheck after acquiring the cross-process lock: another client may have published it.
            if !directory.join("dictation-model.json").is_file() {
                prepare_default(
                    &install.staging,
                    network,
                    cancellation,
                    Arc::clone(&progress),
                )
                .await?;
                progress(ModelProgress::Loading);
                let package = Self::read(&install.staging)?;
                let recognizer = package.recognizer(LocalSpeechMode::Dictation)?;
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
        mode: LocalSpeechMode,
    ) -> Result<sherpa_onnx::OnlineRecognizer, String> {
        let mut config = sherpa_onnx::OnlineRecognizerConfig::default();
        config.model_config.paraformer.encoder = Some(self.encoder.to_string_lossy().into_owned());
        config.model_config.paraformer.decoder = Some(self.decoder.to_string_lossy().into_owned());
        config.model_config.tokens = Some(self.tokens.to_string_lossy().into_owned());
        config.model_config.num_threads = 2;
        if mode == LocalSpeechMode::Conversation {
            config.enable_endpoint = true;
            config.rule1_min_trailing_silence = 2.4;
            config.rule2_min_trailing_silence = 0.9;
            config.rule3_min_utterance_length = 20.0;
        }
        sherpa_onnx::OnlineRecognizer::create(&config)
            .ok_or_else(|| "Could not load Paraformer dictation model".into())
    }

    pub(crate) async fn import(
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
        if destination.exists() {
            return Err("Dictation model already exists; import with a different model ID".into());
        }
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
        let recognizer = package.recognizer(LocalSpeechMode::Dictation)?;
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

    fn publish(&self, destination: &Path) -> Result<(), String> {
        if destination.exists() {
            let outputs = [
                "encoder.onnx.download",
                "decoder.onnx.download",
                "tokens.txt.download",
                "encoder.onnx",
                "decoder.onnx",
                "tokens.txt",
                "tokens.json",
                "am.mvn",
            ];
            for entry in std::fs::read_dir(destination).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                if !outputs.iter().any(|name| entry.file_name() == *name)
                    || !entry
                        .file_type()
                        .map_err(|error| error.to_string())?
                        .is_file()
                {
                    return Err("Dictation model destination contains files outside an unfinished installation".into());
                }
            }
            // An install without its marker is unfinished. Remove only known package outputs;
            // remove_dir rejects unknown user files instead of recursively deleting them.
            for name in outputs {
                let file = destination.join(name);
                match std::fs::remove_file(file) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
            std::fs::remove_dir(destination).map_err(|error| error.to_string())?;
        }
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

async fn prepare_default(
    directory: &Path,
    network: OutboundNetworkSnapshot,
    cancellation: &CancellationToken,
    progress: Arc<dyn Fn(ModelProgress) + Send + Sync>,
) -> Result<(), String> {
    fs::create_dir_all(directory)
        .await
        .map_err(|error| format!("Could not create dictation model directory: {error}"))?;
    let client = ReqwestHttpClient::with_network(network).map_err(|error| error.to_string())?;
    download(
        &client,
        "model_quant.onnx",
        &directory.join("encoder.onnx.download"),
        "dd4121cf45102018c26f9256f0b862df416edfcd06b0863ef4ce378a63c7d5e2",
        cancellation,
        Arc::clone(&progress),
    )
    .await?;
    download(
        &client,
        "decoder_quant.onnx",
        &directory.join("decoder.onnx.download"),
        "873d21ee80c7345bfc27944b843699fe16bba021fd020747d38aef2dfc103681",
        cancellation,
        Arc::clone(&progress),
    )
    .await?;
    download(
        &client,
        "tokens.json",
        &directory.join("tokens.json"),
        "2b20c2b12572d682afff84ce1c8d560f67b8b32a4c1f21567411d141ed352127",
        cancellation,
        Arc::clone(&progress),
    )
    .await?;
    download(
        &client,
        "am.mvn",
        &directory.join("am.mvn"),
        "29b3c740a2c0cfc6b308126d31d7f265fa2be74f3bb095cd2f143ea970896ae5",
        cancellation,
        Arc::clone(&progress),
    )
    .await?;
    let tokens: Vec<String> = serde_json::from_slice(
        &fs::read(directory.join("tokens.json"))
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Invalid Paraformer vocabulary: {error}"))?;
    if tokens.len() != 8404 {
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
    let (neg_mean, inv_stddev) = parse_cmvn(&cmvn)?;
    let mut encoder = fs::OpenOptions::new()
        .append(true)
        .open(directory.join("encoder.onnx.download"))
        .await
        .map_err(|error| error.to_string())?;
    // ONNX ModelProto field 14 is repeated metadata_props. Appending valid protobuf
    // entries preserves the original graph bytes and supplies sherpa's frontend metadata.
    for (key, value) in [
        ("vocab_size", tokens.len().to_string()),
        ("lfr_window_size", "7".into()),
        ("lfr_window_shift", "6".into()),
        ("encoder_output_size", "512".into()),
        ("decoder_num_blocks", "16".into()),
        ("decoder_kernel_size", "11".into()),
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
    name: &str,
    path: &Path,
    expected_sha256: &str,
    cancellation: &CancellationToken,
    progress: Arc<dyn Fn(ModelProgress) + Send + Sync>,
) -> Result<(), String> {
    let client = client.clone();
    let name = name.to_owned();
    let path = path.to_owned();
    let expected_sha256 = expected_sha256.to_owned();
    let cancellation = cancellation.clone();
    tokio::task::spawn_blocking(move || {
        struct FileSink {
            file: std::fs::File,
            digest: Sha256,
            downloaded_bytes: u64,
            reported_bytes: u64,
            progress: Arc<dyn Fn(ModelProgress) + Send + Sync>,
            name: String,
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
                    (self.progress)(ModelProgress::Downloading {
                        file: self.name.clone(),
                        downloaded_bytes: self.downloaded_bytes,
                    });
                }
                Ok(())
            }
        }
        let request = HttpRequest::new(
            HttpMethod::Get,
            format!("{BASE_URL}/{name}"),
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
            progress: Arc::clone(&progress),
            name: name.clone(),
        };
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
        progress(ModelProgress::Downloading {
            file: name.clone(),
            downloaded_bytes: sink.downloaded_bytes,
        });
        progress(ModelProgress::Checking);
        if format!("{:x}", sink.digest.finalize()) != expected_sha256 {
            return Err(format!(
                "Dictation model {name} failed SHA-256 verification"
            ));
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn parse_cmvn(cmvn: &str) -> Result<(String, String), String> {
    fn values(cmvn: &str, marker: &str) -> Result<String, String> {
        let section = cmvn
            .split_once(marker)
            .and_then(|(_, rest)| rest.split_once('['))
            .and_then(|(_, rest)| rest.split_once(']'))
            .map(|(values, _)| values)
            .ok_or("Invalid Paraformer CMVN")?;
        let numbers = section.split_whitespace().collect::<Vec<_>>();
        if numbers.len() != 560 || numbers.iter().any(|number| number.parse::<f32>().is_err()) {
            return Err("Invalid Paraformer CMVN dimensions".into());
        }
        Ok(numbers.join(","))
    }
    Ok((values(cmvn, "<AddShift>")?, values(cmvn, "<Rescale>")?))
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
