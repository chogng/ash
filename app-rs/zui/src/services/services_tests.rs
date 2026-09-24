use std::cell::RefCell;
use std::error::Error;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::Mutex;

use futures::executor::block_on;

use super::ExternalUrl;
use super::FileDialogFuture;
use super::FileDialogOptions;
use super::FileDialogService;
use super::GlobalShortcut;
use super::GlobalShortcutEventHandler;
use super::GlobalShortcutId;
use super::GlobalShortcutService;
use super::MenuEventHandler;
use super::MenuItemId;
use super::MenuModel;
use super::MenuService;
use super::NotificationFuture;
use super::NotificationId;
use super::NotificationRequest;
use super::NotificationService;
use super::OpenTarget;
use super::OpenerFuture;
use super::OpenerService;
use super::Services;
use super::ShortcutAccelerator;
use super::SystemServiceError;
use super::SystemServiceErrorCode;
use super::TrayEventHandler;
use super::TrayIconImage;
use super::TrayId;
use super::TrayOptions;
use super::TrayService;

#[derive(Clone)]
struct RecordingFileDialogs {
    opened: Arc<Mutex<Vec<FileDialogOptions>>>,
}

fn require_send<T: Send>() {}

#[test]
fn blocking_system_handle_results_can_cross_threads() {
    require_send::<NotificationFuture>();
    require_send::<OpenerFuture>();
}

impl FileDialogService for RecordingFileDialogs {
    fn open_file(&self, options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        let opened = self.opened.clone();
        Box::pin(async move {
            opened.lock().unwrap().push(options);
            Ok(Some(PathBuf::from("selected.txt")))
        })
    }

    fn open_files(&self, _options: FileDialogOptions) -> FileDialogFuture<Vec<PathBuf>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn select_folder(&self, _options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        Box::pin(async { Ok(None) })
    }

    fn save_file(&self, _options: FileDialogOptions) -> FileDialogFuture<Option<PathBuf>> {
        Box::pin(async { Ok(None) })
    }
}

#[derive(Clone)]
struct RecordingOpener {
    targets: Arc<Mutex<Vec<OpenTarget>>>,
}

impl OpenerService for RecordingOpener {
    fn open(&self, target: OpenTarget) -> Result<(), SystemServiceError> {
        self.targets.lock().unwrap().push(target);
        Ok(())
    }
}

#[derive(Clone)]
struct RecordingNotifications {
    requests: Arc<Mutex<Vec<NotificationRequest>>>,
}

impl NotificationService for RecordingNotifications {
    fn show(&self, request: NotificationRequest) -> Result<NotificationId, SystemServiceError> {
        self.requests.lock().unwrap().push(request);
        Ok(NotificationId::from_raw(41))
    }
}

struct RecordingMenu {
    models: Rc<RefCell<Vec<MenuModel>>>,
    handler: Rc<RefCell<Option<MenuEventHandler>>>,
}

struct RecordingTray {
    created: Rc<RefCell<Vec<TrayOptions>>>,
    handler: Rc<RefCell<Option<TrayEventHandler>>>,
}

impl TrayService for RecordingTray {
    fn create(&mut self, options: TrayOptions) -> Result<(), SystemServiceError> {
        self.created.borrow_mut().push(options);
        Ok(())
    }

    fn remove(&mut self, _id: &TrayId) {}

    fn set_visible(&mut self, _id: &TrayId, _visible: bool) -> Result<(), SystemServiceError> {
        Ok(())
    }

    fn set_menu(&mut self, _id: &TrayId, _menu: MenuModel) -> Result<(), SystemServiceError> {
        Ok(())
    }

    fn set_event_handler(&mut self, handler: Option<TrayEventHandler>) {
        *self.handler.borrow_mut() = handler;
    }
}

struct RecordingGlobalShortcuts {
    registered: Rc<RefCell<Vec<GlobalShortcut>>>,
    handler: Rc<RefCell<Option<GlobalShortcutEventHandler>>>,
}

impl GlobalShortcutService for RecordingGlobalShortcuts {
    fn register(&mut self, shortcut: GlobalShortcut) -> Result<(), SystemServiceError> {
        self.registered.borrow_mut().push(shortcut);
        Ok(())
    }

    fn unregister(&mut self, _id: &GlobalShortcutId) -> Result<(), SystemServiceError> {
        Ok(())
    }

    fn unregister_all(&mut self) -> Result<(), SystemServiceError> {
        self.registered.borrow_mut().clear();
        Ok(())
    }

    fn set_event_handler(&mut self, handler: Option<GlobalShortcutEventHandler>) {
        *self.handler.borrow_mut() = handler;
    }
}

impl MenuService for RecordingMenu {
    fn set_application_menu(&mut self, model: MenuModel) -> Result<(), SystemServiceError> {
        self.models.borrow_mut().push(model);
        Ok(())
    }

    fn set_event_handler(&mut self, handler: Option<MenuEventHandler>) {
        *self.handler.borrow_mut() = handler;
    }
}

#[test]
fn injected_services_are_used_without_calling_operating_system_backends() {
    let opened = Arc::new(Mutex::new(Vec::new()));
    let targets = Arc::new(Mutex::new(Vec::new()));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let models = Rc::new(RefCell::new(Vec::new()));
    let handler = Rc::new(RefCell::new(None));
    let created_tray = Rc::new(RefCell::new(Vec::new()));
    let tray_handler = Rc::new(RefCell::new(None));
    let registered_shortcuts = Rc::new(RefCell::new(Vec::new()));
    let shortcut_handler = Rc::new(RefCell::new(None));
    let mut services = Services::system();
    services.replace_file_dialogs(RecordingFileDialogs {
        opened: opened.clone(),
    });
    services.replace_opener(RecordingOpener {
        targets: targets.clone(),
    });
    services.replace_notifications(RecordingNotifications {
        requests: requests.clone(),
    });
    services.replace_menus(RecordingMenu {
        models: models.clone(),
        handler,
    });
    services.replace_tray(RecordingTray {
        created: created_tray.clone(),
        handler: tray_handler,
    });
    services.replace_global_shortcuts(RecordingGlobalShortcuts {
        registered: registered_shortcuts.clone(),
        handler: shortcut_handler,
    });

    let options = FileDialogOptions::new().with_title("Open workspace");
    assert_eq!(
        block_on(services.file_dialogs().open_file(options.clone())).unwrap(),
        Some(PathBuf::from("selected.txt"))
    );
    let target = OpenTarget::Url(ExternalUrl::parse("https://example.com/docs").unwrap());
    block_on(services.opener().open(target.clone())).unwrap();
    let request = NotificationRequest::new("Finished").with_body("The task completed");
    assert_eq!(
        block_on(services.notifications().show(request.clone()))
            .unwrap()
            .into_raw(),
        41
    );
    let model = MenuModel::new(Vec::new());
    services
        .menus()
        .set_application_menu(model.clone())
        .unwrap();
    let tray = TrayOptions::new(
        TrayId::new("demo.tray").unwrap(),
        TrayIconImage::from_rgba(vec![255, 255, 255, 255], 1, 1).unwrap(),
    )
    .with_tooltip("Demo");
    services.tray().create(tray.clone()).unwrap();
    let shortcut = GlobalShortcut::new(
        GlobalShortcutId::new("demo.toggle").unwrap(),
        ShortcutAccelerator::parse("CommandOrControl+Shift+KeyD").unwrap(),
    );
    services
        .global_shortcuts()
        .register(shortcut.clone())
        .unwrap();

    assert_eq!(*opened.lock().unwrap(), vec![options]);
    assert_eq!(*targets.lock().unwrap(), vec![target]);
    assert_eq!(*requests.lock().unwrap(), vec![request]);
    assert_eq!(*models.borrow(), vec![model]);
    assert_eq!(*created_tray.borrow(), vec![tray]);
    assert_eq!(*registered_shortcuts.borrow(), vec![shortcut]);
}

#[test]
fn service_value_types_validate_stable_external_identities() {
    assert!(ExternalUrl::parse("not a url").is_err());
    assert_eq!(
        ExternalUrl::parse("https://example.com").unwrap().as_str(),
        "https://example.com"
    );
    assert!(MenuItemId::new("  ").is_err());
    assert_eq!(MenuItemId::new("file.open").unwrap().as_str(), "file.open");
    let unsupported = SystemServiceError::unsupported("menu");
    assert!(unsupported.is_unsupported());
    assert_eq!(unsupported.service(), "menu");
    assert_eq!(unsupported.code(), SystemServiceErrorCode::Unsupported);
    assert!(unsupported.source().is_none());
    let backend = SystemServiceError::backend("menu", std::io::Error::other("offline"));
    assert!(!backend.is_unsupported());
    assert_eq!(backend.service(), "menu");
    assert_eq!(backend.code(), SystemServiceErrorCode::Backend);
    assert_eq!(
        backend.source().map(ToString::to_string).as_deref(),
        Some("offline")
    );
    assert!(TrayId::new("").is_err());
    assert!(TrayIconImage::from_rgba(vec![0; 3], 1, 1).is_err());
    assert!(GlobalShortcutId::new(" ").is_err());
    assert!(ShortcutAccelerator::parse("Shift+KeyD+Alt").is_err());
}
