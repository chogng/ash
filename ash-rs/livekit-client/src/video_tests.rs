use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use livekit::webrtc::prelude::VideoBuffer;
use screen_capture::ScreenCaptureSource;
use screen_capture::mock::MockCaptureSource;

use crate::room::convert_captured_frame_to_webrtc;

#[tokio::test]
async fn test_screen_capture_frame_conversion() {
    let source = MockCaptureSource::new("test_display", 320, 240);
    let converted_count = Arc::new(AtomicUsize::new(0));
    let converted_count_clone = Arc::clone(&converted_count);

    let mut stream = source
        .start_stream(
            30,
            Box::new(move |frame| {
                let video_frame = convert_captured_frame_to_webrtc(&frame);
                assert!(video_frame.is_some());
                let frame = video_frame.unwrap();
                assert_eq!(frame.buffer.width(), 320);
                assert_eq!(frame.buffer.height(), 240);
                converted_count_clone.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .expect("mock stream should start");

    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(converted_count.load(Ordering::SeqCst) >= 2);
    stream.stop();
}
