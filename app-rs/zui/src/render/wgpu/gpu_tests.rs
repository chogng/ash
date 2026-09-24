use super::{srgb_channel, wgpu_color};
use crate::ui::foundation::Color;

#[test]
fn converts_srgb_background_to_linear_wgpu_color() {
    let color = wgpu_color(Color::rgba(128, 64, 255, 127));

    assert!((color.r - srgb_channel(128)).abs() < f64::EPSILON);
    assert!((color.g - srgb_channel(64)).abs() < f64::EPSILON);
    assert_eq!(color.b, 1.0);
    assert_eq!(color.a, 127.0 / 255.0);
}

#[test]
fn preserves_black_and_white_endpoints() {
    assert_eq!(srgb_channel(0), 0.0);
    assert_eq!(srgb_channel(255), 1.0);
}

#[test]
#[ignore = "requires a graphics adapter; run explicitly on a graphics-enabled host"]
fn memory_reader_observes_gpu_buffer_release_and_current_cache_counts() {
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    let instance = wgpu::Instance::default();
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .expect("graphics adapter required for this test");
    let (device, _queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).unwrap();
    let cache = Arc::new(AtomicUsize::new(2));
    let reader =
        super::memory_reader(instance, cache.clone()).expect("wgpu-core statistics required");
    let baseline = reader.read();
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("memory diagnostics test"),
        size: 4096,
        usage: wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    assert_eq!(reader.read().gpu_resources, baseline.gpu_resources + 1);
    cache.store(7, Ordering::Relaxed);
    assert_eq!(reader.read().cache_entries, 7);
    drop(buffer);
    assert_eq!(reader.read().gpu_resources, baseline.gpu_resources);
}
