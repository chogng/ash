use super::*;

#[test]
fn framed_control_round_trip_rejects_truncation_and_unknown_operations() {
    let frame = encode(&Request {
        id: 17,
        operation: Operation::Start {
            config: AudioConfig {
                rate: SampleRate::Hz24000,
                direction: Direction::Capture,
                processing: Processing::Speech,
            },
        },
    })
    .unwrap();
    let request = read::<Request>(&mut &frame[..]).unwrap().unwrap();
    assert_eq!(request.id, 17);
    assert!(matches!(request.operation, Operation::Start { .. }));
    for len in 1..frame.len() {
        assert!(read::<Request>(&mut &frame[..len]).is_err());
    }
    let unknown =
        encode(&serde_json::json!({"id": 1, "operation": "runCommand", "command": "hidden"}))
            .unwrap();
    assert!(read::<Request>(&mut &unknown[..]).is_err());
    assert!(read::<Request>(&mut &u32::MAX.to_le_bytes()[..]).is_err());
}

#[test]
fn pcm_round_trip_preserves_signed_extrema_and_frame_bounds() {
    let event = Event::Capture {
        audio: Capture {
            epoch: 5,
            sequence: 9,
            samples: vec![i16::MIN, 0, i16::MAX],
        },
    };
    let bytes = encode(&event).unwrap();
    match read::<Event>(&mut &bytes[..]).unwrap().unwrap() {
        Event::Capture { audio } => assert_eq!(audio.samples, [i16::MIN, 0, i16::MAX]),
        _ => panic!("wrong audio frame"),
    }
    assert!(encode(&"x".repeat(MAX_BYTES)).is_err());
}
