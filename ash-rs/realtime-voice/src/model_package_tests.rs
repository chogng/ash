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
            &async_utils::CancellationSource::new().token()
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
    let mut config = sherpa_onnx::OnlineRecognizerConfig::default();
    config.model_config.paraformer.encoder = Some(format!("{directory}/encoder.onnx"));
    config.model_config.paraformer.decoder = Some(format!("{directory}/decoder.onnx"));
    config.model_config.tokens = Some(format!("{directory}/tokens.txt"));
    config.model_config.num_threads = 2;
    let recognizer = sherpa_onnx::OnlineRecognizer::create(&config).expect("load Paraformer");
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
    assert!(
        recognizer
            .get_result(&stream)
            .unwrap()
            .text
            .contains("了解这个项目的进度")
    );
}
