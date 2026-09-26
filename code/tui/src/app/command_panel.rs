use crate::TuiStartupContext;
use crate::config::ConfigChoices;
use crate::config::ConfigEditor;
use crate::config::ConfigEditorOutcome;
use crate::config::ConfigEditorPage;
use crate::connectors::ConnectorChoices;
use crate::connectors::ConnectorSelectionAction;
use crate::dirs::DirAddTarget;
use crate::dirs::DirChoices;
use crate::dirs::DirPanel;
use crate::dirs::DirSelectionAction;
use crate::git::BranchChoices;
use crate::git::BranchPanel;
use crate::git::BranchSelectionAction;
use crate::git::WorktreeChoices;
use crate::git::WorktreePanel;
use crate::git::WorktreeSelectionAction;
use crate::keymap_setup::KeymapChoices;
use crate::keymap_setup::KeymapEditor;
use crate::keymap_setup::KeymapEditorOutcome;
use crate::keymap_setup::KeymapEditorPage;
use crate::mcp::McpChoices;
use crate::mcp::McpSelectionAction;
use crate::models::ModelChoices;
use crate::models::ModelSelectionAction;
use crate::projects::RootChoices;
use crate::projects::RootSelectionAction;
use crate::sessions::SessionChoices;
use crate::sessions::SessionSelectionAction;
use crate::skills::SkillChoices;
use crate::skills::SkillSelectionAction;
use crate::status::ProcessResourcesView;
use crate::status::StatusLineChoices;
use crate::status::StatusLineSelectionAction;
use crate::status::StatusPanel;
use crate::status::StatusPanelOutcome;
use crate::theme::ThemeChoices;
use crate::theme::ThemePicker;
use crate::theme::ThemePickerOutcome;
use crate::thread::rewind::RewindChoices;
use crate::thread::rewind::RewindSelectionAction;
use crate::widgets::key_capture;
use crate::widgets::key_capture::KeyCapture;
use crate::widgets::list_selection;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionAdjustment;
use crate::widgets::list_selection::ListSelectionOutcome;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::text_prompt;
use crate::widgets::text_prompt::TextPrompt;
use crossterm::event::KeyEvent;
use ratatui::Frame;
use ratatui::layout::Rect;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug)]
pub(super) enum CommandPanelBody<'a> {
    Selection(&'a ListSelectionState),
    Prompt(&'a TextPrompt),
    Memories(&'a crate::memories::Panel),
    Provider(&'a crate::config::provider::Panel),
    KeyCapture(&'a KeyCapture),
    Status(&'a StatusPanel),
}

impl CommandPanelBody<'_> {
    pub(super) fn allows_backdrop_dismiss(&self) -> bool {
        match self {
            Self::Selection(_) | Self::Status(_) => true,
            Self::Memories(panel) => panel.allows_backdrop_dismiss(),
            Self::Prompt(_) | Self::Provider(_) | Self::KeyCapture(_) => false,
        }
    }
}

#[derive(Debug)]
pub(crate) enum CommandPanel {
    Loading(ListSelection<()>),
    Help(ListSelection<()>),
    Dirs(DirPanel),
    GitBranches(BranchPanel),
    GitWorktrees(WorktreePanel),
    Config(ConfigEditor),
    Connectors(ListSelection<ConnectorSelectionAction>),
    Keymap(KeymapEditor),
    Marketplace(crate::marketplace::Panel),
    Lsp(crate::lsp::Panel),
    Mcp(ListSelection<McpSelectionAction>),
    Memories(crate::memories::Panel),
    Model(ListSelection<ModelSelectionAction>),
    ProjectRoots(ListSelection<RootSelectionAction>),
    Rewind(ListSelection<RewindSelectionAction>),
    Sessions(ListSelection<SessionSelectionAction>),
    Skills(ListSelection<SkillSelectionAction>),
    Startup(ListSelection<()>),
    Usage(ListSelection<()>),
    Status(StatusPanel),
    StatusLine(ListSelection<StatusLineSelectionAction>),
    Theme(ThemePicker),
}

#[derive(Debug)]
pub(crate) enum CommandPanelOutcome {
    Dirs(DirSelectionAction),
    GitBranch(BranchSelectionAction),
    GitWorktree(WorktreeSelectionAction),
    Config(ConfigEditorOutcome),
    Connectors(ConnectorSelectionAction),
    Keymap(KeymapEditorOutcome),
    Marketplace(crate::marketplace::Command),
    Lsp(crate::lsp::Outcome),
    Mcp(McpSelectionAction),
    Memories(crate::memories::Command),
    Model(ModelSelectionAction),
    ProjectRoot(RootSelectionAction),
    Rewind(RewindSelectionAction),
    Sessions(SessionSelectionAction),
    Skills(SkillSelectionAction),
    StatusLine(StatusLineSelectionAction),
    Theme(ThemePickerOutcome),
    Consumed,
    Dismiss,
}

impl CommandPanel {
    pub(super) fn loading(title: &str, message: &str) -> Self {
        Self::Loading(ListSelection::new(
            list_selection::ListSelectionModel::new(
                title,
                vec![list_selection::ListSelectionGroup::new("", Vec::new())],
            )
            .without_tab_bar()
            .with_empty_message(message),
            BTreeMap::new(),
        ))
    }

    pub(super) fn parent_title(&self) -> Option<&str> {
        match self {
            Self::Config(editor) => editor.parent_title(),
            Self::GitBranches(panel) => panel.parent_title(),
            Self::GitWorktrees(panel) => panel.parent_title(),
            Self::Memories(panel) => panel.parent_title(),
            _ => None,
        }
    }

    pub(super) fn navigation_title(&self, language: crate::nls::Language) -> String {
        let title = self.body().title(language);
        match self.parent_title() {
            Some(parent) => format!("{} › {title}", crate::nls::localize(language, parent)),
            None => title.into_owned(),
        }
    }

    pub(super) fn return_to_parent(&mut self) {
        if let Self::Config(editor) = self {
            editor.return_to_parent();
        }
        if let Self::GitBranches(panel) = self {
            panel.return_to_parent();
        }
        if let Self::GitWorktrees(panel) = self {
            panel.return_to_parent();
        }
        if let Self::Memories(panel) = self {
            panel.handle_key(KeyEvent::new(
                crossterm::event::KeyCode::Esc,
                crossterm::event::KeyModifiers::NONE,
            ));
        }
    }

    pub(super) fn activate_provider(
        &mut self,
        target: crate::config::provider::Target,
    ) -> CommandPanelOutcome {
        match self {
            Self::Config(editor) => editor
                .provider_mut()
                .map(|panel| CommandPanelOutcome::Config(panel.activate(target)))
                .unwrap_or(CommandPanelOutcome::Consumed),
            _ => CommandPanelOutcome::Consumed,
        }
    }

    pub(super) fn activate_memory(
        &mut self,
        target: &crate::memories::Target,
        click: list_selection::ListSelectionClick,
    ) -> CommandPanelOutcome {
        match self {
            Self::Memories(panel) => {
                map_selection(panel.click(target, click), CommandPanelOutcome::Memories)
            }
            _ => CommandPanelOutcome::Consumed,
        }
    }

    pub(crate) fn is_testing(&self) -> bool {
        matches!(self, Self::Config(editor) if editor.is_testing())
    }

    pub(crate) fn allows_backdrop_dismiss(&self) -> bool {
        if let Self::GitBranches(panel) = self {
            return !panel.is_subpage();
        }
        if let Self::GitWorktrees(panel) = self {
            return !panel.is_subpage();
        }
        self.body().allows_backdrop_dismiss()
    }

    pub(crate) fn help(model: crate::widgets::list_selection::ListSelectionModel) -> Self {
        Self::Help(ListSelection::new(model, BTreeMap::new()))
    }

    pub(crate) fn dirs(spec: DirChoices) -> Self {
        Self::Dirs(DirPanel::new(spec))
    }

    pub(crate) fn project_dirs(spec: DirChoices) -> Self {
        Self::Dirs(DirPanel::for_target(spec, DirAddTarget::Project))
    }

    pub(crate) fn git_branches(spec: BranchChoices) -> Self {
        Self::GitBranches(BranchPanel::new(spec))
    }

    pub(crate) fn git_worktrees(spec: WorktreeChoices) -> Self {
        Self::GitWorktrees(WorktreePanel::new(spec))
    }

    pub(crate) fn project_roots(spec: RootChoices) -> Self {
        Self::ProjectRoots(ListSelection::new(spec.model, spec.actions))
    }

    pub(crate) fn config(spec: ConfigChoices) -> Self {
        Self::Config(ConfigEditor::new(spec))
    }

    pub(crate) fn connectors(spec: ConnectorChoices) -> Self {
        Self::Connectors(ListSelection::new(spec.model, spec.actions))
    }

    pub(crate) fn keymap(spec: KeymapChoices) -> Self {
        Self::Keymap(KeymapEditor::new(spec))
    }

    pub(crate) fn mcp(spec: McpChoices) -> Self {
        Self::Mcp(ListSelection::new(spec.model, spec.actions))
    }

    pub(crate) fn model(spec: ModelChoices) -> Self {
        Self::Model(ListSelection::new(spec.model, spec.actions))
    }

    pub(crate) fn rewind(spec: RewindChoices) -> Self {
        Self::Rewind(ListSelection::new(spec.model, spec.actions))
    }

    pub(crate) fn sessions(spec: SessionChoices) -> Self {
        Self::Sessions(ListSelection::new(spec.model, spec.actions))
    }

    pub(crate) fn memories(page: crate::memories::Page) -> Self {
        Self::Memories(crate::memories::Panel::new(page))
    }

    pub(crate) fn skills(spec: SkillChoices) -> Self {
        Self::Skills(ListSelection::new(spec.model, spec.actions))
    }

    pub(crate) fn startup(context: &TuiStartupContext) -> Self {
        Self::Startup(ListSelection::new(
            super::startup::choices(context),
            BTreeMap::new(),
        ))
    }

    pub(crate) fn status_line(spec: StatusLineChoices) -> Self {
        Self::StatusLine(ListSelection::new(spec.model, spec.actions))
    }

    pub(crate) fn status(panel: StatusPanel) -> Self {
        Self::Status(panel)
    }

    pub(crate) fn usage(model: crate::widgets::list_selection::ListSelectionModel) -> Self {
        Self::Usage(ListSelection::new(model, BTreeMap::new()))
    }

    pub(crate) fn apply_process_resources(&mut self, resources: ProcessResourcesView) {
        if let Self::Status(panel) = self {
            panel.apply_process_resources(resources);
        }
    }

    pub(crate) fn process_resources_visible(&self, area: Rect) -> bool {
        match self {
            Self::Status(panel) => panel.process_resources_visible(area),
            _ => false,
        }
    }

    pub(crate) fn theme(spec: ThemeChoices) -> Self {
        Self::Theme(ThemePicker::new(spec))
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent, area: Rect) -> CommandPanelOutcome {
        match self {
            Self::Help(content) | Self::Loading(content) | Self::Usage(content) => {
                map_read_only(content.handle_key(key))
            }
            Self::Dirs(content) => {
                map_selection(content.handle_key(key), CommandPanelOutcome::Dirs)
            }
            Self::GitBranches(content) => {
                map_selection(content.handle_key(key), CommandPanelOutcome::GitBranch)
            }
            Self::GitWorktrees(content) => {
                map_selection(content.handle_key(key), CommandPanelOutcome::GitWorktree)
            }
            Self::Config(content) => CommandPanelOutcome::Config(content.handle_key(key)),
            Self::Connectors(content) => {
                map_selection(content.handle_key(key), CommandPanelOutcome::Connectors)
            }
            Self::Keymap(content) => CommandPanelOutcome::Keymap(content.handle_key(key)),
            Self::Memories(content) => {
                map_selection(content.handle_key(key), CommandPanelOutcome::Memories)
            }
            Self::Marketplace(content) => {
                map_selection(content.handle_key(key), CommandPanelOutcome::Marketplace)
            }
            Self::Lsp(content) => CommandPanelOutcome::Lsp(content.handle_key(key)),
            Self::Mcp(content) => map_selection(content.handle_key(key), CommandPanelOutcome::Mcp),
            Self::Model(content) => {
                if key.kind == crossterm::event::KeyEventKind::Press
                    && key.modifiers.is_empty()
                    && key.code == crossterm::event::KeyCode::Char('p')
                    && content.state().items_focused()
                {
                    if let Some(ModelSelectionAction::Select { preference, pinned }) = content
                        .state()
                        .selected_item()
                        .and_then(|item| item.id())
                        .and_then(|id| content.action(id))
                    {
                        return CommandPanelOutcome::Model(ModelSelectionAction::Pin {
                            preference: preference.clone(),
                            pinned: !pinned,
                        });
                    }
                }
                map_selection(content.handle_key(key), CommandPanelOutcome::Model)
            }
            Self::ProjectRoots(content) => {
                map_selection(content.handle_key(key), CommandPanelOutcome::ProjectRoot)
            }
            Self::Rewind(content) => {
                map_selection(content.handle_key(key), CommandPanelOutcome::Rewind)
            }
            Self::Sessions(content) => {
                map_selection(content.handle_key(key), CommandPanelOutcome::Sessions)
            }
            Self::Skills(content) => {
                map_selection(content.handle_key(key), CommandPanelOutcome::Skills)
            }
            Self::Startup(content) => map_read_only(content.handle_key(key)),
            Self::Status(content) => match content.handle_key(key, area) {
                StatusPanelOutcome::Consumed => CommandPanelOutcome::Consumed,
                StatusPanelOutcome::Dismiss => CommandPanelOutcome::Dismiss,
            },
            Self::StatusLine(content) => {
                map_selection(content.handle_key(key), CommandPanelOutcome::StatusLine)
            }
            Self::Theme(content) => CommandPanelOutcome::Theme(content.handle_key(key)),
        }
    }

    pub(crate) fn handle_paste(&mut self, pasted: String) {
        match self {
            Self::Help(content) | Self::Loading(content) | Self::Usage(content) => {
                content.handle_paste(pasted)
            }
            Self::Dirs(content) => content.handle_paste(pasted),
            Self::GitBranches(content) => content.handle_paste(pasted),
            Self::GitWorktrees(content) => content.handle_paste(pasted),
            Self::Config(content) => content.handle_paste(pasted),
            Self::Connectors(content) => content.handle_paste(pasted),
            Self::Keymap(content) => content.handle_paste(pasted),
            Self::Memories(content) => content.paste(pasted),
            Self::Marketplace(content) => content.handle_paste(pasted),
            Self::Lsp(content) => content.handle_paste(pasted),
            Self::Mcp(content) => content.handle_paste(pasted),
            Self::Model(content) => content.handle_paste(pasted),
            Self::ProjectRoots(content) => content.handle_paste(pasted),
            Self::Rewind(content) => content.handle_paste(pasted),
            Self::Sessions(content) => content.handle_paste(pasted),
            Self::Skills(content) => content.handle_paste(pasted),
            Self::Startup(content) => content.handle_paste(pasted),
            Self::Status(_) => {}
            Self::StatusLine(content) => content.handle_paste(pasted),
            Self::Theme(content) => content.handle_paste(pasted),
        }
    }

    pub(crate) fn localize(&mut self, language: crate::nls::Language) {
        match self {
            Self::Help(content)
            | Self::Loading(content)
            | Self::Startup(content)
            | Self::Usage(content) => {
                content.state_mut().localize(language);
            }
            Self::GitBranches(content) => content.localize(language),
            Self::GitWorktrees(content) => content.localize(language),
            Self::Connectors(content) => content.state_mut().localize(language),
            Self::Marketplace(content) => content.localize(language),
            Self::Lsp(content) => content.localize(language),
            Self::Mcp(content) => content.state_mut().localize(language),
            Self::Model(content) => content.state_mut().localize(language),
            Self::ProjectRoots(content) => content.state_mut().localize(language),
            Self::Rewind(content) => content.state_mut().localize(language),
            Self::Sessions(content) => content.state_mut().localize(language),
            Self::Skills(content) => content.state_mut().localize(language),
            Self::StatusLine(content) => content.state_mut().localize(language),
            Self::Dirs(content) => content.localize(language),
            Self::Config(content) => {
                if let Some(selection) = content.selection_mut() {
                    selection.localize(language);
                }
            }
            Self::Keymap(content) => {
                if let Some(selection) = content.selection_mut() {
                    selection.localize(language);
                }
            }
            Self::Memories(content) => {
                content.localize(language);
            }
            Self::Status(content) => content.localize(language),
            Self::Theme(content) => content.selection_mut().localize(language),
        }
    }

    pub(crate) fn list_selection(&self) -> Option<&ListSelectionState> {
        match self {
            Self::Help(selection) | Self::Loading(selection) | Self::Usage(selection) => {
                Some(selection.state())
            }
            Self::Dirs(selection) => Some(selection.state()),
            Self::GitBranches(selection) => Some(selection.state()),
            Self::GitWorktrees(selection) => Some(selection.state()),
            Self::Config(editor) => editor.selection(),
            Self::Connectors(selection) => Some(selection.state()),
            Self::Keymap(editor) => editor.selection(),
            Self::Memories(_) => None,
            Self::Marketplace(selection) => Some(selection.state()),
            Self::Lsp(selection) => Some(selection.state()),
            Self::Mcp(selection) => Some(selection.state()),
            Self::Model(selection) => Some(selection.state()),
            Self::ProjectRoots(selection) => Some(selection.state()),
            Self::Rewind(selection) => Some(selection.state()),
            Self::Sessions(selection) => Some(selection.state()),
            Self::Skills(selection) => Some(selection.state()),
            Self::Startup(selection) => Some(selection.state()),
            Self::Status(_) => None,
            Self::StatusLine(selection) => Some(selection.state()),
            Self::Theme(picker) => Some(picker.selection()),
        }
    }

    pub(super) fn list_selection_mut(&mut self) -> Option<&mut ListSelectionState> {
        match self {
            Self::Help(selection) | Self::Loading(selection) | Self::Usage(selection) => {
                Some(selection.state_mut())
            }
            Self::Dirs(selection) => selection.selection_mut(),
            Self::GitBranches(selection) => Some(selection.state_mut()),
            Self::GitWorktrees(selection) => Some(selection.state_mut()),
            Self::Config(editor) => editor.selection_mut(),
            Self::Connectors(selection) => Some(selection.state_mut()),
            Self::Keymap(editor) => editor.selection_mut(),
            Self::Memories(_) => None,
            Self::Marketplace(selection) => Some(selection.state_mut()),
            Self::Lsp(selection) => Some(selection.state_mut()),
            Self::Mcp(selection) => Some(selection.state_mut()),
            Self::Model(selection) => Some(selection.state_mut()),
            Self::ProjectRoots(selection) => Some(selection.state_mut()),
            Self::Rewind(selection) => Some(selection.state_mut()),
            Self::Sessions(selection) => Some(selection.state_mut()),
            Self::Skills(selection) => Some(selection.state_mut()),
            Self::Startup(selection) => Some(selection.state_mut()),
            Self::StatusLine(selection) => Some(selection.state_mut()),
            Self::Theme(picker) => Some(picker.selection_mut()),
            Self::Status(_) => None,
        }
    }

    pub(super) fn handle_click(
        &mut self,
        target: &list_selection::ListSelectionPointerTarget,
        area: Rect,
        click: list_selection::ListSelectionClick,
    ) -> CommandPanelOutcome {
        if let Self::Config(editor) = self {
            return CommandPanelOutcome::Config(editor.handle_click(target, click));
        }
        if let Self::Marketplace(panel) = self
            && let list_selection::ListSelectionPointerTarget::Tab(index) = target
        {
            return panel
                .select_tab(*index)
                .map(CommandPanelOutcome::Marketplace)
                .unwrap_or(CommandPanelOutcome::Consumed);
        }

        if self
            .list_selection_mut()
            .is_some_and(|selection| selection.focus_pointer(target))
            && matches!(
                target,
                list_selection::ListSelectionPointerTarget::Item(_)
                    | list_selection::ListSelectionPointerTarget::Action
            )
        {
            self.handle_key(
                KeyEvent::new(
                    crossterm::event::KeyCode::Enter,
                    crossterm::event::KeyModifiers::NONE,
                ),
                area,
            )
        } else {
            CommandPanelOutcome::Consumed
        }
    }

    pub(super) fn body(&self) -> CommandPanelBody<'_> {
        match self {
            Self::Help(selection) | Self::Loading(selection) | Self::Usage(selection) => {
                CommandPanelBody::Selection(selection.state())
            }
            Self::Dirs(selection) => CommandPanelBody::Selection(selection.state()),
            Self::GitBranches(selection) => CommandPanelBody::Selection(selection.state()),
            Self::GitWorktrees(selection) => CommandPanelBody::Selection(selection.state()),
            Self::Config(editor) => match editor.page() {
                ConfigEditorPage::Selection(selection) => CommandPanelBody::Selection(selection),
                ConfigEditorPage::Prompt(prompt) => CommandPanelBody::Prompt(prompt),
                ConfigEditorPage::Provider(panel) => CommandPanelBody::Provider(panel),
            },
            Self::Connectors(selection) => CommandPanelBody::Selection(selection.state()),
            Self::Keymap(editor) => match editor.page() {
                KeymapEditorPage::Selection(selection) => CommandPanelBody::Selection(selection),
                KeymapEditorPage::Capture(capture) => CommandPanelBody::KeyCapture(capture),
            },
            Self::Memories(panel) => CommandPanelBody::Memories(panel),
            Self::Marketplace(selection) => CommandPanelBody::Selection(selection.state()),
            Self::Lsp(selection) => CommandPanelBody::Selection(selection.state()),
            Self::Mcp(selection) => CommandPanelBody::Selection(selection.state()),
            Self::Model(selection) => CommandPanelBody::Selection(selection.state()),
            Self::ProjectRoots(selection) => CommandPanelBody::Selection(selection.state()),
            Self::Rewind(selection) => CommandPanelBody::Selection(selection.state()),
            Self::Sessions(selection) => CommandPanelBody::Selection(selection.state()),
            Self::Skills(selection) => CommandPanelBody::Selection(selection.state()),
            Self::Startup(selection) => CommandPanelBody::Selection(selection.state()),
            Self::Status(panel) => CommandPanelBody::Status(panel),
            Self::StatusLine(selection) => CommandPanelBody::Selection(selection.state()),
            Self::Theme(picker) => CommandPanelBody::Selection(picker.selection()),
        }
    }

    pub(crate) fn key_hints(&self) -> &crate::widgets::key_hint::KeyHints {
        match self {
            Self::Help(content) | Self::Loading(content) | Self::Usage(content) => {
                content.key_hints()
            }
            Self::Dirs(content) => content.key_hints(),
            Self::GitBranches(content) => content.key_hints(),
            Self::GitWorktrees(content) => content.key_hints(),
            Self::Config(content) => content.key_hints(),
            Self::Connectors(content) => content.key_hints(),
            Self::Keymap(content) => content.key_hints(),
            Self::Memories(panel) => panel.key_hints(),
            Self::Marketplace(content) => content.key_hints(),
            Self::Lsp(content) => content.key_hints(),
            Self::Mcp(content) => content.key_hints(),
            Self::Model(content) => content.key_hints(),
            Self::ProjectRoots(content) => content.key_hints(),
            Self::Rewind(content) => content.key_hints(),
            Self::Sessions(content) => content.key_hints(),
            Self::Skills(content) => content.key_hints(),
            Self::Startup(content) => content.key_hints(),
            Self::Status(content) => content.key_hints(),
            Self::StatusLine(content) => content.key_hints(),
            Self::Theme(content) => content.key_hints(),
        }
    }

    pub(super) fn tab_at(&self, area: Rect, position: ratatui::layout::Position) -> Option<usize> {
        match self {
            Self::Status(panel) => panel.tab_at(area, position),
            _ => None,
        }
    }

    pub(super) fn select_tab(&mut self, index: usize) {
        if let Self::Status(panel) = self {
            panel.select_tab(index);
        }
    }

    pub(crate) fn replace_dirs(&mut self, spec: DirChoices) -> bool {
        let Self::Dirs(content) = self else {
            return false;
        };
        content.replace(spec);
        true
    }

    pub(crate) fn finish_dir_add(
        &mut self,
        request_id: u64,
        result: Result<crate::dirs::AddedDir, String>,
    ) {
        if let Self::Dirs(content) = self {
            content.finish_add(request_id, result);
        }
    }

    pub(crate) fn set_message(&mut self, message: String) {
        match self {
            Self::GitBranches(selection) => selection.state_mut().set_message(Some(message)),
            Self::GitWorktrees(selection) => selection.state_mut().set_message(Some(message)),
            Self::ProjectRoots(selection) => selection.state_mut().set_message(Some(message)),
            _ => {}
        }
    }

    pub(crate) fn replace_config(&mut self, spec: ConfigChoices) -> bool {
        let Self::Config(content) = self else {
            return false;
        };
        content.replace(spec);
        true
    }

    pub(crate) fn open_subscription(&mut self, spec: ConfigChoices) {
        if let Self::Config(content) = self {
            content.open_subscription(spec);
        }
    }

    pub(crate) fn open_advisor(&mut self, spec: crate::config::AdvisorChoices) {
        if let Self::Config(content) = self {
            content.open_advisor(spec);
        }
    }

    pub(crate) fn update_advisor(&mut self, choices: crate::config::AdvisorChoices) {
        if let Self::Config(content) = self {
            content.update_advisor(choices);
        }
    }

    pub(crate) fn update_subscription(&mut self, spec: ConfigChoices) {
        if let Self::Config(content) = self {
            content.update_subscription(spec);
        }
    }

    pub(crate) fn finish_config_prompt(&mut self, spec: ConfigChoices) -> bool {
        let Self::Config(content) = self else {
            return false;
        };
        content.close_prompt_and_replace(spec);
        true
    }

    pub(crate) fn replace_connectors(&mut self, spec: ConnectorChoices) -> bool {
        let Self::Connectors(content) = self else {
            return false;
        };
        content.replace(spec.model, spec.actions);
        true
    }

    pub(crate) fn replace_keymap_catalog(&mut self, spec: KeymapChoices) -> bool {
        let Self::Keymap(content) = self else {
            return false;
        };
        content.replace_catalog(spec);
        true
    }

    pub(crate) fn replace_mcp(&mut self, spec: McpChoices) -> bool {
        let Self::Mcp(content) = self else {
            return false;
        };
        content.replace(spec.model, spec.actions);
        true
    }

    pub(crate) fn replace_skills(&mut self, spec: SkillChoices) -> bool {
        let Self::Skills(content) = self else {
            return false;
        };
        content.replace(spec.model, spec.actions);
        true
    }

    pub(crate) fn replace_status_line(&mut self, spec: StatusLineChoices) -> bool {
        let Self::StatusLine(content) = self else {
            return false;
        };
        content.replace(spec.model, spec.actions);
        true
    }

    pub(crate) fn push_custom_theme(&mut self, spec: ThemeChoices) -> bool {
        let Self::Theme(content) = self else {
            return false;
        };
        content.push_custom(spec);
        true
    }

    pub(crate) fn is_connectors(&self) -> bool {
        matches!(self, Self::Connectors(_))
    }

    pub(crate) fn is_skills(&self) -> bool {
        matches!(self, Self::Skills(_))
    }
}

fn map_read_only(outcome: ListSelectionOutcome<()>) -> CommandPanelOutcome {
    match outcome {
        ListSelectionOutcome::Activate(())
        | ListSelectionOutcome::Adjust((), ListSelectionAdjustment::Previous)
        | ListSelectionOutcome::Adjust((), ListSelectionAdjustment::Next)
        | ListSelectionOutcome::Consumed
        | ListSelectionOutcome::FocusPrevious => CommandPanelOutcome::Consumed,
        ListSelectionOutcome::Dismiss => CommandPanelOutcome::Dismiss,
    }
}

fn map_selection<A>(
    outcome: ListSelectionOutcome<A>,
    activate: impl FnOnce(A) -> CommandPanelOutcome,
) -> CommandPanelOutcome {
    match outcome {
        ListSelectionOutcome::Activate(action) => activate(action),
        ListSelectionOutcome::Adjust(_, _)
        | ListSelectionOutcome::Consumed
        | ListSelectionOutcome::FocusPrevious => CommandPanelOutcome::Consumed,
        ListSelectionOutcome::Dismiss => CommandPanelOutcome::Dismiss,
    }
}

impl<'a> CommandPanelBody<'a> {
    pub(super) fn title(self, language: crate::nls::Language) -> std::borrow::Cow<'a, str> {
        let title = match self {
            Self::Selection(selection) => {
                return std::borrow::Cow::Owned(selection.localized_title(language));
            }
            Self::Memories(panel) => panel.title(),
            Self::Prompt(prompt) => prompt.title(),
            Self::Provider(_) => "Custom provider",
            Self::KeyCapture(capture) => capture.title(),
            Self::Status(panel) => panel.title(),
        };
        crate::nls::localize(language, title)
    }

    pub(super) fn tab_rows(self, width: u16) -> u16 {
        match self {
            Self::Selection(selection) => selection.tab_rows(width),
            Self::Status(panel) => panel.tab_rows(width),
            Self::Memories(panel) => panel.tab_rows(width),
            Self::Provider(_) | Self::Prompt(_) | Self::KeyCapture(_) => 0,
        }
    }

    pub(super) fn body_rows(self, width: u16) -> u16 {
        match self {
            Self::Selection(selection) => selection.body_rows(width),
            Self::Memories(panel) => panel.body_rows(width),
            Self::Prompt(prompt) => prompt.desired_height(),
            Self::KeyCapture(capture) => capture.desired_height(),
            Self::Status(panel) => panel.body_rows(width),
            Self::Provider(panel) => panel.body_rows(),
        }
    }

    pub(super) fn presentation_focus(self) -> Option<ratatui::style::Color> {
        match self {
            Self::Selection(selection) => selection.presentation_focus(),
            Self::Memories(_)
            | Self::Prompt(_)
            | Self::KeyCapture(_)
            | Self::Status(_)
            | Self::Provider(_) => None,
        }
    }

    pub(super) fn draw_tabs(
        self,
        frame: &mut Frame<'_>,
        area: Rect,
        hovered_tab: Option<usize>,
        pressed_tab: Option<usize>,
        context: crate::render::RenderContext<'_>,
    ) {
        match self {
            Self::Selection(selection) => {
                list_selection::draw_tabs(frame, area, selection, hovered_tab, pressed_tab, context)
            }
            Self::Status(panel) => panel.draw_tabs(frame, area, hovered_tab, pressed_tab, context),
            Self::Memories(panel) => {
                panel.draw_tabs(frame, area, hovered_tab, pressed_tab, context)
            }
            Self::Provider(_) | Self::Prompt(_) | Self::KeyCapture(_) => {}
        }
    }

    pub(super) fn draw_body(
        self,
        frame: &mut Frame<'_>,
        area: Rect,
        hovered: Option<&list_selection::ListSelectionPointerTarget>,
        pressed: Option<&list_selection::ListSelectionPointerTarget>,
        context: crate::render::RenderContext<'_>,
    ) {
        match self {
            Self::Selection(selection) => list_selection::draw_body_with_pointer(
                frame, area, selection, hovered, pressed, context,
            ),
            Self::Memories(panel) => panel.draw(frame, area, None, None, context),
            Self::Prompt(prompt) => text_prompt::draw(frame, area, prompt, context),
            Self::KeyCapture(capture) => key_capture::draw(frame, area, capture, context),
            Self::Status(panel) => panel.draw_body(frame, area, context),
            Self::Provider(panel) => panel.draw_body(frame, area, context),
        }
    }
}

/// Mutable feature editors are held by the active page and moved intact on a mode switch.
#[derive(Debug, Default)]
pub(super) struct Panels {
    generation: u64,
    command: Option<CommandPanel>,
    pub(super) overlay: Option<crate::widgets::overlay::DetailOverlay>,
}

/// An explicitly transferred feature editor, without the source mode's detail overlay.
pub(super) struct Editor {
    generation: u64,
    command: CommandPanel,
}

impl Panels {
    pub(super) fn take_editor(&mut self) -> Option<Editor> {
        let command = self.command.take()?;
        let generation = std::mem::take(&mut self.generation);
        Some(Editor {
            generation,
            command,
        })
    }

    pub(super) fn receive_editor(&mut self, editor: Option<Editor>) {
        match editor {
            Some(editor) => {
                self.command = Some(editor.command);
                self.generation = editor.generation;
            }
            None => self.close_command(),
        }
    }
    pub(super) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn command(&self) -> Option<&CommandPanel> {
        self.command.as_ref()
    }

    pub(crate) fn command_key_hints(&self) -> Option<&crate::widgets::key_hint::KeyHints> {
        self.command.as_ref().map(CommandPanel::key_hints)
    }

    pub(crate) fn command_active(&self) -> bool {
        self.command.is_some()
    }

    pub(crate) fn open_command(&mut self, command: CommandPanel, generation: u64) {
        self.generation = generation;
        self.command = Some(command);
    }

    pub(crate) fn close_command(&mut self) {
        self.generation = 0;
        self.command = None;
    }

    pub(crate) fn handle_command_paste(&mut self, pasted: String) -> bool {
        let Some(command) = self.command.as_mut() else {
            return false;
        };
        command.handle_paste(pasted);
        true
    }

    pub(crate) fn command_list_selection(&self) -> Option<&ListSelectionState> {
        self.command.as_ref().and_then(CommandPanel::list_selection)
    }

    pub(crate) fn replace_dirs(&mut self, choices: DirChoices) {
        if let Some(command) = self.command.as_mut() {
            command.replace_dirs(choices);
        }
    }

    pub(crate) fn finish_dir_add(
        &mut self,
        request_id: u64,
        result: Result<crate::dirs::AddedDir, String>,
    ) {
        if let Some(command) = self.command.as_mut() {
            command.finish_dir_add(request_id, result);
        }
    }

    pub(crate) fn set_command_message(&mut self, message: String) {
        if let Some(command) = self.command.as_mut() {
            command.set_message(message);
        }
    }

    pub(crate) fn replace_config(&mut self, choices: ConfigChoices) {
        if let Some(command) = self.command.as_mut() {
            command.replace_config(choices);
        }
    }

    pub(crate) fn open_subscription(&mut self, choices: ConfigChoices) {
        if let Some(command) = self.command.as_mut() {
            command.open_subscription(choices);
        }
    }

    pub(crate) fn subscription_open(&self) -> bool {
        matches!(self.command.as_ref(), Some(CommandPanel::Config(editor)) if editor.subscription_open())
    }

    pub(crate) fn open_advisor(&mut self, choices: crate::config::AdvisorChoices) {
        if let Some(command) = self.command.as_mut() {
            command.open_advisor(choices);
        }
    }

    pub(crate) fn update_advisor(&mut self, choices: crate::config::AdvisorChoices) {
        if let Some(command) = self.command.as_mut() {
            command.update_advisor(choices);
        }
    }

    pub(crate) fn complete_connection(&mut self, reply: crate::config::provider::Reply) {
        if let Some(CommandPanel::Config(editor)) = self.command.as_mut() {
            editor.complete_connection(reply);
        }
    }

    pub(crate) fn update_subscription(&mut self, choices: ConfigChoices) {
        if let Some(command) = self.command.as_mut() {
            command.update_subscription(choices);
        }
    }

    pub(crate) fn finish_config_prompt(&mut self, choices: ConfigChoices) {
        if let Some(command) = self.command.as_mut() {
            command.finish_config_prompt(choices);
        }
    }

    pub(crate) fn replace_connectors(&mut self, choices: ConnectorChoices) {
        if let Some(command) = self.command.as_mut() {
            command.replace_connectors(choices);
        }
    }

    pub(crate) fn replace_model(&mut self, choices: crate::models::ModelChoices) {
        if let Some(CommandPanel::Model(selection)) = self.command.as_mut() {
            selection.replace(choices.model, choices.actions);
        }
    }

    pub(crate) fn replace_mcp(&mut self, choices: McpChoices) {
        if let Some(command) = self.command.as_mut() {
            command.replace_mcp(choices);
        }
    }

    pub(crate) fn replace_skills(&mut self, choices: SkillChoices) {
        if let Some(command) = self.command.as_mut() {
            command.replace_skills(choices);
        }
    }

    pub(crate) fn replace_keymap(&mut self, choices: KeymapChoices) {
        if let Some(command) = self.command.as_mut() {
            command.replace_keymap_catalog(choices);
        }
    }

    pub(crate) fn replace_status_line(&mut self, choices: StatusLineChoices) {
        if let Some(command) = self.command.as_mut() {
            command.replace_status_line(choices);
        }
    }

    pub(crate) fn apply_process_resources(&mut self, resources: ProcessResourcesView) {
        if let Some(command) = self.command.as_mut() {
            command.apply_process_resources(resources);
        }
    }

    pub(crate) fn push_custom_theme(&mut self, choices: ThemeChoices) {
        if let Some(command) = self.command.as_mut() {
            command.push_custom_theme(choices);
        }
    }

    pub(crate) fn command_is_keymap(&self) -> bool {
        matches!(self.command, Some(CommandPanel::Keymap(_)))
    }

    pub(crate) fn command_is_connectors(&self) -> bool {
        self.command
            .as_ref()
            .is_some_and(CommandPanel::is_connectors)
    }

    pub(crate) fn command_is_skills(&self) -> bool {
        self.command.as_ref().is_some_and(CommandPanel::is_skills)
    }

    pub(crate) fn command_is_theme(&self) -> bool {
        matches!(self.command, Some(CommandPanel::Theme(_)))
    }

    pub(super) fn command_mut(&mut self) -> Option<&mut CommandPanel> {
        self.command.as_mut()
    }
}
