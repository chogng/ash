use std::sync::Arc;
use std::sync::Mutex;

use crate::ui::foundation::Color;
use crate::ui::presentation::Element;
use crate::ui::presentation::UiScene;
use crate::window::PhysicalExtent;
use crate::window::WindowId;

use super::DiagnosticEvent;
use super::DiagnosticEventKind;
use super::DiagnosticsHandle;
use super::DiagnosticsSink;
use super::WindowMetrics;

#[derive(Default)]
struct RecordingSink {
    events: Mutex<Vec<DiagnosticEvent>>,
}

impl DiagnosticsSink for RecordingSink {
    fn record(&self, event: &DiagnosticEvent) {
        self.events
            .lock()
            .expect("recording sink lock")
            .push(event.clone());
    }
}

#[test]
fn bounded_trace_retains_latest_events_and_live_windows() {
    let diagnostics = DiagnosticsHandle::new(2, None, false);
    let window = WindowId::from_raw(7);
    diagnostics.record(DiagnosticEventKind::Resumed);
    diagnostics.open_window(
        window,
        WindowMetrics::new(PhysicalExtent::new(800, 600), 2.0),
    );
    diagnostics.record(DiagnosticEventKind::WindowEvent(window));
    diagnostics.set_work_counts(3, 2);

    let snapshot = diagnostics.snapshot();
    assert_eq!(snapshot.events.len(), 2);
    assert_eq!(snapshot.events[0].sequence, 2);
    assert_eq!(snapshot.windows.len(), 1);
    assert_eq!(snapshot.active_tasks, 3);
    assert_eq!(snapshot.active_timers, 2);
}

#[test]
fn sink_receives_events_and_clear_preserves_sequence_progress() {
    let sink = Arc::new(RecordingSink::default());
    let diagnostics = DiagnosticsHandle::new(2, Some(sink.clone()), false);

    diagnostics.record(DiagnosticEventKind::Resumed);
    diagnostics.clear_events();
    diagnostics.record(DiagnosticEventKind::Exiting);

    let snapshot = diagnostics.snapshot();
    assert_eq!(snapshot.events.len(), 1);
    assert_eq!(snapshot.events[0].sequence, 2);

    let events = sink.events.lock().expect("recording sink lock");
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].sequence, 1);
    assert_eq!(events[1].sequence, 2);
}

#[test]
fn scene_inspection_retention_is_opt_in() {
    let mut scene = UiScene::new(Color::TRANSPARENT);
    scene.with_element(
        Element::leaf("InspectorTarget")
            .in_bounds(crate::ui::Rect::from_xywh(0.0, 0.0, 80.0, 24.0)),
        |_, _| {},
    );

    let without_inspection = DiagnosticsHandle::new(2, None, false).scene_diagnostics(&scene, 1);
    assert!(without_inspection.inspection.is_none());

    let with_inspection = DiagnosticsHandle::new(2, None, true).scene_diagnostics(&scene, 1);
    let inspection = with_inspection
        .inspection
        .expect("inspection retention should copy the frame");
    assert_eq!(inspection.nodes().len(), 1);
    assert_eq!(inspection.nodes()[0].name(), "InspectorTarget");
    assert_eq!(with_inspection.accessibility_nodes, 1);
}

#[test]
fn renderer_memory_readers_are_lazy_and_released_with_their_window() {
    use crate::render::RendererMemory;
    use crate::render::RendererMemoryReader;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    let diagnostics = DiagnosticsHandle::new(2, None, false);
    let window = WindowId::from_raw(18);
    let calls = Arc::new(AtomicUsize::new(0));
    let owner = Arc::new(());
    let weak_owner = Arc::downgrade(&owner);
    diagnostics.open_window(
        window,
        WindowMetrics::new(PhysicalExtent::new(800, 600), 1.0),
    );
    let counter = calls.clone();
    diagnostics.set_memory_reader(
        window,
        Some(RendererMemoryReader::new(move || {
            let _ = &owner;
            counter.fetch_add(1, Ordering::Relaxed);
            RendererMemory {
                gpu_resources: 14,
                cache_entries: 3,
            }
        })),
    );
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    assert_eq!(
        diagnostics.snapshot().windows[0].renderer_memory,
        Some(RendererMemory {
            gpu_resources: 14,
            cache_entries: 3
        })
    );
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    diagnostics.close_window(window);
    assert!(weak_owner.upgrade().is_none());
    assert!(diagnostics.snapshot().windows.is_empty());
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}
