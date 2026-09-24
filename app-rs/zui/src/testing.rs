//! Deterministic application and renderer tools for framework consumer tests.

use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use crate::app::ApplicationActivation;
use crate::app::ApplicationExitDecision;
use crate::app::ApplicationExitReason;
use crate::app::ApplicationPhase;
use crate::app::ApplicationReadiness;
use crate::app::ApplicationReadyFuture;
use crate::app::ExitPolicy;
use crate::app::LifecycleCore;
use crate::app::ProtocolUrl;
use crate::app::SecondInstance;
use crate::app::WindowFramePresentation;
use crate::render::RenderOutcome;
use crate::render::RenderTargetSize;
use crate::render::Renderer;
use crate::render::RendererError;
use crate::runtime::AccessibilityNode;
use crate::runtime::InteractionFrame;
use crate::runtime::UiDispatch;
use crate::services::GlobalShortcutEvent;
use crate::services::TrayEvent;
use crate::ui::presentation::UiFrame;
use crate::ui::presentation::UiScene;
use crate::window::LogicalSize;
use crate::window::WindowId;

/// Manually advanced monotonic clock used by deterministic application tests.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TestClock {
    now: Instant,
}

impl TestClock {
    /// Creates a clock at an explicit monotonic instant.
    pub const fn at(now: Instant) -> Self {
        Self { now }
    }

    /// Returns the current test-controlled instant.
    pub const fn now(self) -> Instant {
        self.now
    }

    /// Advances the clock without sleeping.
    pub fn advance(&mut self, duration: Duration) {
        self.now = self
            .now
            .checked_add(duration)
            .expect("test clock advance must remain within the Instant range");
    }
}

/// Observable state shared by clones of a [`HeadlessRenderer`].
#[derive(Clone, Debug, PartialEq)]
pub struct HeadlessRenderState {
    target_size: RenderTargetSize,
    scale_factor: f64,
    blank_frame_count: usize,
    scenes: Vec<UiScene>,
}

impl Default for HeadlessRenderState {
    fn default() -> Self {
        Self {
            target_size: RenderTargetSize::new(0, 0),
            scale_factor: 1.0,
            blank_frame_count: 0,
            scenes: Vec::new(),
        }
    }
}

impl HeadlessRenderState {
    /// Returns the last physical target size supplied by the runtime.
    pub const fn target_size(&self) -> RenderTargetSize {
        self.target_size
    }

    /// Returns the last logical-to-physical scale factor.
    pub const fn scale_factor(&self) -> f64 {
        self.scale_factor
    }

    /// Returns the number of renderer calls without scene content.
    pub const fn blank_frame_count(&self) -> usize {
        self.blank_frame_count
    }

    /// Returns every immutable scene submitted in presentation order.
    pub fn scenes(&self) -> &[UiScene] {
        &self.scenes
    }
}

/// Cloneable renderer that records immutable scenes without a graphics device or native surface.
#[derive(Clone, Default)]
pub struct HeadlessRenderer {
    state: Arc<Mutex<HeadlessRenderState>>,
}

impl HeadlessRenderer {
    /// Returns a snapshot of all renderer state recorded so far.
    pub fn state(&self) -> HeadlessRenderState {
        self.state.lock().expect("headless renderer lock").clone()
    }

    /// Removes all recorded scenes while preserving target configuration and frame counts.
    pub fn clear_scenes(&self) {
        self.state
            .lock()
            .expect("headless renderer lock")
            .scenes
            .clear();
    }
}

impl Renderer for HeadlessRenderer {
    fn resize(&mut self, size: RenderTargetSize) {
        self.state
            .lock()
            .expect("headless renderer lock")
            .target_size = size;
    }

    fn set_scale_factor(&mut self, scale_factor: f64) {
        self.state
            .lock()
            .expect("headless renderer lock")
            .scale_factor = scale_factor;
    }

    fn render(&mut self) -> Result<RenderOutcome, RendererError> {
        self.state
            .lock()
            .expect("headless renderer lock")
            .blank_frame_count += 1;
        Ok(RenderOutcome::Presented)
    }

    fn render_scene(&mut self, scene: &UiScene) -> Result<RenderOutcome, RendererError> {
        self.state
            .lock()
            .expect("headless renderer lock")
            .scenes
            .push(scene.clone());
        Ok(RenderOutcome::Presented)
    }
}

/// Scope used to cancel deterministic timers with a test-owned window.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TestTimerScope {
    Application,
    Window(WindowId),
}

/// Stable identity of one deterministic timer.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct TestTimerId(u64);

/// Product decision for one window close request delivered during a deterministic app exit.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TestWindowCloseDecision {
    /// Accept the request and remove the window from the deterministic registry.
    #[default]
    Close,
    /// Cancel the complete application exit while leaving this window open.
    Cancel,
}

/// Runtime event emitted by [`TestRuntime`] in deterministic FIFO order.
#[derive(Clone, Debug, PartialEq)]
pub enum TestEvent<T> {
    Ready,
    Resumed,
    Suspended,
    WindowOpened(WindowId),
    RedrawRequested(WindowId),
    User(T),
    Tray(TrayEvent),
    GlobalShortcut(GlobalShortcutEvent),
    SecondInstance(SecondInstance),
    Activated(ApplicationActivation),
    OpenFile(PathBuf),
    OpenUrl(ProtocolUrl),
    WindowCloseRequested(WindowId),
    WindowClosed(WindowId),
    WindowAllClosed,
    ExitRequested(ApplicationExitReason),
    WillExitRequested(ApplicationExitReason),
    ExitCancelled(ApplicationExitReason),
    Exiting(ApplicationExitReason),
}

/// Inspectable headless window owned by a deterministic test runtime.
pub struct TestWindow {
    id: WindowId,
    title: String,
    logical_size: LogicalSize,
    renderer: HeadlessRenderer,
    accessibility: Vec<AccessibilityNode>,
    parent: Option<WindowId>,
    modal: bool,
    input_enabled: bool,
}

impl TestWindow {
    /// Returns the stable test window identity.
    pub const fn id(&self) -> WindowId {
        self.id
    }

    /// Returns the configured title.
    pub fn title(&self) -> &str {
        &self.title
    }

    /// Returns the configured logical size.
    pub const fn logical_size(&self) -> LogicalSize {
        self.logical_size
    }

    /// Returns this window's direct parent, if configured.
    pub const fn parent_id(&self) -> Option<WindowId> {
        self.parent
    }

    /// Returns whether this is a modal child.
    pub const fn is_modal(&self) -> bool {
        self.modal
    }

    /// Returns whether the deterministic native model currently accepts input.
    pub const fn input_enabled(&self) -> bool {
        self.input_enabled
    }

    /// Returns a shared handle to this window's headless renderer.
    pub fn renderer(&self) -> HeadlessRenderer {
        self.renderer.clone()
    }

    /// Returns the most recently presented accessibility snapshot.
    pub fn accessibility(&self) -> &[AccessibilityNode] {
        &self.accessibility
    }
}

struct TestTimer<T> {
    scope: TestTimerScope,
    event: T,
}

/// Deterministic lifecycle, event, timer, and presentation host for application tests.
pub struct TestRuntime<T> {
    clock: TestClock,
    lifecycle: LifecycleCore,
    next_window: u64,
    next_timer: u64,
    windows: BTreeMap<u64, TestWindow>,
    timers: BTreeMap<(Instant, TestTimerId), TestTimer<T>>,
    events: VecDeque<TestEvent<T>>,
    next_exit_decision: ApplicationExitDecision,
    next_will_exit_decision: ApplicationExitDecision,
    window_close_decisions: BTreeMap<u64, TestWindowCloseDecision>,
}

impl<T> TestRuntime<T> {
    /// Creates an empty runtime at an explicit monotonic instant.
    pub fn at(now: Instant) -> Self {
        Self {
            clock: TestClock::at(now),
            lifecycle: LifecycleCore::new(ExitPolicy::default(), ApplicationReadiness::default()),
            next_window: 1,
            next_timer: 1,
            windows: BTreeMap::new(),
            timers: BTreeMap::new(),
            events: VecDeque::new(),
            next_exit_decision: ApplicationExitDecision::Exit,
            next_will_exit_decision: ApplicationExitDecision::Exit,
            window_close_decisions: BTreeMap::new(),
        }
    }

    /// Selects the same last-window exit policy used by native applications.
    pub fn with_exit_policy(mut self, exit_policy: ExitPolicy) -> Self {
        self.lifecycle.set_exit_policy(exit_policy);
        self
    }

    /// Returns the current shared application-host lifecycle phase.
    pub const fn phase(&self) -> ApplicationPhase {
        self.lifecycle.phase()
    }

    /// Returns whether the first deterministic ready event has been committed.
    pub fn is_ready(&self) -> bool {
        self.lifecycle.is_ready()
    }

    /// Waits for deterministic readiness or reports that the runtime exited first.
    pub fn when_ready(&self) -> ApplicationReadyFuture {
        self.lifecycle.when_ready()
    }

    /// Returns the recorded exit reason after the runtime enters its exiting phase.
    pub const fn exit_reason(&self) -> Option<ApplicationExitReason> {
        self.lifecycle.exit_reason()
    }

    /// Emits the initial resume callback event.
    pub fn resume(&mut self) {
        if self.lifecycle.resumed() {
            self.events.push_back(TestEvent::Ready);
            self.lifecycle.mark_ready();
        }
        self.events.push_back(TestEvent::Resumed);
    }

    /// Enters the shared suspended phase and emits its deterministic lifecycle event.
    pub fn suspend(&mut self) {
        self.lifecycle.suspended();
        self.events.push_back(TestEvent::Suspended);
    }

    /// Resolves and presents one complete UI frame into a live headless window.
    pub fn present_frame(
        &mut self,
        id: WindowId,
        frame: &UiFrame<InteractionFrame>,
        dispatch: &UiDispatch,
    ) -> Result<Option<RenderOutcome>, RendererError> {
        let Some(window) = self.windows.get_mut(&id.into_raw()) else {
            return Ok(None);
        };
        let presentation = WindowFramePresentation::resolve(frame, dispatch);
        window.accessibility = presentation.accessibility().to_vec();
        window.renderer.render_scene(presentation.scene()).map(Some)
    }

    /// Enqueues an application-defined event immediately.
    pub fn send_event(&mut self, event: T) {
        self.events.push_back(TestEvent::User(event));
    }

    /// Enqueues one platform-independent tray interaction.
    pub fn send_tray_event(&mut self, event: TrayEvent) {
        self.events.push_back(TestEvent::Tray(event));
    }

    /// Enqueues one platform-independent global shortcut interaction.
    pub fn send_global_shortcut(&mut self, event: GlobalShortcutEvent) {
        self.events.push_back(TestEvent::GlobalShortcut(event));
    }

    /// Enqueues one secondary process invocation.
    pub fn send_second_instance(&mut self, event: SecondInstance) {
        self.events.push_back(TestEvent::SecondInstance(event));
    }

    /// Enqueues an operating-system request to reactivate the application.
    pub fn activate(&mut self, event: ApplicationActivation) {
        self.events.push_back(TestEvent::Activated(event));
    }

    /// Enqueues one operating-system open-file request.
    pub fn send_open_file(&mut self, path: impl Into<PathBuf>) {
        self.events.push_back(TestEvent::OpenFile(path.into()));
    }

    /// Enqueues one application protocol URL.
    pub fn send_open_url(&mut self, url: ProtocolUrl) {
        self.events.push_back(TestEvent::OpenUrl(url));
    }

    /// Schedules an event relative to the manual clock.
    pub fn schedule_after(
        &mut self,
        scope: TestTimerScope,
        delay: Duration,
        event: T,
    ) -> TestTimerId {
        let id = TestTimerId(self.next_timer);
        self.next_timer += 1;
        let deadline = self
            .clock
            .now()
            .checked_add(delay)
            .expect("test timer deadline must remain within the Instant range");
        self.timers
            .insert((deadline, id), TestTimer { scope, event });
        id
    }

    /// Cancels one deterministic timer if it is still pending.
    pub fn cancel_timer(&mut self, id: TestTimerId) {
        self.timers.retain(|(_, candidate), _| *candidate != id);
    }

    /// Advances the manual clock and enqueues every due timer in stable deadline order.
    pub fn advance(&mut self, duration: Duration) {
        self.clock.advance(duration);
        let due = self
            .timers
            .range(..=(self.clock.now(), TestTimerId(u64::MAX)))
            .map(|(key, _)| *key)
            .collect::<Vec<_>>();
        for key in due {
            if let Some(timer) = self.timers.remove(&key) {
                self.events.push_back(TestEvent::User(timer.event));
            }
        }
    }

    /// Removes the next deterministic runtime event.
    pub fn next_event(&mut self) -> Option<TestEvent<T>> {
        self.events.pop_front()
    }
}

#[path = "testing/lifecycle.rs"]
mod lifecycle;

#[path = "testing/windows.rs"]
mod windows;

#[cfg(test)]
#[path = "testing/testing_tests.rs"]
mod tests;
