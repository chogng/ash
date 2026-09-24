use std::collections::HashMap;
use std::future::Future;
use std::time::Duration;
use std::time::Instant;

use crate::devtools::DevToolsHandle;
use crate::devtools::DevToolsRequestSender;
use crate::internal::ActiveEventLoop;
use crate::internal::ControlFlow;
use crate::render::RenderOutcome;
use crate::render::RendererError;
use crate::runtime::AccessibilityNode;
use crate::runtime::InteractionFrame;
use crate::runtime::UiDispatch;
use crate::ui::presentation::UiFrame;
use crate::ui::presentation::UiScene;
use crate::window::CursorPositionError;
use crate::window::DisplaySnapshot;
use crate::window::PhysicalPosition;
use crate::window::WindowHandle;
use crate::window::WindowId;
use crate::window::WindowOperationError;
use crate::window::WindowOptionsError;

use super::AppProxy;
use super::ApplicationError;
use super::ApplicationPhase;
use super::ApplicationReadyFuture;
use super::BackgroundExecutor;
use super::ClipboardHandle;
use super::DiagnosticsHandle;
use super::LifecycleCore;
use super::OpenedWindow;
use super::RendererFactory;
use super::Services;
use super::Task;
use super::TaskScope;
use super::Timer;
use super::TimerScheduleError;
use super::TimerScheduler;
use super::WindowFramePresentation;
use super::WindowMetrics;
use super::WindowOptions;
use super::WindowRuntimeEnvironment;
use crate::window::WindowRole;
use crate::window::WindowRuntime;

/// Main-thread application capabilities available outside a specific window callback.
pub struct AppContext<'a, T: 'static> {
    event_loop: &'a ActiveEventLoop,
    windows: &'a mut HashMap<WindowId, WindowRuntime>,
    renderer_factory: &'a mut dyn RendererFactory,
    clipboard: &'a ClipboardHandle,
    services: &'a Services,
    event_proxy: &'a AppProxy<T>,
    error: &'a mut Option<ApplicationError>,
    lifecycle: &'a mut LifecycleCore,
    control_flow: &'a mut ControlFlow,
    background: &'a BackgroundExecutor<T>,
    timers: &'a TimerScheduler<T>,
    diagnostics: &'a DiagnosticsHandle,
    devtools_requests: DevToolsRequestSender,
}

pub(super) struct AppContextParts<'a, T: 'static> {
    pub(super) event_loop: &'a ActiveEventLoop,
    pub(super) windows: &'a mut HashMap<WindowId, WindowRuntime>,
    pub(super) renderer_factory: &'a mut dyn RendererFactory,
    pub(super) clipboard: &'a ClipboardHandle,
    pub(super) services: &'a Services,
    pub(super) event_proxy: &'a AppProxy<T>,
    pub(super) error: &'a mut Option<ApplicationError>,
    pub(super) lifecycle: &'a mut LifecycleCore,
    pub(super) control_flow: &'a mut ControlFlow,
    pub(super) background: &'a BackgroundExecutor<T>,
    pub(super) timers: &'a TimerScheduler<T>,
    pub(super) diagnostics: &'a DiagnosticsHandle,
    pub(super) devtools_requests: DevToolsRequestSender,
}

impl<'a, T: 'static> AppContext<'a, T> {
    pub(super) fn new(parts: AppContextParts<'a, T>) -> Self {
        Self {
            event_loop: parts.event_loop,
            windows: parts.windows,
            renderer_factory: parts.renderer_factory,
            clipboard: parts.clipboard,
            services: parts.services,
            event_proxy: parts.event_proxy,
            error: parts.error,
            lifecycle: parts.lifecycle,
            control_flow: parts.control_flow,
            background: parts.background,
            timers: parts.timers,
            diagnostics: parts.diagnostics,
            devtools_requests: parts.devtools_requests,
        }
    }

    /// Opens a runtime-owned native window and initializes its renderer.
    pub fn open_window(&mut self, options: WindowOptions) -> Result<OpenedWindow, ApplicationError>
    where
        T: Send,
    {
        let parent = match options.parent() {
            Some(parent) => Some(
                self.windows
                    .get(&parent)
                    .filter(|runtime| runtime.role() == WindowRole::Product)
                    .ok_or_else(|| {
                        ApplicationError::window_options(WindowOptionsError::ParentNotFound {
                            parent,
                        })
                    })?,
            ),
            None => None,
        };
        let desktop_file_name = self.services.desktop_file_name();
        let environment = WindowRuntimeEnvironment::new(
            parent.map(WindowRuntime::native_window),
            WindowRole::Product,
            desktop_file_name
                .as_ref()
                .map(crate::services::DesktopFileName::application_id),
            self.devtools_requests.clone(),
        );
        let runtime = WindowRuntime::open(
            self.event_loop,
            self.renderer_factory,
            self.event_proxy,
            options,
            environment,
        )?;
        let opened = runtime.opened_window();
        self.services
            .menus()
            .attach_window(opened.handle())
            .map_err(|source| {
                ApplicationError::host("native application menu attachment", source)
            })?;
        runtime.finish_open(parent);
        let memory_reader = runtime.memory_reader();
        self.windows.insert(opened.id(), runtime);
        self.diagnostics.open_window(opened.id(), opened.metrics());
        self.diagnostics
            .set_memory_reader(opened.id(), memory_reader);
        self.lifecycle.record_window_opened(opened.id());
        Ok(opened)
    }

    /// Returns the current shared application-host lifecycle phase.
    pub const fn phase(&self) -> ApplicationPhase {
        self.lifecycle.phase()
    }

    /// Returns whether the first [`super::App::ready`] callback has completed.
    pub fn is_ready(&self) -> bool {
        self.lifecycle.is_ready()
    }

    /// Waits for the first [`super::App::ready`] callback to complete or the application to exit.
    pub fn when_ready(&self) -> ApplicationReadyFuture {
        self.lifecycle.when_ready()
    }

    /// Returns whether the runtime currently owns a window with `id`.
    pub fn contains_window(&self, id: WindowId) -> bool {
        self.windows.contains_key(&id)
    }

    /// Returns the current metrics for a runtime-owned window.
    pub fn window_metrics(&self, id: WindowId) -> Option<WindowMetrics> {
        self.windows.get(&id).map(WindowRuntime::metrics)
    }

    /// Returns a non-owning platform capability for a runtime-owned window.
    pub fn window_handle(&self, id: WindowId) -> Option<WindowHandle> {
        self.windows.get(&id).map(WindowRuntime::handle)
    }

    /// Returns the live product parent of `id`, if the window has one.
    pub fn parent_window(&self, id: WindowId) -> Option<WindowHandle> {
        let parent = self.windows.get(&id)?.parent()?;
        self.windows
            .get(&parent)
            .filter(|runtime| runtime.role() == WindowRole::Product)
            .map(WindowRuntime::handle)
    }

    /// Returns direct live product children in stable numeric order.
    pub fn child_windows(&self, parent: WindowId) -> Vec<WindowHandle> {
        let mut children = self
            .windows
            .values()
            .filter(|runtime| {
                runtime.role() == WindowRole::Product && runtime.parent() == Some(parent)
            })
            .map(WindowRuntime::handle)
            .collect::<Vec<_>>();
        children.sort_by_key(|window| window.id().into_raw());
        children
    }

    /// Returns every live product window identity in stable numeric order.
    pub fn window_ids(&self) -> Vec<WindowId> {
        let mut windows: Vec<_> = self
            .windows
            .values()
            .filter(|runtime| matches!(runtime.role(), WindowRole::Product))
            .map(WindowRuntime::id)
            .collect();
        windows.sort_by_key(|window| window.into_raw());
        windows
    }

    /// Returns non-owning capabilities for every live window in stable identity order.
    pub fn window_handles(&self) -> Vec<WindowHandle> {
        self.window_ids()
            .into_iter()
            .filter_map(|window| self.window_handle(window))
            .collect()
    }

    /// Returns the runtime-owned window that currently has keyboard focus, if any.
    pub fn focused_window(&self) -> Option<WindowHandle> {
        self.windows
            .values()
            .filter(|runtime| matches!(runtime.role(), WindowRole::Product) && runtime.has_focus())
            .min_by_key(|runtime| runtime.id().into_raw())
            .map(WindowRuntime::handle)
    }

    /// Captures all connected displays and the platform primary display.
    pub fn display_snapshot(&self) -> DisplaySnapshot {
        DisplaySnapshot::from_native(
            self.event_loop.available_monitors(),
            self.event_loop.primary_monitor(),
            None,
        )
    }

    /// Returns the pointer location in the same global physical screen space as display bounds.
    pub fn cursor_screen_position(&self) -> Result<PhysicalPosition, CursorPositionError> {
        crate::window::cursor_screen_position(self.event_loop)
    }

    /// Requests another frame for a runtime-owned window.
    pub fn request_redraw(&self, id: WindowId) -> Result<(), WindowOperationError> {
        let Some(window) = self.windows.get(&id) else {
            return Err(WindowOperationError::Closed {
                window: id,
                operation: "redraw request",
            });
        };
        window.handle().request_redraw()
    }

    /// Returns the application-wide text clipboard capability.
    pub fn clipboard(&self) -> ClipboardHandle {
        self.clipboard.clone()
    }

    /// Returns the typed operating-system service capabilities.
    pub fn services(&self) -> Services {
        self.services.clone()
    }

    /// Returns a bounded snapshot and trace capability for this application runtime.
    pub fn diagnostics(&self) -> DiagnosticsHandle {
        self.diagnostics.clone()
    }

    /// Sets the native event-loop wakeup policy selected by the application.
    pub fn set_control_flow(&mut self, control_flow: ControlFlow) {
        *self.control_flow = control_flow;
    }

    /// Returns the cloneable application-wide background executor.
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

    /// Schedules an application-scoped user event after `delay`.
    pub fn schedule_after(&self, delay: Duration, event: T) -> Result<Timer, TimerScheduleError<T>>
    where
        T: Send,
    {
        self.timers.schedule_after(delay, event)
    }

    /// Schedules an application-scoped user event at `deadline`.
    pub fn schedule_at(&self, deadline: Instant, event: T) -> Result<Timer, TimerScheduleError<T>>
    where
        T: Send,
    {
        self.timers.schedule_at(deadline, event)
    }
}

/// Runtime and platform capabilities scoped to one native window callback.
pub struct WindowContext<'a, T: 'static> {
    runtime: &'a mut WindowRuntime,
    event_proxy: &'a AppProxy<T>,
    clipboard: &'a ClipboardHandle,
    services: &'a Services,
    error: &'a mut Option<ApplicationError>,
    lifecycle: &'a mut LifecycleCore,
    background: &'a BackgroundExecutor<T>,
    timers: &'a TimerScheduler<T>,
    diagnostics: &'a DiagnosticsHandle,
}

pub(super) struct WindowContextParts<'a, T: 'static> {
    pub(super) runtime: &'a mut WindowRuntime,
    pub(super) event_proxy: &'a AppProxy<T>,
    pub(super) clipboard: &'a ClipboardHandle,
    pub(super) services: &'a Services,
    pub(super) error: &'a mut Option<ApplicationError>,
    pub(super) lifecycle: &'a mut LifecycleCore,
    pub(super) background: &'a BackgroundExecutor<T>,
    pub(super) timers: &'a TimerScheduler<T>,
    pub(super) diagnostics: &'a DiagnosticsHandle,
}

impl<'a, T: 'static> WindowContext<'a, T> {
    pub(super) fn new(parts: WindowContextParts<'a, T>) -> Self {
        Self {
            runtime: parts.runtime,
            event_proxy: parts.event_proxy,
            clipboard: parts.clipboard,
            services: parts.services,
            error: parts.error,
            lifecycle: parts.lifecycle,
            background: parts.background,
            timers: parts.timers,
            diagnostics: parts.diagnostics,
        }
    }

    /// Returns the stable platform identity of this window.
    pub fn id(&self) -> WindowId {
        self.runtime.id()
    }

    /// Returns the current physical and logical window metrics.
    pub fn metrics(&self) -> WindowMetrics {
        self.runtime.metrics()
    }

    /// Returns the current shared application-host lifecycle phase.
    pub const fn phase(&self) -> ApplicationPhase {
        self.lifecycle.phase()
    }

    /// Returns a non-owning capability for product-directed platform updates.
    pub fn window_handle(&self) -> WindowHandle {
        self.runtime.handle()
    }

    /// Returns the shared DevTools session capability for this window.
    pub fn devtools(&self) -> DevToolsHandle {
        self.runtime.handle().devtools()
    }

    /// Opens the default zui DevTools window for this window and schedules a frame.
    pub fn open_devtools(&self) -> Result<(), WindowOperationError> {
        self.runtime.handle().open_devtools()
    }

    /// Closes the default zui DevTools window for this window and schedules a frame.
    pub fn close_devtools(&self) -> Result<(), WindowOperationError> {
        self.runtime.handle().close_devtools()
    }

    /// Toggles DevTools for this window and returns whether it is now open.
    pub fn toggle_devtools(&self) -> Result<bool, WindowOperationError> {
        self.runtime.handle().toggle_devtools()
    }

    /// Returns whether DevTools is currently open for this window.
    pub fn is_devtools_open(&self) -> bool {
        self.runtime.handle().is_devtools_open()
    }

    /// Schedules another frame for this window.
    pub fn request_redraw(&self) -> Result<(), WindowOperationError> {
        self.runtime.handle().request_redraw()
    }

    /// Captures connected displays and the display containing this window.
    pub fn display_snapshot(&self) -> Result<DisplaySnapshot, WindowOperationError> {
        self.runtime.handle().display_snapshot()
    }

    /// Returns the application-wide text clipboard capability.
    pub fn clipboard(&self) -> ClipboardHandle {
        self.clipboard.clone()
    }

    /// Returns the typed operating-system service capabilities.
    pub fn services(&self) -> Services {
        self.services.clone()
    }

    /// Returns a bounded snapshot and trace capability for this application runtime.
    pub fn diagnostics(&self) -> DiagnosticsHandle {
        self.diagnostics.clone()
    }

    /// Resolves and presents one complete UI frame.
    ///
    /// The scene, inspection hierarchy, interaction tree, focus state, and accessibility snapshot
    /// are taken from the same frame boundary. Callers cannot submit an independently cached
    /// accessibility projection that has drifted from the painted scene.
    pub fn present_frame(
        &mut self,
        frame: &UiFrame<InteractionFrame>,
        dispatch: &UiDispatch,
    ) -> Result<RenderOutcome, RendererError> {
        let presentation = WindowFramePresentation::resolve(frame, dispatch);
        self.present_outputs(presentation.scene(), presentation.accessibility())
    }

    fn present_outputs(
        &mut self,
        scene: &UiScene,
        accessibility: &[AccessibilityNode],
    ) -> Result<RenderOutcome, RendererError> {
        let devtools = self.runtime.handle().devtools();
        devtools.set_inspection(scene.inspection().clone());
        let decorated = devtools
            .is_open()
            .then(|| crate::devtools::view::decorate_product_scene(scene, &devtools))
            .flatten();
        let scene = decorated.as_ref().unwrap_or(scene);
        self.runtime.update_accessibility(accessibility);
        let outcome = self.runtime.render_scene(scene)?;
        self.diagnostics.present(
            self.id(),
            self.metrics(),
            self.diagnostics
                .scene_diagnostics(scene, accessibility.len()),
            outcome,
        );
        Ok(outcome)
    }

    /// Starts background work cancelled automatically when this window closes.
    pub fn spawn<F>(&self, future: F) -> Task
    where
        T: Send,
        F: Future<Output = T> + Send + 'static,
    {
        self.background.spawn(TaskScope::Window(self.id()), future)
    }

    /// Schedules a user event cancelled automatically when this window closes.
    pub fn schedule_after(&self, delay: Duration, event: T) -> Result<Timer, TimerScheduleError<T>>
    where
        T: Send,
    {
        self.timers
            .schedule_after_in_scope(TaskScope::Window(self.id()), delay, event)
    }

    /// Schedules a user event at `deadline`, cancelled automatically when this window closes.
    pub fn schedule_at(&self, deadline: Instant, event: T) -> Result<Timer, TimerScheduleError<T>>
    where
        T: Send,
    {
        self.timers
            .schedule_at_in_scope(TaskScope::Window(self.id()), deadline, event)
    }
}

mod application_badge;
mod file_icon;
mod jump_list;
mod locale;
mod login_item;
mod paths;
mod presentation;
mod protocol_client;
mod recent_documents;
mod termination;
