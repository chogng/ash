use std::cell::Cell;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;

use crate::devtools::DevToolsRequest;
use crate::devtools::DevToolsRequestSender;
use crate::input::DeviceRegistry;
use crate::internal::ActiveEventLoop;
use crate::internal::ApplicationHandler;
use crate::internal::NativeDeviceEvent;
use crate::internal::NativeDeviceId;
use crate::internal::NativeWindowEvent;
use crate::internal::NativeWindowId;
use crate::ui::Point;
use crate::window::DisplayChangeMonitor;
use crate::window::DisplaySnapshot;
use crate::window::WindowEvent;
use crate::window::WindowId;
use crate::window::WindowRole;

use super::App;
use super::AppContext;
use super::AppContextParts;
use super::AppProxy;
use super::ApplicationError;
use super::ApplicationExitReason;
use super::ApplicationPhase;
use super::ApplicationReadiness;
use super::BackgroundExecutor;
use super::ClipboardHandle;
use super::DiagnosticEventKind;
use super::DiagnosticsHandle;
use super::ExitPolicy;
use super::LifecycleCore;
use super::ProtocolScheme;
use super::ProtocolUrl;
use super::RendererFactory;
use super::RuntimeEvent;
use super::SecondInstance;
use super::Services;
use super::TimerRegistry;
use super::TimerScheduler;
use super::WindowContext;
use super::WindowContextParts;
use super::WindowRuntime;
use super::WindowRuntimeEnvironment;
#[cfg(target_os = "macos")]
use super::macos::MacOSApplicationDelegateBridge;
use super::runtime_event::ApplicationControlCommand;
use super::single_instance::transport::PrimaryInstance;

#[path = "host_devtools.rs"]
mod host_devtools;
#[path = "host_displays.rs"]
mod host_displays;
#[path = "host_lifecycle.rs"]
mod host_lifecycle;
#[path = "host_windows.rs"]
mod host_windows;

pub(super) struct ApplicationHost<T: 'static, A> {
    pub(super) app: A,
    windows: HashMap<WindowId, WindowRuntime>,
    renderer_factory: Box<dyn RendererFactory>,
    clipboard: ClipboardHandle,
    services: Services,
    event_proxy: AppProxy<T>,
    pub(super) error: Option<ApplicationError>,
    lifecycle: LifecycleCore,
    control_flow: crate::internal::ControlFlow,
    background: BackgroundExecutor<T>,
    timers: TimerScheduler<T>,
    timer_registry: TimerRegistry<T>,
    launch_urls: Vec<ProtocolUrl>,
    pending_second_instances: VecDeque<SecondInstance>,
    protocol_schemes: Vec<ProtocolScheme>,
    diagnostics: DiagnosticsHandle,
    devtools_requests: Arc<Mutex<VecDeque<DevToolsRequest>>>,
    devtools_request_sender: DevToolsRequestSender,
    cursor_positions: HashMap<WindowId, Point>,
    devices: DeviceRegistry,
    display_change_pending: Rc<Cell<bool>>,
    display_snapshot: Option<DisplaySnapshot>,
    display_change_monitor: DisplayChangeMonitor,
    #[cfg(target_os = "macos")]
    _application_delegate_bridge: MacOSApplicationDelegateBridge,
    pub(super) single_instance: Option<PrimaryInstance>,
}

pub(super) struct ApplicationResources<T: 'static> {
    pub(super) renderer_factory: Box<dyn RendererFactory>,
    pub(super) clipboard: ClipboardHandle,
    pub(super) services: Services,
    pub(super) event_proxy: AppProxy<T>,
    pub(super) readiness: ApplicationReadiness,
    pub(super) background: BackgroundExecutor<T>,
    pub(super) timers: TimerScheduler<T>,
    pub(super) launch_urls: Vec<ProtocolUrl>,
    pub(super) protocol_schemes: Vec<ProtocolScheme>,
    pub(super) diagnostics: DiagnosticsHandle,
    pub(super) display_change_pending: Rc<Cell<bool>>,
    #[cfg(target_os = "macos")]
    pub(super) application_delegate_bridge: MacOSApplicationDelegateBridge,
    pub(super) single_instance: Option<PrimaryInstance>,
}

impl<T: 'static, A> ApplicationHost<T, A> {
    pub(super) fn new(app: A, resources: ApplicationResources<T>, exit_policy: ExitPolicy) -> Self
    where
        T: Send,
    {
        let display_change_monitor =
            DisplayChangeMonitor::new(Rc::clone(&resources.display_change_pending));
        let devtools_requests = Arc::new(Mutex::new(VecDeque::new()));
        let request_queue = Arc::clone(&devtools_requests);
        let request_proxy = resources.event_proxy.inner.clone();
        let devtools_request_sender: DevToolsRequestSender = Arc::new(move |request| {
            request_queue
                .lock()
                .expect("devtools request queue lock")
                .push_back(request);
            let _ = request_proxy.send_event(RuntimeEvent::DevToolsWake);
        });
        let runtime_proxy = resources.event_proxy.inner.clone();
        resources
            .services
            .menus()
            .set_event_handler(Some(Arc::new(move |action| {
                let _ = runtime_proxy.send_event(RuntimeEvent::MenuAction(action));
            })));
        let tray_proxy = resources.event_proxy.inner.clone();
        resources
            .services
            .tray()
            .set_event_handler(Some(Arc::new(move |event| {
                let _ = tray_proxy.send_event(RuntimeEvent::Tray(event));
            })));
        let shortcut_proxy = resources.event_proxy.inner.clone();
        resources
            .services
            .global_shortcuts()
            .set_event_handler(Some(Arc::new(move |event| {
                let _ = shortcut_proxy.send_event(RuntimeEvent::GlobalShortcut(event));
            })));
        Self {
            app,
            windows: HashMap::new(),
            renderer_factory: resources.renderer_factory,
            clipboard: resources.clipboard,
            services: resources.services,
            event_proxy: resources.event_proxy,
            error: None,
            lifecycle: LifecycleCore::new(exit_policy, resources.readiness),
            control_flow: crate::internal::ControlFlow::Wait,
            background: resources.background,
            timers: resources.timers,
            timer_registry: TimerRegistry::default(),
            launch_urls: resources.launch_urls,
            pending_second_instances: VecDeque::new(),
            protocol_schemes: resources.protocol_schemes,
            diagnostics: resources.diagnostics,
            devtools_requests,
            devtools_request_sender,
            cursor_positions: HashMap::new(),
            devices: DeviceRegistry::default(),
            display_change_pending: resources.display_change_pending,
            display_snapshot: None,
            display_change_monitor,
            #[cfg(target_os = "macos")]
            _application_delegate_bridge: resources.application_delegate_bridge,
            single_instance: resources.single_instance,
        }
    }

    pub(super) fn exit_reason(&self) -> ApplicationExitReason {
        self.lifecycle
            .exit_reason()
            .unwrap_or(ApplicationExitReason::Platform)
    }
}

impl<T, A> ApplicationHost<T, A>
where
    T: Send + 'static,
    A: App<T>,
{
    fn with_app_context<R>(
        &mut self,
        event_loop: &ActiveEventLoop,
        callback: impl FnOnce(&mut A, &mut AppContext<'_, T>) -> R,
    ) -> R {
        let Self {
            app,
            windows,
            renderer_factory,
            clipboard,
            services,
            event_proxy,
            error,
            lifecycle,
            control_flow,
            background,
            timers,
            diagnostics,
            devtools_request_sender,
            ..
        } = self;
        let mut context = AppContext::new(AppContextParts {
            event_loop,
            windows,
            renderer_factory: renderer_factory.as_mut(),
            clipboard,
            services,
            event_proxy,
            error,
            lifecycle,
            control_flow,
            background,
            timers,
            diagnostics,
            devtools_requests: devtools_request_sender.clone(),
        });
        callback(app, &mut context)
    }

    fn deliver_product_event(&mut self, event_loop: &ActiveEventLoop, event: T) {
        self.with_app_context(event_loop, |app, context| app.user_event(context, event));
    }

    fn apply_control_flow(&self, event_loop: &ActiveEventLoop) {
        let runtime_deadline = match (
            self.timer_registry.next_deadline(),
            self.display_change_monitor.poll_deadline(),
        ) {
            (Some(timer), Some(display)) => Some(timer.min(display)),
            (timer @ Some(_), None) => timer,
            (None, display) => display,
        };
        let control_flow = match (self.control_flow, runtime_deadline) {
            (crate::internal::ControlFlow::Poll, _) => crate::internal::ControlFlow::Poll,
            (crate::internal::ControlFlow::Wait, Some(deadline)) => {
                crate::internal::ControlFlow::WaitUntil(deadline)
            }
            (crate::internal::ControlFlow::WaitUntil(application), Some(timer)) => {
                crate::internal::ControlFlow::WaitUntil(application.min(timer))
            }
            (application, None) => application,
        };
        event_loop.set_control_flow(control_flow.into_native());
    }

    fn refresh_diagnostics(&self) {
        self.diagnostics
            .set_work_counts(self.background.active_count(), self.timer_registry.len());
    }
}

impl<T, A> ApplicationHandler<RuntimeEvent<T>> for ApplicationHost<T, A>
where
    T: Send + 'static,
    A: App<T>,
{
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        let first_resume = self.lifecycle.resumed();
        self.diagnostics.record(DiagnosticEventKind::Resumed);
        if first_resume {
            self.initialize_display_snapshot(event_loop);
            self.with_app_context(event_loop, |app, context| app.ready(context));
            self.lifecycle.mark_ready();
        } else {
            self.mark_display_change();
            self.process_display_changes(event_loop);
        }
        self.with_app_context(event_loop, |app, context| app.resumed(context));
        self.process_window_commands(event_loop);
        for url in std::mem::take(&mut self.launch_urls) {
            self.diagnostics.record(DiagnosticEventKind::OpenUrl);
            self.with_app_context(event_loop, |app, context| app.open_url(context, url));
            self.process_window_commands(event_loop);
        }
        for event in std::mem::take(&mut self.pending_second_instances) {
            self.deliver_second_instance(event_loop, event);
            self.process_window_commands(event_loop);
        }
        self.apply_control_flow(event_loop);
        self.refresh_diagnostics();
    }

    fn suspended(&mut self, event_loop: &ActiveEventLoop) {
        self.lifecycle.suspended();
        self.diagnostics.record(DiagnosticEventKind::Suspended);
        self.with_app_context(event_loop, |app, context| app.suspended(context));
        self.process_window_commands(event_loop);
        self.apply_control_flow(event_loop);
        self.refresh_diagnostics();
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        window_id: NativeWindowId,
        event: NativeWindowEvent,
    ) {
        let window_id = WindowId::from_native(window_id);
        let (role, event, destroyed) = {
            let Some(runtime) = self.windows.get_mut(&window_id) else {
                return;
            };
            runtime.process_accessibility_window_event(&event);
            let event = WindowEvent::from_native(event);
            runtime.apply_platform_event(&event);
            self.diagnostics.update_window(window_id, runtime.metrics());
            let destroyed = matches!(event, WindowEvent::Destroyed);
            (runtime.role(), event, destroyed)
        };
        if matches!(event, WindowEvent::ScaleFactorChanged { .. }) {
            self.mark_display_change();
        }
        self.diagnostics
            .record(DiagnosticEventKind::WindowEvent(window_id));
        match role {
            WindowRole::Product => {
                if !self.handle_product_devtools_event(window_id, &event) {
                    let Some(runtime) = self.windows.get_mut(&window_id) else {
                        return;
                    };
                    let mut context = WindowContext::new(WindowContextParts {
                        runtime,
                        event_proxy: &self.event_proxy,
                        clipboard: &self.clipboard,
                        services: &self.services,
                        error: &mut self.error,
                        lifecycle: &mut self.lifecycle,
                        background: &self.background,
                        timers: &self.timers,
                        diagnostics: &self.diagnostics,
                    });
                    if matches!(event, WindowEvent::RedrawRequested) {
                        self.app.redraw(&mut context);
                    } else {
                        self.app.window_event(&mut context, event);
                    }
                }
            }
            WindowRole::DevTools { owner } => {
                self.handle_devtools_window_event(window_id, owner, event_loop, &event);
            }
        }
        if destroyed && role == WindowRole::Product {
            self.lifecycle.destroy_window(window_id);
        }
        self.process_window_commands(event_loop);
        self.apply_control_flow(event_loop);
        self.refresh_diagnostics();
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: RuntimeEvent<T>) {
        match event {
            RuntimeEvent::Product(event) => {
                self.diagnostics.record(DiagnosticEventKind::UserEvent);
                self.deliver_product_event(event_loop, event);
            }
            RuntimeEvent::Control(ApplicationControlCommand::Exit(reason)) => {
                self.lifecycle.request_exit(reason);
            }
            RuntimeEvent::Control(ApplicationControlCommand::RequestWindowClose(window)) => {
                if self.windows.contains_key(&window) {
                    self.lifecycle.request_window_close(window);
                }
            }
            RuntimeEvent::Control(ApplicationControlCommand::DestroyWindow(window)) => {
                if self.windows.contains_key(&window) {
                    self.lifecycle.destroy_window(window);
                }
            }
            RuntimeEvent::OpenWindow(request) => {
                let (options, response) = request.into_parts();
                let result =
                    self.with_app_context(event_loop, |_, context| context.open_window(options));
                self.process_window_commands(event_loop);
                let _ = response.send(result);
                self.apply_control_flow(event_loop);
                self.refresh_diagnostics();
                return;
            }
            RuntimeEvent::ScheduleTimer(timer) => self.timer_registry.schedule(timer),
            RuntimeEvent::CancelTimer(timer) => self.timer_registry.cancel(timer),
            RuntimeEvent::MenuAction(action) => {
                self.diagnostics.record(DiagnosticEventKind::MenuAction);
                self.with_app_context(event_loop, |app, context| app.menu_action(context, action));
            }
            RuntimeEvent::Tray(event) => {
                self.diagnostics.record(DiagnosticEventKind::TrayEvent);
                self.with_app_context(event_loop, |app, context| app.tray_event(context, event));
            }
            RuntimeEvent::GlobalShortcut(event) => {
                self.diagnostics.record(DiagnosticEventKind::GlobalShortcut);
                self.with_app_context(event_loop, |app, context| {
                    app.global_shortcut(context, event)
                });
            }
            RuntimeEvent::SecondInstance(event) => {
                if self.lifecycle.phase() == ApplicationPhase::Initializing {
                    self.pending_second_instances.push_back(event);
                } else {
                    self.deliver_second_instance(event_loop, event);
                }
            }
            #[cfg(target_os = "macos")]
            RuntimeEvent::Activated(event) => {
                self.diagnostics.record(DiagnosticEventKind::Activated);
                self.with_app_context(event_loop, |app, context| app.activated(context, event));
            }
            #[cfg(target_os = "macos")]
            RuntimeEvent::OpenFile(path) => {
                self.diagnostics.record(DiagnosticEventKind::OpenFile);
                self.with_app_context(event_loop, |app, context| app.open_file(context, path));
            }
            RuntimeEvent::OpenUrl(url) => {
                self.diagnostics.record(DiagnosticEventKind::OpenUrl);
                self.with_app_context(event_loop, |app, context| app.open_url(context, url));
            }
            RuntimeEvent::Accessibility(event) => {
                let window = WindowId::from_native(event.window_id);
                let action = self
                    .windows
                    .get_mut(&window)
                    .filter(|runtime| runtime.role() == WindowRole::Product)
                    .and_then(|runtime| runtime.handle_accessibility_event(event.window_event));
                if let Some(action) = action {
                    self.diagnostics
                        .record(DiagnosticEventKind::AccessibilityAction);
                    self.with_app_context(event_loop, |app, context| {
                        app.accessibility_action(context, action)
                    });
                }
            }
            RuntimeEvent::DevToolsWake => {}
        }
        self.process_window_commands(event_loop);
        self.apply_control_flow(event_loop);
        self.refresh_diagnostics();
    }

    fn device_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        device_id: NativeDeviceId,
        event: NativeDeviceEvent,
    ) {
        let (device_id, event) = self.devices.normalize(device_id, event);
        self.diagnostics.record(DiagnosticEventKind::DeviceEvent);
        self.with_app_context(event_loop, |app, context| {
            app.device_event(context, device_id, event)
        });
        self.process_window_commands(event_loop);
        self.apply_control_flow(event_loop);
        self.refresh_diagnostics();
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        let now = Instant::now();
        for event in self.timer_registry.take_due(now) {
            self.deliver_product_event(event_loop, event);
            self.process_window_commands(event_loop);
        }
        if self.display_change_monitor.take_due_poll(now) {
            self.mark_display_change();
        }
        self.process_display_changes(event_loop);
        self.with_app_context(event_loop, |app, context| app.about_to_wait(context));
        self.process_window_commands(event_loop);
        self.apply_control_flow(event_loop);
        self.refresh_diagnostics();
    }

    fn memory_warning(&mut self, event_loop: &ActiveEventLoop) {
        self.diagnostics.record(DiagnosticEventKind::MemoryWarning);
        self.with_app_context(event_loop, |app, context| app.memory_warning(context));
        self.process_window_commands(event_loop);
        self.apply_control_flow(event_loop);
        self.refresh_diagnostics();
    }

    fn exiting(&mut self, event_loop: &ActiveEventLoop) {
        self.lifecycle.ensure_platform_exit();
        self.diagnostics.record(DiagnosticEventKind::Exiting);
        self.background.cancel_all();
        self.restore_modal_parents();
        self.services.menus().set_event_handler(None);
        self.services.tray().set_event_handler(None);
        self.services.global_shortcuts().set_event_handler(None);
        let _ = self.services.global_shortcuts().unregister_all();
        self.with_app_context(event_loop, |app, context| app.exiting(context));
    }
}
