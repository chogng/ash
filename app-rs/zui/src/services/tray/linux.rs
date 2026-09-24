use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use super::TRAY_SERVICE;
use super::TrayEvent;
use super::TrayEventHandler;
use super::TrayId;
use super::TrayOptions;
use crate::services::MenuModel;
use crate::services::SystemServiceError;

pub(super) struct LinuxTrayRuntime {
    commands: mpsc::Sender<Command>,
    thread: Option<thread::JoinHandle<()>>,
}

impl LinuxTrayRuntime {
    pub(super) fn new(
        handler: Arc<Mutex<Option<TrayEventHandler>>>,
    ) -> Result<Self, SystemServiceError> {
        let (commands, receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("zui-linux-tray".to_owned())
            .spawn(move || run(receiver, handler, ready_sender))
            .map_err(|source| SystemServiceError::backend(TRAY_SERVICE, source))?;
        match ready_receiver.recv() {
            Ok(Ok(())) => Ok(Self {
                commands,
                thread: Some(thread),
            }),
            Ok(Err(message)) => {
                let _ = thread.join();
                Err(backend_error(message))
            }
            Err(source) => {
                let _ = thread.join();
                Err(SystemServiceError::backend(TRAY_SERVICE, source))
            }
        }
    }

    pub(super) fn create(&self, options: TrayOptions) -> Result<(), SystemServiceError> {
        self.request(|reply| Command::Create(options, reply))
    }

    pub(super) fn remove(&self, id: &TrayId) {
        let _ = self.request(|reply| Command::Remove(id.clone(), reply));
    }

    pub(super) fn set_visible(&self, id: &TrayId, visible: bool) -> Result<(), SystemServiceError> {
        self.request(|reply| Command::SetVisible(id.clone(), visible, reply))
    }

    pub(super) fn set_menu(&self, id: &TrayId, menu: MenuModel) -> Result<(), SystemServiceError> {
        self.request(|reply| Command::SetMenu(id.clone(), menu, reply))
    }

    fn request(
        &self,
        command: impl FnOnce(mpsc::SyncSender<Result<(), String>>) -> Command,
    ) -> Result<(), SystemServiceError> {
        let (reply, response) = mpsc::sync_channel(1);
        self.commands
            .send(command(reply))
            .map_err(|source| SystemServiceError::backend(TRAY_SERVICE, source))?;
        response
            .recv()
            .map_err(|source| SystemServiceError::backend(TRAY_SERVICE, source))?
            .map_err(backend_error)
    }
}

impl Drop for LinuxTrayRuntime {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

enum Command {
    Create(TrayOptions, Reply),
    Remove(TrayId, Reply),
    SetVisible(TrayId, bool, Reply),
    SetMenu(TrayId, MenuModel, Reply),
    Shutdown,
}

type Reply = mpsc::SyncSender<Result<(), String>>;

fn run(
    receiver: mpsc::Receiver<Command>,
    handler: Arc<Mutex<Option<TrayEventHandler>>>,
    ready: mpsc::SyncSender<Result<(), String>>,
) {
    if let Err(source) = gtk::init() {
        let _ = ready.send(Err(format!("could not initialize GTK: {source}")));
        return;
    }
    tray_icon::TrayIconEvent::set_event_handler(Some(move |event| {
        let handler = handler.lock().expect("Linux tray handler lock").clone();
        if let Some(handler) = handler {
            handler(TrayEvent::from_native(event));
        }
    }));
    if ready.send(Ok(())).is_err() {
        return;
    }

    let mut icons = HashMap::new();
    loop {
        pump_gtk_events();
        match receiver.recv_timeout(Duration::from_millis(8)) {
            Ok(Command::Create(options, reply)) => {
                let _ = reply.send(create(&mut icons, options));
            }
            Ok(Command::Remove(id, reply)) => {
                icons.remove(&id);
                let _ = reply.send(Ok(()));
            }
            Ok(Command::SetVisible(id, visible, reply)) => {
                let result = icon(&icons, &id).and_then(|icon| {
                    icon.set_visible(visible)
                        .map_err(|source| source.to_string())
                });
                let _ = reply.send(result);
            }
            Ok(Command::SetMenu(id, menu, reply)) => {
                let result = icon(&icons, &id).and_then(|icon| {
                    let menu = crate::services::menu::build_native_menu(menu)
                        .map_err(|source| source.to_string())?;
                    icon.set_menu(Some(Box::new(menu)));
                    Ok(())
                });
                let _ = reply.send(result);
            }
            Ok(Command::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    icons.clear();
    tray_icon::TrayIconEvent::set_event_handler(None::<fn(tray_icon::TrayIconEvent)>);
    pump_gtk_events();
}

fn create(
    icons: &mut HashMap<TrayId, tray_icon::TrayIcon>,
    options: TrayOptions,
) -> Result<(), String> {
    if icons.contains_key(&options.id) {
        return Err(format!(
            "tray identity `{}` already exists",
            options.id.as_str()
        ));
    }
    let icon =
        tray_icon::Icon::from_rgba(options.icon.rgba, options.icon.width, options.icon.height)
            .map_err(|source| source.to_string())?;
    let mut builder = tray_icon::TrayIconBuilder::new()
        .with_id(options.id.as_str())
        .with_icon(icon)
        .with_icon_as_template(options.icon_is_template);
    if let Some(tooltip) = options.tooltip {
        builder = builder.with_tooltip(tooltip);
    }
    if let Some(title) = options.title {
        builder = builder.with_title(title);
    }
    if let Some(model) = options.menu {
        let menu =
            crate::services::menu::build_native_menu(model).map_err(|source| source.to_string())?;
        builder = builder.with_menu(Box::new(menu));
    }
    let icon = builder.build().map_err(|source| source.to_string())?;
    icons.insert(options.id, icon);
    Ok(())
}

fn icon<'a>(
    icons: &'a HashMap<TrayId, tray_icon::TrayIcon>,
    id: &TrayId,
) -> Result<&'a tray_icon::TrayIcon, String> {
    icons
        .get(id)
        .ok_or_else(|| format!("tray identity `{}` does not exist", id.as_str()))
}

fn pump_gtk_events() {
    while gtk::events_pending() {
        gtk::main_iteration();
    }
}

fn backend_error(message: String) -> SystemServiceError {
    SystemServiceError::backend(TRAY_SERVICE, std::io::Error::other(message))
}
