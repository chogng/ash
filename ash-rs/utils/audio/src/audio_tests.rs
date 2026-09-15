use super::*;

#[test]
fn validates_each_supported_container_and_measures_audio_duration() {
    for (format, bytes) in [
        (
            AudioFormat::Wav,
            include_bytes!("../tests/fixtures/tone.wav").as_slice(),
        ),
        (
            AudioFormat::Mp3,
            include_bytes!("../tests/fixtures/tone.mp3").as_slice(),
        ),
        (
            AudioFormat::M4a,
            include_bytes!("../tests/fixtures/tone.m4a").as_slice(),
        ),
        (
            AudioFormat::WebM,
            include_bytes!("../tests/fixtures/tone.webm").as_slice(),
        ),
        (
            AudioFormat::Ogg,
            include_bytes!("../tests/fixtures/tone.ogg").as_slice(),
        ),
    ] {
        let audio =
            load_bytes(bytes.into(), format).unwrap_or_else(|error| panic!("{format:?}: {error}"));
        assert!(
            (950..=1200).contains(&audio.duration_ms()),
            "{format:?}: {}",
            audio.duration_ms()
        );
        assert_eq!(audio.bytes().as_ref(), bytes);
        assert_eq!(
            load_data_url(&audio.data_url()).unwrap().duration_ms(),
            audio.duration_ms()
        );
    }
}

#[test]
fn rejects_empty_oversized_corrupt_and_mislabelled_uploads() {
    assert!(matches!(
        load_bytes(Arc::from([]), AudioFormat::Wav),
        Err(AudioError::Size)
    ));
    assert!(matches!(
        load_bytes(vec![0; MAX_AUDIO_BYTES + 1].into(), AudioFormat::Wav),
        Err(AudioError::Size)
    ));
    assert!(load_bytes(Arc::from(b"not audio".as_slice()), AudioFormat::Wav).is_err());
    let wav = include_bytes!("../tests/fixtures/tone.wav");
    assert!(matches!(
        load_bytes(wav.as_slice().into(), AudioFormat::Mp3),
        Err(AudioError::Format)
    ));
    assert!(load_bytes(wav[..40].into(), AudioFormat::Wav).is_err());
}

#[test]
fn accepts_mime_aliases_and_rejects_non_inline_or_malformed_audio() {
    let audio = load_bytes(
        include_bytes!("../tests/fixtures/tone.wav")
            .as_slice()
            .into(),
        AudioFormat::Wav,
    )
    .unwrap();
    let alias = audio.data_url().replace("audio/wav", "audio/x-wav");
    assert_eq!(load_data_url(&alias).unwrap().data_url(), audio.data_url());
    for url in [
        "https://example.test/audio.wav",
        "data:audio/wav;base64,%%%",
        "data:audio/wav,raw",
        "data:audio/flac;base64,AA==",
        "data:audio/wav;charset=utf-8;base64,AA==",
    ] {
        assert!(load_data_url(url).is_err(), "{url}");
    }
}

#[test]
fn duration_estimate_rounds_up_without_overflow() {
    assert_eq!(approximate_tokens(1000), 10);
    assert_eq!(approximate_tokens(1001), 11);
    assert_eq!(approximate_tokens(u64::MAX), u64::MAX / 100 + 1);
}

#[test]
fn rejects_a_truncated_payload_and_excessive_playback_duration() {
    let wav = include_bytes!("../tests/fixtures/tone.wav");
    assert!(load_bytes(wav[..wav.len() / 2].into(), AudioFormat::Wav).is_err());
    let mut long = wav.to_vec();
    long[24..28].copy_from_slice(&1u32.to_le_bytes());
    long[28..32].copy_from_slice(&2u32.to_le_bytes());
    assert!(matches!(
        load_bytes(long.into(), AudioFormat::Wav),
        Err(AudioError::Duration)
    ));
}
