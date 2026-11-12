use super::start_capture_stream;
use crate::CaptureError;
use crate::CapturedFrame;
use crate::ScreenCaptureStream;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::sleep;
use tokio::time::timeout;

async fn wait_for_stop(stream: &dyn ScreenCaptureStream, limit: Duration) {
    timeout(limit, async {
        while stream.is_active() {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("capture stream should stop");
}

#[tokio::test(start_paused = true)]
async fn capture_stream_stops_immediately_when_permission_is_denied() {
    let stream =
        start_capture_stream(4, Box::new(|_| {}), |_| Err(CaptureError::PermissionDenied)).unwrap();

    wait_for_stop(&*stream, Duration::from_millis(200)).await;
    assert_eq!(
        stream.error(),
        Some(CaptureError::PermissionDenied.to_string())
    );
}

#[tokio::test(start_paused = true)]
async fn capture_stream_stops_and_reports_a_persistent_backend_failure() {
    let stream = start_capture_stream(4, Box::new(|_| panic!("unexpected frame")), |_| {
        Err(CaptureError::Backend("test source unavailable".into()))
    })
    .unwrap();

    sleep(Duration::from_millis(1_900)).await;
    assert!(stream.is_active());
    assert_eq!(stream.error(), None);
    wait_for_stop(&*stream, Duration::from_millis(500)).await;
    assert_eq!(
        stream.error().as_deref(),
        Some("capture backend failed: test source unavailable")
    );
}

#[tokio::test(start_paused = true)]
async fn a_delivered_frame_resets_the_capture_failure_grace_period() {
    let (frames, mut received) = mpsc::unbounded_channel();
    let stream = start_capture_stream(
        4,
        Box::new(move |frame| frames.send(frame.timestamp()).unwrap()),
        |timestamp| {
            let elapsed = timestamp.as_millis();
            if !(1_500..1_750).contains(&elapsed) && elapsed < 3_250 {
                return Err(CaptureError::Backend("temporary failure".into()));
            }
            Ok(CapturedFrame::Rgba {
                data: Arc::from([0; 4]),
                width: 1,
                height: 1,
                stride: 4,
                timestamp,
            })
        },
    )
    .unwrap();

    timeout(Duration::from_secs(4), async {
        let first = received.recv().await.unwrap();
        assert!(first < Duration::from_secs(2));
        while received.recv().await.unwrap() < Duration::from_millis(3_250) {}
    })
    .await
    .expect("frames should resume after both temporary failures");
    assert!(stream.is_active());
    assert_eq!(stream.error(), None);
}
