//! Source-control snapshots for the Changes Pane.

use ash_editor::DiffEditorDocument;
use ash_ui_theme::UiTheme;
use zui::ui::Color;

mod branch_picker;
#[path = "scm/pane.rs"]
mod pane;
#[path = "scm/toolbar.rs"]
mod toolbar;

pub use branch_picker::{
    GIT_BRANCH_SEARCH_INPUT, GitBranchPicker, GitBranchPickerActivation, GitBranchPickerState,
};
pub use pane::EditorPane;
pub use pane::EditorPaneState;
pub use pane::ScrollbarPointerOutcome;
pub use toolbar::ChangesActivation;
pub use toolbar::ChangesScope;
pub use toolbar::ChangesToolbarAction;
pub use toolbar::ChangesToolbarState;
pub use toolbar::PullRequestMode;

pub const CHANGES_PANE: zui::ui::ElementId = zui::ui::ElementId::scoped(1, 29);
pub const MULTI_DIFF_EDITOR: zui::ui::ElementId = zui::ui::ElementId::scoped(1, 30);
pub const MULTI_DIFF_SCROLLBAR: zui::ui::ElementId = zui::ui::ElementId::scoped(1, 31);
pub const CHANGES_TOOLBAR: zui::ui::ElementId = zui::ui::ElementId::scoped(29, 1);
pub const COMMIT_MESSAGE_EDITOR: zui::ui::ElementId = zui::ui::ElementId::scoped(29, 60);

/// Theme values required by the SCM pane. Shell theme ownership remains in the host.
#[derive(Clone, Copy)]
pub struct ScmPaneStyle {
    pub surface: Color,
    pub border: Color,
    pub text: Color,
    pub text_muted: Color,
    pub hover: Color,
    pub active: Color,
    pub menu: Color,
    pub accent: Color,
}

impl ScmPaneStyle {
    pub const fn from_theme(theme: UiTheme) -> Self {
        Self {
            surface: theme.content_background,
            border: theme.border,
            text: theme.foreground,
            text_muted: theme.muted_foreground,
            hover: theme.list_hover_background,
            active: theme.list_active_background,
            menu: theme.menu_background,
            accent: theme.accent,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ScmStaging {
    #[default]
    Unstaged,
    Staged,
    Partial,
}

/// One changed-file snapshot supplied by the repository host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmDiff {
    path: String,
    document: DiffEditorDocument,
    staging: ScmStaging,
}

impl ScmDiff {
    pub fn new(path: impl Into<String>, document: DiffEditorDocument) -> Self {
        Self {
            path: path.into(),
            document,
            staging: ScmStaging::Unstaged,
        }
    }

    pub const fn with_staging(mut self, staging: ScmStaging) -> Self {
        self.staging = staging;
        self
    }

    pub fn path(&self) -> &str {
        &self.path
    }
    pub const fn document(&self) -> &DiffEditorDocument {
        &self.document
    }
    pub const fn staging(&self) -> ScmStaging {
        self.staging
    }
}

/// Retained source-control snapshot for the Changes pane.
///
/// The host maps its repository service result to this model; pane code must not
/// depend on a particular Git transport or directory implementation.
pub struct ScmState {
    diffs: Vec<ScmDiff>,
    editor: EditorPaneState,
    toolbar: ChangesToolbarState,
}

impl Default for ScmState {
    fn default() -> Self {
        Self {
            diffs: Vec::new(),
            editor: EditorPaneState::default(),
            toolbar: ChangesToolbarState::default(),
        }
    }
}

impl ScmState {
    pub fn replace_diffs(
        &mut self,
        diffs: impl IntoIterator<Item = ScmDiff>,
    ) -> Vec<ash_editor::MultiDiffEditorItemIdentity> {
        self.diffs = diffs.into_iter().collect();
        self.refresh_editor_scope()
    }

    pub const fn editor(&self) -> &EditorPaneState {
        &self.editor
    }
    pub fn editor_mut(&mut self) -> &mut EditorPaneState {
        &mut self.editor
    }

    pub const fn toolbar(&self) -> &ChangesToolbarState {
        &self.toolbar
    }

    pub fn toolbar_mut(&mut self) -> &mut ChangesToolbarState {
        &mut self.toolbar
    }

    pub fn set_branch(&mut self, branch: Option<&str>) {
        self.toolbar.set_branch(branch);
    }

    pub fn activate(&mut self, id: zui::ui::ElementId) -> ChangesActivation {
        if let Some(activation) = self.editor.activate(id) {
            return activation;
        }
        match ChangesToolbarAction::from_element_id(id) {
            Some(ChangesToolbarAction::CollapseAll) => {
                self.toolbar.dismiss_menus();
                self.editor.set_all_expanded(false);
                ChangesActivation::Changed
            }
            Some(ChangesToolbarAction::ExpandAll) => {
                self.toolbar.dismiss_menus();
                self.editor.set_all_expanded(true);
                ChangesActivation::Changed
            }
            Some(ChangesToolbarAction::StageAll) => {
                self.toolbar.dismiss_menus();
                ChangesActivation::Stage(
                    self.scoped_diffs()
                        .into_iter()
                        .filter(|diff| diff.staging != ScmStaging::Staged)
                        .map(|diff| diff.path.clone())
                        .collect(),
                )
            }
            Some(ChangesToolbarAction::DiscardAll) => {
                self.toolbar.dismiss_menus();
                ChangesActivation::Discard(
                    self.scoped_diffs()
                        .into_iter()
                        .filter(|diff| diff.staging != ScmStaging::Staged)
                        .map(|diff| diff.path.clone())
                        .collect(),
                )
            }
            action => {
                let activation = self.toolbar.activate(action);
                if matches!(activation, ChangesActivation::ScopeChanged(_)) {
                    let _ = self.refresh_editor_scope();
                }
                activation
            }
        }
    }

    fn scoped_diffs(&self) -> Vec<&ScmDiff> {
        self.diffs
            .iter()
            .filter(|diff| match self.toolbar.scope() {
                ChangesScope::Staged => diff.staging != ScmStaging::Unstaged,
                ChangesScope::Unstaged => diff.staging != ScmStaging::Staged,
                ChangesScope::CurrentTurn
                | ChangesScope::BeforeCurrentTurn
                | ChangesScope::PreviousTurn
                | ChangesScope::Uncommitted => true,
            })
            .collect()
    }

    fn refresh_editor_scope(&mut self) -> Vec<ash_editor::MultiDiffEditorItemIdentity> {
        let visible = self.scoped_diffs().into_iter().cloned().collect::<Vec<_>>();
        self.editor.replace_diffs(&visible)
    }
}

#[cfg(test)]
pub(crate) const TEST_SCM_PANE_STYLE: ScmPaneStyle = ScmPaneStyle {
    surface: Color::WHITE,
    border: Color::rgb(222, 222, 224),
    text: Color::rgb(38, 38, 41),
    text_muted: Color::rgb(126, 126, 132),
    hover: Color::rgb(232, 232, 232),
    active: Color::rgb(235, 235, 237),
    menu: Color::WHITE,
    accent: Color::rgb(15, 110, 96),
};
