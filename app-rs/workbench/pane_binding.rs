use crate::PaneInput;
use crate::PaneInputKind;
use crate::terminal_session::TerminalSessionKey;

/// Feature state currently attached to a Workbench-owned pane.
///
/// This mapping is deliberately application-local. The workbench description stays free of PTY and
/// terminal-session handles while app resolves a Session into its runtime key here.
enum PaneRuntime {
    Unbound,
    Terminal(TerminalSessionKey),
    Changes(Box<ash_scm::ScmState>),
}

/// Binding between one workbench group and its feature runtime, if one has been mounted.
///
/// Workbench owns the logical [`PaneInput`]; this binding owns that mounted view’s state or runtime
/// handle. Domain capabilities remain unaware of the split topology.
pub struct PaneBinding {
    runtime: PaneRuntime,
}

impl PaneBinding {
    pub const fn new() -> Self {
        Self {
            runtime: PaneRuntime::Unbound,
        }
    }

    pub const fn terminal(key: TerminalSessionKey) -> Self {
        Self {
            runtime: PaneRuntime::Terminal(key),
        }
    }

    pub fn changes(state: ash_scm::ScmState) -> Self {
        Self {
            runtime: PaneRuntime::Changes(Box::new(state)),
        }
    }

    pub fn scm(&self) -> Option<&ash_scm::ScmState> {
        match &self.runtime {
            PaneRuntime::Changes(state) => Some(state),
            PaneRuntime::Unbound | PaneRuntime::Terminal(_) => None,
        }
    }
    pub fn scm_mut(&mut self) -> Option<&mut ash_scm::ScmState> {
        match &mut self.runtime {
            PaneRuntime::Changes(state) => Some(state),
            PaneRuntime::Unbound | PaneRuntime::Terminal(_) => None,
        }
    }

    pub fn terminal_key(&self) -> Option<TerminalSessionKey> {
        match &self.runtime {
            PaneRuntime::Terminal(key) => Some(*key),
            PaneRuntime::Unbound | PaneRuntime::Changes(_) => None,
        }
    }

    /// Attaches a Terminal runtime only when this binding describes the matching Session.
    pub fn bind_terminal(
        &mut self,
        input: &PaneInput,
        session_id: &ash_protocol::SessionId,
        key: TerminalSessionKey,
    ) -> bool {
        if input.kind() != PaneInputKind::Terminal
            || input.terminal_session_id() != Some(session_id)
        {
            return false;
        }
        self.runtime = PaneRuntime::Terminal(key);
        true
    }
}

#[cfg(test)]
#[path = "pane_binding_tests.rs"]
mod tests;
