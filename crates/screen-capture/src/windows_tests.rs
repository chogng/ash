use super::*;
use windows::Win32::UI::WindowsAndMessaging::CreateWindowExW;
use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;
use windows::Win32::UI::WindowsAndMessaging::DispatchMessageW;
use windows::Win32::UI::WindowsAndMessaging::MSG;
use windows::Win32::UI::WindowsAndMessaging::PM_REMOVE;
use windows::Win32::UI::WindowsAndMessaging::PeekMessageW;
use windows::Win32::UI::WindowsAndMessaging::SWP_NOMOVE;
use windows::Win32::UI::WindowsAndMessaging::SWP_NOZORDER;
use windows::Win32::UI::WindowsAndMessaging::SetWindowPos;
use windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE;
use windows::Win32::UI::WindowsAndMessaging::WS_OVERLAPPEDWINDOW;
use windows::Win32::UI::WindowsAndMessaging::WS_VISIBLE;
use windows::core::w;

struct TestWindow(HWND);
impl Drop for TestWindow {
    fn drop(&mut self) {
        let _ = unsafe { DestroyWindow(self.0) };
    }
}

fn pump_until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !predicate() {
        assert!(Instant::now() < deadline, "capture did not make progress");
        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
            unsafe {
                DispatchMessageW(&message);
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn invalid_sources_are_rejected_without_starting_capture() {
    assert!(matches!(
        create_display_source("invalid"),
        Err(CaptureError::NotFound(_))
    ));
    assert!(matches!(
        create_window_source("invalid"),
        Err(CaptureError::NotFound(_))
    ));
}

#[test]
#[ignore = "requires an interactive Windows desktop and GPU; captures only its own test window"]
fn window_frames_resize_stop_and_close_release_capture() {
    let window = TestWindow(
        unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("Ash capture test"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                20,
                20,
                320,
                240,
                None,
                None,
                None,
                None,
            )
        }
        .unwrap(),
    );
    let source = create_window_source(&(window.0.0 as usize).to_string()).unwrap();
    assert!(matches!(source.target(), CaptureTarget::Window(_)));
    for _ in 0..3 {
        let (send, receive) = mpsc::channel();
        let mut stream = source
            .start_stream(
                15,
                Box::new(move |frame| {
                    let _ = send.send((frame.width(), frame.height()));
                }),
            )
            .unwrap();
        let mut first = None;
        pump_until(|| {
            assert!(stream.is_active(), "capture worker ended before a frame");
            first = receive.try_recv().ok();
            first.is_some()
        });
        let first = first.unwrap();
        assert!(first.0 > 0 && first.1 > 0);
        unsafe { SetWindowPos(window.0, None, 0, 0, 640, 480, SWP_NOMOVE | SWP_NOZORDER) }.unwrap();
        pump_until(|| {
            receive
                .try_iter()
                .any(|size| size.0 > first.0 && size.1 > first.1)
        });
        stream.stop();
        assert!(!stream.is_active());
        while receive.try_recv().is_ok() {}
        thread::sleep(Duration::from_millis(100));
        assert!(receive.try_recv().is_err());
        unsafe { SetWindowPos(window.0, None, 0, 0, 320, 240, SWP_NOMOVE | SWP_NOZORDER) }.unwrap();
    }
    let mut stream = source.start_stream(15, Box::new(|_| {})).unwrap();
    drop(window);
    pump_until(|| !stream.is_active());
    stream.stop();
}
