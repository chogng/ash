use super::AudioBridge;
use crate::AgentError;
use livekit_client::AudioFrame;
use std::collections::BTreeMap;
use std::time::Duration;
use std::time::Instant;

#[test]
fn unauthorized_audio_is_excluded_and_queues_are_bounded() {
    let mut bridge =
        AudioBridge::new(BTreeMap::from([("alice-device".into(), "alice".into())])).unwrap();
    bridge.push_input(frame("agent", "mic", 20_000)).unwrap();
    assert!(
        bridge
            .input(Instant::now())
            .unwrap()
            .iter()
            .all(|byte| *byte == 0)
    );
    for _ in 0..100 {
        bridge
            .push_input(frame("alice-device", "mic", 5000))
            .unwrap();
    }
    let mut audible = false;
    for _ in 0..20 {
        let packet = bridge.input(Instant::now()).unwrap();
        assert_eq!(packet.len(), 480);
        audible |= packet
            .chunks_exact(2)
            .any(|sample| i16::from_le_bytes([sample[0], sample[1]]).abs() > 100);
    }
    assert!(audible);
    bridge.remove_participant("alice-device");
    assert!(
        bridge
            .input(Instant::now())
            .unwrap()
            .iter()
            .all(|byte| *byte == 0)
    );
}

#[test]
fn interrupted_playback_cannot_replay_queued_model_audio() {
    let mut bridge =
        AudioBridge::new(BTreeMap::from([("alice-device".into(), "alice".into())])).unwrap();
    bridge.push_output(&vec![1; 960]).unwrap();
    assert_eq!(bridge.output().unwrap().unwrap().len(), 480);
    bridge.stop_playback();
    bridge.push_output(&vec![1; 960]).unwrap();
    assert!(bridge.output().unwrap().is_none());
    bridge.push_output(&vec![1; 48_000]).unwrap();
    assert!(bridge.output().unwrap().is_none());
}

#[test]
fn excessive_output_is_rejected_while_playback_is_active() {
    let mut bridge =
        AudioBridge::new(BTreeMap::from([("alice-device".into(), "alice".into())])).unwrap();
    assert!(matches!(
        bridge.push_output(&vec![0; 96_002]),
        Err(AgentError::AudioOverflow)
    ));
}

fn frame(participant: &str, track: &str, value: i16) -> AudioFrame {
    AudioFrame {
        participant_id: participant.into(),
        track_id: track.into(),
        received_at: Instant::now(),
        samples: vec![value; 480],
    }
}

#[test]
fn simultaneous_tracks_mix_instead_of_concatenating_and_expire_by_time() {
    let mut bridge = AudioBridge::new(BTreeMap::from([("alice".into(), "member".into())])).unwrap();
    bridge.push_input(frame("alice", "first", 4000)).unwrap();
    bridge.push_input(frame("alice", "second", -4000)).unwrap();
    assert!(
        bridge
            .input(Instant::now())
            .unwrap()
            .iter()
            .all(|byte| *byte == 0)
    );
    bridge.push_input(frame("alice", "first", 4000)).unwrap();
    assert!(
        bridge
            .input(Instant::now() + Duration::from_millis(201))
            .unwrap()
            .iter()
            .all(|byte| *byte == 0)
    );
}

#[test]
fn removing_one_track_or_participant_preserves_the_other_speakers() {
    let mut bridge = AudioBridge::new(BTreeMap::from([
        ("alice".into(), "member-alice".into()),
        ("bob".into(), "member-bob".into()),
    ]))
    .unwrap();
    bridge.push_input(frame("alice", "first", -4000)).unwrap();
    bridge.push_input(frame("alice", "second", 4000)).unwrap();
    bridge.push_input(frame("bob", "third", 4000)).unwrap();
    bridge.remove_track("first");
    bridge.remove_participant("bob");
    let pcm = bridge.input(Instant::now()).unwrap();
    assert!(
        pcm.chunks_exact(2)
            .any(|sample| i16::from_le_bytes([sample[0], sample[1]]) > 100)
    );
    bridge.remove_track("second");
    assert!(
        bridge
            .input(Instant::now())
            .unwrap()
            .iter()
            .all(|byte| *byte == 0)
    );
}

#[test]
fn unauthorized_and_expired_tracks_do_not_exhaust_track_capacity() {
    let mut bridge = AudioBridge::new(BTreeMap::from([("alice".into(), "member".into())])).unwrap();
    for index in 0..128 {
        bridge
            .push_input(frame("agent", &index.to_string(), 4000))
            .unwrap();
        let mut expired = frame("alice", &index.to_string(), 4000);
        expired.received_at -= Duration::from_secs(1);
        bridge.push_input(expired).unwrap();
    }
    for index in 0..64 {
        bridge
            .push_input(frame("alice", &index.to_string(), 4000))
            .unwrap();
    }
    assert!(matches!(
        bridge.push_input(frame("alice", "overflow", 4000)),
        Err(AgentError::Media(livekit_client::MediaError::Consumer))
    ));
    bridge.remove_track("0");
    bridge
        .push_input(frame("alice", "replacement", 4000))
        .unwrap();
}
