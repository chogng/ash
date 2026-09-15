mod request;
pub(crate) use request::execute;
pub(crate) use request::start;

use crate::client::new_command_id;
use crate::render::RenderContext;
use crate::widgets::key_hint::KeyHints;
use crate::widgets::list_selection::item_style;
use crate::widgets::navigation::Navigation;
use crate::widgets::panel;
use crate::widgets::panel::PanelLayout;
use crate::widgets::search_box;
use crate::widgets::search_box::SearchBoxModel;
use crate::widgets::search_box::SearchBoxState;
use crate::widgets::tab_list;
use crate::widgets::tab_list::TabListInputOutcome;
use crate::widgets::tab_list::TabListItem;
use crate::widgets::tab_list::TabListState;
use ash_protocol::CommandId;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Wrap;
use std::collections::BTreeSet;
use std::sync::LazyLock;
use std::time::Duration;
use std::time::Instant;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum IssueState {
    Open,
    Closed,
}
impl TabListItem for IssueState {
    fn tab_label(&self) -> &str {
        match self {
            Self::Open => "Open",
            Self::Closed => "Closed",
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Repository {
    pub(crate) host: String,
    pub(crate) owner: String,
    pub(crate) name: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Issue {
    pub(crate) labels: Vec<String>,
    pub(crate) assignees: Vec<String>,
    pub(crate) number: u64,
    pub(crate) title: String,
}
pub(crate) struct Page {
    repository: Repository,
    issues: Vec<Issue>,
    next: Option<u32>,
    refresh_after_seconds: Option<u32>,
    freshness: String,
    fetched_at: u64,
    notice: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ListMode {
    Cached,
    Auto,
    Refresh,
    ClearCache,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    List {
        state: IssueState,
        generation: u64,
        page: u32,
        query: String,
        mode: ListMode,
    },
    Read {
        generation: u64,
        repository: Repository,
        number: u64,
    },
    Start {
        generation: u64,
        command_id: CommandId,
        repository: Repository,
        numbers: Vec<u64>,
    },
}
impl Command {
    pub(crate) fn is_control(&self) -> bool {
        matches!(self, Self::Start { .. })
    }
}
pub(crate) enum Event {
    Listed {
        generation: u64,
        page: u32,
        result: Result<Page, String>,
    },
    Read {
        generation: u64,
        result: Result<String, String>,
    },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Focus {
    Tabs,
    Search,
    List,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PointerTarget {
    Tab(usize),
    Search,
    Issue(u64),
}

#[derive(Clone, Copy)]
struct InteractionAreas {
    tabs: Rect,
    search: Rect,
    summary: Rect,
    list: Rect,
}

#[derive(Debug)]
pub(crate) struct Manager {
    open: bool,
    busy: bool,
    pending_creation: bool,
    generation: u64,
    repository: Option<Repository>,
    issues: Vec<Issue>,
    selected: BTreeSet<u64>,
    cursor: usize,
    tabs: TabListState<IssueState>,
    focus: Focus,
    search: SearchBoxState,
    query: String,
    next_page: Option<u32>,
    refresh_at: Option<Instant>,
    fetched_at: u64,
    freshness: String,
    detail: Option<String>,
    detail_scroll: usize,
    status: String,
    attempt: Option<(Vec<u64>, CommandId)>,
}
impl Default for Manager {
    fn default() -> Self {
        Self {
            open: false,
            busy: false,
            pending_creation: false,
            generation: 0,
            repository: None,
            issues: Vec::new(),
            selected: BTreeSet::new(),
            cursor: 0,
            tabs: TabListState::new(vec![IssueState::Open, IssueState::Closed]),
            focus: Focus::List,
            search: SearchBoxState::new(SearchBoxModel::new("Search keywords or #number")),
            query: String::new(),
            next_page: None,
            refresh_at: None,
            fetched_at: 0,
            freshness: String::new(),
            detail: None,
            detail_scroll: 0,
            status: String::new(),
            attempt: None,
        }
    }
}
impl Manager {
    pub(crate) fn close(&mut self) {
        self.open = false;
        self.detail = None;
        self.refresh_at = None;
        if !self.pending_creation {
            self.generation = self.generation.wrapping_add(1);
            self.busy = false;
        }
    }
    pub(crate) fn is_open(&self) -> bool {
        self.open
    }
    pub(crate) fn open(&mut self) -> Option<Command> {
        self.open = true;
        if self.pending_creation {
            return None;
        }
        self.detail = None;
        self.focus = Focus::List;
        self.search.set_input_active(false);
        Some(self.load(1, ListMode::Cached))
    }
    fn load(&mut self, page: u32, mode: ListMode) -> Command {
        self.generation = self.generation.wrapping_add(1);
        self.busy = true;
        self.refresh_at = None;
        self.status = "Loading issues...".into();
        Command::List {
            state: *self.tabs.active_tab().unwrap(),
            generation: self.generation,
            page,
            query: self.query.clone(),
            mode,
        }
    }
    pub(crate) fn poll_refresh(&mut self, now: Instant) -> Option<Command> {
        if self.open
            && !self.busy
            && self.detail.is_none()
            && !self.search.input_active()
            && self.refresh_at.is_some_and(|deadline| now >= deadline)
        {
            Some(self.load(1, ListMode::Auto))
        } else {
            None
        }
    }
    pub(crate) fn key_hints(&self) -> &KeyHints {
        static SEARCH: LazyLock<KeyHints> = LazyLock::new(|| {
            KeyHints::compact()
                .with_note("Type keywords/#number")
                .with_compact_action("Enter", "search")
                .with_compact_action("Esc", "cancel")
        });
        static DETAIL: LazyLock<KeyHints> = LazyLock::new(|| {
            KeyHints::compact()
                .with_compact_action("↑↓", "scroll")
                .with_compact_action("Esc", "back")
        });
        static LIST: LazyLock<KeyHints> = LazyLock::new(|| {
            KeyHints::compact()
                .with_compact_action("↑↓", "navigate")
                .with_compact_action("Tab", "state")
                .with_compact_action("Enter", "details")
                .with_compact_action("Space", "select")
                .with_compact_action("Ctrl+Enter", "start")
                .with_compact_action("/", "search")
                .with_compact_action("r", "refresh")
                .with_compact_action("n", "next")
                .with_compact_action("Esc", "close")
        });
        if self.search.input_active() {
            &SEARCH
        } else if self.detail.is_some() {
            &DETAIL
        } else {
            &LIST
        }
    }
    pub(crate) fn handle_paste(&mut self, pasted: String) {
        if self.search.input_active() {
            self.search.handle_paste(pasted);
        }
    }
    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> Option<Command> {
        if !self.open || key.kind == KeyEventKind::Release {
            return None;
        }
        if key.kind == KeyEventKind::Repeat
            && !self.search.input_active()
            && Navigation::from_key(key).is_none()
        {
            return None;
        }
        if key.code == KeyCode::Esc {
            if self.search.input_active() {
                self.search.set_query(self.query.clone());
                self.search.set_input_active(false);
                self.focus = Focus::List;
            } else if self.detail.take().is_none() {
                self.close();
            }
            return None;
        }
        if self.pending_creation {
            return None;
        }
        if self.detail.is_some() {
            if let Some(navigation) = Navigation::from_key(key) {
                self.detail_scroll = navigation.offset(self.detail_scroll, u16::MAX as usize, 10);
            }
            return None;
        }
        if matches!(key.code, KeyCode::Tab | KeyCode::BackTab) {
            self.search.set_input_active(false);
            self.focus = Focus::Tabs;
            if self.tabs.handle_key(key) == TabListInputOutcome::ActiveChanged {
                self.issues.clear();
                self.cursor = 0;
                return Some(self.load(1, ListMode::Cached));
            }
            return None;
        }
        if self.focus == Focus::Tabs {
            if self.tabs.handle_key(key) == TabListInputOutcome::ActiveChanged {
                self.issues.clear();
                self.cursor = 0;
                return Some(self.load(1, ListMode::Cached));
            }
            if matches!(key.code, KeyCode::Down | KeyCode::Enter) {
                self.focus = Focus::Search;
                self.search.set_input_active(true);
            }
            return None;
        }
        if self.search.input_active() {
            match key.code {
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.search.set_query(String::new());
                }
                KeyCode::Enter => {
                    self.query = self.search.query().trim().to_owned();
                    self.search.set_query(self.query.clone());
                    self.search.set_input_active(false);
                    self.focus = Focus::List;
                    self.selected.clear();
                    self.attempt = None;
                    self.cursor = 0;
                    return Some(self.load(1, ListMode::Refresh));
                }
                KeyCode::Up => {
                    self.search.set_input_active(false);
                    self.focus = Focus::Tabs;
                }
                KeyCode::Down => {
                    self.search.set_input_active(false);
                    self.focus = Focus::List;
                }
                _ => {
                    self.search.handle_key(key);
                }
            }
            return None;
        }
        if key.code == KeyCode::Char('/') {
            self.focus = Focus::Search;
            self.search.set_input_active(true);
            return None;
        }
        if self.busy {
            return None;
        }
        if let Some(navigation) = Navigation::from_key(key) {
            if navigation == Navigation::Previous && self.cursor == 0 {
                self.focus = Focus::Search;
                self.search.set_input_active(true);
            } else {
                self.cursor =
                    navigation.offset(self.cursor, self.issues.len().saturating_sub(1), 10);
            }
            return None;
        }
        if key.kind != KeyEventKind::Press {
            return None;
        }
        match key.code {
            KeyCode::Char('r') => Some(self.load(1, ListMode::Refresh)),
            KeyCode::Char('R') => Some(self.load(1, ListMode::ClearCache)),
            KeyCode::Char('n') => self.next_page.map(|page| self.load(page, ListMode::Cached)),
            KeyCode::Char(' ') => {
                if let Some(issue) = self.issues.get(self.cursor) {
                    if !self.selected.remove(&issue.number) {
                        self.selected.insert(issue.number);
                    }
                    self.attempt = None;
                }
                None
            }
            KeyCode::Enter if key.modifiers.contains(KeyModifiers::CONTROL) => self.start(),
            KeyCode::Char('d') => self.start(),
            KeyCode::Enter => {
                let issue = self.issues.get(self.cursor)?;
                let repository = self.repository.clone()?;
                let number = issue.number;
                self.generation = self.generation.wrapping_add(1);
                self.busy = true;
                self.status = "Reading issue...".into();
                Some(Command::Read {
                    generation: self.generation,
                    repository,
                    number,
                })
            }
            _ => None,
        }
    }

    pub(crate) fn pointer_target_at(
        &self,
        area: Rect,
        position: ratatui::layout::Position,
    ) -> Option<PointerTarget> {
        if self.detail.is_some() {
            return None;
        }
        let areas = self.interaction_areas(area);
        if let Some(index) = tab_list::index_at(self.tabs.tabs(), areas.tabs, position) {
            return Some(PointerTarget::Tab(index));
        }
        if areas.search.contains(position) {
            return Some(PointerTarget::Search);
        }
        if !areas.list.contains(position) {
            return None;
        }
        let first = self
            .cursor
            .saturating_sub(areas.list.height.saturating_sub(1) as usize);
        self.issues
            .get(first + usize::from(position.y - areas.list.y))
            .map(|issue| PointerTarget::Issue(issue.number))
    }

    pub(crate) fn activate_pointer(&mut self, target: &PointerTarget) -> Option<Command> {
        match target {
            PointerTarget::Tab(index) => {
                self.focus = Focus::Tabs;
                self.search.set_input_active(false);
                if self.tabs.select(*index) == tab_list::TabListInputOutcome::ActiveChanged {
                    self.issues.clear();
                    self.cursor = 0;
                    Some(self.load(1, ListMode::Cached))
                } else {
                    None
                }
            }
            PointerTarget::Search => {
                self.focus = Focus::Search;
                self.search.set_input_active(true);
                None
            }
            PointerTarget::Issue(number) => {
                let index = self
                    .issues
                    .iter()
                    .position(|issue| issue.number == *number)?;
                self.cursor = index;
                self.focus = Focus::List;
                self.search.set_input_active(false);
                self.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            }
        }
    }
    fn start(&mut self) -> Option<Command> {
        if self.selected.is_empty() {
            self.status = "Select one or more issues with Space.".into();
            return None;
        }
        let repository = self.repository.clone()?;
        let numbers = self.selected.iter().copied().collect::<Vec<_>>();
        let command_id = match &self.attempt {
            Some((previous, command_id)) if previous == &numbers => command_id.clone(),
            _ => new_command_id("issue-session"),
        };
        self.attempt = Some((numbers.clone(), command_id.clone()));
        self.generation = self.generation.wrapping_add(1);
        self.busy = true;
        self.pending_creation = true;
        self.status = "Starting Issue session...".into();
        Some(Command::Start {
            generation: self.generation,
            command_id,
            repository,
            numbers,
        })
    }
    pub(crate) fn finish_start(&mut self, generation: u64, error: Option<String>) {
        if generation != self.generation {
            return;
        }
        self.busy = false;
        self.pending_creation = false;
        if let Some(error) = error {
            self.status = error;
        } else {
            self.open = false;
            self.selected.clear();
            self.attempt = None;
        }
    }
    pub(crate) fn update(&mut self, event: Event) {
        match event {
            Event::Listed {
                generation,
                page,
                result,
            } if generation == self.generation => {
                self.busy = false;
                match result {
                    Ok(result) => {
                        if self
                            .repository
                            .as_ref()
                            .is_some_and(|repository| repository != &result.repository)
                        {
                            self.selected.clear();
                            self.attempt = None;
                            self.issues.clear();
                        }
                        self.repository = Some(result.repository);
                        if page == 1 {
                            self.issues = result.issues;
                        } else {
                            for issue in result.issues {
                                if !self.issues.iter().any(|entry| entry.number == issue.number) {
                                    self.issues.push(issue);
                                }
                            }
                        }
                        self.cursor = self.cursor.min(self.issues.len().saturating_sub(1));
                        self.next_page = result.next;
                        self.fetched_at = result.fetched_at;
                        self.freshness = result.freshness;
                        self.status = result.notice;
                        self.refresh_at = result.refresh_after_seconds.map(|seconds| {
                            Instant::now() + Duration::from_secs(u64::from(seconds))
                        });
                    }
                    Err(error) => {
                        self.status = error;
                    }
                }
            }
            Event::Read { generation, result } if generation == self.generation => {
                self.busy = false;
                match result {
                    Ok(detail) => {
                        self.detail = Some(detail);
                        self.detail_scroll = 0;
                        self.status.clear();
                    }
                    Err(error) => self.status = error,
                }
            }
            _ => {}
        }
    }
    fn interaction_areas(&self, area: Rect) -> InteractionAreas {
        let body = PanelLayout::new(area, 0).body;
        let tabs_height = tab_list::desired_height(self.tabs.tabs(), body.width).min(body.height);
        let tabs = Rect {
            height: tabs_height,
            ..body
        };
        let search_height =
            search_box::SEARCH_BOX_HEIGHT.min(body.height.saturating_sub(tabs_height));
        let search = Rect {
            y: body.y.saturating_add(tabs_height),
            height: search_height,
            ..body
        };
        let summary_height = (1 + u16::from(!self.status.is_empty()))
            .min(body.height.saturating_sub(tabs_height + search_height));
        let summary = Rect {
            y: search.bottom(),
            height: summary_height,
            ..body
        };
        let state_column = (crate::render::selection_marker(false).len() as u16).min(body.x);
        let list = Rect {
            x: body.x - state_column,
            y: summary.bottom(),
            width: body.width.saturating_add(state_column),
            height: body.height.saturating_sub(
                tabs_height
                    .saturating_add(search_height)
                    .saturating_add(summary_height),
            ),
        };
        InteractionAreas {
            tabs,
            search,
            summary,
            list,
        }
    }

    pub(crate) fn draw(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        hovered: Option<&PointerTarget>,
        pressed: Option<&PointerTarget>,
        context: RenderContext<'_>,
    ) {
        panel::draw_header(frame, area, "Issues", context.focus());
        let body = PanelLayout::new(area, 0).body;
        let style = Style::default()
            .fg(context.foreground())
            .bg(context.background());
        let muted = style.fg(context.muted());
        if let Some(detail) = &self.detail {
            frame.render_widget(
                Paragraph::new(detail.as_str())
                    .style(style)
                    .wrap(Wrap { trim: false })
                    .scroll((self.detail_scroll.min(u16::MAX as usize) as u16, 0)),
                body,
            );
            return;
        }
        let areas = self.interaction_areas(area);
        let hovered_tab = match hovered {
            Some(PointerTarget::Tab(index)) => Some(*index),
            _ => None,
        };
        let pressed_tab = match pressed {
            Some(PointerTarget::Tab(index)) => Some(*index),
            _ => None,
        };
        tab_list::draw(
            frame,
            areas.tabs,
            &self.tabs,
            self.focus == Focus::Tabs,
            hovered_tab,
            pressed_tab,
            context,
        );
        search_box::draw(
            frame,
            areas.search,
            &self.search,
            hovered == Some(&PointerTarget::Search),
            pressed == Some(&PointerTarget::Search),
            context,
        );
        let mut lines = vec![Line::styled(
            format!(
                "{} · {} selected · {} loaded · {}",
                self.repository
                    .as_ref()
                    .map(|r| format!("{}/{}", r.owner, r.name))
                    .unwrap_or_default(),
                self.selected.len(),
                self.issues.len(),
                self.freshness
            ),
            muted,
        )];
        if !self.status.is_empty() {
            lines.push(Line::styled(self.status.as_str(), muted));
        }
        frame.render_widget(Paragraph::new(lines), areas.summary);
        let list_area = areas.list;
        frame.render_widget(Paragraph::default().style(style), list_area);
        let first = self
            .cursor
            .saturating_sub(list_area.height.saturating_sub(1) as usize);
        for (row, (index, issue)) in self
            .issues
            .iter()
            .enumerate()
            .skip(first)
            .take(list_area.height as usize)
            .enumerate()
        {
            let focused = self.focus == Focus::List && self.cursor == index;
            let hovered = hovered == Some(&PointerTarget::Issue(issue.number));
            let pressed = pressed == Some(&PointerTarget::Issue(issue.number));
            let text = format!(
                "{}{} #{} {}",
                crate::render::selection_marker(focused),
                if self.selected.contains(&issue.number) {
                    "[x]"
                } else {
                    "[ ]"
                },
                issue.number,
                issue.title
            );
            frame.render_widget(
                Paragraph::new(text)
                    .style(style.patch(item_style(context, focused, hovered, pressed))),
                Rect {
                    y: list_area.y.saturating_add(row as u16),
                    height: 1,
                    ..list_area
                },
            );
        }
    }
}

#[cfg(test)]
#[path = "issues_tests.rs"]
mod tests;
