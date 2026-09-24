use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::thread;

use ashpd::desktop::CreateSessionOptions;
use ashpd::desktop::global_shortcuts::BindShortcutsOptions;
use ashpd::desktop::global_shortcuts::GlobalShortcuts;
use ashpd::desktop::global_shortcuts::NewShortcut;
use futures::StreamExt;
use tokio::sync::mpsc as tokio_mpsc;

use super::GLOBAL_SHORTCUT_SERVICE;
use super::GlobalShortcut;
use super::GlobalShortcutEvent;
use super::GlobalShortcutEventHandler;
use super::GlobalShortcutId;
use super::GlobalShortcutState;
use crate::services::SystemServiceError;

pub(super) struct PortalGlobalShortcuts {
    commands: tokio_mpsc::UnboundedSender<Command>,
    thread: Option<thread::JoinHandle<()>>,
}

impl PortalGlobalShortcuts {
    pub(super) fn new(
        handler: Arc<Mutex<Option<GlobalShortcutEventHandler>>>,
    ) -> Result<Self, SystemServiceError> {
        let (commands, receiver) = tokio_mpsc::unbounded_channel();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("zui-wayland-shortcuts".to_owned())
            .spawn(move || run(receiver, handler, ready_sender))
            .map_err(|source| SystemServiceError::backend(GLOBAL_SHORTCUT_SERVICE, source))?;
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
                Err(SystemServiceError::backend(GLOBAL_SHORTCUT_SERVICE, source))
            }
        }
    }

    pub(super) fn replace(&self, shortcuts: Vec<GlobalShortcut>) -> Result<(), SystemServiceError> {
        let (reply, response) = mpsc::sync_channel(1);
        self.commands
            .send(Command::Replace(shortcuts, reply))
            .map_err(|source| SystemServiceError::backend(GLOBAL_SHORTCUT_SERVICE, source))?;
        response
            .recv()
            .map_err(|source| SystemServiceError::backend(GLOBAL_SHORTCUT_SERVICE, source))?
            .map_err(backend_error)
    }
}

impl Drop for PortalGlobalShortcuts {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

enum Command {
    Replace(Vec<GlobalShortcut>, mpsc::SyncSender<Result<(), String>>),
    Shutdown,
}

fn run(
    receiver: tokio_mpsc::UnboundedReceiver<Command>,
    handler: Arc<Mutex<Option<GlobalShortcutEventHandler>>>,
    ready: mpsc::SyncSender<Result<(), String>>,
) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(source) => {
            let _ = ready.send(Err(format!("could not create portal runtime: {source}")));
            return;
        }
    };
    if let Err(message) = runtime.block_on(run_async(receiver, handler, &ready)) {
        let _ = ready.send(Err(message));
    }
}

async fn run_async(
    mut receiver: tokio_mpsc::UnboundedReceiver<Command>,
    handler: Arc<Mutex<Option<GlobalShortcutEventHandler>>>,
    ready: &mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let portal = GlobalShortcuts::new()
        .await
        .map_err(|source| format!("global-shortcuts portal is unavailable: {source}"))?;
    if portal.version() == 0 {
        return Err("global-shortcuts portal reported an invalid version".to_owned());
    }
    let mut activated = Box::pin(
        portal
            .receive_activated()
            .await
            .map_err(|source| format!("could not subscribe to shortcut activation: {source}"))?,
    );
    let mut deactivated = Box::pin(
        portal
            .receive_deactivated()
            .await
            .map_err(|source| format!("could not subscribe to shortcut deactivation: {source}"))?,
    );
    ready
        .send(Ok(()))
        .map_err(|_| "shortcut runtime owner disconnected during startup".to_owned())?;
    let mut session = None;
    let mut registered = HashSet::new();

    loop {
        tokio::select! {
            command = receiver.recv() => match command {
                Some(Command::Replace(shortcuts, reply)) => {
                    let result = replace_session(&portal, &mut session, &mut registered, shortcuts).await;
                    let _ = reply.send(result);
                }
                Some(Command::Shutdown) | None => break,
            },
            event = activated.next() => {
                if let Some(event) = event
                    && registered.contains(event.shortcut_id())
                {
                    dispatch(&handler, event.shortcut_id(), GlobalShortcutState::Pressed);
                }
            },
            event = deactivated.next() => {
                if let Some(event) = event
                    && registered.contains(event.shortcut_id())
                {
                    dispatch(&handler, event.shortcut_id(), GlobalShortcutState::Released);
                }
            },
        }
    }
    if let Some(session) = session {
        let _ = session.close().await;
    }
    Ok(())
}

async fn replace_session(
    portal: &GlobalShortcuts,
    session: &mut Option<ashpd::desktop::Session<GlobalShortcuts>>,
    registered: &mut HashSet<String>,
    shortcuts: Vec<GlobalShortcut>,
) -> Result<(), String> {
    if shortcuts.is_empty() {
        if let Some(old) = session.take() {
            old.close()
                .await
                .map_err(|source| format!("could not close shortcut portal session: {source}"))?;
        }
        registered.clear();
        return Ok(());
    }

    let requested = shortcuts
        .iter()
        .map(|shortcut| {
            Ok(
                NewShortcut::new(shortcut.id.as_str(), shortcut.id.as_str()).preferred_trigger(
                    Some(portal_trigger(shortcut.accelerator.as_str())?.as_str()),
                ),
            )
        })
        .collect::<Result<Vec<_>, String>>()?;
    let next_session = portal
        .create_session(CreateSessionOptions::default())
        .await
        .map_err(|source| format!("could not create shortcut portal session: {source}"))?;
    let request = portal
        .bind_shortcuts(
            &next_session,
            &requested,
            None,
            BindShortcutsOptions::default(),
        )
        .await
        .map_err(|source| format!("could not request shortcut bindings: {source}"))?;
    let response = request
        .response()
        .map_err(|source| format!("shortcut binding was rejected: {source}"))?;
    let accepted = response
        .shortcuts()
        .iter()
        .map(|shortcut| shortcut.id().to_owned())
        .collect::<HashSet<_>>();
    let expected = shortcuts
        .iter()
        .map(|shortcut| shortcut.id.as_str().to_owned())
        .collect::<HashSet<_>>();
    if accepted != expected {
        let _ = next_session.close().await;
        return Err("the desktop portal did not bind every requested shortcut".to_owned());
    }
    if let Some(old) = session.replace(next_session) {
        let _ = old.close().await;
    }
    *registered = accepted;
    Ok(())
}

fn dispatch(
    handler: &Arc<Mutex<Option<GlobalShortcutEventHandler>>>,
    id: &str,
    state: GlobalShortcutState,
) {
    let handler = handler
        .lock()
        .expect("global shortcut handler lock")
        .clone();
    if let (Some(handler), Ok(id)) = (handler, GlobalShortcutId::new(id)) {
        handler(GlobalShortcutEvent { id, state });
    }
}

pub(super) fn is_wayland_session() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .is_ok_and(|session| session.eq_ignore_ascii_case("wayland"))
}

fn portal_trigger(accelerator: &str) -> Result<String, String> {
    let mut control = false;
    let mut shift = false;
    let mut alt = false;
    let mut super_key = false;
    let mut key = None;
    for segment in accelerator.split('+') {
        match segment.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "control" | "ctrl" => control = true,
            "shift" => shift = true,
            "alt" | "option" => alt = true,
            "command" | "cmd" | "meta" | "super" => super_key = true,
            _ if key.is_none() => key = Some(portal_key(segment)),
            _ => {
                return Err(format!(
                    "accelerator `{accelerator}` contains multiple keys"
                ));
            }
        }
    }
    let key = key.ok_or_else(|| format!("accelerator `{accelerator}` has no key"))?;
    let mut trigger = String::new();
    if control {
        trigger.push_str("<Control>");
    }
    if shift {
        trigger.push_str("<Shift>");
    }
    if alt {
        trigger.push_str("<Alt>");
    }
    if super_key {
        trigger.push_str("<Super>");
    }
    trigger.push_str(&key);
    Ok(trigger)
}

fn portal_key(key: &str) -> String {
    if let Some(character) = key.strip_prefix("Key")
        && character.chars().count() == 1
    {
        return character.to_ascii_lowercase();
    }
    if let Some(digit) = key.strip_prefix("Digit")
        && digit.chars().count() == 1
    {
        return digit.to_owned();
    }
    key.to_owned()
}

fn backend_error(message: String) -> SystemServiceError {
    SystemServiceError::backend(GLOBAL_SHORTCUT_SERVICE, std::io::Error::other(message))
}

#[cfg(test)]
mod tests {
    use super::portal_trigger;

    #[test]
    fn portable_accelerators_convert_to_xdg_shortcut_triggers() {
        assert_eq!(
            portal_trigger("CommandOrControl+Shift+KeyD").unwrap(),
            "<Control><Shift>d"
        );
        assert_eq!(portal_trigger("Alt+Digit1").unwrap(), "<Alt>1");
    }
}
