use crate::TuiRecoveryDrafts;
use crate::TuiRecoveryState;
use crate::host::TerminationSource;
use crate::nls::Language;
use crate::nls::localize;
use crate::terminal::ScreenMode;
use crate::terminal::TerminalSession;
use crate::thread::composer::built_in_slash_command_definitions;
use ash_slash_commands::SlashCommandCatalog;
use ash_slash_commands::SlashCommandsState;
use crossterm::event;
use crossterm::event::Event;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use ratatui::Frame;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::TryRecvError;
use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LocalCommand {
    Status,
    Quit,
}

impl LocalCommand {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "status" => Some(Self::Status),
            "quit" => Some(Self::Quit),
            _ => None,
        }
    }
}

struct ReconnectView {
    input: String,
    commands: SlashCommandsState,
    message: Message,
}

#[derive(Default)]
enum Message {
    #[default]
    Waiting,
    Status,
    RequiresConnection,
}

impl ReconnectView {
    fn search_catalog() -> SlashCommandCatalog {
        SlashCommandCatalog::new(
            built_in_slash_command_definitions()
                .into_iter()
                .filter(|command| command.name != "help"),
        )
        .expect("reconnect search commands are valid")
    }

    fn new() -> Self {
        let mut view = Self {
            input: "/".into(),
            commands: SlashCommandsState::new(Self::search_catalog()),
            message: Message::Waiting,
        };
        view.sync_input();
        view
    }

    fn sync_input(&mut self) {
        self.commands.sync_input(&self.input, self.input.len());
        if self.input == "/" {
            // An empty query shows only the commands that work while reconnecting.
            self.commands.set_catalog(
                SlashCommandCatalog::new(
                    built_in_slash_command_definitions()
                        .into_iter()
                        .filter(|command| LocalCommand::from_name(&command.name).is_some()),
                )
                .expect("local reconnect commands are valid"),
            );
        } else if self
            .commands
            .catalog()
            .commands()
            .iter()
            .all(|command| LocalCommand::from_name(&command.name).is_some())
        {
            self.commands.set_catalog(Self::search_catalog());
        }
    }

    /// Returns true only for a local quit action.
    fn handle_key(&mut self, key: KeyEvent) -> bool {
        if key.kind == KeyEventKind::Release {
            return false;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            return matches!(key.code, KeyCode::Char('c' | 'd'));
        }
        match key.code {
            KeyCode::Up => self.commands.select_previous(),
            KeyCode::Down => self.commands.select_next(),
            KeyCode::Esc => {
                self.input.truncate(1);
                self.message = Message::Waiting;
                self.sync_input();
            }
            KeyCode::Backspace if self.input.len() > 1 => {
                self.input.pop();
                self.sync_input();
            }
            KeyCode::Char(character)
                if self.input.len() < 64
                    && (character.is_ascii_alphanumeric() || character == '-') =>
            {
                self.input.push(character.to_ascii_lowercase());
                self.sync_input();
            }
            KeyCode::Tab => {
                if let Some(command) = self.commands.selected_command()
                    && LocalCommand::from_name(&command.name).is_some()
                {
                    self.input = format!("/{}", command.name);
                    self.sync_input();
                }
            }
            KeyCode::Enter => {
                let invocation = self.commands.invocation(&self.input);
                let selected = invocation
                    .as_ref()
                    .map(|value| &value.command)
                    .or_else(|| self.commands.selected_command());
                self.message =
                    match selected.and_then(|command| LocalCommand::from_name(&command.name)) {
                        Some(LocalCommand::Status) => Message::Status,
                        Some(LocalCommand::Quit) => return true,
                        None => Message::RequiresConnection,
                    };
            }
            _ => {}
        }
        false
    }

    fn lines<'a>(
        &'a self,
        language: Language,
        recovery: Option<&TuiRecoveryState>,
    ) -> Vec<Line<'a>> {
        let status = match self.message {
            Message::Waiting => localize(language, "Reconnecting to App Server…").into_owned(),
            Message::Status => recovery.map_or_else(
                || localize(language, "No conversation was open.").into_owned(),
                |recovery| format!("{} {}", localize(language, "Thread"), recovery.thread_id()),
            ),
            Message::RequiresConnection => {
                localize(language, "Requires an App Server connection.").into_owned()
            }
        };
        let mut lines = vec![Line::raw(status), Line::raw(format!("> {}", self.input))];
        if let Some(view) = self.commands.view() {
            const VISIBLE_COMMANDS: usize = 4;
            let start = view
                .selected
                .unwrap_or_default()
                .saturating_sub(VISIBLE_COMMANDS - 1);
            for (index, command) in view
                .commands
                .iter()
                .enumerate()
                .skip(start)
                .take(VISIBLE_COMMANDS)
            {
                let marker = if view.selected == Some(index) {
                    "›"
                } else {
                    " "
                };
                let description = if LocalCommand::from_name(&command.name).is_some() {
                    localize(language, &command.description)
                } else {
                    localize(language, "Requires an App Server connection.")
                };
                lines.push(Line::raw(format!(
                    "{marker} /{}  {description}",
                    command.name
                )));
            }
        }
        lines.push(Line::raw(localize(
            language,
            "↑/↓ Select · Enter Run · Ctrl+C Quit",
        )));
        lines
    }

    fn render(
        &self,
        frame: &mut Frame<'_>,
        language: Language,
        recovery: Option<&TuiRecoveryState>,
    ) {
        let area = frame.area();
        frame.render_widget(Paragraph::new(self.lines(language, recovery)), area);
        if area.height > 1 && area.width > 0 {
            let offset = (self.input.len() as u16 + 2).min(area.width - 1);
            frame.set_cursor_position((area.x + offset, area.y + 1));
        }
    }
}

/// Keeps local commands usable while the CLI host reconnects in the background.
/// Dropping the result receiver after local quit lets the host cancel retry delays.
pub fn wait_for_reconnect<T>(
    result: Receiver<Result<T, String>>,
    recovery: Option<&TuiRecoveryState>,
    drafts: &TuiRecoveryDrafts,
) -> Result<Option<T>, String> {
    let termination = TerminationSource::register().map_err(|error| error.to_string())?;
    let requested = termination.request();
    let mut terminal =
        TerminalSession::open(ScreenMode::Inline).map_err(|error| error.to_string())?;
    terminal
        .set_inline_height(7)
        .map_err(|error| error.to_string())?;
    let mut view = ReconnectView::new();
    let mut redraw = true;
    loop {
        if requested.take() {
            return Ok(None);
        }
        match result.try_recv() {
            Ok(ready) => return ready.map(Some),
            Err(TryRecvError::Disconnected) => {
                return Err(localize(drafts.language, "App Server reconnect stopped.").into_owned());
            }
            Err(TryRecvError::Empty) => {}
        }
        if redraw {
            terminal
                .draw(|frame, _| view.render(frame, drafts.language, recovery))
                .map_err(|error| error.to_string())?;
            redraw = false;
        }
        if event::poll(Duration::from_millis(25)).map_err(|error| error.to_string())? {
            match event::read().map_err(|error| error.to_string())? {
                Event::Key(key) if view.handle_key(key) => return Ok(None),
                Event::Key(_) | Event::Resize(_, _) => redraw = true,
                _ => {}
            }
        }
    }
}

#[cfg(test)]
#[path = "reconnecting_tests.rs"]
mod tests;
