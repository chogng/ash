//! Hosts feature editors and details above any full-screen page.

use crate::app::App;
use crate::app::AppCommand;
use crate::app::command_panel::CommandPanel;
use crate::keymap::bindings;
use crate::render::InteractionState;
use crate::render::RenderContext;
use crate::widgets::modal::ModalLayout;
use crate::widgets::navigation::Navigation;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use ratatui::Frame;
use ratatui::layout::Rect;

pub(super) fn is_open(app: &App) -> bool {
    app.overlay().is_some() || app.command_panel().is_some()
}

pub(super) fn allows_backdrop_dismiss(app: &App) -> bool {
    if app.overlay().is_some() {
        return true;
    }
    app.command_panel()
        .is_some_and(|panel| panel.allows_backdrop_dismiss())
}

pub(super) fn layout(available: Rect) -> ModalLayout {
    ModalLayout::new(
        available,
        (available.width.saturating_mul(3) / 4).clamp(64, 100),
        (available.height.saturating_mul(4) / 5).clamp(12, 32),
    )
}

pub(super) fn body_area(panel: &CommandPanel, content: Rect) -> Rect {
    let rows = panel.body().tab_rows(content.width).min(content.height);
    let gap = u16::from(rows > 0).min(content.height.saturating_sub(rows));
    Rect::new(
        content.x,
        content.y + rows + gap,
        content.width,
        content.height.saturating_sub(rows + gap),
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::app) enum Target {
    Close,
    Parent,
    Provider(crate::config::provider::Target),
    Memories(crate::memories::Target),
    Backdrop,
    Blocked,
    Tab(usize),
    List(crate::widgets::list_selection::ListSelectionPointerTarget),
}

pub(super) fn target_at(
    app: &App,
    available: Rect,
    position: ratatui::layout::Position,
) -> Option<Target> {
    if !available.contains(position) {
        return None;
    }
    let layout = layout(available);
    if !layout.surface.contains(position) {
        return if allows_backdrop_dismiss(app) {
            Some(Target::Backdrop)
        } else {
            Some(Target::Blocked)
        };
    }
    if layout.close.contains(position) {
        return Some(Target::Close);
    }
    if app.overlay().is_some() {
        return None;
    }
    let panel = app.command_panel()?;
    if let Some(parent) = panel.parent_title() {
        if parent_area(layout, &crate::nls::localize(app.language(), parent)).contains(position) {
            return Some(Target::Parent);
        }
    }
    let body = body_area(panel, layout.content);
    if let crate::app::command_panel::CommandPanelBody::Provider(provider) = panel.body() {
        return provider.target_at(body, position).map(Target::Provider);
    }
    let tabs = Rect {
        height: panel
            .body()
            .tab_rows(layout.content.width)
            .min(layout.content.height),
        ..layout.content
    };
    if let crate::app::command_panel::CommandPanelBody::Memories(memories) = panel.body() {
        return memories
            .target_at(tabs, body, position)
            .map(Target::Memories);
    }
    match panel.list_selection() {
        Some(selection) => {
            crate::widgets::list_selection::pointer_target_at(selection, tabs, body, position)
                .map(Target::List)
        }
        None => panel.tab_at(tabs, position).map(Target::Tab),
    }
}

pub(super) fn activate(
    app: &mut App,
    available: Rect,
    target: Target,
    click: crate::widgets::list_selection::ListSelectionClick,
) -> Option<AppCommand> {
    match target {
        Target::Memories(target) => {
            let outcome = app
                .fullscreen
                .panels
                .command_mut()?
                .activate_memory(&target, click);
            app.handle_command_panel_outcome(outcome)
        }
        Target::Parent => {
            app.fullscreen.panels.command_mut()?.return_to_parent();
            None
        }
        Target::Provider(target) => {
            let outcome = app
                .fullscreen
                .panels
                .command_mut()?
                .activate_provider(target);
            app.handle_command_panel_outcome(outcome)
        }
        Target::Tab(index) => {
            app.fullscreen.modal_alert = false;
            app.fullscreen.panels.command_mut()?.select_tab(index);
            None
        }
        Target::Close => {
            close(app);
            None
        }
        Target::Backdrop => {
            if allows_backdrop_dismiss(app) {
                close(app);
            }
            None
        }
        Target::Blocked => {
            app.fullscreen.modal_alert = true;
            None
        }
        Target::List(target) => {
            app.fullscreen.modal_alert = false;
            let panel = app.fullscreen.panels.command_mut()?;
            let body = body_area(panel, layout(available).content);
            let outcome = panel.handle_click(&target, body, click);
            app.handle_command_panel_outcome(outcome)
        }
    }
}

pub(super) fn draw(frame: &mut Frame<'_>, app: &App, context: RenderContext<'_>) {
    if !is_open(app) {
        return;
    }
    let layout = layout(frame.area());
    context.clear_hyperlinks(layout.surface);
    let close = app
        .fullscreen
        .pointer
        .interaction_state(&super::pointer::PointerTarget::Modal(Target::Close));
    if let Some(detail) = app.overlay() {
        let hints = crate::widgets::key_hint::KeyHints::new()
            .with_compact_action("↑/↓", "scroll")
            .with_action("Esc", "close");
        crate::widgets::modal::draw(
            frame,
            layout,
            &context.localize(detail.title()),
            &hints,
            close,
            false,
            app.key_hint_style(),
            context,
        );
        detail.draw_body(frame, layout.content, context);
    } else if let Some(panel) = app.command_panel() {
        let hovered = match app.fullscreen.pointer.hovered() {
            Some(super::pointer::PointerTarget::Modal(target)) => Some(target),
            _ => None,
        };
        let pressed = match app.fullscreen.pointer.pressed() {
            Some(super::pointer::PointerTarget::Modal(target)) => Some(target),
            _ => None,
        };
        let blocked_alert = app.fullscreen.modal_alert
            || app.fullscreen.pointer.pressed()
                == Some(&super::pointer::PointerTarget::Modal(Target::Blocked));
        draw_panel(
            frame,
            panel,
            layout,
            hovered,
            pressed,
            close,
            blocked_alert,
            app.key_hint_style(),
            context,
        );
    }
}

pub(super) fn draw_panel(
    frame: &mut Frame<'_>,
    panel: &CommandPanel,
    layout: ModalLayout,
    hovered: Option<&Target>,
    pressed: Option<&Target>,
    close: InteractionState,
    blocked_alert: bool,
    hint_style: crate::config::KeyHintStyle,
    context: RenderContext<'_>,
) {
    let body = panel.body();
    let title = panel.navigation_title(context.language());
    let alert_hints;
    let hints = if blocked_alert {
        alert_hints = crate::widgets::key_hint::KeyHints::new()
            .with_note("editing in progress")
            .with_action("Esc", "cancel");
        &alert_hints
    } else {
        panel.key_hints()
    };
    crate::widgets::modal::draw(
        frame,
        layout,
        &title,
        hints,
        close,
        blocked_alert,
        hint_style,
        context,
    );
    if let Some(parent) = panel.parent_title() {
        let localized_parent = context.localize(parent);
        let style = ratatui::style::Style::default()
            .fg(context.foreground())
            .add_modifier(ratatui::style::Modifier::UNDERLINED | ratatui::style::Modifier::BOLD)
            .patch(crate::render::interaction_style(
                context,
                InteractionState {
                    hovered: hovered == Some(&Target::Parent),
                    pressed: pressed == Some(&Target::Parent),
                    ..Default::default()
                },
            ));
        let area = parent_area(layout, &localized_parent);
        frame.render_widget(
            ratatui::widgets::Paragraph::new(localized_parent).style(style),
            area,
        );
    }
    let tabs = Rect {
        height: body
            .tab_rows(layout.content.width)
            .min(layout.content.height),
        ..layout.content
    };
    let tab = |target: Option<&Target>| match target {
        Some(Target::Tab(index))
        | Some(Target::List(crate::widgets::list_selection::ListSelectionPointerTarget::Tab(
            index,
        ))) => Some(*index),
        _ => None,
    };
    let hovered_list = match hovered {
        Some(Target::List(target)) => Some(target),
        _ => None,
    };
    let pressed_list = match pressed {
        Some(Target::List(target)) => Some(target),
        _ => None,
    };
    if let crate::app::command_panel::CommandPanelBody::Memories(memories) = body {
        fn target(target: Option<&Target>) -> Option<&crate::memories::Target> {
            match target {
                Some(Target::Memories(target)) => Some(target),
                _ => None,
            }
        }
        let tab = |target: Option<&crate::memories::Target>| match target {
            Some(crate::memories::Target::List(
                crate::widgets::list_selection::ListSelectionPointerTarget::Tab(index),
            )) => Some(*index),
            _ => None,
        };
        memories.draw_tabs(
            frame,
            tabs,
            tab(target(hovered)),
            tab(target(pressed)),
            context,
        );
        memories.draw(
            frame,
            body_area(panel, layout.content),
            target(hovered),
            target(pressed),
            context,
        );
        return;
    }
    body.draw_tabs(frame, tabs, tab(hovered), tab(pressed), context);
    if let crate::app::command_panel::CommandPanelBody::Provider(provider) = body {
        let target = |target: Option<&Target>| match target {
            Some(Target::Provider(target)) => Some(*target),
            _ => None,
        };
        provider.draw_with_pointer(
            frame,
            body_area(panel, layout.content),
            target(hovered),
            target(pressed),
            context,
        );
        return;
    }
    body.draw_body(
        frame,
        body_area(panel, layout.content),
        hovered_list,
        pressed_list,
        context,
    );
}

fn parent_area(layout: ModalLayout, title: &str) -> Rect {
    use unicode_width::UnicodeWidthStr;
    Rect::new(
        layout.title.x + 1,
        layout.title.y,
        (title.width() as u16).min(layout.title.width.saturating_sub(1)),
        layout.title.height,
    )
}

/// An open modal consumes every key; unhandled content input never reaches the page below.
pub(super) fn handle_key(
    app: &mut App,
    key: KeyEvent,
    available: Rect,
) -> Option<Option<AppCommand>> {
    if !is_open(app) {
        return None;
    }
    app.fullscreen.modal_alert = false;
    app.fullscreen.pointer.cancel_click();
    let layout = layout(available);
    if let Some(detail) = app.overlay_mut() {
        if key.kind == KeyEventKind::Press && bindings::CLOSE.matches(key) {
            super::navigation::close_overlay(app);
        } else if let Some(navigation) = Navigation::from_key(key) {
            detail.scroll_body(navigation, layout.content);
        }
        return Some(None);
    }
    let panel = app.fullscreen.panels.command_mut()?;
    let area = body_area(panel, layout.content);
    let outcome = panel.handle_key(key, area);
    Some(app.handle_command_panel_outcome(outcome))
}

pub(super) fn close(app: &mut App) {
    app.fullscreen.modal_alert = false;
    if app.overlay().is_some() {
        super::navigation::close_overlay(app);
    } else {
        app.close_command_panel();
    }
}

pub(super) fn process_resources_visible(app: &App, available: Rect) -> bool {
    app.overlay().is_none()
        && app.command_panel().is_some_and(|panel| {
            panel.process_resources_visible(body_area(panel, layout(available).content))
        })
}

#[cfg(test)]
#[path = "modal_tests.rs"]
mod tests;
