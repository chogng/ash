//! Application events delivered through the desktop application loop.

use crate::remote_connection_process::RemoteWindowLaunchEvent;
use crate::remote_tunnel_process::RemoteTunnelEvent;
use crate::session_host::SessionRuntimeEvent;
use crate::terminal_session::{TerminalSessionEventEnvelope, TerminalSessionReady};
use ash_editor_host::FileEditorLanguageEvent;
use ash_terminal_runtime::TerminalRuntimeEvent;

pub(crate) enum WorkbenchEvent {
    InputHistoryReady,
    InputClassified(ash_session::ComposerClassificationResult),
    Memory(crate::memory::MemoryCompletion),
    Memories(crate::memories::Completion),
    Session(SessionRuntimeEvent),
    Terminal(TerminalSessionEventEnvelope),
    TerminalReady(TerminalSessionReady),
    EditorLanguage(FileEditorLanguageEvent),
    RemoteWindowLaunch(RemoteWindowLaunchEvent),
    RemoteTunnel(RemoteTunnelEvent),
    ScmOperationFinished(Result<(), String>),
}

impl From<SessionRuntimeEvent> for WorkbenchEvent {
    fn from(event: SessionRuntimeEvent) -> Self {
        Self::Session(event)
    }
}

impl From<TerminalSessionEventEnvelope> for WorkbenchEvent {
    fn from(event: TerminalSessionEventEnvelope) -> Self {
        Self::Terminal(event)
    }
}

impl From<TerminalSessionReady> for WorkbenchEvent {
    fn from(event: TerminalSessionReady) -> Self {
        Self::TerminalReady(event)
    }
}

impl From<TerminalRuntimeEvent> for WorkbenchEvent {
    fn from(event: TerminalRuntimeEvent) -> Self {
        match event {
            TerminalRuntimeEvent::Session(event) => Self::Terminal(event),
            TerminalRuntimeEvent::Ready(event) => Self::TerminalReady(event),
        }
    }
}
