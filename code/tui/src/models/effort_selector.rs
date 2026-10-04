//! A staged effort edit. The catalog owns the levels; the host owns dismissal and placement.

use crate::render::InteractionState;
use crate::render::RenderContext;
use crate::widgets::key_hint::KeyHints;
use ash_protocol::CollaborationMode;
use ash_protocol::ReasoningEffort;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use ratatui::Frame;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use std::time::Instant;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Target {
    Level(usize),
    Multitask,
}

#[derive(Debug)]
pub(crate) enum Outcome {
    Apply {
        effort: ReasoningEffort,
        mode: CollaborationMode,
    },
    Consumed,
    Dismiss,
}

#[derive(Debug)]
pub(crate) struct EffortSelector {
    levels: Vec<ReasoningEffort>,
    current: Option<ReasoningEffort>,
    selected: usize,
    original_mode: CollaborationMode,
    multitask: bool,
    opened: Instant,
    phase: usize,
    hints: KeyHints,
}

impl EffortSelector {
    pub(super) fn new(
        levels: &[ReasoningEffort],
        current: Option<ReasoningEffort>,
        mode: CollaborationMode,
    ) -> Self {
        // The validated catalog entry supplies at least one level, in provider order.
        assert!(!levels.is_empty());
        Self {
            levels: levels.to_vec(),
            current,
            selected: current
                .and_then(|value| levels.iter().position(|level| *level == value))
                .unwrap_or(0),
            original_mode: mode,
            multitask: mode == CollaborationMode::Multitask,
            opened: Instant::now(),
            phase: 0,
            hints: KeyHints::new()
                .with_compact_action("←/→", "choose")
                .with_compact_action("Tab", "toggle multitask")
                .with_compact_action("Enter", "apply")
                .with_compact_action("Esc", "cancel"),
        }
    }

    pub(crate) fn key_hints(&self) -> &KeyHints {
        &self.hints
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        if key.kind == KeyEventKind::Release || !key.modifiers.is_empty() {
            return Outcome::Consumed;
        }
        match key.code {
            KeyCode::Left | KeyCode::Up => {
                return self.activate(Target::Level(self.selected.saturating_sub(1)));
            }
            KeyCode::Right | KeyCode::Down => {
                return self.activate(Target::Level(
                    (self.selected + 1).min(self.levels.len() - 1),
                ));
            }
            KeyCode::Tab if key.kind == KeyEventKind::Press => {
                return self.activate(Target::Multitask);
            }
            KeyCode::Enter if key.kind == KeyEventKind::Press => {
                // Turning cooperation off restores the mode that was edited, rather than
                // silently replacing Plan, Ask or Debug with an execution mode.
                let mode = if self.multitask {
                    CollaborationMode::Multitask
                } else if self.original_mode == CollaborationMode::Multitask {
                    CollaborationMode::Agent
                } else {
                    self.original_mode
                };
                return Outcome::Apply {
                    effort: self.levels[self.selected],
                    mode,
                };
            }
            KeyCode::Esc if key.kind == KeyEventKind::Press => return Outcome::Dismiss,
            _ => {}
        }
        Outcome::Consumed
    }

    pub(crate) fn activate(&mut self, target: Target) -> Outcome {
        match target {
            Target::Level(index) => self.selected = index,
            Target::Multitask => self.multitask = !self.multitask,
        }
        Outcome::Consumed
    }

    pub(crate) fn tick(&mut self, now: Instant) -> bool {
        if self.levels[self.selected] != ReasoningEffort::Max {
            return false;
        }
        let phase = (now.saturating_duration_since(self.opened).as_millis() / 160 % 6) as usize;
        if phase == self.phase {
            return false;
        }
        self.phase = phase;
        true
    }

    fn description(&self) -> &'static str {
        match self.levels[self.selected] {
            ReasoningEffort::None => "No reasoning. Best for straightforward tasks.",
            ReasoningEffort::Minimal | ReasoningEffort::Low => {
                "Less reasoning for quick, straightforward tasks."
            }
            ReasoningEffort::Medium => "Balanced reasoning for everyday tasks.",
            ReasoningEffort::High => "More reasoning for complex tasks and careful verification.",
            ReasoningEffort::ExtraHigh => "Deeper reasoning for difficult tasks; may take longer.",
            ReasoningEffort::Max => {
                "Maximum reasoning. May use more tokens and take longer; use for the hardest tasks."
            }
        }
    }

    pub(crate) fn body_rows(&self, width: u16, context: RenderContext<'_>) -> u16 {
        self.description_row(width)
            + crate::render::wrap_lines(
                vec![Line::raw(context.localize(self.description()).into_owned())],
                width as usize,
            )
            .len() as u16
    }

    fn description_row(&self, width: u16) -> u16 {
        if width >= 70 { 5 } else { 7 }
    }

    fn layout(&self, area: Rect, context: RenderContext<'_>) -> Layout {
        let scale_width = if area.width >= 70 {
            area.width - 26
        } else {
            area.width
        };
        let slots = (scale_width / 8).max(1) as usize;
        let visible = slots.min(self.levels.len());
        let first = self.selected.saturating_sub(visible - 1);
        let step = if visible > 1 {
            scale_width.saturating_sub(7) / (visible - 1) as u16
        } else {
            scale_width
        };
        let levels = (first..first + visible)
            .map(|index| {
                let x = area.x + (index - first) as u16 * step;
                let width = if index + 1 == first + visible {
                    area.x + scale_width - x
                } else {
                    step
                };
                (index, Rect::new(x, area.y + 2, width, 1))
            })
            .collect();
        let toggle_width = crate::render::display_width(&format!(
            "{}  {}",
            context.localize("Multitask"),
            context.localize(if self.multitask { "on" } else { "off" })
        )) as u16;
        Layout {
            levels,
            toggle: if area.width >= 70 {
                Rect::new(
                    area.x + scale_width + 4,
                    area.y + 1,
                    toggle_width.min(22),
                    1,
                )
            } else {
                Rect::new(area.x, area.y + 4, toggle_width.min(area.width), 1)
            },
            scale_width,
        }
    }

    pub(crate) fn target_at(
        &self,
        area: Rect,
        position: Position,
        context: RenderContext<'_>,
    ) -> Option<Target> {
        if !area.contains(position) {
            return None;
        }
        let layout = self.layout(area, context);
        if layout.toggle.contains(position) {
            return Some(Target::Multitask);
        }
        layout
            .levels
            .iter()
            .find_map(|(index, rect)| rect.contains(position).then_some(Target::Level(*index)))
    }

    pub(crate) fn draw(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        hovered: Option<Target>,
        pressed: Option<Target>,
        context: RenderContext<'_>,
    ) {
        let layout = self.layout(area, context);
        let row = |offset, height| Rect::new(area.x, area.y + offset, area.width, height);
        let muted = Style::default().fg(context.muted());
        frame.render_widget(
            Paragraph::new(context.localize("Less reasoning → More reasoning")).style(muted),
            Rect::new(area.x, area.y, layout.scale_width, 1).intersection(area),
        );
        frame.render_widget(
            Paragraph::new("─".repeat(layout.scale_width as usize)).style(muted),
            Rect::new(area.x, area.y + 1, layout.scale_width, 1).intersection(area),
        );
        for (index, rect) in layout.levels {
            let target = Target::Level(index);
            let selected = self.selected == index;
            let level = self.levels[index];
            let interaction = InteractionState {
                selected,
                hovered: hovered == Some(target),
                pressed: pressed == Some(target),
                ..Default::default()
            };
            let style = Style::default()
                .fg(if selected {
                    context.focus()
                } else {
                    context.muted()
                })
                .patch(crate::render::interaction_style(context, interaction));
            let spans = if selected && level == ReasoningEffort::Max {
                // Theme colors retain terminal color-depth conversion and user palette choices.
                let colors = [
                    context.danger(),
                    context.warning(),
                    context.success(),
                    context.accent(),
                    context.function(),
                    context.mode_color(CollaborationMode::Multitask),
                ];
                "max"
                    .chars()
                    .enumerate()
                    .map(|(index, ch)| {
                        Span::styled(
                            ch.to_string(),
                            style
                                .fg(colors[(self.phase + index) % colors.len()])
                                .add_modifier(Modifier::BOLD),
                        )
                    })
                    .collect::<Vec<_>>()
            } else {
                vec![Span::styled(
                    level.as_str(),
                    if selected {
                        style.add_modifier(Modifier::BOLD)
                    } else {
                        style
                    },
                )]
            };
            frame.render_widget(Paragraph::new(Line::from(spans)), rect.intersection(area));
            if selected {
                frame.render_widget(
                    Paragraph::new("▲").style(Style::default().fg(context.focus())),
                    Rect::new(rect.x + level.as_str().len() as u16 / 2, area.y + 1, 1, 1)
                        .intersection(area),
                );
            }
        }
        let value = self.current.map_or_else(
            || crate::nls::Text::from("Default"),
            |level| crate::nls::Text::literal(level.as_str()),
        );
        let mut current = crate::nls::Text::template("Current: {0}", vec![value]);
        current.localize(context.language());
        frame.render_widget(
            Paragraph::new(current.to_string()).style(muted),
            row(3, 1).intersection(area),
        );
        let toggle = format!(
            "{}  {}",
            context.localize("Multitask"),
            context.localize(if self.multitask { "on" } else { "off" })
        );
        let style =
            Style::default()
                .fg(context.foreground())
                .patch(crate::render::interaction_style(
                    context,
                    InteractionState {
                        selected: self.multitask,
                        hovered: hovered == Some(Target::Multitask),
                        pressed: pressed == Some(Target::Multitask),
                        ..Default::default()
                    },
                ));
        frame.render_widget(
            Paragraph::new(toggle).style(style),
            layout.toggle.intersection(area),
        );
        let coordinator = if area.width >= 70 {
            Rect::new(layout.toggle.x, area.y + 2, 22, 1)
        } else {
            row(5, 1)
        };
        frame.render_widget(
            Paragraph::new(context.localize("Ash coordinates")).style(muted),
            coordinator.intersection(area),
        );
        let lines = crate::render::wrap_lines(
            vec![Line::raw(context.localize(self.description()).into_owned())],
            area.width as usize,
        );
        frame.render_widget(
            Paragraph::new(lines).style(muted),
            row(
                self.description_row(area.width),
                area.height.saturating_sub(self.description_row(area.width)),
            )
            .intersection(area),
        );
    }
}

struct Layout {
    levels: Vec<(usize, Rect)>,
    toggle: Rect,
    scale_width: u16,
}

#[cfg(test)]
#[path = "effort_selector_tests.rs"]
mod tests;
