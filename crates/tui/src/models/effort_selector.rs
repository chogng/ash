//! A staged effort edit. The catalog owns the levels; the host owns dismissal and placement.

use crate::keymap::KeyEvent;
use crate::render::InteractionState;
use crate::render::RenderContext;
use crate::widgets::key_hint::KeyHints;
use ash_protocol::CollaborationMode;
use ash_protocol::ReasoningEffort;
use crossterm::event::KeyCode;
use crossterm::event::KeyEventKind;
use ratatui::Frame;
use ratatui::layout::Alignment;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use std::time::Instant;

const LEVEL_CENTER_SPACING: u16 = 12;

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
    levels: Vec<ash_protocol::ModelReasoningEffortOption>,
    selected: usize,
    original_mode: CollaborationMode,
    multitask: bool,
    opened: Instant,
    phase: usize,
    hints: KeyHints,
}

impl EffortSelector {
    pub(super) fn new(
        levels: &[ash_protocol::ModelReasoningEffortOption],
        current: Option<ReasoningEffort>,
        mode: CollaborationMode,
    ) -> Self {
        // The validated catalog entry supplies at least one level, in provider order.
        assert!(!levels.is_empty());
        Self {
            levels: levels.to_vec(),
            selected: current
                .and_then(|value| levels.iter().position(|option| option.effort == value))
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
                    effort: self.levels[self.selected].effort,
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
        if self.levels[self.selected].effort != ReasoningEffort::Max && !self.multitask {
            return false;
        }
        let phase = (now.saturating_duration_since(self.opened).as_millis() / 80 % 48) as usize;
        if phase == self.phase {
            return false;
        }
        self.phase = phase;
        true
    }

    fn description(&self) -> &str {
        self.levels[self.selected]
            .description
            .as_deref()
            .unwrap_or_default()
    }

    pub(crate) fn body_rows(&self, width: u16, context: RenderContext<'_>) -> u16 {
        let layout = self.layout(Rect::new(0, 0, width, 0), context);
        layout.description.y
            + crate::render::wrap_lines(
                vec![Line::raw(context.localize(self.description()).into_owned())],
                layout.description.width as usize,
            )
            .len() as u16
    }

    fn layout(&self, area: Rect, context: RenderContext<'_>) -> Layout {
        // Catalog order sets the ticks. Label clearance sets the minimum spacing;
        // a narrow viewport compresses evenly, then scrolls to keep the edit visible.
        let label_width = self
            .levels
            .iter()
            .map(|option| option.effort.as_str().len() as u16)
            .max()
            .unwrap();
        let label_span = (label_width / 2 + 1) * 2 + 1;
        let visible = (1 + usize::from(area.width.saturating_sub(label_span) / label_span))
            .min(self.levels.len());
        let intervals = (visible - 1) as u16;
        let spacing = if intervals == 0 {
            0
        } else {
            LEVEL_CENTER_SPACING.min(area.width.saturating_sub(label_span) / intervals)
        };
        let end_labels_width = (crate::render::display_width(&context.localize("Faster"))
            + crate::render::display_width(&context.localize("Smarter"))
            + 2) as u16;
        let scale_width = (label_span + spacing * intervals)
            .max(end_labels_width)
            .min(area.width);
        let toggle_width = (crate::render::display_width(&context.localize("Multitask"))
            + 2
            + crate::render::display_width(&context.localize("on"))
                .max(crate::render::display_width(&context.localize("off"))))
            as u16;
        let alongside = area.width >= scale_width + 4 + toggle_width;
        let group_width = if alongside {
            scale_width + 4 + toggle_width
        } else {
            scale_width
        };
        let x = area.x + (area.width - group_width) / 2;
        let first = self.selected.saturating_sub(visible - 1);
        let first_center = x + scale_width.saturating_sub(spacing * intervals + 1) / 2;
        let levels = (first..first + visible)
            .map(|index| {
                let center = first_center + (index - first) as u16 * spacing;
                // Click ownership changes halfway between ticks, regardless of label length.
                let left = if index == first {
                    x
                } else {
                    center - spacing / 2
                };
                let right = if index + 1 == first + visible {
                    x + scale_width
                } else {
                    center + spacing.div_ceil(2)
                };
                let width = (self.levels[index].effort.as_str().len() as u16).min(scale_width);
                let label_x = center
                    .saturating_sub(width / 2)
                    .max(x)
                    .min(x + scale_width - width);
                LevelLayout {
                    index,
                    hit_area: Rect::new(left, area.y + 2, right - left, 1),
                    label: Rect::new(label_x, area.y + 2, width, 1),
                    marker: Position::new(center, area.y + 1),
                }
            })
            .collect();
        let description_row = if alongside { 4 } else { 6 };
        let description_width = area.width.min(84);
        Layout {
            levels,
            toggle: if alongside {
                Rect::new(x + scale_width + 4, area.y + 1, toggle_width, 1)
            } else {
                let width = toggle_width.min(area.width);
                Rect::new(area.x + (area.width - width) / 2, area.y + 4, width, 1)
            },
            axis: Rect::new(x, area.y + 1, scale_width, 1),
            description: Rect::new(
                area.x + (area.width - description_width) / 2,
                area.y + description_row,
                description_width,
                area.height.saturating_sub(description_row),
            ),
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
        layout.levels.iter().find_map(|level| {
            level
                .hit_area
                .contains(position)
                .then_some(Target::Level(level.index))
        })
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
        let muted = Style::default().fg(context.muted());
        let faster = context.localize("Faster");
        let smarter = context.localize("Smarter");
        let smarter_width = (crate::render::display_width(&smarter) as u16).min(layout.axis.width);
        frame.render_widget(
            Paragraph::new(faster).style(muted),
            Rect::new(layout.axis.x, area.y, layout.axis.width, 1).intersection(area),
        );
        frame.render_widget(
            Paragraph::new(smarter).style(muted),
            Rect::new(
                layout.axis.right() - smarter_width,
                area.y,
                smarter_width,
                1,
            )
            .intersection(area),
        );
        frame.render_widget(
            Paragraph::new("─".repeat(layout.axis.width as usize)).style(muted),
            layout.axis.intersection(area),
        );
        // Theme colors retain terminal color-depth conversion and user palette choices.
        let rainbow = [
            context.danger(),
            context.warning(),
            context.success(),
            context.accent(),
            context.function(),
            context.mode_color(CollaborationMode::Multitask),
        ];
        for LevelLayout {
            index,
            hit_area,
            label,
            marker,
        } in layout.levels
        {
            let target = Target::Level(index);
            let selected = self.selected == index;
            let level = self.levels[index].effort;
            // Colors belong to effort identities, so a model's subset or order
            // cannot change the meaning of a selected label and its arrow.
            let selected_color = match level {
                ReasoningEffort::None => context.foreground(),
                ReasoningEffort::Minimal => context.success(),
                ReasoningEffort::Low => context.warning(),
                ReasoningEffort::Medium => context.accent(),
                ReasoningEffort::High => context.focus(),
                ReasoningEffort::ExtraHigh => context.function(),
                ReasoningEffort::Max => rainbow[self.phase / 2 % rainbow.len()],
            };
            // The scale marks selection with its arrow and label; only pointer
            // interaction fills the wider hit area between ticks.
            let interaction = InteractionState {
                hovered: hovered == Some(target),
                pressed: pressed == Some(target),
                ..Default::default()
            };
            let style = Style::default()
                .fg(if selected {
                    selected_color
                } else {
                    context.muted()
                })
                .patch(crate::render::interaction_style(context, interaction));
            let spans = if selected && level == ReasoningEffort::Max {
                level
                    .as_str()
                    .chars()
                    .enumerate()
                    .map(|(index, ch)| {
                        Span::styled(
                            ch.to_string(),
                            style
                                .fg(rainbow[(self.phase / 2 + index) % rainbow.len()])
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
            frame.render_widget(
                ratatui::widgets::Block::default().style(style),
                hit_area.intersection(area),
            );
            frame.render_widget(Paragraph::new(Line::from(spans)), label.intersection(area));
            if selected {
                frame.render_widget(
                    Paragraph::new("▲").style(Style::default().fg(selected_color)),
                    Rect::new(marker.x, marker.y, 1, 1).intersection(area),
                );
            }
        }
        let toggle = format!(
            "{}  {}",
            context.localize("Multitask"),
            context.localize(if self.multitask { "on" } else { "off" })
        );
        let style = Style::default().fg(if self.multitask {
            context.mode_color(CollaborationMode::Multitask)
        } else {
            context.foreground()
        });
        let interaction = crate::render::interaction_style(
            context,
            InteractionState {
                hovered: hovered == Some(Target::Multitask),
                pressed: pressed == Some(Target::Multitask),
                ..Default::default()
            },
        );
        let toggle = if self.multitask {
            // The wave blends two theme text colors, independent of whether the
            // host terminal reported its background. Text and the on/off value stay stable.
            Line::from(
                toggle
                    .chars()
                    .enumerate()
                    .map(|(index, ch)| {
                        let wave = (self.phase as f32 * std::f32::consts::TAU / 48.0
                            - index as f32 * 0.5)
                            .cos();
                        let amount = (1.0 - wave) / 2.0;
                        Span::styled(
                            ch.to_string(),
                            context
                                .blend_style(
                                    style.add_modifier(Modifier::BOLD),
                                    context.function(),
                                    amount,
                                )
                                .patch(interaction),
                        )
                    })
                    .collect::<Vec<_>>(),
            )
        } else {
            Line::from(Span::styled(toggle, style.patch(interaction)))
        };
        frame.render_widget(Paragraph::new(toggle), layout.toggle.intersection(area));
        let lines = crate::render::wrap_lines(
            vec![Line::raw(context.localize(self.description()).into_owned())],
            layout.description.width as usize,
        );
        frame.render_widget(
            Paragraph::new(lines)
                .style(muted)
                .alignment(Alignment::Center),
            layout.description.intersection(area),
        );
    }
}

struct Layout {
    levels: Vec<LevelLayout>,
    toggle: Rect,
    axis: Rect,
    description: Rect,
}

struct LevelLayout {
    index: usize,
    hit_area: Rect,
    label: Rect,
    marker: Position,
}

#[cfg(test)]
#[path = "effort_selector_tests.rs"]
mod tests;

impl crate::app::command_panel::PanelContent for EffortSelector {
    fn body(&self) -> crate::app::command_panel::CommandPanelBody<'_> {
        use crate::app::command_panel::CommandPanelBody;
        CommandPanelBody::Effort(self)
    }
    fn key_hints(&self) -> &crate::widgets::key_hint::KeyHints {
        self.key_hints()
    }
}
