use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use screen_capture::ScreenCaptureSource;
use screen_capture::mock::MockCaptureSource;

use crate::codec::VideoDecoder;
use crate::codec::VideoEncoder;
use crate::codec::capture_planes;

#[tokio::test]
async fn test_screen_capture_frame_conversion() {
    let source = MockCaptureSource::new("test_display", 320, 240);
    let converted_count = Arc::new(AtomicUsize::new(0));
    let converted_count_clone = Arc::clone(&converted_count);

    let mut stream = source
        .start_stream(
            30,
            Box::new(move |frame| {
                let video_frame = capture_planes(&frame);
                assert!(video_frame.is_some());
                let frame = video_frame.unwrap();
                assert_eq!(frame.width, 320);
                assert_eq!(frame.height, 240);
                converted_count_clone.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .expect("mock stream should start");

    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(converted_count.load(Ordering::SeqCst) >= 2);
    stream.stop();
}

#[test]
fn invalid_capture_dimensions_and_truncated_rows_are_rejected() {
    for (width, height, stride, bytes) in [
        (0, 1, 4, 4),
        (2, 2, 4, 8),
        (2, 2, 8, 15),
        (u32::MAX, 2, 8, 16),
    ] {
        let frame = screen_capture::CapturedFrame::Rgba {
            data: vec![0; bytes].into(),
            width,
            height,
            stride,
            timestamp: Duration::ZERO,
        };
        assert!(capture_planes(&frame).is_none());
    }
}

#[test]
fn captured_pixels_survive_vp8_encode_and_decode() {
    let frame = screen_capture::CapturedFrame::Rgba {
        data: vec![48; 64 * 64 * 4].into(),
        width: 64,
        height: 64,
        stride: 64 * 4,
        timestamp: Duration::ZERO,
    };
    let planes = capture_planes(&frame).unwrap();
    let encoded = VideoEncoder::new(15).encode(&planes).unwrap();
    let decoded = VideoDecoder::new().decode(&encoded).unwrap();
    assert_eq!((decoded.width, decoded.height), (64, 64));
    assert_eq!(decoded.y.len(), 64 * 64);
    assert_eq!(decoded.u.len(), 32 * 32);
}

#[test]
fn oversized_vp8_keyframe_is_rejected_before_decode() {
    let mut header = [0, 0, 0, 0x9d, 0x01, 0x2a, 0, 0, 0, 0];
    header[6..8].copy_from_slice(&8192u16.to_le_bytes());
    header[8..10].copy_from_slice(&8192u16.to_le_bytes());
    assert!(VideoDecoder::new().decode(&header).is_none());
}
