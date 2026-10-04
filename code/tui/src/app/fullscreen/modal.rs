//! Hosts feature editors and details above any full-screen page.

use crate::app::App;
use crate::app::AppCommand;
use crate::app::command_panel::CommandPanel;
use crate::app::command_panel::CommandPanelPointerTarget;
use crate::keymap::KeyEvent;
use crate::keymap::bindings;
use crate::render::InteractionState;
use crate::render::RenderContext;
use crate::widgets::modal::ModalLayout;
use crate::widgets::navigation::Navigation;
use crate::widgets::panel::PanelLayout;
use crossterm::event::KeyEventKind;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::text::Line;

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

pub(super) fn layout_for(app: &App, available: Rect) -> ModalLayout {
    let header_rows = super::layout::header_rows(available);
    let available = Rect {
        height: super::layout::modal_hintline(app, available)
            .y
            .saturating_sub(available.y),
        ..available
    };
    if app.overlay().is_none()
        && let Some(CommandPanel::Shortcuts(panel)) = app.command_panel()
    {
        let width = available.width.saturating_sub(4).min(164);
        let content_width = ModalLayout::new(available, width, available.height)
            .content
            .width;
        let height = panel
            .body_rows(content_width, app.render_context())
            .saturating_add(3);
        return ModalLayout::new(available, width, height);
    }
    if app.overlay().is_none()
        && let Some(CommandPanel::Effort(selector)) = app.command_panel()
    {
        let width = PanelLayout::content_width(available.width);
        let body_rows = selector.body_rows(width, app.render_context());
        let chrome_rows = crate::widgets::panel::HEADER_ROWS + 1;
        let height = body_rows
            .saturating_add(chrome_rows)
            // The dock replaces the input and bottom chrome, but keeps feedback above it.
            .min(available.height.saturating_sub(header_rows + 1));
        let surface = Rect::new(
            available.x,
            available.bottom() - height,
            available.width,
            height,
        );
        let panel = PanelLayout::new(surface, 0);
        let content = Rect {
            height: body_rows.min(height.saturating_sub(chrome_rows)),
            ..panel.body
        };
        return ModalLayout {
            surface,
            title: panel.title,
            close: Rect::default(),
            content,
        };
    }
    if app.overlay().is_none()
        && let Some(panel) = app.command_panel()
        && let crate::app::command_panel::CommandPanelBody::Dialog(dialog) = panel.body()
    {
        let width = available.width.min(76);
        let content_width = ModalLayout::new(available, width, available.height)
            .content
            .width;
        let height = dialog.body_rows(content_width).saturating_add(3).max(5);
        return ModalLayout::new(available, width, height);
    }
    layout(available)
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

pub(super) fn dialog_body_area(app: &App, available: Rect) -> Option<Rect> {
    if app.overlay().is_some() {
        return None;
    }
    let panel = app.command_panel()?;
    let crate::app::command_panel::CommandPanelBody::Dialog(dialog) = panel.body() else {
        return None;
    };
    let content = layout_for(app, available).content;
    Some(Rect {
        height: dialog.body_rows(content.width).min(content.height),
        ..content
    })
}

pub(super) fn selectable_text_area(app: &App, available: Rect) -> Option<Rect> {
    is_open(app)
        .then(|| dialog_body_area(app, available).unwrap_or(layout_for(app, available).content))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::app) enum Target {
    Close,
    Parent,
    Backdrop,
    Blocked,
    Text,
    Panel(CommandPanelPointerTarget),
}

pub(super) fn target_at(
    app: &App,
    available: Rect,
    position: ratatui::layout::Position,
) -> Option<Target> {
    if !available.contains(position) {
        return None;
    }
    // Hints belong to the page, so they neither dismiss nor alert the modal backdrop.
    if super::layout::modal_hintline(app, available).contains(position) {
        return None;
    }
    let layout = layout_for(app, available);
    if !layout.surface.contains(position) {
        return if allows_backdrop_dismiss(app)
            || app.command_panel().is_some_and(|panel| {
                matches!(
                    panel.body(),
                    crate::app::command_panel::CommandPanelBody::Dialog(_)
                )
            }) {
            Some(Target::Backdrop)
        } else {
            Some(Target::Blocked)
        };
    }
    if layout.close.contains(position) {
        return Some(Target::Close);
    }
    let text_area = selectable_text_area(app, available);
    if app.overlay().is_some() {
        return text_area
            .is_some_and(|area| area.contains(position))
            .then_some(Target::Text);
    }
    let panel = app.command_panel()?;
    if let Some(parent) = panel.parent_title() {
        if parent_area(layout, &crate::nls::localize(app.language(), parent)).contains(position) {
            return Some(Target::Parent);
        }
    }
    let body = body_area(panel, layout.content);
    let tabs = Rect {
        height: panel
            .body()
            .tab_rows(layout.content.width)
            .min(layout.content.height),
        ..layout.content
    };
    let target = panel
        .pointer_target_at(tabs, body, position, app.render_context())
        .map(Target::Panel);
    target.or_else(|| {
        text_area
            .is_some_and(|area| area.contains(position))
            .then_some(Target::Text)
    })
}

pub(super) fn activate(
    app: &mut App,
    available: Rect,
    target: Target,
    click: crate::widgets::list_selection::ListSelectionClick,
) -> Option<AppCommand> {
    match target {
        Target::Parent => {
            app.fullscreen.panels.command_mut()?.return_to_parent();
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
        Target::Text => None,
        Target::Panel(target) => {
            app.fullscreen.modal_alert = false;
            let content = layout_for(app, available).content;
            let panel = app.fullscreen.panels.command_mut()?;
            let body = body_area(panel, content);
            let outcome = panel.activate_pointer_target(target, body, click);
            app.handle_command_panel_outcome(outcome)
        }
    }
}

pub(super) fn draw(frame: &mut Frame<'_>, app: &App, context: RenderContext<'_>) {
    if !is_open(app) {
        return;
    }
    let layout = layout_for(app, frame.area());
    context.clear_hyperlinks(layout.surface);
    let close = app
        .fullscreen
        .pointer
        .interaction_state(&super::pointer::PointerTarget::Modal(Target::Close));
    if let Some(detail) = app.overlay() {
        crate::widgets::modal::draw(
            frame,
            layout,
            &context.localize(detail.title()),
            close,
            false,
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
        draw_panel(
            frame,
            panel,
            layout,
            hovered,
            pressed,
            close,
            app.fullscreen.modal_alert_active(),
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
    context: RenderContext<'_>,
) {
    let body = panel.body();
    let title = panel.navigation_title(context.language());
    if matches!(panel, CommandPanel::Effort(_)) {
        frame.render_widget(ratatui::widgets::Clear, layout.surface);
        frame.render_widget(
            ratatui::widgets::Block::default().style(
                ratatui::style::Style::default()
                    .fg(context.foreground())
                    .bg(context.background()),
            ),
            layout.surface,
        );
        crate::widgets::panel::draw_header(
            frame,
            layout.surface,
            Line::from(title.as_str()),
            Line::default(),
            context.focus(),
        );
    } else {
        crate::widgets::modal::draw(frame, layout, &title, close, blocked_alert, context);
    }
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
    fn panel_target(target: Option<&Target>) -> Option<&CommandPanelPointerTarget> {
        match target {
            Some(Target::Panel(target)) => Some(target),
            _ => None,
        }
    }
    panel.draw_content(
        frame,
        tabs,
        body_area(panel, layout.content),
        panel_target(hovered),
        panel_target(pressed),
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
    let layout = layout_for(app, available);
    if let Some(detail) = app.overlay_mut() {
        if key.kind == KeyEventKind::Press && bindings::CLOSE.matches(key) {
            super::navigation::close_overlay(app);
        } else if let Some(navigation) = Navigation::from_key(key) {
            detail.scroll_body(navigation, layout.content);
        }
        return Some(None);
    }
    let panel = app.fullscreen.panels.command_mut()?;
    let was_dialog = matches!(
        panel.body(),
        crate::app::command_panel::CommandPanelBody::Dialog(_)
    );
    let area = body_area(panel, layout.content);
    let outcome = panel.handle_key(key, area);
    if was_dialog
        && app.command_panel().is_some_and(|panel| {
            !matches!(
                panel.body(),
                crate::app::command_panel::CommandPanelBody::Dialog(_)
            )
        })
    {
        app.fullscreen.selection.clear();
    }
    Some(app.handle_command_panel_outcome(outcome))
}

pub(super) fn close(app: &mut App) {
    app.fullscreen.modal_alert = false;
    if app.overlay().is_some() {
        super::navigation::close_overlay(app);
    } else if app.command_panel().is_some_and(|panel| {
        matches!(
            panel.body(),
            crate::app::command_panel::CommandPanelBody::Dialog(_)
        )
    }) {
        app.fullscreen.selection.clear();
        if let Some(panel) = app.fullscreen.panels.command_mut() {
            panel.return_to_parent();
        }
    } else {
        app.close_command_panel();
    }
}

pub(super) fn process_resources_visible(app: &App, available: Rect) -> bool {
    app.overlay().is_none()
        && app.command_panel().is_some_and(|panel| {
            panel.process_resources_visible(body_area(panel, layout_for(app, available).content))
        })
}

#[cfg(test)]
#[path = "modal_tests.rs"]
mod tests;
