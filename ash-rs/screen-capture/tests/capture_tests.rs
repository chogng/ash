use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use screen_capture::ScreenCaptureSource;
use screen_capture::mock::MockCaptureSource;

#[tokio::test]
async fn test_mock_capture_stream_lifecycle() {
    let source = MockCaptureSource::new("test_disp", 640, 480);
    assert_eq!(source.info().width, 640);
    assert_eq!(source.info().height, 480);

    let frame_count = Arc::new(AtomicUsize::new(0));
    let frame_count_clone = Arc::clone(&frame_count);

    let mut stream = source
        .start_stream(
            30,
            Box::new(move |frame| {
                assert_eq!(frame.width(), 640);
                assert_eq!(frame.height(), 480);
                frame_count_clone.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .expect("mock stream should start successfully");

    assert!(stream.is_active());

    tokio::time::sleep(Duration::from_millis(150)).await;
    let received = frame_count.load(Ordering::SeqCst);
    assert!(received >= 2, "expected at least 2 frames, got {received}");

    stream.stop();
    assert!(!stream.is_active());

    let count_after_stop = frame_count.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        frame_count.load(Ordering::SeqCst),
        count_after_stop,
        "no more frames should be sent after stop"
    );
}
