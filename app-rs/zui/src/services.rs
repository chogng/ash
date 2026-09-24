//! Typed operating-system capabilities owned and injected by the application runtime.

mod application_badge;
mod blocking;
mod clipboard;
mod dialog_parent;
mod error;
mod file_dialog;
mod file_icon;
mod global_shortcut;
mod jump_list;
mod login_item;
mod menu;
mod message_dialog;
mod notification;
mod opener;
mod process;
mod protocol_client;
mod recent_document;
mod resource;
mod tray;
mod update;

pub use application_badge::ApplicationBadge;
pub use application_badge::ApplicationBadgeHandle;
pub use application_badge::ApplicationBadgeRequest;
pub use application_badge::ApplicationBadgeService;
pub use application_badge::SystemApplicationBadge;
pub use clipboard::Clipboard;
pub use clipboard::ClipboardError;
pub use clipboard::ClipboardHandle;
pub use clipboard::ClipboardHtml;
pub use clipboard::ClipboardImage;
pub use clipboard::SystemClipboard;
pub use error::SystemServiceError;
pub use error::SystemServiceErrorCode;
pub use file_dialog::FileDialogFilter;
pub use file_dialog::FileDialogFilterError;
pub use file_dialog::FileDialogFuture;
pub use file_dialog::FileDialogHandle;
pub use file_dialog::FileDialogOptions;
pub use file_dialog::FileDialogOptionsError;
pub use file_dialog::FileDialogService;
pub use file_dialog::SystemFileDialogs;
pub use file_icon::FileIconFuture;
pub use file_icon::FileIconHandle;
pub use file_icon::FileIconImage;
pub use file_icon::FileIconImageError;
pub use file_icon::FileIconRequest;
pub use file_icon::FileIconRequestError;
pub use file_icon::FileIconService;
pub use file_icon::FileIconSize;
pub use file_icon::SystemFileIcons;
pub use global_shortcut::GlobalShortcut;
pub use global_shortcut::GlobalShortcutEvent;
pub use global_shortcut::GlobalShortcutEventHandler;
pub use global_shortcut::GlobalShortcutHandle;
pub use global_shortcut::GlobalShortcutId;
pub use global_shortcut::GlobalShortcutIdError;
pub use global_shortcut::GlobalShortcutService;
pub use global_shortcut::GlobalShortcutState;
pub use global_shortcut::ShortcutAccelerator;
pub use global_shortcut::ShortcutAcceleratorError;
pub use global_shortcut::SystemGlobalShortcuts;
pub use jump_list::JumpListCategory;
pub use jump_list::JumpListCategoryKind;
pub use jump_list::JumpListHandle;
pub use jump_list::JumpListItem;
pub use jump_list::JumpListModelError;
pub use jump_list::JumpListRequest;
pub use jump_list::JumpListService;
pub use jump_list::JumpListSettings;
pub use jump_list::JumpListTask;
pub use jump_list::JumpListUpdateResult;
pub use jump_list::SystemJumpLists;
pub use login_item::LoginItemHandle;
pub use login_item::LoginItemName;
pub use login_item::LoginItemNameError;
pub use login_item::LoginItemOptions;
pub use login_item::LoginItemRegistration;
pub use login_item::LoginItemRequest;
pub use login_item::LoginItemService;
pub use login_item::LoginItemServiceKind;
pub use login_item::LoginItemSettings;
pub use login_item::LoginItemStartupState;
pub use login_item::LoginItemState;
pub use login_item::LoginItemStatus;
pub use login_item::LoginItemUpdate;
pub use login_item::SystemLoginItems;
pub use menu::MenuAboutMetadata;
pub use menu::MenuAccelerator;
pub use menu::MenuAcceleratorError;
pub use menu::MenuAction;
pub use menu::MenuEntry;
pub use menu::MenuEventHandler;
pub use menu::MenuGroup;
pub use menu::MenuHandle;
pub use menu::MenuItemId;
pub use menu::MenuItemIdError;
pub use menu::MenuModel;
pub use menu::MenuModelError;
pub use menu::MenuRole;
pub use menu::MenuRoleItem;
pub use menu::MenuService;
pub use menu::SystemMenu;
pub use message_dialog::MessageDialogButtons;
pub use message_dialog::MessageDialogFuture;
pub use message_dialog::MessageDialogHandle;
pub use message_dialog::MessageDialogLevel;
pub use message_dialog::MessageDialogRequest;
pub use message_dialog::MessageDialogResponse;
pub use message_dialog::MessageDialogService;
pub use message_dialog::SystemMessageDialogs;
pub use notification::NotificationFuture;
pub use notification::NotificationHandle;
pub use notification::NotificationId;
pub use notification::NotificationRequest;
pub use notification::NotificationService;
pub use notification::SystemNotifications;
pub use opener::ExternalUrl;
pub use opener::ExternalUrlError;
pub use opener::OpenTarget;
pub use opener::OpenerFuture;
pub use opener::OpenerHandle;
pub use opener::OpenerService;
pub use opener::SystemOpener;
pub use process::ChildProcess;
pub use process::PlatformProcessSandbox;
pub use process::PreparedProcessCommand;
pub use process::ProcessCommand;
pub use process::ProcessController;
pub use process::ProcessDropPolicy;
pub use process::ProcessEnvironment;
pub use process::ProcessExit;
pub use process::ProcessFileSystemAccess;
pub use process::ProcessFuture;
pub use process::ProcessHandle;
pub use process::ProcessId;
pub use process::ProcessNetworkAccess;
pub use process::ProcessSandbox;
pub use process::ProcessSandboxError;
pub use process::ProcessSandboxKind;
pub use process::ProcessSandboxPolicy;
pub use process::ProcessService;
pub use process::ProcessStdio;
pub use process::SystemProcesses;
#[doc(hidden)]
pub use process::appcontainer_runner_main;
pub use protocol_client::DesktopFileName;
pub use protocol_client::DesktopFileNameError;
pub use protocol_client::ProtocolClientHandle;
pub use protocol_client::ProtocolClientOptions;
pub use protocol_client::ProtocolClientRemoval;
pub use protocol_client::ProtocolClientRequest;
pub use protocol_client::ProtocolClientService;
pub use protocol_client::SystemProtocolClients;
pub use recent_document::RecentDocumentHandle;
pub use recent_document::RecentDocumentService;
pub use recent_document::SystemRecentDocuments;
pub use resource::ResourceHandle;
pub use resource::ResourcePath;
pub use resource::ResourcePathError;
pub use resource::ResourceService;
pub use resource::SystemResourceLocator;
pub use tray::SystemTray;
pub use tray::TrayBounds;
pub use tray::TrayButtonState;
pub use tray::TrayEvent;
pub use tray::TrayEventHandler;
pub use tray::TrayEventKind;
pub use tray::TrayHandle;
pub use tray::TrayIconImage;
pub use tray::TrayIconImageError;
pub use tray::TrayId;
pub use tray::TrayIdError;
pub use tray::TrayMouseButton;
pub use tray::TrayOptions;
pub use tray::TrayPosition;
pub use tray::TrayService;
pub use update::AppVersion;
pub use update::AppVersionError;
pub use update::DisabledUpdates;
pub use update::HttpUpdateTransport;
pub use update::SignedHttpUpdater;
pub use update::StagedUpdate;
pub use update::SystemUpdateInstaller;
pub use update::UpdateArtifact;
pub use update::UpdateConfig;
pub use update::UpdateFuture;
pub use update::UpdateHandle;
pub use update::UpdateInstaller;
pub use update::UpdatePublicKey;
pub use update::UpdateRelease;
pub use update::UpdateService;
pub use update::UpdateTransport;

/// Cloneable typed collection of operating-system services available to an application.
#[derive(Clone)]
pub struct Services {
    application_badge: ApplicationBadgeHandle,
    file_dialogs: FileDialogHandle,
    file_icons: FileIconHandle,
    message_dialogs: MessageDialogHandle,
    opener: OpenerHandle,
    notifications: NotificationHandle,
    menus: MenuHandle,
    tray: TrayHandle,
    global_shortcuts: GlobalShortcutHandle,
    jump_lists: JumpListHandle,
    login_items: LoginItemHandle,
    protocol_clients: ProtocolClientHandle,
    recent_documents: RecentDocumentHandle,
    resources: ResourceHandle,
    processes: ProcessHandle,
    updates: UpdateHandle,
    desktop_file_name: Option<DesktopFileName>,
}

impl Services {
    pub(super) fn system() -> Self {
        Self {
            application_badge: ApplicationBadgeHandle::new(SystemApplicationBadge),
            file_dialogs: FileDialogHandle::new(SystemFileDialogs),
            file_icons: FileIconHandle::new(SystemFileIcons),
            message_dialogs: MessageDialogHandle::new(SystemMessageDialogs),
            opener: OpenerHandle::new(SystemOpener),
            notifications: NotificationHandle::new(SystemNotifications),
            menus: MenuHandle::new(SystemMenu::default()),
            tray: TrayHandle::new(SystemTray::default()),
            global_shortcuts: GlobalShortcutHandle::new(SystemGlobalShortcuts::default()),
            jump_lists: JumpListHandle::new(SystemJumpLists),
            login_items: LoginItemHandle::new(SystemLoginItems),
            protocol_clients: ProtocolClientHandle::new(SystemProtocolClients),
            recent_documents: RecentDocumentHandle::new(SystemRecentDocuments),
            resources: ResourceHandle::new(SystemResourceLocator::default()),
            processes: ProcessHandle::new(SystemProcesses::default()),
            updates: UpdateHandle::new(DisabledUpdates),
            desktop_file_name: None,
        }
    }

    /// Returns the main-thread application launcher badge capability.
    pub fn application_badge(&self) -> ApplicationBadgeHandle {
        self.application_badge.clone()
    }

    /// Returns the configured Linux desktop-entry identity, if any.
    pub fn desktop_file_name(&self) -> Option<DesktopFileName> {
        self.desktop_file_name.clone()
    }

    /// Returns the injected file-dialog capability.
    pub fn file_dialogs(&self) -> FileDialogHandle {
        self.file_dialogs.clone()
    }

    /// Returns the injected asynchronous operating-system file-icon capability.
    pub fn file_icons(&self) -> FileIconHandle {
        self.file_icons.clone()
    }

    /// Returns the injected asynchronous message-dialog capability.
    pub fn message_dialogs(&self) -> MessageDialogHandle {
        self.message_dialogs.clone()
    }

    /// Returns the injected system opener capability.
    pub fn opener(&self) -> OpenerHandle {
        self.opener.clone()
    }

    /// Returns the injected desktop-notification capability.
    pub fn notifications(&self) -> NotificationHandle {
        self.notifications.clone()
    }

    /// Returns the main-thread application-menu capability.
    pub fn menus(&self) -> MenuHandle {
        self.menus.clone()
    }

    /// Returns the main-thread system-tray capability.
    pub fn tray(&self) -> TrayHandle {
        self.tray.clone()
    }

    /// Returns the main-thread global-shortcut capability.
    pub fn global_shortcuts(&self) -> GlobalShortcutHandle {
        self.global_shortcuts.clone()
    }

    /// Returns the main-thread Windows Jump List capability.
    pub fn jump_lists(&self) -> JumpListHandle {
        self.jump_lists.clone()
    }

    /// Returns the main-thread application login-item capability.
    pub fn login_items(&self) -> LoginItemHandle {
        self.login_items.clone()
    }

    /// Returns the main-thread default protocol-client capability.
    pub fn protocol_clients(&self) -> ProtocolClientHandle {
        self.protocol_clients.clone()
    }

    /// Returns the main-thread recent-document capability.
    pub fn recent_documents(&self) -> RecentDocumentHandle {
        self.recent_documents.clone()
    }

    /// Returns the application resource-location capability.
    pub fn resources(&self) -> ResourceHandle {
        self.resources.clone()
    }

    /// Returns the shell-free managed child-process capability.
    pub fn processes(&self) -> ProcessHandle {
        self.processes.clone()
    }

    /// Returns the application update capability.
    pub fn updates(&self) -> UpdateHandle {
        self.updates.clone()
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn menu_accelerator_table(&self) -> Option<std::rc::Rc<std::cell::Cell<isize>>> {
        self.menus.accelerator_table()
    }

    pub(super) fn replace_file_dialogs(&mut self, service: impl FileDialogService + 'static) {
        self.file_dialogs = FileDialogHandle::new(service);
    }

    pub(super) fn replace_file_icons(&mut self, service: impl FileIconService + 'static) {
        self.file_icons = FileIconHandle::new(service);
    }

    pub(super) fn replace_application_badge(
        &mut self,
        service: impl ApplicationBadgeService + 'static,
    ) {
        self.application_badge = ApplicationBadgeHandle::new(service);
        self.application_badge
            .set_desktop_file_name(self.desktop_file_name.clone());
    }

    pub(super) fn replace_message_dialogs(&mut self, service: impl MessageDialogService + 'static) {
        self.message_dialogs = MessageDialogHandle::new(service);
    }

    pub(super) fn replace_opener(&mut self, service: impl OpenerService + 'static) {
        self.opener = OpenerHandle::new(service);
    }

    pub(super) fn replace_notifications(&mut self, service: impl NotificationService + 'static) {
        self.notifications = NotificationHandle::new(service);
    }

    pub(super) fn replace_menus(&mut self, service: impl MenuService + 'static) {
        self.menus = MenuHandle::new(service);
    }

    pub(super) fn replace_tray(&mut self, service: impl TrayService + 'static) {
        self.tray = TrayHandle::new(service);
    }

    pub(super) fn replace_global_shortcuts(
        &mut self,
        service: impl GlobalShortcutService + 'static,
    ) {
        self.global_shortcuts = GlobalShortcutHandle::new(service);
    }

    pub(super) fn replace_jump_lists(&mut self, service: impl JumpListService + 'static) {
        self.jump_lists = JumpListHandle::new(service);
    }

    pub(super) fn replace_login_items(&mut self, service: impl LoginItemService + 'static) {
        self.login_items = LoginItemHandle::new(service);
    }

    pub(super) fn replace_protocol_clients(
        &mut self,
        service: impl ProtocolClientService + 'static,
    ) {
        self.protocol_clients = ProtocolClientHandle::new(service);
        self.protocol_clients
            .set_desktop_file_name(self.desktop_file_name.clone());
    }

    pub(super) fn set_desktop_file_name(&mut self, name: DesktopFileName) {
        self.application_badge
            .set_desktop_file_name(Some(name.clone()));
        self.protocol_clients
            .set_desktop_file_name(Some(name.clone()));
        self.desktop_file_name = Some(name);
    }

    pub(super) fn replace_recent_documents(
        &mut self,
        service: impl RecentDocumentService + 'static,
    ) {
        self.recent_documents = RecentDocumentHandle::new(service);
    }

    pub(super) fn replace_resources(&mut self, service: impl ResourceService + 'static) {
        self.resources = ResourceHandle::new(service);
    }

    pub(super) fn replace_processes(&mut self, service: impl ProcessService + 'static) {
        self.processes = ProcessHandle::new(service);
    }

    pub(super) fn replace_updates(&mut self, service: impl UpdateService + 'static) {
        self.updates = UpdateHandle::new(service);
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn translate_menu_accelerator(
    table: &std::cell::Cell<isize>,
    message: *const std::ffi::c_void,
) -> bool {
    menu::translate_accelerator(table, message)
}

#[cfg(test)]
#[path = "services/services_tests.rs"]
mod tests;
