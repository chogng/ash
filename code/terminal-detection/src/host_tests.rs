use super::HostTerminal;
use super::TerminalKind;
use super::TerminalMultiplexer;
use super::detect;
use crate::ColorLevel;
use crate::appearance::EnvironmentValues;
use std::collections::HashMap;

#[derive(Default)]
struct FakeEnvironment {
    values: HashMap<String, String>,
}

impl FakeEnvironment {
    fn with(mut self, name: &str, value: &str) -> Self {
        self.values.insert(name.into(), value.into());
        self
    }
}

impl EnvironmentValues for FakeEnvironment {
    fn value(&self, name: &str) -> Option<String> {
        self.values.get(name).cloned()
    }
}

#[test]
fn explicit_program_identifies_terminal_and_version() {
    let terminal = detect(
        &FakeEnvironment::default()
            .with("TERM_PROGRAM", "iTerm.app")
            .with("TERM_PROGRAM_VERSION", "3.5")
            .with("COLORTERM", "truecolor"),
    );
    assert_eq!(
        terminal,
        HostTerminal {
            kind: TerminalKind::Iterm,
            program: Some("iTerm.app".into()),
            version: Some("3.5".into()),
            term: None,
            multiplexer: None,
            color_level: ColorLevel::TrueColor,
        }
    );
}

#[test]
fn distinctive_variables_are_used_without_term_program() {
    let terminal = detect(
        &FakeEnvironment::default()
            .with("WEZTERM_VERSION", "2026.1")
            .with("TERM", "xterm-256color"),
    );
    assert_eq!(terminal.kind, TerminalKind::WezTerm);
    assert_eq!(terminal.version.as_deref(), Some("2026.1"));
    assert_eq!(terminal.color_level, ColorLevel::Ansi256);
}

#[test]
fn multiplexer_is_orthogonal_to_terminal_identity() {
    let terminal = detect(
        &FakeEnvironment::default()
            .with("TERM_PROGRAM", "Ghostty")
            .with("TMUX", "/tmp/tmux-501/default,1,0"),
    );
    assert_eq!(terminal.kind, TerminalKind::Ghostty);
    assert_eq!(
        terminal.multiplexer,
        Some(TerminalMultiplexer::Tmux { version: None })
    );
}

#[test]
fn dumb_term_overrides_optimistic_program_metadata() {
    let terminal = detect(
        &FakeEnvironment::default()
            .with("TERM_PROGRAM", "vscode")
            .with("TERM", "dumb"),
    );
    assert!(terminal.is_dumb());
    assert_eq!(terminal.color_level, ColorLevel::Monochrome);
}

#[test]
fn zellij_version_is_retained_when_available() {
    let terminal = detect(
        &FakeEnvironment::default()
            .with("ZELLIJ", "0")
            .with("ZELLIJ_VERSION", "0.42"),
    );
    assert_eq!(
        terminal.multiplexer,
        Some(TerminalMultiplexer::Zellij {
            version: Some("0.42".into()),
        })
    );
}

#[test]
fn multiplexer_program_keeps_the_underlying_terminal_and_separate_versions() {
    for (program, expected) in [
        (
            "TMUX",
            TerminalMultiplexer::Tmux {
                version: Some("3.5".into()),
            },
        ),
        (
            "Zellij",
            TerminalMultiplexer::Zellij {
                version: Some("3.5".into()),
            },
        ),
    ] {
        let terminal = detect(
            &FakeEnvironment::default()
                .with("TERM_PROGRAM", program)
                .with("TERM_PROGRAM_VERSION", "3.5")
                .with("WEZTERM_VERSION", "2026.1")
                .with("TERM", "xterm-256color"),
        );
        assert_eq!(
            terminal,
            HostTerminal {
                kind: TerminalKind::WezTerm,
                program: Some(program.into()),
                version: Some("2026.1".into()),
                term: Some("xterm-256color".into()),
                multiplexer: Some(expected),
                color_level: ColorLevel::Ansi256,
            }
        );
    }
}

#[test]
fn ghostty_is_detected_from_resources_or_term_behind_tmux() {
    for environment in [
        FakeEnvironment::default().with("GHOSTTY_RESOURCES_DIR", "/opt/ghostty"),
        FakeEnvironment::default().with("TERM", "xterm-ghostty"),
    ] {
        let terminal = detect(&environment.with("TERM_PROGRAM", "tmux"));
        assert_eq!(terminal.kind, TerminalKind::Ghostty);
        assert_eq!(
            terminal.multiplexer,
            Some(TerminalMultiplexer::Tmux { version: None })
        );
    }
}
