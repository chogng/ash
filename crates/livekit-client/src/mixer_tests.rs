use super::*;

fn frame(track: &str, participant: &str) -> AudioFrame {
    AudioFrame {
        participant_id: participant.into(),
        track_id: track.into(),
        received_at: Instant::now(),
        samples: vec![1_000; 480],
    }
}

#[test]
fn clearing_playback_preserves_track_volumes_and_discards_old_pcm() {
    let mut mixer = AudioMixer::default();
    mixer.push(frame("alice-mic", "alice")).unwrap();
    mixer.push(frame("bob-mic", "bob")).unwrap();
    mixer.set_volume("alice-mic", 0.).unwrap();
    mixer.set_volume("bob-mic", 0.25).unwrap();
    mixer.clear();
    assert_eq!(mixer.render(480, Instant::now()).unwrap(), vec![0; 480]);
    mixer.push(frame("alice-mic", "alice")).unwrap();
    mixer.push(frame("bob-mic", "bob")).unwrap();
    assert_eq!(mixer.render(480, Instant::now()).unwrap(), vec![250; 480]);
    mixer.push(frame("alice-mic", "alice")).unwrap();
    mixer.clear_track("alice-mic");
    mixer.push(frame("alice-mic", "alice")).unwrap();
    assert_eq!(mixer.render(480, Instant::now()).unwrap(), vec![0; 480]);
}

#[test]
fn removing_tracks_releases_capacity_and_their_settings() {
    let mut mixer = AudioMixer::default();
    for index in 0..128 {
        let track = format!("track-{index}");
        mixer.push(frame(&track, "alice")).unwrap();
        mixer.set_volume(&track, 0.).unwrap();
        mixer.remove_track(&track);
    }
    mixer.push(frame("track-127", "bob")).unwrap();
    assert_eq!(mixer.render(480, Instant::now()).unwrap(), vec![1_000; 480]);
    mixer.remove_participant("bob");
    assert_eq!(mixer.render(480, Instant::now()).unwrap(), vec![0; 480]);
}
