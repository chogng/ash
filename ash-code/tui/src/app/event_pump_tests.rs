use super::RuntimeEvent;
use super::RuntimeQueue;
use super::next_process_resource_request;
use crate::client::ClientEvent;
use crate::terminal::TerminalEvent;
use ash_app_server_protocol::protocol::transcript::ThreadTranscriptUpdateEnvelope;
use ash_memory_diagnostics::ProcessResourceDemand;
use ash_memory_diagnostics::ProcessResourceRequest;
use ash_memory_diagnostics::ProcessResourceUsage;
use ash_memory_diagnostics::ProcessResourcesReading;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use crossterm::event::Event;
use crossterm::event::KeyModifiers;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use std::time::Instant;

#[test]
fn terminal_input_is_received_before_queued_client_work() {
    let queue = RuntimeQueue::default();
    let stop = AtomicBool::new(false);
    assert!(queue.push_client(ClientEvent::ConnectorsChanged, &stop));
    assert!(queue.push_terminal(
        RuntimeEvent::Terminal(TerminalEvent::Input(Event::FocusGained)),
        &stop,
    ));

    assert!(matches!(
        queue.recv(None).unwrap(),
        Some(RuntimeEvent::Terminal(TerminalEvent::Input(
            Event::FocusGained
        )))
    ));
    assert!(matches!(
        queue.recv(None).unwrap(),
        Some(RuntimeEvent::Client(ClientEvent::ConnectorsChanged))
    ));
}

#[test]
fn termination_is_received_before_every_queue_lane() {
    let queue = RuntimeQueue::default();
    let stop = AtomicBool::new(false);
    assert!(queue.push_client(ClientEvent::ConnectorsChanged, &stop));
    assert!(queue.push_terminal(
        RuntimeEvent::Terminal(TerminalEvent::Input(Event::FocusGained)),
        &stop,
    ));
    assert!(queue.request_termination(&stop));

    assert!(matches!(
        queue.recv(None).unwrap(),
        Some(RuntimeEvent::TerminationRequested)
    ));
}

#[test]
fn ticks_coalesce_while_the_consumer_is_busy() {
    let queue = RuntimeQueue::default();
    let stop = AtomicBool::new(false);
    assert!(queue.push_tick(&stop));
    assert!(queue.push_tick(&stop));
    assert!(queue.push_tick(&stop));

    assert!(matches!(
        queue.recv(None).unwrap(),
        Some(RuntimeEvent::Terminal(TerminalEvent::Tick))
    ));
    assert!(
        queue
            .recv(Some(Duration::from_millis(1)))
            .unwrap()
            .is_none()
    );
}

#[test]
fn process_resource_readings_coalesce_and_remain_behind_user_input() {
    let queue = RuntimeQueue::default();
    let stop = AtomicBool::new(false);
    assert!(queue.push_process_resources(resource_reading(1, 10), &stop));
    assert!(queue.push_process_resources(resource_reading(1, 20), &stop));
    assert!(queue.push_terminal(
        RuntimeEvent::Terminal(TerminalEvent::Input(Event::FocusGained)),
        &stop,
    ));

    assert!(matches!(
        queue.recv(None).unwrap(),
        Some(RuntimeEvent::Terminal(TerminalEvent::Input(
            Event::FocusGained
        )))
    ));
    let Some(RuntimeEvent::ProcessResources(reading)) = queue.recv(None).unwrap() else {
        panic!("expected a process resource reading");
    };
    assert_eq!(reading.current.unwrap().resident_bytes, Some(20));
    assert!(
        queue
            .recv(Some(Duration::from_millis(1)))
            .unwrap()
            .is_none()
    );
}

#[test]
fn stale_process_resource_reading_cannot_replace_a_newer_request() {
    let queue = RuntimeQueue::default();
    let stop = AtomicBool::new(false);
    assert!(queue.push_process_resources(resource_reading(2, 20), &stop));
    assert!(queue.push_process_resources(resource_reading(1, 10), &stop));

    let Some(RuntimeEvent::ProcessResources(reading)) = queue.recv(None).unwrap() else {
        panic!("expected a process resource reading");
    };
    assert_eq!(reading.request.revision, 2);
    assert_eq!(reading.current.unwrap().resident_bytes, Some(20));
}

#[test]
fn cpu_observation_cycle_restarts_only_after_cpu_was_not_requested() {
    let cpu = ProcessResourceDemand::Summary(ash_memory_diagnostics::ProcessResourceMetrics::Cpu);
    let first = next_process_resource_request(ProcessResourceRequest::default(), cpu);
    let detailed = next_process_resource_request(first, ProcessResourceDemand::Detailed);
    let disabled = next_process_resource_request(detailed, ProcessResourceDemand::Disabled);
    let restarted = next_process_resource_request(disabled, cpu);

    assert_eq!(
        [
            first.cpu_cycle,
            detailed.cpu_cycle,
            disabled.cpu_cycle,
            restarted.cpu_cycle
        ],
        [1, 1, 1, 2]
    );
    assert_eq!(restarted.revision, 4);
}

#[test]
fn consecutive_pointer_movements_keep_only_the_latest_position() {
    let queue = RuntimeQueue::default();
    let stop = AtomicBool::new(false);
    assert!(queue.push_terminal(mouse(MouseEventKind::Moved, 2, 3), &stop));
    assert!(queue.push_terminal(mouse(MouseEventKind::Moved, 8, 5), &stop));

    assert_mouse(queue.recv(None).unwrap(), MouseEventKind::Moved, 8, 5);
    assert!(
        queue
            .recv(Some(Duration::from_millis(1)))
            .unwrap()
            .is_none()
    );
}

#[test]
fn mouse_up_overtakes_pending_drag_positions() {
    let queue = RuntimeQueue::default();
    let stop = AtomicBool::new(false);
    assert!(queue.push_terminal(mouse(MouseEventKind::Down(MouseButton::Left), 1, 1), &stop,));
    assert!(queue.push_terminal(mouse(MouseEventKind::Drag(MouseButton::Left), 4, 2), &stop,));
    assert!(queue.push_terminal(mouse(MouseEventKind::Drag(MouseButton::Left), 9, 6), &stop,));
    assert!(queue.push_terminal(mouse(MouseEventKind::Up(MouseButton::Left), 10, 6), &stop,));

    assert_mouse(
        queue.recv(None).unwrap(),
        MouseEventKind::Down(MouseButton::Left),
        1,
        1,
    );
    assert_mouse(
        queue.recv(None).unwrap(),
        MouseEventKind::Up(MouseButton::Left),
        10,
        6,
    );
    assert!(
        queue
            .recv(Some(Duration::from_millis(1)))
            .unwrap()
            .is_none()
    );
}

#[test]
fn client_control_is_served_after_a_bounded_terminal_burst() {
    let queue = RuntimeQueue::default();
    let stop = AtomicBool::new(false);
    assert!(queue.push_client(ClientEvent::ConnectorsChanged, &stop));
    for _ in 0..20 {
        assert!(queue.push_terminal(
            RuntimeEvent::Terminal(TerminalEvent::Input(Event::FocusGained)),
            &stop,
        ));
    }

    for _ in 0..super::TERMINAL_BURST_LIMIT {
        assert!(matches!(
            queue.recv(None).unwrap(),
            Some(RuntimeEvent::Terminal(TerminalEvent::Input(
                Event::FocusGained
            )))
        ));
    }
    assert!(matches!(
        queue.recv(None).unwrap(),
        Some(RuntimeEvent::Client(ClientEvent::ConnectorsChanged))
    ));
}

#[test]
fn client_control_overtakes_transcript_data() {
    let queue = RuntimeQueue::default();
    let stop = AtomicBool::new(false);
    assert!(queue.push_client(transcript_update(), &stop));
    assert!(queue.push_client(ClientEvent::ConfigChanged, &stop));

    assert!(matches!(
        queue.recv(None).unwrap(),
        Some(RuntimeEvent::Client(ClientEvent::ConfigChanged))
    ));
    assert!(matches!(
        queue.recv(None).unwrap(),
        Some(RuntimeEvent::Client(ClientEvent::ThreadTranscriptUpdated(
            _
        )))
    ));
}

fn mouse(kind: MouseEventKind, column: u16, row: u16) -> RuntimeEvent {
    RuntimeEvent::Terminal(TerminalEvent::Input(Event::Mouse(MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    })))
}

fn resource_reading(revision: u64, resident_bytes: u64) -> ProcessResourcesReading {
    ProcessResourcesReading {
        request: ProcessResourceRequest {
            revision,
            cpu_cycle: 1,
            demand: ProcessResourceDemand::Detailed,
        },
        current: Ok(ProcessResourceUsage {
            resident_bytes: Some(resident_bytes),
            cpu_tenths_percent: Some(10),
        }),
        tree: None,
        sampled_at: Instant::now(),
    }
}

fn transcript_update() -> ClientEvent {
    ClientEvent::ThreadTranscriptUpdated(Box::new(ThreadTranscriptUpdateEnvelope {
        session_id: SessionId::new("session").unwrap(),
        thread_id: ThreadId::new("thread").unwrap(),
        durable_sequence: 1,
        revision: 1,
        stream_cursor: None,
        changes: Vec::new(),
    }))
}

fn assert_mouse(
    event: Option<RuntimeEvent>,
    expected_kind: MouseEventKind,
    expected_column: u16,
    expected_row: u16,
) {
    let Some(RuntimeEvent::Terminal(TerminalEvent::Input(Event::Mouse(mouse)))) = event else {
        panic!("expected a mouse input event");
    };
    assert_eq!(mouse.kind, expected_kind);
    assert_eq!(mouse.column, expected_column);
    assert_eq!(mouse.row, expected_row);
}
