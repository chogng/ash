use crate::client::ClientEvent;
use crate::client::ClientEventSource;
use crate::host::TerminationSource;
use crate::terminal::TerminalEvent;
use crate::terminal::TerminalEventSource;
use ash_app_server_client::AppServerEvents;
use ash_memory_diagnostics::ProcessResourceDemand;
use ash_memory_diagnostics::ProcessResourceRequest;
use ash_memory_diagnostics::ProcessResourceTargets;
use ash_memory_diagnostics::ProcessResourcesReading;
use ash_memory_diagnostics::ProcessResourcesSource;
use crossterm::event::Event;
use crossterm::event::MouseEventKind;
use std::collections::VecDeque;
use std::io;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

const EVENT_QUEUE_CAPACITY: usize = 1_024;
const TERMINAL_BURST_LIMIT: usize = 8;

pub(super) enum RuntimeEvent {
    Terminal(TerminalEvent),
    Client(ClientEvent),
    ProcessResources(ProcessResourcesReading),
    HostNotice(String),
    TerminationRequested,
}

pub(super) struct EventPump {
    queue: Arc<RuntimeQueue>,
    stop: Arc<AtomicBool>,
    terminal: TerminalEventSource,
    client: ClientEventSource,
    process_resources: ProcessResourcesRuntime,
    process_resource_request: ProcessResourceRequest,
    notices: Option<crate::TuiNotices>,
    _termination: TerminationSource,
}

enum ProcessResourcesRuntime {
    Active(ProcessResourcesSource),
    Unavailable {
        error: String,
        targets: ProcessResourceTargets,
    },
}

impl EventPump {
    pub(super) fn start(
        events: AppServerEvents,
        resource_targets: ProcessResourceTargets,
        notices: Option<crate::TuiNotices>,
    ) -> Result<Self, io::Error> {
        let queue = Arc::new(RuntimeQueue::default());
        let stop = Arc::new(AtomicBool::new(false));
        let termination = TerminationSource::register()?;
        let termination_request = termination.request();
        let terminal_stop = Arc::clone(&stop);
        let terminal_queue = Arc::clone(&queue);
        let terminal = TerminalEventSource::start(Arc::clone(&stop), move |event| {
            if termination_request.take() {
                let _ = terminal_queue.request_termination(&terminal_stop);
                return false;
            }
            if matches!(event, TerminalEvent::Tick) {
                terminal_queue.push_tick(&terminal_stop)
            } else {
                terminal_queue.push_terminal(RuntimeEvent::Terminal(event), &terminal_stop)
            }
        })?;

        let client_queue = Arc::clone(&queue);
        let client_stop = Arc::clone(&stop);
        let client = match ClientEventSource::start(events, Arc::clone(&stop), move |event| {
            client_queue.push_client(event, &client_stop)
        }) {
            Ok(client) => client,
            Err(error) => {
                stop.store(true, Ordering::Release);
                queue.close();
                let mut terminal = terminal;
                let _ = terminal.join();
                return Err(error);
            }
        };

        let resources_queue = Arc::clone(&queue);
        let resources_stop = Arc::clone(&stop);
        let process_resources = match ProcessResourcesSource::start(
            Arc::clone(&stop),
            resource_targets,
            move |reading| resources_queue.push_process_resources(reading, &resources_stop),
        ) {
            Ok(source) => ProcessResourcesRuntime::Active(source),
            Err(error) => ProcessResourcesRuntime::Unavailable {
                error: error.to_string(),
                targets: resource_targets,
            },
        };

        Ok(Self {
            queue,
            stop,
            terminal,
            client,
            process_resources,
            process_resource_request: ProcessResourceRequest::default(),
            notices,
            _termination: termination,
        })
    }

    pub(super) fn set_process_resource_demand(
        &mut self,
        demand: ProcessResourceDemand,
    ) -> ProcessResourceRequest {
        if self.process_resource_request.demand == demand {
            return self.process_resource_request;
        }
        let request = next_process_resource_request(self.process_resource_request, demand);
        self.process_resource_request = request;
        match &self.process_resources {
            ProcessResourcesRuntime::Active(source) => source.set_request(request),
            ProcessResourcesRuntime::Unavailable { error, targets }
                if !matches!(demand, ProcessResourceDemand::Disabled) =>
            {
                let reading = ProcessResourcesReading {
                    request,
                    current: Err(error.clone()),
                    tree: matches!(targets, ProcessResourceTargets::CurrentAndTree(_))
                        .then(|| Err(error.clone())),
                    sampled_at: std::time::Instant::now(),
                };
                let _ = self.queue.push_process_resources(reading, &self.stop);
            }
            ProcessResourcesRuntime::Unavailable { .. } => {}
        }
        request
    }

    pub(super) fn recv(&self) -> Result<RuntimeEvent, io::Error> {
        if let Some(notice) = self.notice() {
            return Ok(notice);
        }
        self.queue.recv(None)?.ok_or_else(queue_closed)
    }

    pub(super) fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Option<RuntimeEvent>, io::Error> {
        if let Some(notice) = self.notice() {
            return Ok(Some(notice));
        }
        self.queue.recv(Some(timeout))
    }

    fn notice(&self) -> Option<RuntimeEvent> {
        self.notices
            .as_ref()
            .and_then(|notices| notices.try_recv().ok())
            .map(RuntimeEvent::HostNotice)
    }

    pub(super) fn shutdown(mut self) -> Result<(), io::Error> {
        self.stop.store(true, Ordering::Release);
        self.queue.close();
        let resources_result = match &mut self.process_resources {
            ProcessResourcesRuntime::Active(source) => source.join(),
            ProcessResourcesRuntime::Unavailable { .. } => Ok(()),
        };
        let terminal_result = self.terminal.join();
        let client_result = self.client.join();
        resources_result.and(terminal_result).and(client_result)
    }
}

fn next_process_resource_request(
    current: ProcessResourceRequest,
    demand: ProcessResourceDemand,
) -> ProcessResourceRequest {
    let revision = current
        .revision
        .checked_add(1)
        .expect("process resource request revision overflowed");
    let previous_cpu = current
        .demand
        .metrics()
        .is_some_and(|metrics| metrics.includes_cpu());
    let next_cpu = demand
        .metrics()
        .is_some_and(|metrics| metrics.includes_cpu());
    let cpu_cycle = if !previous_cpu && next_cpu {
        current
            .cpu_cycle
            .checked_add(1)
            .expect("process CPU observation cycle overflowed")
    } else {
        current.cpu_cycle
    };
    ProcessResourceRequest {
        revision,
        cpu_cycle,
        demand,
    }
}

#[derive(Default)]
struct RuntimeQueue {
    state: Mutex<RuntimeQueueState>,
    available: Condvar,
    space: Condvar,
}

#[derive(Default)]
struct RuntimeQueueState {
    terminal: VecDeque<RuntimeEvent>,
    client_control: VecDeque<RuntimeEvent>,
    client_data: VecDeque<RuntimeEvent>,
    process_resources: Option<ProcessResourcesReading>,
    tick_pending: bool,
    termination_requested: bool,
    closed: bool,
    terminal_burst: usize,
    next_nonterminal: NonTerminalLane,
}

impl RuntimeQueue {
    fn push_terminal(&self, event: RuntimeEvent, stop: &AtomicBool) -> bool {
        self.push(event, stop, QueueLane::Terminal)
    }

    fn push_client(&self, event: ClientEvent, stop: &AtomicBool) -> bool {
        let lane = match event {
            ClientEvent::ThreadTranscriptUpdated(_) => QueueLane::ClientData,
            _ => QueueLane::ClientControl,
        };
        self.push(RuntimeEvent::Client(event), stop, lane)
    }

    fn push_process_resources(&self, reading: ProcessResourcesReading, stop: &AtomicBool) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.closed || stop.load(Ordering::Acquire) {
            return false;
        }
        if state
            .process_resources
            .as_ref()
            .is_none_or(|current| current.request.revision <= reading.request.revision)
        {
            state.process_resources = Some(reading);
        }
        self.available.notify_one();
        true
    }

    fn push(&self, event: RuntimeEvent, stop: &AtomicBool, lane: QueueLane) -> bool {
        let mut state = self.state.lock().unwrap();
        let mut event = event;
        loop {
            if matches!(lane, QueueLane::Terminal) {
                match coalesce_pointer_input(&mut state.terminal, event) {
                    Some(pending) => event = pending,
                    None => {
                        self.available.notify_one();
                        return true;
                    }
                }
            }
            if lane.queue(&mut state).len() < EVENT_QUEUE_CAPACITY
                || state.closed
                || stop.load(Ordering::Acquire)
            {
                break;
            }
            state = self.space.wait(state).unwrap();
        }
        if state.closed || stop.load(Ordering::Acquire) {
            return false;
        }
        lane.queue(&mut state).push_back(event);
        self.available.notify_one();
        true
    }

    fn push_tick(&self, stop: &AtomicBool) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.closed || stop.load(Ordering::Acquire) {
            return false;
        }
        state.tick_pending = true;
        self.available.notify_one();
        true
    }

    fn request_termination(&self, stop: &AtomicBool) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.closed || stop.load(Ordering::Acquire) {
            return false;
        }
        state.termination_requested = true;
        self.available.notify_one();
        true
    }

    fn recv(&self, timeout: Option<Duration>) -> Result<Option<RuntimeEvent>, io::Error> {
        let mut state = self.state.lock().unwrap();
        if let Some(timeout) = timeout {
            let (next, wait) = self
                .available
                .wait_timeout_while(state, timeout, |state| state.is_empty())
                .unwrap();
            state = next;
            if wait.timed_out() && state.is_empty() {
                return Ok(None);
            }
        } else {
            state = self
                .available
                .wait_while(state, |state| state.is_empty())
                .unwrap();
        }

        let event = state.pop();
        self.space.notify_all();
        if event.is_none() && state.closed {
            return Err(queue_closed());
        }
        Ok(event)
    }

    fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        self.available.notify_all();
        self.space.notify_all();
    }
}

fn coalesce_pointer_input(
    queue: &mut VecDeque<RuntimeEvent>,
    incoming: RuntimeEvent,
) -> Option<RuntimeEvent> {
    let Some(incoming_kind) = mouse_kind(&incoming) else {
        return Some(incoming);
    };
    let Some(previous_kind) = queue.back().and_then(mouse_kind) else {
        return Some(incoming);
    };

    let replace_previous = matches!(
        (previous_kind, incoming_kind),
        (MouseEventKind::Moved, MouseEventKind::Moved)
    ) || matches!(
        (previous_kind, incoming_kind),
        (MouseEventKind::Drag(previous), MouseEventKind::Drag(incoming)) if previous == incoming
    );
    if replace_previous {
        *queue
            .back_mut()
            .expect("the previous pointer event is still queued") = incoming;
        return None;
    }

    if matches!(
        (previous_kind, incoming_kind),
        (MouseEventKind::Drag(previous), MouseEventKind::Up(incoming)) if previous == incoming
    ) {
        queue.pop_back();
    }
    Some(incoming)
}

fn mouse_kind(event: &RuntimeEvent) -> Option<MouseEventKind> {
    match event {
        RuntimeEvent::Terminal(TerminalEvent::Input(Event::Mouse(mouse))) => Some(mouse.kind),
        RuntimeEvent::Terminal(_)
        | RuntimeEvent::Client(_)
        | RuntimeEvent::ProcessResources(_)
        | RuntimeEvent::HostNotice(_)
        | RuntimeEvent::TerminationRequested => None,
    }
}

impl RuntimeQueueState {
    fn is_empty(&self) -> bool {
        !self.termination_requested
            && self.terminal.is_empty()
            && self.client_control.is_empty()
            && self.client_data.is_empty()
            && self.process_resources.is_none()
            && !self.tick_pending
            && !self.closed
    }

    fn pop(&mut self) -> Option<RuntimeEvent> {
        if std::mem::take(&mut self.termination_requested) {
            return Some(RuntimeEvent::TerminationRequested);
        }
        let has_nonterminal = !self.client_control.is_empty()
            || !self.client_data.is_empty()
            || self.process_resources.is_some()
            || self.tick_pending;
        if self.terminal_burst < TERMINAL_BURST_LIMIT || !has_nonterminal {
            if let Some(event) = self.terminal.pop_front() {
                self.terminal_burst = self
                    .terminal_burst
                    .saturating_add(1)
                    .min(TERMINAL_BURST_LIMIT);
                return Some(event);
            }
        }
        if let Some(event) = self.pop_nonterminal() {
            self.terminal_burst = 0;
            return Some(event);
        }
        if let Some(event) = self.terminal.pop_front() {
            self.terminal_burst = 1;
            return Some(event);
        }
        None
    }

    fn pop_nonterminal(&mut self) -> Option<RuntimeEvent> {
        let mut lane = self.next_nonterminal;
        for _ in 0..NonTerminalLane::COUNT {
            let event = match lane {
                NonTerminalLane::ClientControl => self.client_control.pop_front(),
                NonTerminalLane::ClientData => self.client_data.pop_front(),
                NonTerminalLane::ProcessResources => self
                    .process_resources
                    .take()
                    .map(RuntimeEvent::ProcessResources),
                NonTerminalLane::Tick => std::mem::take(&mut self.tick_pending)
                    .then_some(RuntimeEvent::Terminal(TerminalEvent::Tick)),
            };
            self.next_nonterminal = lane.next();
            if event.is_some() {
                return event;
            }
            lane = self.next_nonterminal;
        }
        None
    }
}

#[derive(Clone, Copy)]
enum QueueLane {
    Terminal,
    ClientControl,
    ClientData,
}

impl QueueLane {
    fn queue<'a>(&self, state: &'a mut RuntimeQueueState) -> &'a mut VecDeque<RuntimeEvent> {
        match self {
            Self::Terminal => &mut state.terminal,
            Self::ClientControl => &mut state.client_control,
            Self::ClientData => &mut state.client_data,
        }
    }
}

#[derive(Clone, Copy, Default)]
enum NonTerminalLane {
    #[default]
    ClientControl,
    ClientData,
    ProcessResources,
    Tick,
}

impl NonTerminalLane {
    const COUNT: usize = 4;

    fn next(self) -> Self {
        match self {
            Self::ClientControl => Self::ClientData,
            Self::ClientData => Self::ProcessResources,
            Self::ProcessResources => Self::Tick,
            Self::Tick => Self::ClientControl,
        }
    }
}

fn queue_closed() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "TUI event sources stopped")
}

impl Drop for EventPump {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.queue.close();
    }
}

#[cfg(test)]
#[path = "event_pump_tests.rs"]
mod tests;
