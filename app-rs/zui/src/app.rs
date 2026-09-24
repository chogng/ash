use std::future::Future;
use std::time::Duration;
use std::time::Instant;

pub use crate::accessibility::AccessibilityAction;
pub use crate::accessibility::AccessibilityActionKind;
use crate::devtools::DiagnosticEventKind;
use crate::devtools::DiagnosticsHandle;
use crate::devtools::DiagnosticsSink;
use crate::input::DeviceEvent;
use crate::input::DeviceId;
use crate::render::RendererFactory;
#[cfg(feature = "wgpu")]
use crate::render::WgpuRendererFactory;
use crate::runtime::BackgroundExecutor;
use crate::runtime::Task;
use crate::runtime::TaskScope;
use crate::runtime::Timer;
use crate::runtime::TimerRegistry;
use crate::runtime::TimerScheduleError;
use crate::runtime::TimerScheduler;
use crate::services::ApplicationBadgeService;
use crate::services::Clipboard;
use crate::services::ClipboardHandle;
use crate::services::DesktopFileName;
use crate::services::FileDialogService;
use crate::services::FileIconService;
use crate::services::GlobalShortcutEvent;
use crate::services::GlobalShortcutService;
use crate::services::JumpListService;
use crate::services::LoginItemService;
use crate::services::MenuItemId;
use crate::services::MenuService;
use crate::services::MessageDialogService;
use crate::services::NotificationService;
use crate::services::OpenerService;
use crate::services::ProcessService;
use crate::services::ProtocolClientService;
use crate::services::RecentDocumentService;
use crate::services::ResourceService;
use crate::services::Services;
use crate::services::SystemClipboard;
use crate::services::SystemResourceLocator;
use crate::services::TrayEvent;
use crate::services::TrayService;
use crate::services::UpdateService;
use crate::window::DisplayEvent;
use crate::window::OpenedWindow;
use crate::window::WindowEvent;
use crate::window::WindowId;
use crate::window::WindowMetrics;
use crate::window::WindowOptions;
use crate::window::WindowRuntime;
use crate::window::WindowRuntimeEnvironment;
mod builder;
mod context;
mod error;
mod frame;
mod host;
mod lifecycle;
mod locale;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(all(test, target_os = "macos"))]
#[path = "app/macos_tests.rs"]
mod macos_tests;
pub(crate) mod native_host;
mod paths;
mod presentation;
mod protocol;
mod readiness;
mod relaunch;
pub(crate) mod runtime_event;
mod single_instance;
mod window_request;

pub use builder::ApplicationBuilder;
pub use context::AppContext;
use context::AppContextParts;
pub use context::WindowContext;
use context::WindowContextParts;
pub use error::ApplicationError;
pub(crate) use frame::WindowFramePresentation;
pub use lifecycle::ApplicationActivation;
pub use lifecycle::ApplicationExitDecision;
pub use lifecycle::ApplicationExitReason;
pub use lifecycle::ApplicationPhase;
pub use lifecycle::ExitPolicy;
pub(crate) use lifecycle::LifecycleCore;
pub(crate) use lifecycle::WindowCommand;
pub use locale::ApplicationLocale;
pub(crate) use locale::ApplicationLocaleConfig;
pub use locale::ApplicationLocaleError;
pub use locale::ApplicationLocaleErrorCode;
pub(crate) use locale::ApplicationLocales;
pub use native_host::ApplicationRunError;
pub use native_host::ApplicationRunErrorCode;
pub use native_host::ControlFlow;
pub use paths::ApplicationPath;
pub(crate) use paths::ApplicationPathConfig;
pub use paths::ApplicationPathError;
pub use paths::ApplicationPathErrorCode;
pub(crate) use paths::ApplicationPaths;
pub use presentation::AboutPanelFuture;
pub use presentation::AboutPanelOptions;
pub use presentation::ApplicationFocusOptions;
pub use presentation::ApplicationFocusOutcome;
pub use presentation::UserActivityInfo;
pub use protocol::ProtocolScheme;
pub use protocol::ProtocolSchemeError;
pub use protocol::ProtocolUrl;
pub use protocol::ProtocolUrlError;
pub(crate) use readiness::ApplicationReadiness;
pub use readiness::ApplicationReadyError;
pub use readiness::ApplicationReadyFuture;
pub(crate) use relaunch::ApplicationRelauncher;
pub use relaunch::RelaunchError;
pub use relaunch::RelaunchErrorCode;
pub use relaunch::RelaunchOptions;
pub use runtime_event::AppDisconnected;
pub use runtime_event::AppProxy;
use runtime_event::RuntimeEvent;
pub use single_instance::SecondInstance;
pub use single_instance::SingleInstanceKey;
pub use single_instance::SingleInstanceKeyError;
pub use single_instance::SingleInstanceOptions;
pub use single_instance::SingleInstanceRun;
pub use window_request::OpenWindowError;
pub use window_request::OpenWindowErrorCode;
pub use window_request::OpenWindowFuture;
pub(crate) use window_request::OpenWindowRequest;

/// Product-owned lifecycle and event handling executed by [`Application`].
///
/// Implementations retain domain state and build UI frames. The runtime owns native windows,
/// renderer instances, platform resize synchronization, and event-loop dispatch.
pub trait App<T: 'static> {
    /// Creates initial windows and starts product resources on the first native resume.
    ///
    /// [`ApplicationHandle::is_ready`] remains `false` until this callback returns. Every
    /// [`ApplicationHandle::when_ready`] waiter is then woken before [`App::resumed`] is invoked.
    fn ready(&mut self, _context: &mut AppContext<'_, T>) {}

    /// Observes every platform resume, including the first resume after [`App::ready`].
    fn resumed(&mut self, _context: &mut AppContext<'_, T>) {}

    /// Handles an operating-system request to reactivate this already-running application.
    ///
    /// The native runtime currently emits this callback on macOS. Deterministic hosts can enqueue
    /// the same contract with [`crate::testing::TestRuntime::activate`].
    fn activated(&mut self, _context: &mut AppContext<'_, T>, _event: ApplicationActivation) {}

    /// Observes platform suspension after the runtime has stopped receiving active window work.
    fn suspended(&mut self, _context: &mut AppContext<'_, T>) {}

    /// Observes a window after its native resources and renderer enter the runtime registry.
    fn window_opened(&mut self, _context: &mut AppContext<'_, T>, _window: WindowId) {}

    /// Handles a non-redraw event for one runtime-owned window.
    ///
    /// Both the native close control and [`crate::window::WindowHandle::close`] deliver
    /// [`WindowEvent::CloseRequested`]. The default implementation accepts the request by calling
    /// [`WindowContext::close`]; an override can cancel it by returning without closing.
    fn window_event(&mut self, context: &mut WindowContext<'_, T>, event: WindowEvent) {
        if matches!(event, WindowEvent::CloseRequested) {
            context.close();
        }
    }

    /// Handles raw physical input that is not associated with a particular window.
    fn device_event(
        &mut self,
        _context: &mut AppContext<'_, T>,
        _device: DeviceId,
        _event: DeviceEvent,
    ) {
    }

    /// Observes a connected display being added, removed, or changing reported properties.
    ///
    /// macOS and Windows use native topology notifications. Linux performs a bounded snapshot
    /// poll so changes are observable without busy-waiting.
    fn display_event(&mut self, _context: &mut AppContext<'_, T>, _event: DisplayEvent) {}

    /// Builds and presents one frame for a runtime-owned window.
    fn redraw(&mut self, _context: &mut WindowContext<'_, T>) {}

    /// Observes a window after its renderer and native resources leave the runtime registry.
    fn window_closed(&mut self, _context: &mut AppContext<'_, T>, _window: WindowId) {}

    /// Observes the transition from one live product window to none outside an application exit.
    fn window_all_closed(&mut self, _context: &mut AppContext<'_, T>) {}

    /// Handles an action selected from the application menu.
    fn menu_action(&mut self, _context: &mut AppContext<'_, T>, _action: MenuItemId) {}

    /// Handles pointer interaction with a runtime-owned system-tray item.
    fn tray_event(&mut self, _context: &mut AppContext<'_, T>, _event: TrayEvent) {}

    /// Handles a registered system-wide keyboard shortcut.
    fn global_shortcut(&mut self, _context: &mut AppContext<'_, T>, _event: GlobalShortcutEvent) {}

    /// Handles a launch or forwarded URL accepted by the application builder.
    fn open_url(&mut self, _context: &mut AppContext<'_, T>, _url: ProtocolUrl) {}

    /// Handles a file the operating system asks this already-running application to open.
    ///
    /// The native runtime currently emits this callback for macOS file URLs. File association
    /// declaration remains a distribution concern.
    fn open_file(&mut self, _context: &mut AppContext<'_, T>, _path: std::path::PathBuf) {}

    /// Handles a later process invocation forwarded to this primary application instance.
    ///
    /// Arguments include the invoked executable at index zero. The working directory and opaque
    /// additional data are captured by the secondary process. Accepted custom-protocol arguments
    /// are subsequently delivered through [`App::open_url`]. Native hosts never invoke this
    /// callback before the first [`App::ready`] callback completes.
    fn second_instance(&mut self, _context: &mut AppContext<'_, T>, _event: SecondInstance) {}

    /// Handles a focus or activation request from operating-system assistive technology.
    fn accessibility_action(
        &mut self,
        _context: &mut AppContext<'_, T>,
        _action: AccessibilityAction,
    ) {
    }

    /// Projects a background or application-defined event into product state.
    fn user_event(&mut self, _context: &mut AppContext<'_, T>, _event: T) {}

    /// Advances product deadlines before the native event loop sleeps.
    fn about_to_wait(&mut self, _context: &mut AppContext<'_, T>) {}

    /// Decides whether a normal application exit may begin.
    ///
    /// The runtime calls this for explicit exit requests and last-window policy exits before
    /// teardown starts. After an accepted explicit request, every live product window receives a
    /// child-first [`WindowEvent::CloseRequested`]; returning without [`WindowContext::close`] from
    /// any one of those callbacks cancels the exit. Forced, fatal, and platform termination skip
    /// both cancellation points. Returning [`ApplicationExitDecision::Cancel`] keeps the event loop
    /// alive and permits a later exit request.
    fn before_exit(
        &mut self,
        _context: &mut AppContext<'_, T>,
        _reason: ApplicationExitReason,
    ) -> ApplicationExitDecision {
        ApplicationExitDecision::Exit
    }

    /// Decides whether an accepted normal exit may commit after every window has closed.
    ///
    /// This is the final cancelable point corresponding to Electron's `will-quit` event. Returning
    /// [`ApplicationExitDecision::Cancel`] keeps the event loop alive, but windows already closed
    /// during the exit attempt remain closed. Forced, fatal, and platform exits skip this callback.
    fn will_exit(
        &mut self,
        _context: &mut AppContext<'_, T>,
        _reason: ApplicationExitReason,
    ) -> ApplicationExitDecision {
        ApplicationExitDecision::Exit
    }

    /// Gives the product an opportunity to release caches after a platform memory warning.
    fn memory_warning(&mut self, _context: &mut AppContext<'_, T>) {}

    /// Releases product resources while the event loop is exiting.
    fn exiting(&mut self, _context: &mut AppContext<'_, T>) {}
}

/// Completed application state, any fatal runtime failure, and the recorded exit reason.
pub struct ApplicationExit<A> {
    app: A,
    error: Option<ApplicationError>,
    reason: ApplicationExitReason,
}

impl<A> ApplicationExit<A> {
    /// Returns the final product state after the native event loop exits.
    pub const fn app(&self) -> &A {
        &self.app
    }

    /// Returns the fatal runtime failure that caused termination, if any.
    pub const fn error(&self) -> Option<&ApplicationError> {
        self.error.as_ref()
    }

    /// Returns why the reusable application host began exiting.
    pub const fn reason(&self) -> ApplicationExitReason {
        self.reason
    }

    /// Consumes the exit report and returns the final product state, runtime failure, and reason.
    pub fn into_parts(self) -> (A, Option<ApplicationError>, ApplicationExitReason) {
        (self.app, self.error, self.reason)
    }
}

/// Entry point for running reusable native applications on the default or an injected renderer.
pub struct Application;

impl Application {
    /// Creates a configurable application builder using the default wgpu renderer backend.
    #[cfg(feature = "wgpu")]
    pub fn builder() -> ApplicationBuilder {
        ApplicationBuilder::new(WgpuRendererFactory)
    }

    /// Creates a configurable application builder using an explicitly selected renderer factory.
    pub fn with_renderer(renderer_factory: impl RendererFactory + 'static) -> ApplicationBuilder {
        ApplicationBuilder::new(renderer_factory)
    }

    /// Runs an application using the default wgpu renderer backend.
    #[cfg(feature = "wgpu")]
    pub fn run<T, A, C>(create: C) -> Result<ApplicationExit<A>, ApplicationRunError>
    where
        T: Send + 'static,
        A: App<T> + 'static,
        C: FnOnce(ApplicationHandle<T>) -> A,
    {
        Self::builder().run(create)
    }

    /// Runs one primary application or forwards this invocation to its existing primary process.
    #[cfg(feature = "wgpu")]
    pub fn run_single_instance<T, A, C>(
        options: SingleInstanceOptions,
        create: C,
    ) -> Result<SingleInstanceRun<A>, ApplicationRunError>
    where
        T: Send + 'static,
        A: App<T> + 'static,
        C: FnOnce(ApplicationHandle<T>) -> A,
    {
        Self::builder().run_single_instance(options, create)
    }

    /// Runs an application using an explicitly selected renderer factory.
    pub fn run_with_renderer<T, A, C>(
        renderer_factory: impl RendererFactory + 'static,
        create: C,
    ) -> Result<ApplicationExit<A>, ApplicationRunError>
    where
        T: Send + 'static,
        A: App<T> + 'static,
        C: FnOnce(ApplicationHandle<T>) -> A,
    {
        Self::with_renderer(renderer_factory).run(create)
    }
}

/// Cloneable application-wide capabilities supplied while product state is constructed.
#[derive(Clone)]
pub struct ApplicationHandle<T: 'static> {
    event_proxy: AppProxy<T>,
    readiness: ApplicationReadiness,
    clipboard: ClipboardHandle,
    services: Services,
    background: BackgroundExecutor<T>,
    timers: TimerScheduler<T>,
    diagnostics: DiagnosticsHandle,
}

impl<T: 'static> ApplicationHandle<T> {
    /// Returns the typed main-thread wakeup proxy for background product work.
    pub fn event_proxy(&self) -> AppProxy<T> {
        self.event_proxy.clone()
    }

    /// Returns the typed main-thread application proxy for background work.
    pub fn proxy(&self) -> AppProxy<T> {
        self.event_proxy.clone()
    }

    /// Returns the runtime-owned text clipboard capability.
    pub fn clipboard(&self) -> ClipboardHandle {
        self.clipboard.clone()
    }

    /// Returns all typed operating-system service capabilities.
    pub fn services(&self) -> Services {
        self.services.clone()
    }

    /// Returns the application-wide background executor.
    pub fn background_executor(&self) -> BackgroundExecutor<T> {
        self.background.clone()
    }

    /// Starts application-scoped background work and delivers its output as a user event.
    pub fn spawn<F>(&self, future: F) -> Task
    where
        T: Send,
        F: Future<Output = T> + Send + 'static,
    {
        self.background.spawn(TaskScope::Application, future)
    }

    /// Returns the application-wide event-loop timer scheduler.
    pub fn timers(&self) -> TimerScheduler<T> {
        self.timers.clone()
    }

    /// Returns the application-wide bounded runtime diagnostics capability.
    pub fn diagnostics(&self) -> DiagnosticsHandle {
        self.diagnostics.clone()
    }

    /// Requests a normal application exit from any thread.
    ///
    /// Success means the command reached the main event-loop queue. The request still passes
    /// through [`App::before_exit`] and every live window's cancelable close callback.
    pub fn exit(&self) -> Result<(), AppDisconnected<ApplicationExitReason>> {
        self.event_proxy.exit()
    }

    /// Requests immediate teardown without application or window cancellation callbacks.
    ///
    /// The returned [`ApplicationExit`] preserves `exit_code` in
    /// [`ApplicationExitReason::Forced`] so the binary entry point can return it.
    pub fn force_exit(&self, exit_code: i32) -> Result<(), AppDisconnected<ApplicationExitReason>> {
        self.event_proxy.force_exit(exit_code)
    }

    /// Requests a cancelable window-close callback from any thread.
    ///
    /// This method confirms command delivery, not that `window` is still live. Prefer
    /// [`crate::window::WindowHandle::close`] when a retained window capability is available.
    pub fn close_window(&self, window: WindowId) -> Result<(), AppDisconnected<WindowId>> {
        self.event_proxy.close_window(window)
    }

    /// Destroys a runtime-owned window from any thread without a cancelable close callback.
    ///
    /// This method confirms command delivery, not that `window` is still live. Prefer
    /// [`crate::window::WindowHandle::destroy`] when a retained capability is available.
    pub fn destroy_window(&self, window: WindowId) -> Result<(), AppDisconnected<WindowId>> {
        self.event_proxy.destroy_window(window)
    }

    /// Opens a runtime-owned native window from any thread.
    ///
    /// The future resolves after the window enters the runtime registry and [`App::window_opened`]
    /// returns. Dropping the future does not cancel a request that already reached the event loop.
    pub fn open_window(&self, options: WindowOptions) -> OpenWindowFuture
    where
        T: Send,
    {
        self.event_proxy.open_window(options)
    }

    /// Schedules an application event relative to the current monotonic time.
    pub fn schedule_after(&self, delay: Duration, event: T) -> Result<Timer, TimerScheduleError<T>>
    where
        T: Send,
    {
        self.timers.schedule_after(delay, event)
    }

    /// Schedules an application event at an explicit monotonic deadline.
    pub fn schedule_at(&self, deadline: Instant, event: T) -> Result<Timer, TimerScheduleError<T>>
    where
        T: Send,
    {
        self.timers.schedule_at(deadline, event)
    }
}
