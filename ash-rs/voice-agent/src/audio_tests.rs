use super::AudioBridge;
use crate::AgentError;
use std::collections::BTreeMap;

#[test]
fn unauthorized_audio_is_excluded_and_queues_are_bounded() {
    let mut bridge =
        AudioBridge::new(BTreeMap::from([("alice-device".into(), "alice".into())])).unwrap();
    bridge.push_input("agent", &[20_000; 480]);
    assert!(bridge.input().unwrap().iter().all(|byte| *byte == 0));
    for _ in 0..100 {
        bridge.push_input("alice-device", &[5000; 480]);
    }
    assert_eq!(bridge.input["alice-device"].len(), 9600);
    let mut audible = false;
    for _ in 0..20 {
        let packet = bridge.input().unwrap();
        assert_eq!(packet.len(), 480);
        audible |= packet
            .chunks_exact(2)
            .any(|sample| i16::from_le_bytes([sample[0], sample[1]]).abs() > 100);
    }
    assert!(audible);
    bridge.clear_input();
    assert!(bridge.input().unwrap().iter().all(|byte| *byte == 0));
}

#[test]
fn interrupted_playback_cannot_replay_queued_model_audio() {
    let mut bridge =
        AudioBridge::new(BTreeMap::from([("alice-device".into(), "alice".into())])).unwrap();
    bridge.push_output(&vec![1; 960]).unwrap();
    assert_eq!(bridge.output().unwrap().unwrap().len(), 480);
    bridge.stop_playback();
    bridge.push_output(&vec![1; 960]).unwrap();
    bridge.resume_playback();
    assert!(bridge.output().unwrap().is_none());
    assert!(matches!(
        bridge.push_output(&vec![0; 96_002]),
        Err(AgentError::AudioOverflow)
    ));
}
