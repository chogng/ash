#[test]
fn encoded_pcm_has_a_complete_mono_24khz_wav_contract() {
    let wav = super::encode_wav(&[i16::MIN, 0, i16::MAX]);
    assert_eq!(&wav[..4], b"RIFF");
    assert_eq!(
        u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize,
        wav.len() - 8
    );
    assert_eq!(&wav[8..16], b"WAVEfmt ");
    assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 24_000);
    assert_eq!(&wav[36..40], b"data");
    assert_eq!(&wav[44..], &[0, 128, 0, 0, 255, 127]);
}
