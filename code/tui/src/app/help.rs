use crate::keymap::KeymapActionSnapshot;
use crate::keymap::fixed_bindings;
use crate::thread::composer::SlashCommandCatalog;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::search_box::SearchBoxModel;
use ash_slash_commands::SlashCommandOrigin;

pub(crate) fn help_choices(
    slash_commands: &SlashCommandCatalog,
    shortcut_actions: Vec<KeymapActionSnapshot>,
    dictation_shortcut: Option<&str>,
) -> ListSelectionModel {
    let mut commands = Vec::new();
    let mut custom_commands = Vec::new();
    for command in slash_commands.commands() {
        let item = ListSelectionItem::new(format!("/{}", command.name))
            .with_description(&command.description);
        match slash_commands
            .origin(&command.name)
            .expect("every catalog command has an origin")
        {
            SlashCommandOrigin::Local => commands.push(item),
            SlashCommandOrigin::Server => custom_commands.push(item),
        }
    }

    ListSelectionModel::new(
        "Help",
        vec![
            ListSelectionGroup::new(
                "Shortcuts",
                shortcut_items(shortcut_actions, dictation_shortcut),
            ),
            ListSelectionGroup::new("Commands", commands),
            ListSelectionGroup::new(
                "Custom commands",
                non_empty(custom_commands, "No custom commands available"),
            ),
        ],
    )
    .with_search(SearchBoxModel::new("Search help"))
    .with_empty_message("No matching help entries")
}

fn shortcut_items(
    actions: Vec<KeymapActionSnapshot>,
    dictation_shortcut: Option<&str>,
) -> Vec<ListSelectionItem> {
    let mut items = Vec::new();
    if let Some(shortcut) = dictation_shortcut {
        items.push(
            ListSelectionItem::new(shortcut)
                .with_description("toggle dictation into the current draft"),
        );
    }
    for action in actions {
        for key in action.default_bindings {
            items.push(ListSelectionItem::new(key).with_description(action.label));
        }
        for binding in action.user_bindings {
            let description = match binding.when {
                Some(condition) => format!("{} when {condition} · custom", action.label),
                None => format!("{} · custom", action.label),
            };
            items.push(ListSelectionItem::new(binding.key).with_description(description));
        }
    }
    items.extend(
        fixed_bindings()
            .map(|(key, description)| ListSelectionItem::new(key).with_description(description)),
    );
    items
}

fn non_empty(items: Vec<ListSelectionItem>, label: &str) -> Vec<ListSelectionItem> {
    if items.is_empty() {
        vec![ListSelectionItem::new(label)]
    } else {
        items
    }
}

/// A local reference view; it never reads config or dispatches a command to open.
#[derive(Debug)]
pub(crate) struct Shortcuts {
    groups: Vec<ShortcutGroup>,
    scroll: usize,
    language: crate::nls::Language,
    hints: crate::widgets::key_hint::KeyHints,
}

#[derive(Debug)]
struct ShortcutGroup {
    title: &'static str,
    entries: Vec<(String, &'static str)>,
}

impl Shortcuts {
    pub(crate) fn new(keymap: &crate::keymap::AppKeymap, dictation: Option<&str>) -> Self {
        use crate::keymap::AppKeymapAction;
        use crate::keymap::AppKeymapContext;
        use crate::keymap::bindings;

        // Resolve in the same empty-composer context as the entry point so custom
        // bindings and blockers cannot leave a disabled default in the reference.
        let context = AppKeymapContext {
            accepts_input: true,
            chat_input_focused: true,
            has_selection: false,
            chat_input_empty: true,
            is_press: true,
        };
        let mut compose = ShortcutGroup {
            title: "Compose",
            entries: vec![
                ("/".into(), "Commands"),
                ("@".into(), "Mention files and plugins"),
                ("$".into(), "Select a skill"),
                ("Enter".into(), "Send message"),
                ("Shift+Enter / Ctrl+J".into(), "New line"),
                ("Ctrl+R".into(), "Search input history"),
            ],
        };
        if let Some(key) = keymap.action_hint(AppKeymapAction::ReadClipboardImage, context) {
            compose.entries.push((key, "Attach clipboard image"));
        }
        let mut session = ShortcutGroup {
            title: "Session",
            entries: vec![
                (bindings::SHORTCUT_HELP.keys(), "Keyboard shortcuts"),
                (bindings::DASHBOARD_OPEN.keys(), "Dashboard (empty input)"),
                (
                    format!("{0} {0}", bindings::CLOSE.keys()),
                    "Open rewind checkpoints",
                ),
            ],
        };
        for action in [
            AppKeymapAction::CycleCollaborationMode,
            AppKeymapAction::DecreaseReasoningEffort,
            AppKeymapAction::IncreaseReasoningEffort,
            AppKeymapAction::CycleApprovalMode,
            AppKeymapAction::OpenRewind,
            AppKeymapAction::CopyLastResponse,
            AppKeymapAction::InterruptOrQuit,
            AppKeymapAction::Suspend,
        ] {
            if let Some(key) = keymap.action_hint(action, context) {
                session.entries.push((key, action.label()));
            }
        }
        if let Some(key) = dictation {
            session.entries.push((key.into(), "Toggle dictation"));
        }
        let transcript = ShortcutGroup {
            title: "Transcript",
            entries: vec![
                ("PageUp / PageDown".into(), "Scroll transcript"),
                ("Ctrl+Home / Ctrl+End".into(), "Oldest / latest"),
                ("Ctrl+↑ / Ctrl+↓".into(), "Select a message"),
                (
                    bindings::TRANSCRIPT_EXPAND.keys(),
                    "Expand selected message",
                ),
                (
                    bindings::TRANSCRIPT_DETAILS.keys(),
                    "View selected message details",
                ),
                (bindings::RETURN_INPUT.keys(), "Return to input"),
            ],
        };
        Self {
            groups: vec![compose, session, transcript],
            scroll: 0,
            language: crate::nls::Language::English,
            hints: crate::widgets::key_hint::KeyHints::compact()
                .with_compact_action("↑/↓", "scroll")
                .with_binding(bindings::CLOSE),
        }
    }

    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        self.language = language;
    }

    pub(crate) fn key_hints(&self) -> &crate::widgets::key_hint::KeyHints {
        &self.hints
    }

    pub(crate) fn handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
        area: ratatui::layout::Rect,
    ) -> super::command_panel::CommandPanelOutcome {
        use super::command_panel::CommandPanelOutcome;
        if key.kind == crossterm::event::KeyEventKind::Press
            && (crate::keymap::bindings::DISMISS_LIST.matches(key)
                || crate::keymap::bindings::SHORTCUT_HELP.matches(key))
        {
            return CommandPanelOutcome::Dismiss;
        }
        if let Some(navigation) = crate::widgets::navigation::Navigation::from_key(key) {
            let rows = self
                .styled_lines(
                    area.width,
                    self.language,
                    Default::default(),
                    Default::default(),
                    Default::default(),
                )
                .len();
            let last = rows.saturating_sub(area.height.into());
            self.scroll = navigation.offset(self.scroll, last, area.height.into());
        }
        CommandPanelOutcome::Consumed
    }

    pub(crate) fn body_rows(&self, width: u16, context: crate::render::RenderContext<'_>) -> u16 {
        self.lines(width, context).len().min(usize::from(u16::MAX)) as u16
    }

    pub(crate) fn draw(
        &self,
        frame: &mut ratatui::Frame<'_>,
        area: ratatui::layout::Rect,
        context: crate::render::RenderContext<'_>,
    ) {
        let lines = self.lines(area.width, context);
        let scroll = self
            .scroll
            .min(lines.len().saturating_sub(area.height.into()));
        frame.render_widget(
            ratatui::widgets::Paragraph::new(lines).scroll((scroll as u16, 0)),
            area,
        );
    }

    fn lines(
        &self,
        width: u16,
        context: crate::render::RenderContext<'_>,
    ) -> Vec<ratatui::text::Line<'static>> {
        use ratatui::style::Modifier;
        use ratatui::style::Style;
        self.styled_lines(
            width,
            context.language(),
            Style::default()
                .fg(context.focus())
                .add_modifier(Modifier::BOLD),
            Style::default().fg(context.foreground()),
            Style::default().fg(context.muted()),
        )
    }

    fn styled_lines(
        &self,
        width: u16,
        language: crate::nls::Language,
        key_style: ratatui::style::Style,
        text_style: ratatui::style::Style,
        muted_style: ratatui::style::Style,
    ) -> Vec<ratatui::text::Line<'static>> {
        use ratatui::style::Modifier;
        use ratatui::text::Line;
        use ratatui::text::Span;
        use unicode_width::UnicodeWidthStr;

        let columns = match width {
            120.. => 3,
            72.. => 2,
            _ => 1,
        };
        let gap = 4;
        let column_width = usize::from(width).saturating_sub(gap * (columns - 1)) / columns;
        let mut lines = Vec::new();
        for groups in self.groups.chunks(columns) {
            let blocks = groups
                .iter()
                .map(|group| {
                    let mut rows = crate::render::wrap_lines(
                        vec![Line::styled(
                            crate::nls::localize(language, group.title).into_owned(),
                            text_style.add_modifier(Modifier::BOLD),
                        )],
                        column_width,
                    );
                    let key_width = group
                        .entries
                        .iter()
                        .map(|(key, _)| key.width())
                        .max()
                        .unwrap_or(0);
                    for (key, description) in &group.entries {
                        let description = crate::nls::localize(language, description).into_owned();
                        if key_width + 2 >= column_width {
                            rows.extend(crate::render::wrap_lines(
                                vec![Line::styled(key.clone(), key_style)],
                                column_width,
                            ));
                            rows.extend(crate::render::wrap_lines(
                                vec![Line::styled(description, text_style)],
                                column_width,
                            ));
                        } else {
                            let description_rows = crate::render::wrap_lines(
                                vec![Line::styled(description, text_style)],
                                column_width - key_width - 2,
                            );
                            for (index, row) in description_rows.into_iter().enumerate() {
                                let mut line = if index == 0 {
                                    Line::from(vec![
                                        Span::styled(key.clone(), key_style),
                                        Span::raw(" ".repeat(key_width + 2 - key.width())),
                                    ])
                                } else {
                                    Line::from(Span::raw(" ".repeat(key_width + 2)))
                                };
                                line.spans.extend(row.spans);
                                rows.push(line);
                            }
                        }
                    }
                    rows
                })
                .collect::<Vec<_>>();
            let height = blocks.iter().map(Vec::len).max().unwrap_or(0);
            for row in 0..height {
                let mut line = Line::default();
                for (index, block) in blocks.iter().enumerate() {
                    let content = block.get(row).cloned().unwrap_or_default();
                    let used = content.width();
                    line.spans.extend(content.spans);
                    if index + 1 < blocks.len() {
                        line.spans.push(Span::raw(
                            " ".repeat(column_width.saturating_sub(used) + gap),
                        ));
                    }
                }
                lines.push(line);
            }
            lines.push(Line::default());
        }
        lines.extend(crate::render::wrap_lines(
            vec![Line::from(vec![
                Span::styled("/shortcuts", key_style),
                Span::styled(
                    format!(" {}", crate::nls::localize(language, "customize")),
                    muted_style,
                ),
            ])],
            width.into(),
        ));
        lines
    }
}

#[cfg(test)]
#[path = "help_tests.rs"]
mod tests;
