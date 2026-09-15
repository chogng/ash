use super::*;

fn tone(rate: u32, start: usize, size: usize) -> Vec<f32> {
    (start..start + size)
        .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / rate as f32).sin() * 0.3)
        .collect()
}

#[test]
fn device_rate_conversion_produces_bounded_twenty_ms_packets() {
    for device_rate in [16_000, 44_100, 48_000, 96_000] {
        for target in [
            SampleRate::Hz16000,
            SampleRate::Hz24000,
            SampleRate::Hz48000,
        ] {
            let mut processor =
                CaptureProcessor::new(device_rate, 48_000, target, Processing::Unprocessed)
                    .unwrap();
            let mut packets = Vec::new();
            let chunk = device_rate as usize / 100;
            for step in 0..100 {
                packets.extend(
                    processor
                        .capture(&tone(device_rate, step * chunk, chunk))
                        .unwrap(),
                );
            }
            assert!(
                (47..=50).contains(&packets.len()),
                "rate={device_rate}, packets={}",
                packets.len()
            );
            assert!(
                packets
                    .iter()
                    .all(|packet| packet.len() == target.packet_samples())
            );
            let energy = packets[10]
                .iter()
                .map(|&s| f64::from(s).powi(2))
                .sum::<f64>()
                / target.packet_samples() as f64;
            assert!(energy > 10_000_000.0 && energy < 100_000_000.0);
        }
    }
}

#[test]
fn reset_discards_partial_audio_and_filter_history() {
    let mut processor =
        CaptureProcessor::new(48_000, 48_000, SampleRate::Hz24000, Processing::Speech).unwrap();
    for _ in 0..20 {
        processor.capture(&vec![0.5; 480]).unwrap();
    }
    processor.reset();
    let mut output = Vec::new();
    for _ in 0..30 {
        output.extend(processor.capture(&[0.0; 480]).unwrap());
    }
    assert!(output.iter().flatten().all(|&sample| sample == 0));
    assert!(processor.capture(&[f32::NAN]).is_err());
}

#[test]
fn speech_processing_accepts_render_reference_and_changes_echo() {
    let mut processed =
        CaptureProcessor::new(48_000, 48_000, SampleRate::Hz48000, Processing::Speech).unwrap();
    let mut raw =
        CaptureProcessor::new(48_000, 48_000, SampleRate::Hz48000, Processing::Unprocessed)
            .unwrap();
    let mut processed_energy = 0_f64;
    let mut raw_energy = 0_f64;
    for step in 0..300 {
        let signal = tone(48_000, step * 480, 480);
        processed.render(&signal, 10).unwrap();
        let clean = processed.capture(&signal).unwrap();
        let original = raw.capture(&signal).unwrap();
        if step > 200 {
            processed_energy += clean
                .iter()
                .flatten()
                .map(|&s| f64::from(s).powi(2))
                .sum::<f64>();
            raw_energy += original
                .iter()
                .flatten()
                .map(|&s| f64::from(s).powi(2))
                .sum::<f64>();
        }
    }
    assert!(
        processed_energy < raw_energy * 0.8,
        "processed={processed_energy}, raw={raw_energy}"
    );
}
