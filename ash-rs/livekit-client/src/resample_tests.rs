use crate::AudioRate;
use crate::AudioResampler;

#[test]
fn voice_rate_conversion_keeps_packet_size_and_boundary_continuity() {
    let mut up = AudioResampler::new(AudioRate::Voice, AudioRate::Room);
    let first = up.process(&vec![10_000; 240]).unwrap();
    let second = up.process(&vec![20_000; 240]).unwrap();
    assert_eq!(first.len(), 480);
    assert_eq!(second.len(), 480);
    assert!(second.iter().any(|sample| *sample > 15_000));
    let mut down = AudioResampler::new(AudioRate::Room, AudioRate::Voice);
    assert_eq!(down.process(&second).unwrap().len(), 240);
    assert!(down.process(&vec![0; 479]).is_err());
}
