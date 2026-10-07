use super::*;

#[tokio::test]
async fn selected_model_package_is_loaded_from_its_own_directory() {
    let root = tempfile::tempdir().unwrap();
    let package = root.path().join("custom-online");
    fs::create_dir(&package).await.unwrap();
    fs::write(
        package.join("dictation-model.json"),
        format!("{{\"format\":\"{FORMAT}\"}}"),
    )
    .await
    .unwrap();
    for name in ["encoder.onnx", "decoder.onnx", "tokens.txt"] {
        fs::write(package.join(name), b"fixture").await.unwrap();
    }
    let selected = ModelPackage::resolve(
        root.path(),
        "custom-online",
        network(),
        &async_utils::CancellationSource::new().token(),
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    assert_eq!(selected.encoder, package.join("encoder.onnx"));
    assert_eq!(selected.decoder, package.join("decoder.onnx"));
    assert_eq!(selected.tokens, package.join("tokens.txt"));
}

#[tokio::test]
async fn invalid_model_ids_cannot_select_paths_outside_the_model_root() {
    let root = tempfile::tempdir().unwrap();
    assert_eq!(
        ModelPackage::resolve(
            root.path(),
            "../outside",
            network(),
            &async_utils::CancellationSource::new().token(),
            Arc::new(|_| {}),
        )
        .await
        .err()
        .unwrap(),
        "Invalid local dictation model ID"
    );
}

fn network() -> OutboundNetworkSnapshot {
    OutboundNetworkSnapshot::new(http_client::HttpClientConfig::new()).unwrap()
}

#[test]
fn installations_are_exclusive_and_released_after_failure() {
    let root = tempfile::tempdir().unwrap();
    let first = Installation::new(root.path(), "shared-model").unwrap();
    assert!(Installation::new(root.path(), "shared-model").is_err());
    let staging = first.staging.clone();
    drop(first);
    assert!(!staging.exists());
    assert!(Installation::new(root.path(), "shared-model").is_ok());
}

#[test]
fn publication_preserves_unknown_files_and_replaces_only_unfinished_outputs() {
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("model");
    std::fs::create_dir(&destination).unwrap();
    std::fs::write(destination.join("encoder.onnx.download"), b"partial").unwrap();
    std::fs::write(destination.join("user-file"), b"preserved").unwrap();
    let install = Installation::new(root.path(), "model").unwrap();
    std::fs::write(install.staging.join("dictation-model.json"), b"verified").unwrap();
    assert!(install.publish(&destination).is_err());
    assert_eq!(
        std::fs::read(destination.join("encoder.onnx.download")).unwrap(),
        b"partial"
    );
    assert_eq!(
        std::fs::read(destination.join("user-file")).unwrap(),
        b"preserved"
    );
    std::fs::remove_file(destination.join("user-file")).unwrap();
    install.publish(&destination).unwrap();
    assert_eq!(
        std::fs::read(destination.join("dictation-model.json")).unwrap(),
        b"verified"
    );
    assert!(!destination.join("encoder.onnx.download").exists());
    // A published package is immutable, even if the caller still holds the install lock.
    assert!(install.publish(&destination).is_err());
}

#[tokio::test]
async fn cancelled_import_and_existing_destination_preserve_installed_models() {
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let destination = root.path().join("installed");
    fs::create_dir(&destination).await.unwrap();
    fs::write(destination.join("sentinel"), b"preserved")
        .await
        .unwrap();
    let cancellation = async_utils::CancellationSource::new();
    cancellation.cancel();
    assert!(
        ModelPackage::import(
            root.path(),
            "installed",
            source.path(),
            &cancellation.token(),
            &|_| {}
        )
        .await
        .is_err()
    );
    assert_eq!(
        fs::read(destination.join("sentinel")).await.unwrap(),
        b"preserved"
    );
    assert!(!root.path().join(".installed.installing").exists());
}

#[test]
fn onnx_metadata_uses_the_model_proto_metadata_props_field() {
    assert_eq!(
        metadata_entry("vocab_size", "8404"),
        [
            0x72, 0x12, 0x0a, 0x0a, b'v', b'o', b'c', b'a', b'b', b'_', b's', b'i', b'z', b'e',
            0x12, 0x04, b'8', b'4', b'0', b'4',
        ]
    );
}

#[test]
fn cmvn_requires_both_full_feature_vectors() {
    let vector = std::iter::repeat_n("0.5", 560)
        .collect::<Vec<_>>()
        .join(" ");
    let cmvn = format!(
        "<AddShift> 560 560\n<LearnRateCoef> 0 [ {vector} ]\n<Rescale> 560 560\n<LearnRateCoef> 0 [ {vector} ]"
    );
    let (mean, scale) = parse_cmvn(&cmvn).unwrap();
    assert_eq!(mean.split(',').count(), 560);
    assert_eq!(scale.split(',').count(), 560);
    assert!(parse_cmvn("<AddShift> [ 0.5 ] <Rescale> [ 0.5 ]").is_err());
}

#[test]
#[ignore = "requires ASH_TEST_DICTATION_MODEL_DIR and ASH_TEST_DICTATION_WAV"]
fn paraformer_streaming_model_transcribes_real_audio() {
    let directory = std::env::var("ASH_TEST_DICTATION_MODEL_DIR").unwrap();
    let wav = std::env::var("ASH_TEST_DICTATION_WAV").unwrap();
    let imported = tempfile::tempdir().unwrap();
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(ModelPackage::import(
            imported.path(),
            "verified-import",
            Path::new(&directory),
            &async_utils::CancellationSource::new().token(),
            &|_| {},
        ))
        .expect("import and validate real package");
    let package = ModelPackage::read(&imported.path().join("verified-import")).unwrap();
    let recognizer = package
        .recognizer(LocalSpeechMode::Dictation)
        .expect("load Paraformer");
    let wave = sherpa_onnx::Wave::read(&wav).expect("read recorded audio");
    assert_eq!(wave.sample_rate(), 16000);
    let stream = recognizer.create_stream();
    for chunk in wave.samples().chunks(3200) {
        stream.accept_waveform(16000, chunk);
        while recognizer.is_ready(&stream) {
            recognizer.decode(&stream);
        }
    }
    stream.input_finished();
    while recognizer.is_ready(&stream) {
        recognizer.decode(&stream);
    }
    let text = recognizer.get_result(&stream).unwrap().text;
    eprintln!("Recognized fixed test phrase: {text}");
    assert!(text.contains("了解这个项目的进度"));
}

#[tokio::test]
#[ignore = "downloads and loads the pinned model into ASH_TEST_DICTATION_CACHE_DIR"]
async fn default_model_preparation_publishes_a_loadable_package() {
    let root = std::env::var("ASH_TEST_DICTATION_CACHE_DIR").unwrap();
    let network = OutboundNetworkSnapshot::new(
        http_client::HttpClientConfig::new()
            .with_redirect_policy(http_client::RedirectPolicy::Follow {
                max_hops: std::num::NonZeroU8::new(4).unwrap(),
            })
            .with_streaming_response_body_limit(
                http_client::ResponseBodyLimit::new(
                    std::num::NonZeroUsize::new(300 * 1024 * 1024).unwrap(),
                )
                .unwrap(),
            )
            .with_timeouts(http_client::TransportTimeouts::new(
                http_client::Timeout::After(std::time::Duration::from_secs(30)),
                http_client::Timeout::Disabled,
                http_client::Timeout::Disabled,
                http_client::Timeout::After(std::time::Duration::from_secs(300)),
            )),
    )
    .unwrap();
    let package = ModelPackage::resolve(
        Path::new(&root),
        DEFAULT_MODEL_ID,
        network,
        &async_utils::CancellationSource::new().token(),
        Arc::new(|event| eprintln!("{event:?}")),
    )
    .await
    .unwrap();
    assert!(
        crate::DictationModelManager::is_available(Path::new(&root), DEFAULT_MODEL_ID).unwrap()
    );
    assert!(package.recognizer(LocalSpeechMode::Dictation).is_ok());
    assert!(
        !Path::new(&root)
            .join(format!(".{DEFAULT_MODEL_ID}.installing"))
            .exists()
    );
}
