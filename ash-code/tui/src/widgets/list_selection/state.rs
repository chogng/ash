use crate::keymap::bindings;
use crate::keymap::bindings::Keybinding;
use crate::nls::Text;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use ratatui::style::Color;

use super::ListSelectionPreview;
use super::matcher::selection_match_score;
use crate::widgets::key_hint::KeyHints;
use crate::widgets::navigation::Navigation;
use crate::widgets::search_box::SEARCH_BOX_HEIGHT;
use crate::widgets::search_box::SearchBoxInputOutcome;
use crate::widgets::search_box::SearchBoxModel;
use crate::widgets::search_box::SearchBoxState;
use crate::widgets::tab_list;
use crate::widgets::tab_list::FocusedTabListInputOutcome;
use crate::widgets::tab_list::TabListInputOutcome;
use crate::widgets::tab_list::TabListItem;
use crate::widgets::tab_list::TabListState;

const PAGE_ROWS: usize = 12;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ListSelectionItem {
    id: Option<ListSelectionItemId>,
    label: Text,
    description: Option<Text>,
    columns: Option<ListSelectionItemColumns>,
    selection_foreground: Option<Color>,
    presentation_focus: Option<Color>,
    preview: Option<ListSelectionPreview>,
    section_heading: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ListSelectionItemColumns {
    pub(super) leading: String,
    pub(super) middle: String,
    pub(super) trailing: String,
}

impl ListSelectionItem {
    pub(crate) fn new(label: impl Into<Text>) -> Self {
        Self {
            id: None,
            label: label.into(),
            description: None,
            columns: None,
            selection_foreground: None,
            presentation_focus: None,
            preview: None,
            section_heading: false,
        }
    }

    pub(crate) fn with_id(mut self, id: ListSelectionItemId) -> Self {
        self.id = Some(id);
        self
    }

    pub(crate) fn with_description(mut self, description: impl Into<Text>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub(crate) fn as_section_heading(mut self) -> Self {
        self.section_heading = true;
        self
    }

    pub(crate) fn section_heading(&self) -> bool {
        self.section_heading
    }

    pub(crate) fn with_columns(
        mut self,
        leading: impl Into<String>,
        middle: impl Into<String>,
        trailing: impl Into<String>,
    ) -> Self {
        let columns = ListSelectionItemColumns {
            leading: leading.into(),
            middle: middle.into(),
            trailing: trailing.into(),
        };
        self.description = Some(format!("{} {}", columns.middle, columns.trailing).into());
        self.columns = Some(columns);
        self
    }

    pub(crate) fn with_selection_foreground(mut self, color: Color) -> Self {
        self.selection_foreground = Some(color);
        self
    }

    pub(crate) fn with_presentation_focus(mut self, color: Color) -> Self {
        self.presentation_focus = Some(color);
        self
    }

    pub(crate) fn with_preview(mut self, preview: ListSelectionPreview) -> Self {
        self.preview = Some(preview);
        self
    }

    pub(crate) fn label(&self) -> &str {
        &self.label
    }

    pub(crate) fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub(super) fn detail(&self) -> Option<&str> {
        self.columns
            .as_ref()
            .map(|columns| columns.middle.as_str())
            .or(self.description())
            .filter(|description| !description.is_empty())
    }

    pub(super) fn columns(&self) -> Option<&ListSelectionItemColumns> {
        self.columns.as_ref()
    }

    pub(crate) fn id(&self) -> Option<&ListSelectionItemId> {
        self.id.as_ref()
    }

    pub(crate) fn selection_foreground(&self) -> Option<Color> {
        self.selection_foreground
    }

    pub(crate) fn presentation_focus(&self) -> Option<Color> {
        self.presentation_focus
    }

    pub(crate) fn preview(&self) -> Option<&ListSelectionPreview> {
        self.preview.as_ref()
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct ListSelectionItemId(String);

impl ListSelectionItemId {
    pub(crate) fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ListSelectionGroup {
    label: Text,
    items: Vec<ListSelectionItem>,
}

impl ListSelectionGroup {
    pub(crate) fn new(label: impl Into<Text>, items: Vec<ListSelectionItem>) -> Self {
        Self {
            label: label.into(),
            items,
        }
    }

    pub(crate) fn label(&self) -> &str {
        &self.label
    }
}

impl TabListItem for ListSelectionGroup {
    fn tab_label(&self) -> &str {
        self.label()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ListSelectionModel {
    tabs: Vec<ListSelectionGroup>,
    presentation: ListSelectionPresentation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ListSelectionPresentation {
    title: Text,
    action: Option<ListSelectionItem>,
    scroll_counts: bool,
    search: Option<SearchBoxModel>,
    filter_input: bool,
    empty_message: String,
    activation: Keybinding,
    show_activation_hint: bool,
    dismiss: Keybinding,
    key_hints: KeyHints,
    show_tabs: bool,
    initial_selected: usize,
    expandable: bool,
}

impl ListSelectionModel {
    pub(crate) fn new(title: impl Into<Text>, tabs: Vec<ListSelectionGroup>) -> Self {
        assert!(
            !tabs.is_empty(),
            "a selection view requires at least one tab"
        );
        Self {
            tabs,
            presentation: ListSelectionPresentation {
                title: title.into(),
                action: None,
                scroll_counts: true,
                search: None,
                filter_input: true,
                empty_message: "No matching items".into(),
                activation: bindings::ACCEPT,
                show_activation_hint: false,
                dismiss: bindings::DISMISS_LIST,
                key_hints: KeyHints::new(),
                show_tabs: true,
                initial_selected: 0,
                expandable: false,
            },
        }
    }

    pub(crate) fn with_expandable_descriptions(mut self) -> Self {
        self.presentation.expandable = true;
        self
    }

    pub(crate) fn with_action(mut self, action: ListSelectionItem) -> Self {
        self.presentation.action = Some(action);
        self
    }

    pub(crate) fn without_scroll_counts(mut self) -> Self {
        self.presentation.scroll_counts = false;
        self
    }

    pub(crate) fn with_activation(mut self, shortcut: Keybinding) -> Self {
        self.presentation.activation = shortcut;
        self.presentation.show_activation_hint = true;
        self
    }

    pub(crate) fn with_dismiss(mut self, shortcut: Keybinding) -> Self {
        self.presentation.dismiss = shortcut;
        self
    }

    pub(crate) fn with_key_hint_note(mut self, note: impl Into<String>) -> Self {
        self.presentation.key_hints = self.presentation.key_hints.with_note(note);
        self
    }

    pub(crate) fn without_tab_bar(mut self) -> Self {
        self.presentation.show_tabs = false;
        self
    }

    pub(crate) fn with_initial_selected(mut self, index: usize) -> Self {
        self.presentation.initial_selected = index;
        self
    }

    pub(crate) fn with_search(mut self, search: SearchBoxModel) -> Self {
        self.presentation.search = Some(search);
        self.presentation.filter_input = true;
        self
    }

    /// Displays an input field whose value does not filter the list.
    pub(crate) fn with_input(mut self, input: SearchBoxModel) -> Self {
        self.presentation.search = Some(input);
        self.presentation.filter_input = false;
        self
    }

    pub(crate) fn with_empty_message(mut self, message: impl Into<String>) -> Self {
        self.presentation.empty_message = message.into();
        self
    }

    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        localize_presentation(&mut self.presentation, language);
        localize_groups(&mut self.tabs, language);
    }

    pub(super) fn show_tabs(&self) -> bool {
        self.presentation.show_tabs
    }

    pub(crate) fn key_hints(&self) -> KeyHints {
        let presentation = &self.presentation;
        if presentation.expandable {
            let mut hints = KeyHints::compact()
                .with_compact_action(
                    presentation.activation.keys(),
                    presentation.activation.action(),
                )
                .with_compact_action("←/→", "details");
            if presentation.show_tabs {
                hints = hints.with_compact_action("Tab", "tabs");
            }
            if presentation.search.is_some() {
                hints = hints.with_compact_action("/", "search");
            }
            return hints
                .with_compact_action(presentation.dismiss.keys(), presentation.dismiss.action())
                .extend(presentation.key_hints.clone());
        }
        let mut hints = KeyHints::new();
        if presentation.show_activation_hint {
            hints = hints.with_binding(presentation.activation);
        }
        if presentation.show_tabs {
            hints = hints.with_binding(bindings::TABS);
        }
        if presentation.search.is_some() {
            hints = hints.with_binding(bindings::SEARCH);
        }
        hints
            .with_binding(presentation.dismiss)
            .extend(presentation.key_hints.clone())
    }

    fn into_parts(self) -> (ListSelectionPresentation, Vec<ListSelectionGroup>) {
        (self.presentation, self.tabs)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ListSelectionInputOutcome {
    Activate(ListSelectionItemId),
    Adjust(ListSelectionItemId, ListSelectionAdjustment),
    Consumed,
    Dismiss,
    FocusPrevious,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ListSelectionAdjustment {
    Previous,
    Next,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ListSelectionState {
    pub(super) scroll_offset: Option<usize>,
    model: ListSelectionPresentation,
    tabs: TabListState<ListSelectionGroup>,
    selected_visible: Option<usize>,
    search: Option<SearchBoxState>,
    focus: ListSelectionFocus,
    message: Option<String>,
    expanded: std::collections::BTreeSet<ListSelectionItemId>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ListSelectionFocus {
    Tabs,
    Action,
    Search,
    Items,
}

impl ListSelectionState {
    pub(crate) fn new(model: ListSelectionModel) -> Self {
        let (model, tabs) = model.into_parts();
        let search = model.search.clone().map(SearchBoxState::new);
        let mut state = Self {
            scroll_offset: None,
            model,
            tabs: TabListState::new(tabs),
            selected_visible: None,
            search,
            focus: ListSelectionFocus::Items,
            message: None,
            expanded: Default::default(),
        };
        state.selected_visible = (state.visible_len() > 0).then_some(
            state
                .model
                .initial_selected
                .min(state.visible_len().saturating_sub(1)),
        );
        state.skip_section_heading(ListSelectionDirection::Next);
        state
    }

    pub(crate) fn replace_model(&mut self, model: ListSelectionModel) {
        let selected = self.selected_item().and_then(|item| item.id()).cloned();
        let (model, tabs) = model.into_parts();
        self.search = match (self.search.take(), model.search.clone()) {
            (Some(mut state), Some(search_model)) => {
                state.replace_model(search_model);
                Some(state)
            }
            (None, Some(search_model)) => Some(SearchBoxState::new(search_model)),
            (_, None) => None,
        };
        self.model = model;
        self.tabs.replace_tabs(tabs);
        self.expanded.retain(|id| {
            self.tabs
                .tabs()
                .iter()
                .any(|group| group.items.iter().any(|item| item.id() == Some(id)))
        });
        if let Some(id) = selected
            && let Some(index) = self
                .visible_items()
                .iter()
                .position(|item| item.id() == Some(&id))
        {
            self.selected_visible = Some(index);
        }
        self.reconcile_selection();
        if self.focus == ListSelectionFocus::Search && self.search.is_none()
            || self.focus == ListSelectionFocus::Tabs && !self.show_tabs()
            || self.focus == ListSelectionFocus::Action && !self.has_action()
        {
            self.focus = ListSelectionFocus::Items;
        }
        self.sync_search_focus();
    }

    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        localize_presentation(&mut self.model, language);
        if let Some(search) = self.search.as_mut() {
            search.localize(language);
        }
        localize_groups(self.tabs.tabs_mut(), language);
        if let Some(message) = self.message.as_mut() {
            *message = crate::nls::localize_owned(language, &*message);
        }
    }

    pub(super) fn expandable(&self) -> bool {
        self.model.expandable
    }

    pub(super) fn expanded(&self, item: &ListSelectionItem) -> bool {
        item.id().is_some_and(|id| self.expanded.contains(id))
    }

    pub(crate) fn title(&self) -> &str {
        &self.model.title
    }

    pub(crate) fn localized_title(&self, language: crate::nls::Language) -> String {
        let mut title = self.model.title.clone();
        title.localize(language);
        title.to_string()
    }

    pub(crate) fn set_message(&mut self, message: Option<String>) {
        self.message = message;
    }

    pub(crate) fn message(&self) -> Option<&str> {
        self.message.as_deref()
    }

    /// Selects a stable item across groups and moves keyboard focus to it.
    pub(crate) fn focus_item(&mut self, id: &ListSelectionItemId) -> bool {
        self.scroll_offset = None;
        let Some((tab, item)) = self
            .tabs
            .tabs()
            .iter()
            .enumerate()
            .find_map(|(tab, group)| {
                group
                    .items
                    .iter()
                    .position(|item| item.id() == Some(id))
                    .map(|item| (tab, item))
            })
        else {
            return false;
        };
        self.tabs.select(tab);
        self.selected_visible = self
            .visible_indices()
            .iter()
            .position(|index| *index == item);
        self.set_focus(ListSelectionFocus::Items);
        true
    }

    pub(crate) fn tabs(&self) -> &[ListSelectionGroup] {
        self.tabs.tabs()
    }

    pub(crate) fn focus_search(&mut self) -> bool {
        if self.search.is_none() {
            return false;
        }
        self.set_focus(ListSelectionFocus::Search);
        true
    }

    pub(crate) fn focus_pointer(&mut self, target: &super::ListSelectionPointerTarget) -> bool {
        match target {
            super::ListSelectionPointerTarget::Action => {
                if !self.has_action() {
                    return false;
                }
                self.set_focus(ListSelectionFocus::Action);
                true
            }
            super::ListSelectionPointerTarget::Tab(index) => {
                if !self.show_tabs() {
                    return false;
                }
                match self.tabs.select(*index) {
                    TabListInputOutcome::Unhandled => return false,
                    TabListInputOutcome::ActiveChanged => self.select_first_visible(),
                    TabListInputOutcome::Consumed => {}
                }
                self.set_focus(ListSelectionFocus::Tabs);
                true
            }
            super::ListSelectionPointerTarget::Search => self.focus_search(),
            super::ListSelectionPointerTarget::Item(id) => self.focus_item(id),
        }
    }

    pub(super) fn tab_list(&self) -> &TabListState<ListSelectionGroup> {
        &self.tabs
    }

    pub(crate) fn tabs_focused(&self) -> bool {
        self.focus == ListSelectionFocus::Tabs
    }

    pub(super) fn search_focused(&self) -> bool {
        self.focus == ListSelectionFocus::Search
    }

    pub(crate) fn items_focused(&self) -> bool {
        self.focus == ListSelectionFocus::Items
    }

    pub(crate) fn action_focused(&self) -> bool {
        self.focus == ListSelectionFocus::Action
    }

    pub(super) fn action(&self) -> Option<&ListSelectionItem> {
        self.model.action.as_ref()
    }

    fn has_action(&self) -> bool {
        self.action().is_some_and(|action| action.id().is_some())
    }

    pub(super) fn scroll_counts(&self) -> bool {
        self.model.scroll_counts
    }

    pub(crate) fn query(&self) -> &str {
        self.search
            .as_ref()
            .map(SearchBoxState::query)
            .unwrap_or_default()
    }

    pub(crate) fn show_tabs(&self) -> bool {
        self.model.show_tabs
    }

    pub(crate) fn search(&self) -> Option<&SearchBoxState> {
        self.search.as_ref()
    }

    pub(crate) fn empty_message(&self) -> &str {
        &self.model.empty_message
    }

    pub(crate) fn visible_items(&self) -> Vec<&ListSelectionItem> {
        self.visible_indices()
            .into_iter()
            .filter_map(|index| self.active_tab().items.get(index))
            .collect()
    }

    pub(crate) fn selected_visible_index(&self) -> Option<usize> {
        self.selected_visible
    }

    pub(crate) fn select_visible_item(&mut self, index: usize) -> bool {
        let selectable = self
            .visible_items()
            .get(index)
            .is_some_and(|item| item.id().is_some());
        if !selectable {
            return false;
        }
        self.selected_visible = Some(index);
        true
    }

    pub(crate) fn tab_rows(&self, width: u16) -> u16 {
        if self.show_tabs() {
            tab_list::desired_height(self.tabs(), width)
        } else {
            0
        }
    }

    pub(crate) fn body_rows(&self, width: u16) -> u16 {
        let search_rows = self.search.as_ref().map(|_| SEARCH_BOX_HEIGHT).unwrap_or(0);
        let list_rows = self.item_rows(width).len().max(1);
        let preview_rows = self
            .selected_item()
            .and_then(ListSelectionItem::preview)
            .map(ListSelectionPreview::desired_height)
            .unwrap_or_default();
        search_rows
            .saturating_add(if self.action().is_some() { 2 } else { 0 })
            .saturating_add(u16::from(self.message.is_some()))
            .saturating_add(list_rows.min(u16::MAX as usize) as u16)
            .saturating_add(preview_rows.min(u16::MAX as usize) as u16)
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> ListSelectionInputOutcome {
        self.scroll_offset = None;
        if key.kind == KeyEventKind::Release {
            return ListSelectionInputOutcome::Consumed;
        }
        if self.show_tabs() && bindings::TABS.matches(key) {
            if self.tabs.handle_key(key) == TabListInputOutcome::ActiveChanged {
                self.select_first_visible();
            }
            if key.kind == KeyEventKind::Press {
                self.set_focus(ListSelectionFocus::Tabs);
            }
            return ListSelectionInputOutcome::Consumed;
        }
        if self.model.dismiss.matches(key) {
            if key.kind != KeyEventKind::Press {
                return ListSelectionInputOutcome::Consumed;
            }
            if self.search_focused() {
                self.set_focus(ListSelectionFocus::Items);
                return ListSelectionInputOutcome::Consumed;
            }
            return ListSelectionInputOutcome::Dismiss;
        }
        if self.action_focused()
            && key.kind == KeyEventKind::Press
            && self.model.activation.matches(key)
        {
            return self
                .action()
                .and_then(|action| action.id())
                .cloned()
                .map(ListSelectionInputOutcome::Activate)
                .unwrap_or(ListSelectionInputOutcome::Consumed);
        }
        if self.search_focused() {
            if key.kind == KeyEventKind::Press && bindings::SEARCH_RETURN.matches(key) {
                self.set_focus(ListSelectionFocus::Items);
                return ListSelectionInputOutcome::Consumed;
            }
            if let Some(search) = self.search.as_mut()
                && search.handle_key(key) == SearchBoxInputOutcome::QueryChanged
            {
                self.select_first_visible();
                return ListSelectionInputOutcome::Consumed;
            }
            // Search keeps its characters; only explicit arrows leave the field.
            if !matches!(key.code, KeyCode::Up | KeyCode::Down) {
                return ListSelectionInputOutcome::Consumed;
            }
        }
        if self.focus == ListSelectionFocus::Tabs {
            match self.tabs.handle_focused_key(key) {
                FocusedTabListInputOutcome::ActiveChanged => {
                    self.select_first_visible();
                    return ListSelectionInputOutcome::Consumed;
                }
                FocusedTabListInputOutcome::EnterContent => {
                    self.set_focus(if self.has_action() {
                        ListSelectionFocus::Action
                    } else {
                        ListSelectionFocus::Items
                    });
                    return ListSelectionInputOutcome::Consumed;
                }
                FocusedTabListInputOutcome::FocusNext => {
                    self.move_focus_down();
                    return ListSelectionInputOutcome::Consumed;
                }
                FocusedTabListInputOutcome::Consumed => {
                    return ListSelectionInputOutcome::Consumed;
                }
                FocusedTabListInputOutcome::Unhandled => {}
            }
        }
        if self.focus == ListSelectionFocus::Items
            && key.kind == KeyEventKind::Press
            && self.model.activation.matches(key)
        {
            return self
                .selected_item_id()
                .map(ListSelectionInputOutcome::Activate)
                .unwrap_or(ListSelectionInputOutcome::Consumed);
        }
        if let Some(navigation) = Navigation::from_key(key) {
            match navigation {
                Navigation::Previous => {
                    if key.code == KeyCode::Up && key.kind == KeyEventKind::Press {
                        if !self.move_focus_up() {
                            return ListSelectionInputOutcome::FocusPrevious;
                        }
                    } else if self.focus == ListSelectionFocus::Items {
                        self.move_selection(ListSelectionDirection::Previous);
                    }
                }
                Navigation::Next => {
                    if self.focus == ListSelectionFocus::Items {
                        self.move_selection(ListSelectionDirection::Next);
                    } else if key.kind == KeyEventKind::Press {
                        self.move_focus_down();
                    }
                }
                _ => {
                    self.set_focus(ListSelectionFocus::Items);
                    self.selected_visible = self.visible_len().checked_sub(1).map(|last| {
                        navigation.offset(self.selected_visible.unwrap_or(0), last, PAGE_ROWS)
                    });
                }
            }
            return ListSelectionInputOutcome::Consumed;
        }
        // Adjusting values, opening an item and changing focus are one-shot actions.
        if key.kind != KeyEventKind::Press {
            return ListSelectionInputOutcome::Consumed;
        }
        match key.code {
            _ if bindings::SEARCH.matches(key) => {
                self.focus_search();
            }
            _ if self.focus == ListSelectionFocus::Items
                && (bindings::LEFT.matches(key) || bindings::RIGHT.matches(key)) =>
            {
                if let Some(id) = self.selected_item_id() {
                    if self.model.expandable {
                        if bindings::RIGHT.matches(key) {
                            self.expanded.insert(id);
                        } else {
                            self.expanded.remove(&id);
                        }
                        return ListSelectionInputOutcome::Consumed;
                    }
                    let adjustment = if bindings::LEFT.matches(key) {
                        ListSelectionAdjustment::Previous
                    } else {
                        ListSelectionAdjustment::Next
                    };
                    return ListSelectionInputOutcome::Adjust(id, adjustment);
                }
            }
            _ => {}
        }
        ListSelectionInputOutcome::Consumed
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        if self.focus == ListSelectionFocus::Search
            && let Some(search) = self.search.as_mut()
            && search.handle_paste(pasted) == SearchBoxInputOutcome::QueryChanged
        {
            self.select_first_visible();
        }
    }

    fn move_focus_up(&mut self) -> bool {
        match self.focus {
            ListSelectionFocus::Tabs => true,
            ListSelectionFocus::Action => {
                if self.show_tabs() {
                    self.set_focus(ListSelectionFocus::Tabs);
                    true
                } else {
                    false
                }
            }
            ListSelectionFocus::Search => {
                if self.has_action() {
                    self.set_focus(ListSelectionFocus::Action);
                    true
                } else if self.show_tabs() {
                    self.set_focus(ListSelectionFocus::Tabs);
                    true
                } else {
                    false
                }
            }
            ListSelectionFocus::Items => {
                if self
                    .visible_items()
                    .iter()
                    .take(self.selected_visible.unwrap_or(0))
                    .any(|item| !item.section_heading())
                {
                    self.move_selection(ListSelectionDirection::Previous);
                } else if self.search.is_some() {
                    self.set_focus(ListSelectionFocus::Search);
                } else if self.has_action() {
                    self.set_focus(ListSelectionFocus::Action);
                } else if self.show_tabs() {
                    self.set_focus(ListSelectionFocus::Tabs);
                } else {
                    return false;
                }
                true
            }
        }
    }

    fn move_focus_down(&mut self) {
        match self.focus {
            ListSelectionFocus::Tabs => {
                self.set_focus(if self.has_action() {
                    ListSelectionFocus::Action
                } else if self.search.is_some() {
                    ListSelectionFocus::Search
                } else {
                    ListSelectionFocus::Items
                });
            }
            ListSelectionFocus::Action => self.set_focus(if self.search.is_some() {
                ListSelectionFocus::Search
            } else {
                ListSelectionFocus::Items
            }),
            ListSelectionFocus::Search => self.set_focus(ListSelectionFocus::Items),
            ListSelectionFocus::Items => self.move_selection(ListSelectionDirection::Next),
        }
    }

    fn set_focus(&mut self, focus: ListSelectionFocus) {
        self.focus = focus;
        self.sync_search_focus();
    }

    fn sync_search_focus(&mut self) {
        if let Some(search) = self.search.as_mut() {
            search.set_input_active(self.focus == ListSelectionFocus::Search);
        }
    }

    pub(crate) fn active_tab(&self) -> &ListSelectionGroup {
        self.tabs.active_tab().expect("list groups are enabled")
    }

    pub(crate) fn active_tab_index(&self) -> usize {
        self.tabs.active_index().expect("list groups are enabled")
    }

    fn selected_item_id(&self) -> Option<ListSelectionItemId> {
        self.selected_item()?.id().cloned()
    }

    pub(crate) fn selected_item(&self) -> Option<&ListSelectionItem> {
        let selected = self.selected_visible?;
        self.visible_items().get(selected).copied()
    }

    pub(crate) fn presentation_focus(&self) -> Option<Color> {
        self.selected_item()?.presentation_focus()
    }

    fn visible_indices(&self) -> Vec<usize> {
        let normalized_query = self.query().to_lowercase();
        if !self.model.filter_input || normalized_query.is_empty() {
            return (0..self.active_tab().items.len()).collect();
        }
        let mut matches = self
            .active_tab()
            .items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                selection_match_score(item.label(), item.description(), &normalized_query)
                    .map(|score| (index, score))
            })
            .collect::<Vec<_>>();
        matches.sort_by_key(|(_, score)| *score);
        matches.into_iter().map(|(index, _)| index).collect()
    }

    fn visible_len(&self) -> usize {
        self.visible_indices().len()
    }

    fn move_selection(&mut self, direction: ListSelectionDirection) {
        let visible_len = self.visible_len();
        if visible_len == 0 {
            self.selected_visible = None;
            return;
        }
        let selected = self.selected_visible.unwrap_or(0).min(visible_len - 1);
        self.selected_visible = Some(match direction {
            ListSelectionDirection::Previous => selected.saturating_sub(1),
            ListSelectionDirection::Next => selected.saturating_add(1).min(visible_len - 1),
        });
        self.skip_section_heading(direction);
    }

    fn select_first_visible(&mut self) {
        self.selected_visible = (self.visible_len() > 0).then_some(0);
        self.skip_section_heading(ListSelectionDirection::Next);
    }

    fn skip_section_heading(&mut self, direction: ListSelectionDirection) {
        let Some(index) = self.selected_visible else {
            return;
        };
        let items = self.visible_items();
        if !items.get(index).is_some_and(|item| item.section_heading()) {
            return;
        }
        let next = match direction {
            ListSelectionDirection::Next => {
                (index + 1..items.len()).find(|&index| !items[index].section_heading())
            }
            ListSelectionDirection::Previous => (0..index)
                .rev()
                .find(|&index| !items[index].section_heading()),
        };
        self.selected_visible =
            next.or_else(|| items.iter().position(|item| !item.section_heading()));
    }

    fn reconcile_selection(&mut self) {
        let visible_len = self.visible_len();
        self.selected_visible = match (self.selected_visible, visible_len) {
            (_, 0) => None,
            (Some(selected), len) => Some(selected.min(len - 1)),
            (None, _) => Some(0),
        };
        self.skip_section_heading(ListSelectionDirection::Next);
    }
}

fn localize_presentation(
    presentation: &mut ListSelectionPresentation,
    language: crate::nls::Language,
) {
    presentation.title.localize(language);
    presentation.empty_message = crate::nls::localize_owned(language, &presentation.empty_message);
    if let Some(action) = &mut presentation.action {
        action.label.localize(language);
    }
    if let Some(search) = presentation.search.as_mut() {
        search.localize(language);
    }
}

fn localize_groups(groups: &mut [ListSelectionGroup], language: crate::nls::Language) {
    for group in groups {
        group.label.localize(language);
        for item in &mut group.items {
            item.label.localize(language);
            if let Some(description) = item.description.as_mut() {
                description.localize(language);
            }
            if let Some(columns) = item.columns.as_mut() {
                columns.leading = crate::nls::localize_owned(language, &columns.leading);
                columns.middle = crate::nls::localize_owned(language, &columns.middle);
                columns.trailing = crate::nls::localize_owned(language, &columns.trailing);
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ListSelectionDirection {
    Previous,
    Next,
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
