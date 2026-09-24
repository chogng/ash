use super::AppProxy;
use super::OpenWindowFuture;

fn require_send_sync<T: Send + Sync>() {}
fn require_send<T: Send>() {}

#[test]
fn application_proxy_and_window_future_cross_thread_boundaries() {
    require_send_sync::<AppProxy<usize>>();
    require_send::<OpenWindowFuture>();
}
