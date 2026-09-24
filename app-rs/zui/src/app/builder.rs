use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;

use crate::internal::ApplicationRunError;
use crate::internal::NativeEventLoopOptions;
use crate::internal::run_application_with_user_events;

use super::App;
use super::AppProxy;
use super::ApplicationBadgeService;
use super::ApplicationExit;
use super::ApplicationHandle;
use super::ApplicationLocaleConfig;
use super::ApplicationLocales;
use super::ApplicationPathConfig;
use super::ApplicationPaths;
use super::ApplicationReadiness;
use super::ApplicationRelauncher;
use super::BackgroundExecutor;
use super::Clipboard;
use super::ClipboardHandle;
use super::DesktopFileName;
use super::DiagnosticsHandle;
use super::DiagnosticsSink;
use super::ExitPolicy;
use super::FileDialogService;
use super::FileIconService;
use super::GlobalShortcutService;
use super::JumpListService;
use super::LoginItemService;
use super::MenuService;
use super::MessageDialogService;
use super::NotificationService;
use super::OpenerService;
use super::ProcessService;
use super::ProtocolClientService;
use super::ProtocolScheme;
use super::ProtocolUrl;
use super::RecentDocumentService;
use super::RendererFactory;
use super::ResourceService;
use super::RuntimeEvent;
use super::SecondInstance;
use super::Services;
use super::SingleInstanceOptions;
use super::SingleInstanceRun;
use super::SystemClipboard;
use super::SystemResourceLocator;
use super::TimerScheduler;
use super::TrayService;
use super::UpdateService;
use super::host::ApplicationHost;
use super::host::ApplicationResources;
use super::protocol;
use super::single_instance::transport;
use super::single_instance::transport::Acquisition;
use super::single_instance::transport::PrimaryInstance;

/// Configures shared renderer and platform capabilities before running an application.
pub struct ApplicationBuilder {
    renderer_factory: Box<dyn RendererFactory>,
    clipboard: ClipboardHandle,
    services: Services,
    exit_policy: ExitPolicy,
    protocol_schemes: Vec<ProtocolScheme>,
    launch_urls: Vec<ProtocolUrl>,
    diagnostics_capacity: usize,
    diagnostics_sink: Option<Arc<dyn DiagnosticsSink>>,
    retain_diagnostics_inspection: bool,
    pub(super) application_locale: ApplicationLocaleConfig,
    pub(super) application_paths: ApplicationPathConfig,
}

impl ApplicationBuilder {
    pub(super) fn new(renderer_factory: impl RendererFactory + 'static) -> Self {
        Self {
            renderer_factory: Box::new(renderer_factory),
            clipboard: ClipboardHandle::new(SystemClipboard),
            services: Services::system(),
            exit_policy: ExitPolicy::default(),
            protocol_schemes: Vec::new(),
            launch_urls: Vec::new(),
            diagnostics_capacity: 512,
            diagnostics_sink: None,
            retain_diagnostics_inspection: false,
            application_locale: ApplicationLocaleConfig::default(),
            application_paths: ApplicationPathConfig::default(),
        }
    }

    /// Replaces the renderer factory used for subsequently opened windows.
    pub fn with_renderer(mut self, renderer_factory: impl RendererFactory + 'static) -> Self {
        self.renderer_factory = Box::new(renderer_factory);
        self
    }

    /// Replaces the application-wide text clipboard capability.
    pub fn with_clipboard(mut self, clipboard: impl Clipboard + 'static) -> Self {
        self.clipboard = ClipboardHandle::new(clipboard);
        self
    }

    /// Replaces the native file-dialog service exposed to application code.
    pub fn with_file_dialogs(mut self, service: impl FileDialogService + 'static) -> Self {
        self.services.replace_file_dialogs(service);
        self
    }

    /// Replaces operating-system file-icon lookup for tests or product policy.
    pub fn with_file_icons(mut self, service: impl FileIconService + 'static) -> Self {
        self.services.replace_file_icons(service);
        self
    }

    /// Replaces the application launcher badge backend for tests or product policy.
    pub fn with_application_badge(
        mut self,
        service: impl ApplicationBadgeService + 'static,
    ) -> Self {
        self.services.replace_application_badge(service);
        self
    }

    /// Replaces the native message-dialog service exposed to application code.
    pub fn with_message_dialogs(mut self, service: impl MessageDialogService + 'static) -> Self {
        self.services.replace_message_dialogs(service);
        self
    }

    /// Replaces the operating-system opener used for paths and external URLs.
    pub fn with_opener(mut self, service: impl OpenerService + 'static) -> Self {
        self.services.replace_opener(service);
        self
    }

    /// Replaces the desktop-notification service exposed to application code.
    pub fn with_notifications(mut self, service: impl NotificationService + 'static) -> Self {
        self.services.replace_notifications(service);
        self
    }

    /// Replaces the native application-menu service and event source.
    pub fn with_menus(mut self, service: impl MenuService + 'static) -> Self {
        self.services.replace_menus(service);
        self
    }

    /// Replaces the system-tray service and event source.
    pub fn with_tray(mut self, service: impl TrayService + 'static) -> Self {
        self.services.replace_tray(service);
        self
    }

    /// Replaces the global-shortcut service and event source.
    pub fn with_global_shortcuts(mut self, service: impl GlobalShortcutService + 'static) -> Self {
        self.services.replace_global_shortcuts(service);
        self
    }

    /// Replaces Windows Jump List configuration for tests or product policy.
    pub fn with_jump_lists(mut self, service: impl JumpListService + 'static) -> Self {
        self.services.replace_jump_lists(service);
        self
    }

    /// Replaces login-item registration and status lookup for tests or product policy.
    pub fn with_login_items(mut self, service: impl LoginItemService + 'static) -> Self {
        self.services.replace_login_items(service);
        self
    }

    /// Replaces packaged-resource discovery for development, tests, or custom bundles.
    pub fn with_resources(mut self, service: impl ResourceService + 'static) -> Self {
        self.services.replace_resources(service);
        self
    }

    /// Uses an explicit packaged-resource root.
    pub fn with_resource_root(mut self, root: impl Into<std::path::PathBuf>) -> Self {
        self.services
            .replace_resources(SystemResourceLocator::from_root(root));
        self
    }

    /// Replaces shell-free child-process spawning for policy enforcement or tests.
    pub fn with_processes(mut self, service: impl ProcessService + 'static) -> Self {
        self.services.replace_processes(service);
        self
    }

    /// Replaces default protocol-client registration and lookup for tests or product policy.
    pub fn with_protocol_clients(mut self, service: impl ProtocolClientService + 'static) -> Self {
        self.services.replace_protocol_clients(service);
        self
    }

    /// Sets the installed Linux desktop-entry identity before native windows are created.
    ///
    /// The identity is also the default for protocol-client and launcher badge operations. It
    /// must match the packaged `.desktop` filename for desktop integration to find this app.
    pub fn with_desktop_file_name(mut self, name: DesktopFileName) -> Self {
        self.services.set_desktop_file_name(name);
        self
    }

    /// Replaces the operating-system recent-document service.
    pub fn with_recent_documents(mut self, service: impl RecentDocumentService + 'static) -> Self {
        self.services.replace_recent_documents(service);
        self
    }

    /// Replaces application update checking, download verification, and installer handoff.
    pub fn with_updates(mut self, service: impl UpdateService + 'static) -> Self {
        self.services.replace_updates(service);
        self
    }

    /// Sets the number of latest runtime events retained for diagnostics snapshots.
    pub const fn with_diagnostics_capacity(mut self, capacity: usize) -> Self {
        self.diagnostics_capacity = capacity;
        self
    }

    /// Streams diagnostic events to an application-provided observer.
    pub fn with_diagnostics_sink(mut self, sink: impl DiagnosticsSink + 'static) -> Self {
        self.diagnostics_sink = Some(Arc::new(sink));
        self
    }

    /// Retains the latest scene's complete inspection hierarchy in diagnostics snapshots.
    ///
    /// This is opt-in because copying inspection nodes on every presented frame has a measurable
    /// cost for applications that only need runtime counters and event traces.
    pub const fn with_diagnostics_inspection(mut self) -> Self {
        self.retain_diagnostics_inspection = true;
        self
    }

    /// Selects whether closing the last window exits the event loop automatically.
    pub const fn with_exit_policy(mut self, exit_policy: ExitPolicy) -> Self {
        self.exit_policy = exit_policy;
        self
    }

    /// Accepts command-line launch URLs using one custom protocol scheme.
    pub fn with_protocol_scheme(mut self, scheme: ProtocolScheme) -> Self {
        if !self.protocol_schemes.contains(&scheme) {
            self.protocol_schemes.push(scheme);
        }
        self
    }

    /// Adds an explicit launch URL for platform forwarding or deterministic tests.
    pub fn with_launch_url(mut self, url: ProtocolUrl) -> Self {
        self.launch_urls.push(url);
        self
    }

    /// Runs the configured native application until the platform event loop exits.
    pub fn run<T, A, C>(self, create: C) -> Result<ApplicationExit<A>, ApplicationRunError>
    where
        T: Send + 'static,
        A: App<T> + 'static,
        C: FnOnce(ApplicationHandle<T>) -> A,
    {
        self.run_primary(None, create)
    }

    /// Runs one primary native application or forwards this invocation to an existing process.
    ///
    /// A forwarded invocation returns without constructing product state. The primary receives a
    /// [`super::SecondInstance`] callback containing the secondary arguments, working directory,
    /// and opaque additional data.
    pub fn run_single_instance<T, A, C>(
        self,
        options: SingleInstanceOptions,
        create: C,
    ) -> Result<SingleInstanceRun<A>, ApplicationRunError>
    where
        T: Send + 'static,
        A: App<T> + 'static,
        C: FnOnce(ApplicationHandle<T>) -> A,
    {
        let working_directory =
            std::env::current_dir().map_err(ApplicationRunError::single_instance)?;
        let event = SecondInstance::new(std::env::args_os(), working_directory)
            .with_additional_data(options.additional_data().to_vec());
        match transport::acquire(options.key(), &event)
            .map_err(ApplicationRunError::single_instance)?
        {
            Acquisition::Primary(instance) => self
                .run_primary(Some(instance), create)
                .map(SingleInstanceRun::Primary),
            Acquisition::Forwarded => Ok(SingleInstanceRun::Forwarded),
        }
    }

    fn run_primary<T, A, C>(
        self,
        single_instance: Option<PrimaryInstance>,
        create: C,
    ) -> Result<ApplicationExit<A>, ApplicationRunError>
    where
        T: Send + 'static,
        A: App<T> + 'static,
        C: FnOnce(ApplicationHandle<T>) -> A,
    {
        let application_locales = ApplicationLocales::detect(self.application_locale);
        let application_paths =
            ApplicationPaths::detect(self.application_paths).map_err(ApplicationRunError::paths)?;
        let renderer_factory = self.renderer_factory;
        let clipboard = self.clipboard;
        let services = self.services;
        let exit_policy = self.exit_policy;
        let protocol_schemes = self.protocol_schemes;
        let mut launch_urls = self.launch_urls;
        let diagnostics = DiagnosticsHandle::new(
            self.diagnostics_capacity,
            self.diagnostics_sink,
            self.retain_diagnostics_inspection,
        );
        let background_pool = BackgroundExecutor::<T>::create_pool()
            .map_err(ApplicationRunError::background_executor)?;
        launch_urls.extend(protocol::urls_from_arguments(
            &protocol_schemes,
            std::env::args_os().skip(1),
        ));
        let display_change_pending = Rc::new(Cell::new(false));
        let event_loop_options = NativeEventLoopOptions::default();
        #[cfg(target_os = "windows")]
        let event_loop_options = event_loop_options
            .with_menu_accelerator_table(services.menu_accelerator_table())
            .with_display_change_pending(Rc::clone(&display_change_pending));
        let relauncher = ApplicationRelauncher::default();
        let application_relauncher = relauncher.clone();
        let mut host =
            run_application_with_user_events(event_loop_options, move |runtime_proxy| {
                let event_proxy = AppProxy::new(
                    runtime_proxy,
                    application_relauncher,
                    application_locales,
                    application_paths,
                );
                if let Some(instance) = single_instance.as_ref() {
                    let proxy = event_proxy.inner.clone();
                    instance.attach(move |event| {
                        proxy
                            .send_event(RuntimeEvent::SecondInstance(event))
                            .is_ok()
                    });
                }
                #[cfg(target_os = "macos")]
                let application_delegate_bridge =
                    super::macos::MacOSApplicationDelegateBridge::install(
                        event_proxy.inner.clone(),
                        protocol_schemes.clone(),
                    );
                let background = BackgroundExecutor::new(event_proxy.clone(), background_pool);
                let timers = TimerScheduler::new(event_proxy.clone());
                let readiness = ApplicationReadiness::default();
                let handle = ApplicationHandle {
                    event_proxy: event_proxy.clone(),
                    readiness: readiness.clone(),
                    clipboard: clipboard.clone(),
                    services: services.clone(),
                    background: background.clone(),
                    timers: timers.clone(),
                    diagnostics: diagnostics.clone(),
                };
                let resources = ApplicationResources {
                    renderer_factory,
                    clipboard,
                    services,
                    event_proxy,
                    readiness,
                    background,
                    timers,
                    launch_urls,
                    protocol_schemes,
                    diagnostics,
                    display_change_pending,
                    single_instance,
                    #[cfg(target_os = "macos")]
                    application_delegate_bridge,
                };
                ApplicationHost::new(create(handle), resources, exit_policy)
            })?;
        drop(host.single_instance.take());
        relauncher
            .launch_all()
            .map_err(ApplicationRunError::relaunch)?;
        let reason = host.exit_reason();
        Ok(ApplicationExit {
            app: host.app,
            error: host.error,
            reason,
        })
    }
}
