//! Home-page actions and the draft being submitted to a new conversation.

use crate::app::App;
use crate::app::AppCommand;
use crate::app::command_panel::CommandPanel;
use crate::app::welcome::pet;
use crate::render::InteractionState;
use crate::render::InteractionTarget;
use crate::render::RenderContext;
use crate::render::interaction_style;
use crate::render::selection_marker;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Block;
use ratatui::widgets::BorderType;
use ratatui::widgets::Borders;
use ratatui::widgets::Paragraph;

#[derive(Debug, Default)]
pub(in crate::app) struct Home {
    pub(in crate::app) selected: Option<usize>,
    welcome_visible: bool,
}

impl Home {
    pub(super) fn show_welcome(&mut self) {
        self.selected = None;
        self.welcome_visible = true;
    }

    pub(super) fn dismiss_welcome(&mut self) {
        self.selected = None;
        self.welcome_visible = false;
    }

    pub(super) const fn welcome_visible(&self) -> bool {
        self.welcome_visible
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::app) enum Action {
    NewTask,
    Resume,
    Dashboard,
    Settings,
    Help,
    Quit,
}

const ACTIONS: [(Action, &str); 6] = [
    (Action::NewTask, "New task"),
    (Action::Resume, "Resume session"),
    (Action::Dashboard, "Dashboard"),
    (Action::Settings, "Settings"),
    (Action::Help, "Help and shortcuts"),
    (Action::Quit, "Quit"),
];

pub(super) struct HomeLayout {
    pub(super) card: Rect,
    pub(super) identity: Rect,
    pub(super) pet: Rect,
    pub(super) actions: Rect,
}

pub(super) fn layout(area: Rect) -> HomeLayout {
    let width = area.width.saturating_sub(4);
    let height = area.height.min(13);
    let card = Rect::new(area.x + (area.width - width) / 2, area.y, width, height);
    let show_pet = width >= 64 && height >= 10;
    let content_x = card.x + 3.min(card.width);
    let content_y = card.y + (if height >= 5 { 2 } else { 1 }).min(card.height);
    let pet = if show_pet {
        Rect::new(content_x, content_y, 8, 4)
    } else {
        Rect::default()
    };
    let text_x = content_x + if show_pet { 12 } else { 0 };
    let text_width = card.right().saturating_sub(text_x + 2);
    let identity_rows =
        if height >= 10 { 3 } else { 1 }.min(card.bottom().saturating_sub(content_y + 1));
    let identity = Rect::new(text_x, content_y, text_width, identity_rows);
    let actions_y = identity.bottom() + u16::from(height >= 10);
    let actions_x = text_x.saturating_sub(2).max(card.x);
    let actions = Rect::new(
        actions_x,
        actions_y.min(card.bottom()),
        card.right().saturating_sub(actions_x.saturating_add(2)),
        card.bottom()
            .saturating_sub(actions_y + 1)
            .min(ACTIONS.len() as u16),
    );
    HomeLayout {
        card,
        identity,
        pet,
        actions,
    }
}

pub(super) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    app: &App,
    hovered: Option<Action>,
    pressed: Option<Action>,
    context: RenderContext<'_>,
) {
    let areas = layout(area);
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(context.border())),
        areas.card,
    );
    if !areas.pet.is_empty() {
        frame.render_widget(pet::PetWidget::new(pet::sprite()), areas.pet);
    }
    let text = vec![
        Line::from(vec![
            Span::styled(
                "Ash Code",
                Style::default()
                    .fg(context.foreground())
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!(" v{}", env!("CARGO_PKG_VERSION")),
                Style::default().fg(context.muted()),
            ),
        ]),
        Line::default(),
        Line::from(Span::styled(
            context.localize("Start a task below, or continue a previous session."),
            Style::default().fg(context.muted()),
        )),
    ];
    let selected = app.fullscreen.home.selected;
    if !areas.actions.is_empty() || selected.is_none() {
        frame.render_widget(Paragraph::new(text), areas.identity);
    }
    if areas.actions.is_empty() {
        if let Some(index) = selected
            && !areas.identity.is_empty()
        {
            let style = interaction_style(
                context,
                InteractionState {
                    target: InteractionTarget::Rest,
                    selected: !super::modal::is_open(app),
                    hovered: false,
                    pressed: false,
                },
            );
            frame.render_widget(
                Paragraph::new(format!(
                    "{}{}",
                    selection_marker(!super::modal::is_open(app)),
                    context.localize(ACTIONS[index].1)
                ))
                .style(style),
                Rect::new(
                    areas.identity.x.saturating_sub(2),
                    areas.identity.y,
                    areas.identity.width.saturating_add(2),
                    1,
                ),
            );
        }
        return;
    }
    let offset = selected
        .unwrap_or(0)
        .saturating_add(1)
        .saturating_sub(usize::from(areas.actions.height));
    for (row, (index, (action, label))) in ACTIONS
        .iter()
        .enumerate()
        .skip(offset)
        .take(usize::from(areas.actions.height))
        .enumerate()
    {
        let y = areas.actions.y + row as u16;
        let selected = selected == Some(index) && !super::modal::is_open(app);
        let style = interaction_style(
            context,
            InteractionState {
                target: InteractionTarget::Rest,
                selected,
                hovered: hovered == Some(*action),
                pressed: pressed == Some(*action),
            },
        )
        .add_modifier(Modifier::BOLD);
        frame.render_widget(
            Paragraph::new(format!(
                "{}{}",
                selection_marker(selected),
                context.localize(label)
            ))
            .style(style),
            Rect::new(areas.actions.x, y, areas.actions.width, 1),
        );
    }
}

pub(super) fn action_at(
    app: &App,
    area: Rect,
    position: ratatui::layout::Position,
) -> Option<Action> {
    let actions = layout(area).actions;
    if !actions.contains(position) {
        return None;
    }
    let offset = app
        .fullscreen
        .home
        .selected
        .unwrap_or(0)
        .saturating_add(1)
        .saturating_sub(usize::from(actions.height));
    ACTIONS
        .get(offset + usize::from(position.y - actions.y))
        .map(|(action, _)| *action)
}

pub(super) fn activate(app: &mut App, action: Action) -> Option<AppCommand> {
    app.fullscreen.home.selected = ACTIONS
        .iter()
        .position(|(candidate, _)| *candidate == action);
    app.fullscreen.focus_page();
    match action {
        Action::NewTask => {
            app.open_command_panel(CommandPanel::new_task_worktrees());
            None
        }
        Action::Resume => {
            let choices = crate::sessions::session_choices(
                app.sessions.catalog(),
                app.sessions.active_session_id().map(|id| id.as_str()),
            );
            app.open_command_panel(CommandPanel::sessions(choices));
            None
        }
        Action::Dashboard => {
            super::navigation::show_manager(app);
            None
        }
        Action::Settings => Some(crate::config::Command::OpenEditor.into()),
        Action::Help => {
            let choices = crate::app::help::help_choices(
                app.thread_presentations.slash_commands(),
                app.app_keymap.setup_actions(),
            );
            app.open_command_panel(CommandPanel::help(choices));
            None
        }
        Action::Quit => Some(AppCommand::Quit),
    }
}

pub(super) fn handle_key(app: &mut App, key: KeyEvent) -> Option<Option<AppCommand>> {
    if !app.fullscreen.welcome_visible() || app.completion().is_some() {
        return None;
    }
    if key.kind != KeyEventKind::Press {
        return app.fullscreen.home.selected.map(|_| None);
    }
    if app.sessions.pending_submission.is_some() {
        return Some(None);
    }
    let selected = app.fullscreen.home.selected;
    match (key.modifiers, key.code) {
        (KeyModifiers::NONE, KeyCode::Tab) => {
            app.fullscreen.home.selected = match selected {
                None => Some(0),
                Some(i) if i + 1 < ACTIONS.len() => Some(i + 1),
                _ => None,
            };
        }
        (_, KeyCode::BackTab) => {
            app.fullscreen.home.selected = match selected {
                None => Some(ACTIONS.len() - 1),
                Some(0) => None,
                Some(i) => Some(i - 1),
            };
        }
        (KeyModifiers::NONE, KeyCode::Up | KeyCode::Down) if selected.is_some() => {
            let index = selected.unwrap();
            app.fullscreen.home.selected = if key.code == KeyCode::Up {
                index.checked_sub(1)
            } else {
                (index + 1 < ACTIONS.len()).then_some(index + 1)
            };
        }
        (KeyModifiers::NONE, KeyCode::Enter) if selected.is_some() => {
            return Some(activate(app, ACTIONS[selected.unwrap()].0));
        }
        (KeyModifiers::NONE, KeyCode::Esc) if selected.is_some() => {
            app.fullscreen.home.selected = None
        }
        (KeyModifiers::NONE, KeyCode::Esc) if app.sessions.active_session_id().is_some() => {
            app.show_conversation()
        }
        _ if selected.is_some() => return Some(None),
        _ => return None,
    }
    if app.fullscreen.home.selected.is_some() {
        app.fullscreen.focus_page();
    } else {
        app.fullscreen.focus_input();
    }
    Some(None)
}

#[cfg(test)]
#[path = "home_tests.rs"]
mod tests;
