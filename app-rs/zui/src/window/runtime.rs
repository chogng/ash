use crate::accessibility::AccessibilityAction;
use crate::accessibility::AccessibilityBridge;
use crate::app::AppProxy;
use crate::app::ApplicationError;
use crate::devtools::DevToolsRequestSender;
use crate::internal::ActiveEventLoop;
use crate::render::RenderOutcome;
use crate::render::RenderTargetSize;
use crate::render::Renderer;
use crate::render::RendererError;
use crate::render::RendererFactory;
use crate::runtime::AccessibilityNode;
use crate::ui::foundation::Size;
use crate::ui::presentation::UiScene;
use crate::window::NativeWindow;
use crate::window::PhysicalExtent;
use crate::window::WindowCloseRequester;
use crate::window::WindowEvent;
use crate::window::WindowHandle;
use crate::window::WindowId;
use crate::window::WindowOptions;
use crate::window::WindowRole;

/// Current platform dimensions for one runtime-owned window.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowMetrics {
    physical_extent: PhysicalExtent,
    scale_factor: f64,
}

impl WindowMetrics {
    pub(crate) const fn new(physical_extent: PhysicalExtent, scale_factor: f64) -> Self {
        Self {
            physical_extent,
            scale_factor,
        }
    }

    /// Returns the current physical render-target dimensions.
    pub const fn physical_extent(self) -> PhysicalExtent {
        self.physical_extent
    }

    /// Returns the validated logical-to-physical scale factor.
    pub fn scale_factor(self) -> f64 {
        if self.scale_factor.is_finite() && self.scale_factor > 0.0 {
            self.scale_factor
        } else {
            1.0
        }
    }

    /// Returns the logical content size derived from the current physical dimensions.
    pub fn logical_size(self) -> Size {
        let scale_factor = self.scale_factor() as f32;
        Size::new(
            self.physical_extent.width as f32 / scale_factor,
            self.physical_extent.height as f32 / scale_factor,
        )
    }
}

/// Identity, non-owning handle, and initial metrics returned after opening a window.
#[derive(Clone)]
pub struct OpenedWindow {
    id: WindowId,
    handle: WindowHandle,
    metrics: WindowMetrics,
}

impl OpenedWindow {
    /// Returns the stable platform window identity.
    pub const fn id(&self) -> WindowId {
        self.id
    }

    /// Returns a non-owning capability for product-directed platform updates.
    pub fn handle(&self) -> WindowHandle {
        self.handle.clone()
    }

    /// Returns metrics captured when the window was opened.
    pub const fn metrics(&self) -> WindowMetrics {
        self.metrics
    }
}

pub(crate) struct WindowRuntime {
    window: NativeWindow,
    renderer: Box<dyn Renderer>,
    metrics: WindowMetrics,
    accessibility: AccessibilityBridge,
    role: WindowRole,
    close_requester: WindowCloseRequester,
    parent: Option<WindowId>,
    modal: bool,
    initially_visible: bool,
}

pub(crate) struct WindowRuntimeEnvironment<'a> {
    parent_window: Option<&'a NativeWindow>,
    role: WindowRole,
    desktop_application_id: Option<&'a str>,
    request_sender: DevToolsRequestSender,
}

impl<'a> WindowRuntimeEnvironment<'a> {
    pub(crate) fn new(
        parent_window: Option<&'a NativeWindow>,
        role: WindowRole,
        desktop_application_id: Option<&'a str>,
        request_sender: DevToolsRequestSender,
    ) -> Self {
        Self {
            parent_window,
            role,
            desktop_application_id,
            request_sender,
        }
    }
}

impl WindowRuntime {
    pub(crate) fn open<T: Send + 'static>(
        event_loop: &ActiveEventLoop,
        renderer_factory: &mut dyn RendererFactory,
        proxy: &AppProxy<T>,
        options: WindowOptions,
        environment: WindowRuntimeEnvironment<'_>,
    ) -> Result<Self, ApplicationError> {
        options
            .validate()
            .map_err(ApplicationError::window_options)?;
        NativeWindow::validate_platform_options(event_loop, &options)
            .map_err(ApplicationError::window_options)?;
        let title = options.title.clone();
        let initially_visible = options.visible;
        let parent = options.parent;
        let modal = options.modal;
        let WindowRuntimeEnvironment {
            parent_window,
            role,
            desktop_application_id,
            request_sender,
        } = environment;
        let window = NativeWindow::create(
            event_loop,
            options,
            parent_window,
            desktop_application_id,
            request_sender,
        )
        .map_err(ApplicationError::window)?;
        let metrics = WindowMetrics::new(window.inner_extent(), window.scale_factor());
        let accessibility =
            AccessibilityBridge::new(event_loop, &window, proxy, title, metrics.scale_factor());
        let mut renderer = renderer_factory
            .create(window.render_window())
            .map_err(ApplicationError::renderer)?;
        renderer.resize(RenderTargetSize::new(
            metrics.physical_extent.width,
            metrics.physical_extent.height,
        ));
        renderer.set_scale_factor(metrics.scale_factor());
        let close_requester = proxy.window_close_requester();
        Ok(Self {
            window,
            renderer,
            metrics,
            accessibility,
            role,
            close_requester,
            parent,
            modal,
            initially_visible,
        })
    }

    pub(crate) fn finish_open(&self, parent: Option<&WindowRuntime>) {
        if self.modal
            && let Some(parent) = parent
        {
            parent.window.set_enabled(false);
        }
        if self.initially_visible {
            self.window.show();
        }
    }

    pub(crate) fn opened_window(&self) -> OpenedWindow {
        OpenedWindow {
            id: self.window.id(),
            handle: self
                .window
                .handle(self.close_requester.clone(), self.parent, self.modal),
            metrics: self.metrics,
        }
    }

    pub(crate) fn id(&self) -> WindowId {
        self.window.id()
    }

    pub(crate) fn metrics(&self) -> WindowMetrics {
        self.metrics
    }

    pub(crate) fn handle(&self) -> WindowHandle {
        self.window
            .handle(self.close_requester.clone(), self.parent, self.modal)
    }

    pub(crate) fn has_focus(&self) -> bool {
        self.window.has_focus()
    }

    pub(crate) fn request_redraw(&self) {
        self.window.request_redraw();
    }

    pub(crate) const fn role(&self) -> WindowRole {
        self.role
    }

    pub(crate) const fn parent(&self) -> Option<WindowId> {
        self.parent
    }

    pub(crate) const fn is_modal(&self) -> bool {
        self.modal
    }

    pub(crate) fn set_enabled(&self, enabled: bool) {
        self.window.set_enabled(enabled);
    }

    pub(crate) fn native_window(&self) -> &NativeWindow {
        &self.window
    }

    pub(crate) fn apply_platform_event(&mut self, event: &WindowEvent) {
        match event {
            WindowEvent::Resized(size) => {
                self.metrics.physical_extent = PhysicalExtent::new(size.width, size.height);
                self.renderer
                    .resize(RenderTargetSize::new(size.width, size.height));
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                self.metrics.scale_factor = *scale_factor;
                self.renderer.set_scale_factor(*scale_factor);
            }
            _ => {}
        }
    }

    pub(crate) fn process_accessibility_window_event(
        &mut self,
        event: &crate::internal::NativeWindowEvent,
    ) {
        self.accessibility.process_window_event(&self.window, event);
    }

    pub(crate) fn handle_accessibility_event(
        &mut self,
        event: accesskit_platform::WindowEvent,
    ) -> Option<AccessibilityAction> {
        self.accessibility.handle_event(self.id(), event)
    }

    pub(crate) fn update_accessibility(&mut self, nodes: &[AccessibilityNode]) {
        self.accessibility
            .update(nodes, self.metrics.scale_factor());
    }

    pub(crate) fn memory_reader(&self) -> Option<crate::render::RendererMemoryReader> {
        self.renderer.memory_reader()
    }

    pub(crate) fn render_scene(&mut self, scene: &UiScene) -> Result<RenderOutcome, RendererError> {
        let outcome = self.renderer.render_scene(scene)?;
        if outcome == RenderOutcome::Retry {
            self.window.request_redraw();
        }
        Ok(outcome)
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
