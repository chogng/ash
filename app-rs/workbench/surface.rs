/// Application surface currently shown in the main area.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MainSurfaceKind {
    #[default]
    Agent,
    Editor,
    Terminal,
}

/// Main-area selection with a reversible terminal overlay transition.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MainSurface {
    active: MainSurfaceKind,
    terminal_return: MainSurfaceKind,
}

impl Default for MainSurface {
    fn default() -> Self {
        Self {
            active: MainSurfaceKind::Agent,
            terminal_return: MainSurfaceKind::Agent,
        }
    }
}

impl MainSurface {
    pub const fn active(self) -> MainSurfaceKind {
        self.active
    }

    pub const fn is_editor(self) -> bool {
        matches!(self.active, MainSurfaceKind::Editor)
    }

    pub const fn is_terminal(self) -> bool {
        matches!(self.active, MainSurfaceKind::Terminal)
    }

    pub fn show_agent(&mut self) {
        self.active = MainSurfaceKind::Agent;
        self.terminal_return = MainSurfaceKind::Agent;
    }

    pub fn show_editor(&mut self) {
        self.active = MainSurfaceKind::Editor;
        self.terminal_return = MainSurfaceKind::Editor;
    }

    pub fn toggle_terminal(&mut self) {
        if self.is_terminal() {
            self.active = self.terminal_return;
        } else {
            self.terminal_return = self.active;
            self.active = MainSurfaceKind::Terminal;
        }
    }
}

#[cfg(test)]
#[path = "surface_tests.rs"]
mod tests;
