use super::appearance::ColorLevel;
use super::appearance::EnvironmentValues;
use super::appearance::detect_color_level;
use std::sync::OnceLock;

/// Known host-terminal families used for terminal-specific compatibility decisions.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalKind {
    /// Apple Terminal.app.
    AppleTerminal,
    /// Ghostty.
    Ghostty,
    /// iTerm2.
    Iterm,
    /// Warp.
    Warp,
    /// Visual Studio Code integrated terminal.
    VsCode,
    /// WezTerm.
    WezTerm,
    /// kitty.
    Kitty,
    /// Alacritty.
    Alacritty,
    /// KDE Konsole.
    Konsole,
    /// GNOME Terminal.
    Gnome,
    /// A terminal exposing VTE metadata without a more specific identity.
    Vte,
    /// Windows Terminal.
    WindowsTerminal,
    /// `TERM=dumb`.
    Dumb,
    /// No known terminal signal was found.
    Unknown,
}

/// Multiplexer enclosing the current terminal session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TerminalMultiplexer {
    /// tmux and an optional version from `TERM_PROGRAM_VERSION`.
    Tmux { version: Option<String> },
    /// Zellij and an optional version from `ZELLIJ_VERSION`.
    Zellij { version: Option<String> },
}

/// Process-wide snapshot of the terminal hosting Ash.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostTerminal {
    /// Stable terminal category.
    pub kind: TerminalKind,
    /// Raw `TERM_PROGRAM` when present.
    pub program: Option<String>,
    /// Program-specific version when present.
    pub version: Option<String>,
    /// Raw non-empty `TERM` capability string.
    pub term: Option<String>,
    /// Active multiplexer independently detected from terminal identity.
    pub multiplexer: Option<TerminalMultiplexer>,
    /// Color fidelity inferred from standard terminal environment variables.
    pub color_level: ColorLevel,
}

impl HostTerminal {
    /// Returns whether the host explicitly declares a non-interactive dumb terminal.
    pub const fn is_dumb(&self) -> bool {
        matches!(self.kind, TerminalKind::Dumb)
    }
}

static HOST_TERMINAL: OnceLock<HostTerminal> = OnceLock::new();

/// Detects and caches the terminal environment for the lifetime of the process.
pub fn detect_host_terminal() -> HostTerminal {
    HOST_TERMINAL
        .get_or_init(|| detect(&ProcessEnvironment))
        .clone()
}

fn detect(environment: &impl EnvironmentValues) -> HostTerminal {
    let term = environment.non_empty("TERM");
    let program = environment.non_empty("TERM_PROGRAM");
    let multiplexer = detect_multiplexer(environment);
    let (kind, version) = if let Some(program) = program.as_deref()
        && !is_multiplexer_program(program)
    {
        (
            kind_from_program(program),
            environment.non_empty("TERM_PROGRAM_VERSION"),
        )
    } else {
        detect_from_distinctive_variables(environment, term.as_deref())
    };
    let kind = if term.as_deref() == Some("dumb") {
        TerminalKind::Dumb
    } else {
        kind
    };
    HostTerminal {
        kind,
        program,
        version,
        term,
        multiplexer,
        color_level: detect_color_level(environment),
    }
}

fn detect_multiplexer(environment: &impl EnvironmentValues) -> Option<TerminalMultiplexer> {
    let program = environment.non_empty("TERM_PROGRAM");
    let is_program = |name: &str| {
        program
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case(name))
    };
    if is_program("tmux")
        || environment.non_empty("TMUX").is_some()
        || environment.non_empty("TMUX_PANE").is_some()
    {
        let version = is_program("tmux")
            .then(|| environment.non_empty("TERM_PROGRAM_VERSION"))
            .flatten();
        return Some(TerminalMultiplexer::Tmux { version });
    }
    if is_program("zellij")
        || environment.non_empty("ZELLIJ").is_some()
        || environment.non_empty("ZELLIJ_SESSION_NAME").is_some()
        || environment.non_empty("ZELLIJ_VERSION").is_some()
    {
        return Some(TerminalMultiplexer::Zellij {
            version: if is_program("zellij") {
                environment.non_empty("TERM_PROGRAM_VERSION")
            } else {
                environment.non_empty("ZELLIJ_VERSION")
            },
        });
    }
    None
}

fn detect_from_distinctive_variables(
    environment: &impl EnvironmentValues,
    term: Option<&str>,
) -> (TerminalKind, Option<String>) {
    if environment.non_empty("GHOSTTY_RESOURCES_DIR").is_some() {
        return (TerminalKind::Ghostty, None);
    }
    if let Some(version) = environment.value("WEZTERM_VERSION") {
        return (TerminalKind::WezTerm, non_blank(version));
    }
    if environment.has("ITERM_SESSION_ID")
        || environment.has("ITERM_PROFILE")
        || environment.has("ITERM_PROFILE_NAME")
    {
        return (TerminalKind::Iterm, None);
    }
    if environment.has("TERM_SESSION_ID") {
        return (TerminalKind::AppleTerminal, None);
    }
    if environment.has("KITTY_WINDOW_ID") || term.is_some_and(|term| term.contains("kitty")) {
        return (TerminalKind::Kitty, None);
    }
    if environment.has("ALACRITTY_SOCKET") || term == Some("alacritty") {
        return (TerminalKind::Alacritty, None);
    }
    if let Some(version) = environment.value("KONSOLE_VERSION") {
        return (TerminalKind::Konsole, non_blank(version));
    }
    if environment.has("GNOME_TERMINAL_SCREEN") {
        return (TerminalKind::Gnome, None);
    }
    if let Some(version) = environment.value("VTE_VERSION") {
        return (TerminalKind::Vte, non_blank(version));
    }
    if environment.has("WT_SESSION") {
        return (TerminalKind::WindowsTerminal, None);
    }
    if term == Some("xterm-ghostty") {
        return (TerminalKind::Ghostty, None);
    }
    (TerminalKind::Unknown, None)
}

fn is_multiplexer_program(program: &str) -> bool {
    program.eq_ignore_ascii_case("tmux") || program.eq_ignore_ascii_case("zellij")
}

fn kind_from_program(program: &str) -> TerminalKind {
    let key: String = program
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    match key.as_str() {
        "appleterminal" => TerminalKind::AppleTerminal,
        "ghostty" => TerminalKind::Ghostty,
        "iterm" | "iterm2" | "itermapp" => TerminalKind::Iterm,
        "warp" | "warpterminal" => TerminalKind::Warp,
        "vscode" => TerminalKind::VsCode,
        "wezterm" => TerminalKind::WezTerm,
        "kitty" => TerminalKind::Kitty,
        "alacritty" => TerminalKind::Alacritty,
        "konsole" => TerminalKind::Konsole,
        "gnometerminal" => TerminalKind::Gnome,
        "vte" => TerminalKind::Vte,
        "windowsterminal" => TerminalKind::WindowsTerminal,
        _ => TerminalKind::Unknown,
    }
}

fn non_blank(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

/// Adds normalized non-empty reads to the underlying environment boundary.
trait NonEmptyEnvironment: EnvironmentValues {
    fn non_empty(&self, name: &str) -> Option<String> {
        self.value(name).and_then(non_blank)
    }
}

impl<T: EnvironmentValues> NonEmptyEnvironment for T {}

struct ProcessEnvironment;

impl EnvironmentValues for ProcessEnvironment {
    fn value(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;
