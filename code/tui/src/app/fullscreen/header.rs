use crate::app::App;
use crate::render::RenderContext;
use ash_memory_diagnostics::ProcessResourceDemand;
use ratatui::Frame;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::widgets::Paragraph;
use unicode_width::UnicodeWidthStr;

const DASHBOARD: &str = "Dashboard";

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(in crate::app) enum Target {
    Branch,
    Workspace,
    Context,
    Dashboard,
}

impl Target {
    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::Branch => "Switch branch",
            Self::Workspace => "Switch project folder",
            Self::Context => "Context usage",
            Self::Dashboard => "Dashboard",
        }
    }
}

#[derive(Debug, Default)]
pub(in crate::app) struct State {
    selected: Option<Target>,
}

impl State {
    pub(super) fn selected(&self) -> Option<Target> {
        self.selected
    }

    pub(super) fn select(&mut self, target: Target) {
        self.selected = Some(target);
    }

    pub(super) fn clear(&mut self) {
        self.selected = None;
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct HeaderLayout {
    branch: Rect,
    workspace: Rect,
    status: Rect,
    context: Rect,
    dashboard: Rect,
}

pub(super) fn draw(frame: &mut Frame<'_>, area: Rect, app: &App, context: RenderContext<'_>) {
    let areas = header_layout(area, app, context);

    if !areas.branch.is_empty()
        && let Some(branch) = app.status_line().branch_label()
    {
        let line = crate::render::truncate_with_ellipsis(branch, usize::from(areas.branch.width));
        let style = Style::default()
            .fg(context.foreground())
            .add_modifier(Modifier::BOLD)
            .patch(action_surface(
                app,
                Target::Branch,
                branch_enabled(app),
                context,
            ));
        frame.render_widget(Paragraph::new(line).style(style), areas.branch);
    }

    if !areas.workspace.is_empty() {
        let path = crate::render::truncate_with_ellipsis(
            app.welcome().directory(),
            usize::from(areas.workspace.width),
        );
        frame.render_widget(
            Paragraph::new(path).style(Style::default().fg(context.muted()).patch(action_surface(
                app,
                Target::Workspace,
                workspace_enabled(app),
                context,
            ))),
            areas.workspace,
        );
    }

    if !areas.status.is_empty() {
        let status = crate::status::header_line(
            app.status_line(),
            usize::from(areas.status.width),
            app.status_line_runtime(),
            context,
        );
        frame.render_widget(Paragraph::new(status), areas.status);
    }

    if !areas.context.is_empty() {
        let selected = app.fullscreen.header.selected() == Some(Target::Context);
        let hovered = app.fullscreen.pointer.hovered()
            == Some(&super::pointer::PointerTarget::Header(Target::Context));
        let line = crate::status::context_header_line(
            app.status_line(),
            selected || hovered,
            context,
            action_surface(app, Target::Context, true, context),
        );
        frame.render_widget(Paragraph::new(line), areas.context);
    }

    draw_action(
        frame,
        areas.dashboard,
        &format!("[{}]", context.localize(DASHBOARD)),
        app,
        Target::Dashboard,
        true,
        context,
    );
}

fn draw_action(
    frame: &mut Frame<'_>,
    area: Rect,
    label: &str,
    app: &App,
    target: Target,
    enabled: bool,
    context: RenderContext<'_>,
) {
    if !area.is_empty() {
        frame.render_widget(
            Paragraph::new(label).style(
                Style::default()
                    .fg(context.muted())
                    .patch(action_surface(app, target, enabled, context)),
            ),
            area,
        );
    }
}

fn action_surface(app: &App, target: Target, enabled: bool, context: RenderContext<'_>) -> Style {
    let pointer = super::pointer::PointerTarget::Header(target);
    let state = app.fullscreen.pointer.interaction_state(&pointer);
    if !enabled {
        return Style::default()
            .fg(context.disabled_foreground())
            .add_modifier(Modifier::DIM);
    }
    if state.pressed {
        return Style::default().fg(context.pressed_foreground());
    }
    if app.fullscreen.header.selected() == Some(target) {
        return Style::default()
            .fg(context.focus())
            .add_modifier(Modifier::UNDERLINED);
    }
    if state.hovered {
        return Style::default().fg(context.hover_foreground());
    }
    Style::default()
}

pub(super) fn target_at(app: &App, area: Rect, position: Position) -> Option<Target> {
    let areas = header_layout(area, app, app.render_context());
    [
        (Target::Branch, areas.branch, branch_enabled(app)),
        (Target::Workspace, areas.workspace, workspace_enabled(app)),
        (Target::Context, areas.context, true),
        (Target::Dashboard, areas.dashboard, true),
    ]
    .into_iter()
    .find_map(|(target, area, enabled)| (enabled && area.contains(position)).then_some(target))
}

pub(super) fn keyboard_targets(app: &App) -> Vec<Target> {
    [
        (Target::Branch, branch_enabled(app)),
        (Target::Workspace, workspace_enabled(app)),
        (Target::Context, true),
        (Target::Dashboard, true),
    ]
    .into_iter()
    .filter_map(|(target, enabled)| enabled.then_some(target))
    .collect()
}

fn branch_enabled(app: &App) -> bool {
    app.workspace_mutation_available() && app.status_line().branch_label().is_some()
}

fn workspace_enabled(app: &App) -> bool {
    app.workspace_mutation_available() && app.workspace_switch_available()
}

fn header_layout(area: Rect, app: &App, context: RenderContext<'_>) -> HeaderLayout {
    if area.is_empty() {
        return HeaderLayout::default();
    }
    let dashboard_width = context.localize(DASHBOARD).width() as u16 + 2;
    let show_dashboard = area.width >= 24;
    let dashboard = show_dashboard
        .then(|| {
            Rect::new(
                area.right().saturating_sub(dashboard_width),
                area.y,
                dashboard_width,
                1,
            )
        })
        .unwrap_or_default();
    let right_before_dashboard = if dashboard.is_empty() {
        area.right()
    } else {
        dashboard.x.saturating_sub(1)
    };

    let ratio =
        crate::status::context_header_line(app.status_line(), false, context, Style::default());
    let progress =
        crate::status::context_header_line(app.status_line(), true, context, Style::default());
    let context_slot_width = ratio.width().max(progress.width()) as u16;
    let show_context =
        show_dashboard && right_before_dashboard.saturating_sub(area.x) >= context_slot_width + 18;
    let context_width = if show_context
        && (app.fullscreen.header.selected() == Some(Target::Context)
            || app.fullscreen.pointer.hovered()
                == Some(&super::pointer::PointerTarget::Header(Target::Context)))
    {
        progress.width() as u16
    } else if show_context {
        ratio.width() as u16
    } else {
        0
    };
    let context = if show_context {
        Rect::new(
            right_before_dashboard.saturating_sub(context_width),
            area.y,
            context_width,
            1,
        )
    } else {
        Rect::default()
    };
    let context_slot_left = if show_context {
        right_before_dashboard.saturating_sub(context_slot_width)
    } else {
        right_before_dashboard
    };
    let left_right = context_slot_left.saturating_sub(u16::from(show_context));
    let available = left_right.saturating_sub(area.x);
    let status_width = available.saturating_sub(20).min(24);
    let status = if status_width > 0 {
        Rect::new(
            left_right.saturating_sub(status_width),
            area.y,
            status_width,
            1,
        )
    } else {
        Rect::default()
    };
    let workspace_right = if status.is_empty() {
        left_right
    } else {
        status.x.saturating_sub(1)
    };
    let workspace_start = area.x;
    let available_identity = workspace_right.saturating_sub(workspace_start);
    let content_budget = available_identity;
    let branch_text = app.status_line().branch_label().unwrap_or_default();
    let branch_width = if branch_text.is_empty() {
        0
    } else {
        (branch_text.width() as u16).min(content_budget / 2)
    };
    let branch = Rect::new(workspace_start, area.y, branch_width, 1);
    let path_start = branch.right().saturating_add(u16::from(branch_width > 0));
    let remaining_for_path = workspace_right.saturating_sub(path_start);
    let path_text = app.welcome().directory();
    let path_width = (path_text.width() as u16).min(remaining_for_path);
    let workspace = Rect::new(path_start, area.y, path_width, 1);
    HeaderLayout {
        branch,
        workspace,
        status,
        context,
        dashboard,
    }
}

pub(super) fn process_resource_demand(app: &App, area: Rect) -> ProcessResourceDemand {
    let status = header_layout(area, app, app.render_context()).status;
    app.status_line()
        .header_process_resources(usize::from(status.width), app.status_line_runtime())
        .map_or(
            ProcessResourceDemand::Disabled,
            ProcessResourceDemand::Summary,
        )
}

#[cfg(test)]
#[path = "header_tests.rs"]
mod tests;
