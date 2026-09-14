use crate::keymap::bindings;
use crate::render::InteractionState;
use crate::render::InteractionTarget;
use crate::render::RenderContext;
use crate::render::interaction_style;
use crate::render::selection_marker;
use crate::thread::composer::ChatInput;
use crate::thread::composer::ChatSubmission;
use crate::thread::composer::QueuedChatInput;
use crate::widgets::navigation::Navigation;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use std::ops::Range;

pub(crate) const DEFAULT_MAX_VISIBLE_ITEMS: usize = 3;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct QueueId(u64);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct QueueTarget {
    pub(crate) queue_id: QueueId,
    pub(crate) command_id: ash_protocol::CommandId,
    pub(crate) revision: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum QueueAction {
    Pause,
    Replace(ChatSubmission),
    Move(queue::QueueMove),
    Send(Option<ash_protocol::TurnId>),
}

#[derive(Debug, Eq, PartialEq)]
struct QueueEntry {
    id: QueueId,
    command_id: ash_protocol::CommandId,
    revision: Option<i64>,
    input: Option<QueuedChatInput>,
    display_text: String,
    sending: bool,
    paused: bool,
}

/// Keeps drafts and a view of the backend queue. Dispatch belongs to App Server.
#[derive(Debug, Default, Eq, PartialEq)]
pub(crate) struct Queue {
    next_id: u64,
    entries: Vec<QueueEntry>,
    editing: Option<QueueId>,
}

impl Queue {
    pub(crate) fn push(&mut self, input: QueuedChatInput) -> QueueId {
        if let Some(id) = self.editing.take()
            && let Some(entry) = self.entries.iter_mut().find(|entry| entry.id == id)
        {
            entry.display_text = input.display_text().to_owned();
            entry.input = Some(input);
            return id;
        }
        let id = QueueId(self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        self.entries.push(QueueEntry {
            id,
            command_id: crate::client::new_command_id("queue"),
            revision: None,
            display_text: input.display_text().to_owned(),
            input: Some(input),
            sending: false,
            paused: false,
        });
        id
    }

    pub(crate) fn submit(&mut self, id: QueueId) -> Option<crate::thread::Command> {
        let entry = self.entries.iter_mut().find(|entry| entry.id == id)?;
        if entry.sending {
            return None;
        }
        let submission = entry.input.as_ref()?.submission().clone();
        entry.sending = true;
        Some(match entry.revision {
            Some(revision) => crate::thread::Command::EditQueue {
                target: QueueTarget {
                    queue_id: id,
                    command_id: entry.command_id.clone(),
                    revision,
                },
                action: QueueAction::Replace(submission),
            },
            None => crate::thread::Command::Enqueue {
                queue_id: id,
                command_id: entry.command_id.clone(),
                submission,
            },
        })
    }

    pub(crate) fn target(&mut self, id: QueueId) -> Option<QueueTarget> {
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.id == id && !entry.sending)?;
        let target = QueueTarget {
            queue_id: id,
            command_id: entry.command_id.clone(),
            revision: entry.revision?,
        };
        entry.sending = true;
        Some(target)
    }

    pub(crate) fn apply(&mut self, messages: Vec<queue::QueuedMessage>) -> Result<(), String> {
        let messages = messages
            .into_iter()
            .map(|message| {
                let submission = submission(&message.request.input)?;
                Ok((message, submission))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut previous = std::mem::take(&mut self.entries);
        let mut entries = Vec::new();
        for (message, submission) in messages {
            let existing = previous
                .iter()
                .position(|entry| entry.command_id == message.request.command_id)
                .map(|index| previous.remove(index));
            if matches!(
                message.status,
                queue::QueueStatus::Started | queue::QueueStatus::Cancelled
            ) {
                continue;
            }
            let mut entry = match existing {
                Some(entry) => entry,
                None => {
                    let id = QueueId(self.next_id);
                    self.next_id = self.next_id.saturating_add(1);
                    QueueEntry {
                        id,
                        command_id: message.request.command_id,
                        revision: None,
                        display_text: submission.display_text.clone(),
                        input: Some(QueuedChatInput::from_submission(submission.clone())),
                        sending: false,
                        paused: false,
                    }
                }
            };
            if entry
                .revision
                .is_none_or(|revision| revision <= message.revision)
            {
                entry.revision = Some(message.revision);
                entry.sending = message.status == queue::QueueStatus::Delivering;
                entry.paused = message.status == queue::QueueStatus::Paused;
                entry.display_text = match message.error {
                    Some(error) => format!("{} · {error}", submission.display_text),
                    None => submission.display_text.clone(),
                };
                if self.editing != Some(entry.id) {
                    entry.input = Some(QueuedChatInput::from_submission(submission));
                }
            }
            entries.push(entry);
        }
        entries.extend(
            previous
                .into_iter()
                .filter(|entry| entry.revision.is_none()),
        );
        self.entries = entries;
        Ok(())
    }

    pub(crate) fn restore(&mut self, id: QueueId, input: &mut ChatInput) -> Result<(), String> {
        if !input.is_empty() {
            return Err("clear the current draft before restoring a queued message".into());
        }
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.id == id && !entry.sending)
            .ok_or("the queued message is no longer editable")?;
        let queued = entry
            .input
            .take()
            .ok_or("the queued message is already being edited")?;
        match input.restore_queued(queued) {
            Ok(()) => {
                self.editing = Some(id);
                Ok(())
            }
            Err(queued) => {
                entry.input = Some(*queued);
                Err("clear the current draft before restoring a queued message".into())
            }
        }
    }

    pub(crate) fn is_editing(&self) -> bool {
        self.editing.is_some()
    }

    pub(crate) fn finish_edit(&mut self) {
        self.editing = None;
    }
    pub(crate) fn fail_send(&mut self, id: QueueId) -> bool {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.id == id) {
            entry.sending = false;
            true
        } else {
            false
        }
    }
    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.editing = None;
    }
    pub(crate) fn view(&self, navigation: &QueueNavigation) -> QueueView<'_> {
        QueueView {
            focused: navigation.focused(self),
            selected: navigation.selected,
            items: self
                .entries
                .iter()
                .enumerate()
                .map(|(index, entry)| QueueItemView {
                    id: entry.id,
                    position: index + 1,
                    text: &entry.display_text,
                    sending: entry.sending,
                    editing: self.editing == Some(entry.id),
                    paused: entry.paused,
                })
                .collect(),
        }
    }
}

/// Selection and focus for one mode's view of a shared message queue.
#[derive(Debug, Default, Eq, PartialEq)]
pub(crate) struct QueueNavigation {
    selected: Option<QueueId>,
}

impl QueueNavigation {
    pub(crate) fn focused(&self, queue: &Queue) -> bool {
        self.selected.is_some_and(|selected| {
            queue
                .entries
                .iter()
                .any(|entry| entry.id == selected && !entry.sending && entry.input.is_some())
        })
    }

    pub(crate) fn blur(&mut self) {
        self.selected = None;
    }

    pub(crate) fn reconcile(&mut self, queue: &Queue) {
        if let Some(selected) = self.selected {
            // An in-flight edit temporarily disables a row without changing its selection.
            if queue
                .entries
                .iter()
                .any(|entry| entry.id == selected && entry.input.is_some())
            {
                return;
            }
            self.selected = None;
            self.focus_latest(queue);
        }
    }

    pub(crate) fn focus_latest(&mut self, queue: &Queue) -> bool {
        let Some(id) = queue
            .entries
            .iter()
            .rev()
            .find(|entry| !entry.sending && entry.input.is_some())
            .map(|entry| entry.id)
        else {
            return false;
        };
        self.selected = Some(id);
        true
    }

    pub(crate) fn focus(&mut self, queue: &Queue, id: QueueId) -> bool {
        let selectable = queue
            .entries
            .iter()
            .any(|entry| entry.id == id && !entry.sending && entry.input.is_some());
        if selectable {
            self.selected = Some(id);
        }
        selectable
    }

    pub(crate) fn handle_key(&mut self, queue: &Queue, key: KeyEvent) -> QueueKeyOutcome {
        if !self.focused(queue) {
            return QueueKeyOutcome::Unhandled;
        }
        if let Some(navigation) = Navigation::from_key(key) {
            let ids: Vec<_> = queue
                .entries
                .iter()
                .filter(|entry| !entry.sending && entry.input.is_some())
                .map(|entry| entry.id)
                .collect();
            if let Some(last) = ids.len().checked_sub(1) {
                let current = ids
                    .iter()
                    .position(|id| Some(*id) == self.selected)
                    .unwrap_or(0);
                self.selected = Some(ids[navigation.offset(current, last, 3)]);
            }
            return QueueKeyOutcome::Consumed;
        }
        if key.kind != KeyEventKind::Press {
            return QueueKeyOutcome::Consumed;
        }
        let Some(id) = self.selected else {
            return QueueKeyOutcome::Consumed;
        };
        if bindings::QUEUE_UP.matches(key) {
            QueueKeyOutcome::Move(id, queue::QueueMove::Up)
        } else if bindings::QUEUE_DOWN.matches(key) {
            QueueKeyOutcome::Move(id, queue::QueueMove::Down)
        } else if bindings::QUEUE_EDIT.matches(key) {
            QueueKeyOutcome::Restore(id)
        } else if bindings::QUEUE_SEND.matches(key) {
            QueueKeyOutcome::Send(id)
        } else if bindings::QUEUE_REMOVE.matches(key) {
            if let Some(index) = queue.entries.iter().position(|entry| entry.id == id) {
                self.selected = queue
                    .entries
                    .iter()
                    .skip(index + 1)
                    .chain(queue.entries[..index].iter().rev())
                    .find(|entry| !entry.sending && entry.input.is_some())
                    .map(|entry| entry.id);
            }
            QueueKeyOutcome::Delete(id)
        } else if bindings::RETURN_INPUT.matches(key) {
            self.blur();
            QueueKeyOutcome::Consumed
        } else if bindings::INTERRUPT.matches(key) {
            QueueKeyOutcome::Unhandled
        } else {
            QueueKeyOutcome::Consumed
        }
    }
}

fn submission(input: &[ash_protocol::UserInput]) -> Result<ChatSubmission, String> {
    let mut values = Vec::new();
    let mut display = Vec::new();
    for item in input {
        match item {
            ash_protocol::UserInput::Context {
                name,
                content,
                file_path,
            } => {
                values.push(crate::thread::composer::ChatInputItem::Context {
                    name: name.clone(),
                    content: content.clone(),
                    file_path: file_path.clone(),
                });
                display.push(format!("[Context: {name}]"));
            }
            ash_protocol::UserInput::Text { text } => {
                values.push(crate::thread::composer::ChatInputItem::Text(text.clone()));
                display.push(text.clone());
            }
            ash_protocol::UserInput::ImageAttachment { attachment } => {
                values.push(crate::thread::composer::ChatInputItem::Attachment(
                    attachment.clone(),
                ));
                display.push("[Image]".into());
            }
            ash_protocol::UserInput::Skill { skill } => {
                values.push(crate::thread::composer::ChatInputItem::Skill {
                    skill: skill.clone(),
                });
            }
            ash_protocol::UserInput::Instruction { reference } => {
                values.push(crate::thread::composer::ChatInputItem::Instruction {
                    reference: reference.clone(),
                });
                display.push(format!(
                    "[Instruction: {}]",
                    reference.relative_path.display()
                ));
            }
            _ => return Err("queued input contains a type this composer cannot edit".into()),
        }
    }
    Ok(ChatSubmission {
        display_text: display.join(" "),
        input: values,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct QueueItemView<'a> {
    pub(crate) id: QueueId,
    pub(crate) position: usize,
    pub(crate) text: &'a str,
    pub(crate) sending: bool,
    pub(crate) editing: bool,
    pub(crate) paused: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum QueueKeyOutcome {
    Restore(QueueId),
    Send(QueueId),
    Delete(QueueId),
    Move(QueueId, queue::QueueMove),
    Consumed,
    Unhandled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct QueueView<'a> {
    pub(crate) focused: bool,
    pub(crate) selected: Option<QueueId>,
    pub(crate) items: Vec<QueueItemView<'a>>,
}

pub(crate) fn desired_height(view: &QueueView<'_>, max_visible_items: usize) -> u16 {
    u16::try_from(view.items.len().min(max_visible_items)).unwrap_or(u16::MAX)
}

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    view: &QueueView<'_>,
    max_visible_items: usize,
    hovered: Option<QueueId>,
    pressed: Option<QueueId>,
    context: RenderContext<'_>,
) {
    let range = visible_range(view, max_visible_items);
    let lines = view
        .items
        .get(range.clone())
        .unwrap_or_default()
        .iter()
        .map(|item| {
            let selected = view.focused && view.selected == Some(item.id);
            let state = if item.sending {
                " · sending"
            } else if item.editing {
                " · editing"
            } else if item.paused {
                " · paused"
            } else {
                ""
            };
            let next = if item.position == 1 { " · next" } else { "" };
            Line::styled(
                format!(
                    "{}Queue {}: {}{next}{state}",
                    selection_marker(selected),
                    item.position,
                    item.text
                ),
                if selected || hovered == Some(item.id) || pressed == Some(item.id) {
                    interaction_style(
                        context,
                        InteractionState {
                            target: InteractionTarget::Rest,
                            selected,
                            hovered: hovered == Some(item.id),
                            pressed: pressed == Some(item.id),
                        },
                    )
                } else {
                    Style::default().fg(context.muted())
                },
            )
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), area);
    for (row, item) in view.items.get(range).unwrap_or_default().iter().enumerate() {
        let selected = view.focused && view.selected == Some(item.id);
        let hovered = hovered == Some(item.id);
        let pressed = pressed == Some(item.id);
        if selected || hovered || pressed {
            frame.buffer_mut().set_style(
                Rect::new(area.x, area.y.saturating_add(row as u16), area.width, 1),
                interaction_style(
                    context,
                    InteractionState {
                        target: InteractionTarget::Rest,
                        selected,
                        hovered,
                        pressed,
                    },
                ),
            );
        }
    }
}

pub(crate) fn pointer_target_at(
    area: Rect,
    view: &QueueView<'_>,
    max_visible_items: usize,
    position: ratatui::layout::Position,
) -> Option<QueueId> {
    if !area.contains(position) {
        return None;
    }
    let range = visible_range(view, max_visible_items);
    view.items
        .get(range.start + usize::from(position.y - area.y))
        .map(|item| item.id)
}

fn visible_range(view: &QueueView<'_>, max_visible_items: usize) -> Range<usize> {
    let visible = view.items.len().min(max_visible_items);
    let selected = view
        .selected
        .and_then(|selected| view.items.iter().position(|item| item.id == selected));
    let start = selected
        .map(|selected| selected.saturating_add(1).saturating_sub(visible))
        .unwrap_or_else(|| view.items.len().saturating_sub(visible));
    start..start.saturating_add(visible)
}

#[cfg(test)]
#[path = "queue_tests.rs"]
mod tests;
