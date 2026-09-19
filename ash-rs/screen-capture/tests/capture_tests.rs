use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use screen_capture::CaptureTarget;
use screen_capture::PermissionStatus;
use screen_capture::ScreenCaptureSource;
use screen_capture::check_permission;
use screen_capture::create_display_source;
use screen_capture::create_window_source;
use screen_capture::enumerate_displays;
use screen_capture::enumerate_windows;
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

#[test]
fn test_permission_query() {
    let status = check_permission();
    #[cfg(target_os = "macos")]
    assert!(
        status == PermissionStatus::Granted || status == PermissionStatus::Denied,
        "unexpected permission status: {:?}",
        status
    );
    #[cfg(not(target_os = "macos"))]
    assert_eq!(status, PermissionStatus::NotDetermined);
}

#[test]
fn test_display_enumeration() {
    let displays = enumerate_displays();
    #[cfg(target_os = "macos")]
    {
        let displays = displays.expect("enumerate_displays should succeed on macOS");
        for disp in &displays {
            assert!(!disp.id.is_empty(), "display id should not be empty");
            assert!(disp.width > 0, "display width should be > 0");
            assert!(disp.height > 0, "display height should be > 0");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        assert!(displays.is_err());
    }
}

#[test]
fn test_window_enumeration() {
    let windows = enumerate_windows();
    #[cfg(target_os = "macos")]
    {
        let windows = windows.expect("enumerate_windows should succeed on macOS");
        for win in &windows {
            assert!(!win.id.is_empty(), "window id should not be empty");
            assert!(win.width > 0, "window width should be > 0");
            assert!(win.height > 0, "window height should be > 0");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        assert!(windows.is_err());
    }
}

#[test]
fn test_source_creation_and_targets() {
    #[cfg(target_os = "macos")]
    {
        if let Ok(displays) = enumerate_displays() {
            if let Some(first_disp) = displays.first() {
                let source = create_display_source(&first_disp.id)
                    .expect("create_display_source should succeed for valid display");
                assert_eq!(source.info().id, first_disp.id);
                match source.target() {
                    CaptureTarget::Display(info) => {
                        assert_eq!(info.id, first_disp.id);
                    }
                    CaptureTarget::Window(_) => panic!("expected display target"),
                }
            }
        }

        if let Ok(windows) = enumerate_windows() {
            if let Some(first_win) = windows.first() {
                let source = create_window_source(&first_win.id)
                    .expect("create_window_source should succeed for valid window");
                assert_eq!(source.info().id, first_win.id);
                match source.target() {
                    CaptureTarget::Window(info) => {
                        assert_eq!(info.id, first_win.id);
                    }
                    CaptureTarget::Display(_) => panic!("expected window target"),
                }
            }
        }
    }
}

#[tokio::test]
async fn test_platform_display_stream_lifecycle() {
    #[cfg(target_os = "macos")]
    {
        if check_permission() != PermissionStatus::Granted {
            return;
        }

        let displays = match enumerate_displays() {
            Ok(d) if !d.is_empty() => d,
            _ => return,
        };

        let source = create_display_source(&displays[0].id)
            .expect("display source creation should succeed");

        let frame_received = Arc::new(AtomicUsize::new(0));
        let frame_received_clone = Arc::clone(&frame_received);

        let mut stream = match source.start_stream(
            15,
            Box::new(move |frame| {
                assert!(frame.width() > 0);
                assert!(frame.height() > 0);
                frame_received_clone.fetch_add(1, Ordering::SeqCst);
            }),
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        assert!(stream.is_active());
        tokio::time::sleep(Duration::from_millis(250)).await;

        stream.stop();
        assert!(!stream.is_active());
    }
}
