use super::*;

fn packet() -> Vec<u8> {
    let mut encoder =
        opus::Encoder::new(48_000, opus::Channels::Mono, opus::Application::Voip).unwrap();
    let pcm: Vec<i16> = (0..960)
        .map(|i| ((i as f32 * 0.08).sin() * 10_000.0) as i16)
        .collect();
    let mut encoded = vec![0; 1275];
    let size = encoder.encode(&pcm, &mut encoded).unwrap();
    encoded.truncate(size);
    encoded
}

#[test]
fn jitter_window_handles_reordering_wrap_and_loss_without_unbounded_growth() {
    let bytes = packet();
    let mut player = Playout::new().unwrap();
    player.insert(65535, &bytes).unwrap();
    player.insert(1, &bytes).unwrap();
    assert!(player.tick().unwrap().is_none());
    player.insert(0, &bytes).unwrap();
    for _ in 0..4 {
        assert_eq!(player.tick().unwrap().unwrap().len(), 960);
    }
    assert!(player.packets.is_empty());
    for _ in 0..12 {
        player.tick().unwrap();
    }
    assert!(player.tick().unwrap().is_none());
    for seq in 300..10_000 {
        player.insert(seq, &bytes).unwrap();
        assert!(player.packets.len() <= 10);
    }
    assert!(player.insert(10_001, &vec![0; 1276]).is_err());
}

#[test]
fn startup_reordering_retains_the_earlier_packet() {
    let mut player = Playout::new().unwrap();
    let bytes = packet();
    for number in [52, 50, 51] {
        player.insert(number, &bytes).unwrap();
    }
    assert_eq!(player.next, Some(50));
    player.tick().unwrap().unwrap();
    assert_eq!(player.next, Some(51));
    assert_eq!(player.packets.len(), 2);
}
