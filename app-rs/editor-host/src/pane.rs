use crate::FileEditorDiagnosticTooltip;
use crate::FileEditorHost;
use crate::FileEditorSearchMode;
use crate::FileEditorSearchState;
use crate::LanguageCompletionPopover;
use crate::LanguageHoverPopover;
use ash_editor::{
    CodeEditor, CodeEditorDiagnostic, CodeEditorFoldControl, CodeEditorHeader,
    CodeEditorLineWrapping, CodeEditorNavigation, CodeEditorPosition, CodeEditorStyle,
};
use ash_text_file::TextFileStatus;
use ash_ui_components::{
    ButtonBackgrounds, ButtonState, ButtonStyle, InputBoxState, Radio, RadioGroup,
    RadioGroupOrientation, RadioGroupStyle, RadioSelection, SearchBox,
};
use zui::ui::{
    CaretVisibility, Component, ComponentElement, Edges, Element, PaintRect, Rect, Size, TextBlock,
    TextInputLayoutEngine, TextStyle, UiScene,
};

use crate::interaction::{
    FILE_EDITOR_DOCUMENT, FILE_EDITOR_FIND_INPUT, FILE_EDITOR_NOTICE, FILE_EDITOR_PANE,
    FILE_EDITOR_REPLACE_INPUT, FILE_EDITOR_SEARCH_BAR, FileEditorAction,
};
use ash_ui_theme::UiTheme;
use zui::ui::{AccessibilityRole, UiNode};

#[path = "pane_interaction.rs"]
mod interaction;

const TAB_BAR_HEIGHT: f32 = 32.0;
const TAB_HORIZONTAL_PADDING: f32 = 10.0;
const TAB_MIN_WIDTH: f32 = 96.0;
const TAB_MAX_WIDTH: f32 = 180.0;
const TAB_CLOSE_SIZE: f32 = 20.0;
const NOTICE_BAR_HEIGHT: f32 = 36.0;
const NOTICE_ACTION_WIDTH: f32 = 124.0;
const NOTICE_ACTION_GAP: f32 = 6.0;
const SEARCH_ROW_HEIGHT: f32 = 36.0;
const SEARCH_PADDING: f32 = 6.0;
const SEARCH_ACTION_GAP: f32 = 4.0;
const SEARCH_ACTION_WIDTH: f32 = 72.0;
const SEARCH_SUMMARY_WIDTH: f32 = 88.0;

const RELOAD_ACTIONS: [FileEditorAction; 1] = [FileEditorAction::Reload];
const CONFLICT_ACTIONS: [FileEditorAction; 2] =
    [FileEditorAction::Reload, FileEditorAction::Overwrite];
const CLOSE_ACTIONS: [FileEditorAction; 3] = [
    FileEditorAction::SaveAndClose,
    FileEditorAction::DiscardAndClose,
    FileEditorAction::CancelClose,
];
const FIND_ACTIONS: [FileEditorAction; 3] = [
    FileEditorAction::FindPrevious,
    FileEditorAction::FindNext,
    FileEditorAction::CloseSearch,
];
const REPLACE_ACTIONS: [FileEditorAction; 2] = [
    FileEditorAction::ReplaceCurrent,
    FileEditorAction::ReplaceAll,
];

/// Transient file-editor decision currently presented by the Desktop shell.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum FileEditorPrompt {
    #[default]
    None,
    ConfirmClose,
}

struct FileEditorNotice<'a> {
    message: String,
    actions: &'a [FileEditorAction],
    modal: bool,
}

/// Desktop file-tab and document presentation over a retained [`FileEditorHost`].
pub struct FileEditorPane<'a> {
    bounds: Rect,
    parent: zui::ui::ElementId,
    host: &'a FileEditorHost,
    editor_style: CodeEditorStyle,
    palette: UiTheme,
    caret_visibility: CaretVisibility,
    prompt: FileEditorPrompt,
    search_mode: FileEditorSearchMode,
    search_query: Option<SearchBox>,
    search_replacement: Option<SearchBox>,
    search_match_count: usize,
    diagnostics: &'a [CodeEditorDiagnostic],
    language_hover: Option<&'a ash_lsp_manager::LanguageHover>,
    language_completions: Option<&'a ash_lsp_manager::LanguageCompletions>,
    completion_selection: usize,
    pointer_position: Option<zui::ui::Point>,
}

impl<'a> FileEditorPane<'a> {
    pub const fn new(
        bounds: Rect,
        host: &'a FileEditorHost,
        editor_style: CodeEditorStyle,
        palette: UiTheme,
        caret_visibility: CaretVisibility,
    ) -> Self {
        Self {
            bounds,
            parent: FILE_EDITOR_PANE,
            host,
            editor_style,
            palette,
            caret_visibility,
            prompt: FileEditorPrompt::None,
            search_mode: FileEditorSearchMode::Hidden,
            search_query: None,
            search_replacement: None,
            search_match_count: 0,
            diagnostics: &[],
            language_hover: None,
            language_completions: None,
            completion_selection: 0,
            pointer_position: None,
        }
    }

    pub const fn with_parent(mut self, parent: zui::ui::ElementId) -> Self {
        self.parent = parent;
        self
    }

    pub const fn with_prompt(mut self, prompt: FileEditorPrompt) -> Self {
        self.prompt = prompt;
        self
    }

    pub const fn with_search_mode(mut self, mode: FileEditorSearchMode) -> Self {
        self.search_mode = mode;
        self
    }

    pub const fn with_diagnostics(mut self, diagnostics: &'a [CodeEditorDiagnostic]) -> Self {
        self.diagnostics = diagnostics;
        self
    }

    pub const fn with_pointer_position(mut self, pointer_position: Option<zui::ui::Point>) -> Self {
        self.pointer_position = pointer_position;
        self
    }

    pub const fn with_language_features(
        mut self,
        hover: Option<&'a ash_lsp_manager::LanguageHover>,
        completions: Option<&'a ash_lsp_manager::LanguageCompletions>,
    ) -> Self {
        self.language_hover = hover;
        self.language_completions = completions;
        self
    }

    pub const fn with_completion_selection(mut self, selected: usize) -> Self {
        self.completion_selection = selected;
        self
    }

    pub fn diagnostic_range_at(&self, point: zui::ui::Point) -> Option<std::ops::Range<usize>> {
        self.editor()?
            .diagnostic_at(point)
            .map(CodeEditorDiagnostic::range)
    }

    pub fn with_search(
        mut self,
        search: &FileEditorSearchState,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &zui::ui::UiDispatch,
        caret_visibility: CaretVisibility,
    ) -> Self {
        self.search_mode = search.mode();
        if self.search_mode == FileEditorSearchMode::Hidden {
            return self;
        }
        self.search_match_count = self.host.active_match_count(&search.query());
        let query_state = input_state(dispatch, FILE_EDITOR_FIND_INPUT, caret_visibility);
        self.search_query = Some(SearchBox::new(
            self.search_input_bounds(0),
            "Find",
            query_state,
            self.palette.search_box_style(),
            search.query_input(),
            text_layout,
        ));
        if self.search_mode == FileEditorSearchMode::Replace {
            let replacement_state =
                input_state(dispatch, FILE_EDITOR_REPLACE_INPUT, caret_visibility);
            self.search_replacement = Some(SearchBox::new(
                self.search_input_bounds(1),
                "Replace",
                replacement_state,
                self.palette.search_box_style(),
                search.replacement_input(),
                text_layout,
            ));
        }
        self
    }

    pub fn editor_bounds(&self) -> Rect {
        Rect::from_xywh(
            self.bounds.origin.x,
            self.bounds.origin.y + TAB_BAR_HEIGHT + self.search_height() + self.notice_height(),
            self.bounds.size.width,
            (self.bounds.size.height
                - TAB_BAR_HEIGHT
                - self.search_height()
                - self.notice_height())
            .max(0.0),
        )
    }

    pub fn search_caret_bounds(&self, focused: zui::ui::ElementId) -> Option<Rect> {
        match focused {
            FILE_EDITOR_FIND_INPUT => self.search_query.as_ref()?.caret_bounds(),
            FILE_EDITOR_REPLACE_INPUT => self.search_replacement.as_ref()?.caret_bounds(),
            _ => None,
        }
    }

    pub fn caret_bounds(&self) -> Option<Rect> {
        self.editor()?.caret_bounds()
    }

    pub fn text_position_at(&self, point: zui::ui::Point) -> Option<CodeEditorPosition> {
        self.editor()?.text_position_at(point)
    }

    pub fn fold_control(&self, index: usize) -> Option<CodeEditorFoldControl> {
        self.editor()?.fold_controls().get(index).copied()
    }

    pub fn fold_control_count(&self) -> usize {
        self.editor()
            .map_or(0, |editor| editor.fold_controls().len())
    }

    pub fn visible_row_capacity(&self) -> usize {
        self.editor()
            .map_or(0, |editor| editor.visible_row_capacity())
    }

    pub fn visual_row_count(&self) -> usize {
        self.editor().map_or(0, |editor| editor.visual_row_count())
    }

    pub fn caret_visual_row(&self) -> Option<usize> {
        self.editor()?.caret_visual_row()
    }

    pub fn navigation(&self) -> CodeEditorNavigation {
        self.editor()
            .map_or_else(CodeEditorNavigation::default, |editor| editor.navigation())
    }

    fn tab_width(&self) -> f32 {
        if self.host.tabs().is_empty() {
            return TAB_MIN_WIDTH;
        }
        (self.bounds.size.width / self.host.tabs().len() as f32).clamp(TAB_MIN_WIDTH, TAB_MAX_WIDTH)
    }

    fn tab_radio_group(&self) -> RadioGroup {
        let button_style = ButtonStyle::new(
            ButtonBackgrounds::new(self.palette.side_bar_background),
            TextStyle::new(12.0, self.palette.muted_foreground).with_line_height(18.0),
        )
        .with_selected_backgrounds(ButtonBackgrounds::new(self.palette.content_background))
        .with_selected_text_style(
            TextStyle::new(12.0, self.palette.foreground).with_line_height(18.0),
        )
        .with_leading_text()
        .with_padding(Edges::new(
            7.0,
            TAB_HORIZONTAL_PADDING + TAB_CLOSE_SIZE,
            7.0,
            TAB_HORIZONTAL_PADDING,
        ));
        let radios =
            self.host
                .tabs()
                .iter()
                .enumerate()
                .map(|(index, tab)| {
                    let suffix = match tab.status() {
                        TextFileStatus::Clean => "",
                        TextFileStatus::Dirty => " •",
                        TextFileStatus::ReloadAvailable => " ↻",
                        TextFileStatus::Conflict => " !",
                    };
                    Radio::new(format!("{}{suffix}", tab.label()), ButtonState::Resting)
                        .with_selection(if self.host.active_index() == Some(index) {
                            RadioSelection::Selected
                        } else {
                            RadioSelection::Unselected
                        })
                })
                .collect();
        RadioGroup::new(
            Rect::from_xywh(
                self.bounds.origin.x,
                self.bounds.origin.y,
                self.bounds.size.width,
                TAB_BAR_HEIGHT,
            ),
            RadioGroupOrientation::Horizontal,
            radios,
            RadioGroupStyle::new(button_style, Size::new(self.tab_width(), TAB_BAR_HEIGHT)),
        )
    }

    fn tab_bounds(&self, index: usize) -> Rect {
        self.tab_radio_group()
            .radio_bounds(index)
            .unwrap_or_default()
    }

    fn tab_close_bounds(&self, index: usize) -> Rect {
        let tab = self.tab_bounds(index);
        Rect::from_xywh(
            tab.origin.x + tab.size.width - TAB_CLOSE_SIZE - 6.0,
            tab.origin.y + (TAB_BAR_HEIGHT - TAB_CLOSE_SIZE) / 2.0,
            TAB_CLOSE_SIZE,
            TAB_CLOSE_SIZE,
        )
    }

    fn search_height(&self) -> f32 {
        match self.search_mode {
            FileEditorSearchMode::Hidden => 0.0,
            FileEditorSearchMode::Find => SEARCH_ROW_HEIGHT,
            FileEditorSearchMode::Replace => SEARCH_ROW_HEIGHT * 2.0,
        }
    }

    fn search_bounds(&self) -> Rect {
        Rect::from_xywh(
            self.bounds.origin.x,
            self.bounds.origin.y + TAB_BAR_HEIGHT,
            self.bounds.size.width,
            self.search_height(),
        )
    }

    fn search_input_bounds(&self, row: usize) -> Rect {
        let actions = if row == 0 {
            FIND_ACTIONS.len()
        } else {
            REPLACE_ACTIONS.len()
        };
        let summary = if row == 0 { SEARCH_SUMMARY_WIDTH } else { 0.0 };
        let reserved = actions as f32 * SEARCH_ACTION_WIDTH
            + actions.saturating_sub(1) as f32 * SEARCH_ACTION_GAP
            + summary
            + SEARCH_ACTION_GAP;
        Rect::from_xywh(
            self.bounds.origin.x + SEARCH_PADDING,
            self.bounds.origin.y + TAB_BAR_HEIGHT + row as f32 * SEARCH_ROW_HEIGHT + SEARCH_PADDING,
            (self.bounds.size.width - SEARCH_PADDING * 2.0 - reserved).max(80.0),
            SEARCH_ROW_HEIGHT - SEARCH_PADDING * 2.0,
        )
    }

    fn search_action_bounds(&self, action: FileEditorAction) -> Rect {
        let (row, actions) = match action {
            FileEditorAction::FindPrevious
            | FileEditorAction::FindNext
            | FileEditorAction::CloseSearch => (0, FIND_ACTIONS.as_slice()),
            FileEditorAction::ReplaceCurrent | FileEditorAction::ReplaceAll => {
                (1, REPLACE_ACTIONS.as_slice())
            }
            _ => return Rect::default(),
        };
        let index = actions
            .iter()
            .position(|candidate| *candidate == action)
            .unwrap_or(0);
        let group_width = actions.len() as f32 * SEARCH_ACTION_WIDTH
            + actions.len().saturating_sub(1) as f32 * SEARCH_ACTION_GAP;
        Rect::from_xywh(
            self.bounds.right() - SEARCH_PADDING - group_width
                + index as f32 * (SEARCH_ACTION_WIDTH + SEARCH_ACTION_GAP),
            self.bounds.origin.y + TAB_BAR_HEIGHT + row as f32 * SEARCH_ROW_HEIGHT + SEARCH_PADDING,
            SEARCH_ACTION_WIDTH,
            SEARCH_ROW_HEIGHT - SEARCH_PADDING * 2.0,
        )
    }

    fn search_summary_bounds(&self) -> Rect {
        let previous = self.search_action_bounds(FileEditorAction::FindPrevious);
        Rect::from_xywh(
            previous.origin.x - SEARCH_SUMMARY_WIDTH,
            previous.origin.y,
            SEARCH_SUMMARY_WIDTH - SEARCH_ACTION_GAP,
            previous.size.height,
        )
    }

    fn search_actions(&self) -> impl Iterator<Item = FileEditorAction> + '_ {
        FIND_ACTIONS.into_iter().chain(
            (self.search_mode == FileEditorSearchMode::Replace)
                .then_some(REPLACE_ACTIONS)
                .into_iter()
                .flatten(),
        )
    }

    fn notice(&self) -> Option<FileEditorNotice<'static>> {
        let tab = self.host.active()?;
        if self.prompt == FileEditorPrompt::ConfirmClose {
            return Some(FileEditorNotice {
                message: format!("Save changes to {} before closing?", tab.label()),
                actions: &CLOSE_ACTIONS,
                modal: true,
            });
        }
        match tab.status() {
            TextFileStatus::ReloadAvailable => Some(FileEditorNotice {
                message: format!("{} changed on disk.", tab.label()),
                actions: &RELOAD_ACTIONS,
                modal: false,
            }),
            TextFileStatus::Conflict => Some(FileEditorNotice {
                message: format!("{} has local and disk changes.", tab.label()),
                actions: &CONFLICT_ACTIONS,
                modal: false,
            }),
            TextFileStatus::Clean | TextFileStatus::Dirty => None,
        }
    }

    fn notice_height(&self) -> f32 {
        self.notice().map_or(0.0, |_| NOTICE_BAR_HEIGHT)
    }

    fn notice_bounds(&self) -> Rect {
        Rect::from_xywh(
            self.bounds.origin.x,
            self.bounds.origin.y + TAB_BAR_HEIGHT + self.search_height(),
            self.bounds.size.width,
            NOTICE_BAR_HEIGHT,
        )
    }

    fn notice_action_bounds(&self, action_count: usize, index: usize) -> Rect {
        let notice = self.notice_bounds();
        let action_width = self.notice_action_width(action_count);
        let total_width = action_count as f32 * action_width
            + action_count.saturating_sub(1) as f32 * NOTICE_ACTION_GAP;
        Rect::from_xywh(
            notice.origin.x + notice.size.width - total_width - 8.0
                + index as f32 * (action_width + NOTICE_ACTION_GAP),
            notice.origin.y + 6.0,
            action_width,
            NOTICE_BAR_HEIGHT - 12.0,
        )
    }

    fn notice_action_width(&self, action_count: usize) -> f32 {
        if action_count == 0 {
            return 0.0;
        }
        let gaps = action_count.saturating_sub(1) as f32 * NOTICE_ACTION_GAP;
        ((self.bounds.size.width - 16.0 - gaps).max(1.0) / action_count as f32)
            .min(NOTICE_ACTION_WIDTH)
    }

    fn editor(&self) -> Option<CodeEditor<'_>> {
        let tab = self.host.active()?;
        Some(
            CodeEditor::new(
                self.editor_bounds(),
                tab.document(),
                tab.viewport(),
                CodeEditorHeader::Hidden,
                self.editor_style.clone(),
            )
            .with_line_wrapping(CodeEditorLineWrapping::Soft)
            .with_diagnostics(self.diagnostics)
            .with_caret_visibility(self.caret_visibility),
        )
    }
}

impl Component for FileEditorPane<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("FileEditorPane")
            .in_bounds(self.bounds)
            .with_identity(FILE_EDITOR_PANE)
    }

    fn interaction_node(&self, element: &zui::ui::ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                FILE_EDITOR_PANE,
                element.bounds(),
                AccessibilityRole::Group,
                "File editor",
            )
            .with_parent(self.parent),
        )
    }

    fn compose(
        &self,
        context: &mut zui::ui::ComponentContext<'_, '_>,
        _element: &zui::ui::ComputedElement,
    ) {
        for region in interaction::child_interaction_regions(self) {
            context.draw_component(&region);
        }
        if let Some(root) = interaction::modal_root(self) {
            context.set_modal_root(root);
        }
        self.paint(context.scene_mut());
    }

    fn paint(&self, scene: &mut UiScene) {
        scene.draw_rect(PaintRect::new(self.bounds, self.palette.content_background));
        let tabs = self.tab_radio_group();
        scene.draw_component(&tabs);
        scene.with_clip(tabs.bounds(), |scene| {
            for index in 0..self.host.tabs().len() {
                let close = self.tab_close_bounds(index);
                scene.draw_text(TextBlock::new(
                    "×",
                    zui::ui::Point::new(close.origin.x + 5.0, close.origin.y + 1.0),
                    zui::ui::Size::new(TAB_CLOSE_SIZE - 6.0, 18.0),
                    TextStyle::new(14.0, self.palette.muted_foreground).with_line_height(18.0),
                ));
            }
        });
        if self.search_mode != FileEditorSearchMode::Hidden {
            scene.with_element(
                Element::leaf("FileEditorSearchBar")
                    .in_bounds(self.search_bounds())
                    .with_identity(FILE_EDITOR_SEARCH_BAR),
                |scene, _element| {
                    scene.draw_rect(PaintRect::new(
                        self.search_bounds(),
                        self.palette.side_bar_background,
                    ));
                    if let Some(query) = self.search_query.as_ref() {
                        scene.draw_component(query);
                    }
                    if let Some(replacement) = self.search_replacement.as_ref() {
                        scene.draw_component(replacement);
                    }
                    let summary = if self.search_match_count == 1 {
                        "1 match".to_owned()
                    } else {
                        format!("{} matches", self.search_match_count)
                    };
                    let summary_bounds = self.search_summary_bounds();
                    scene.draw_text(TextBlock::new(
                        summary,
                        zui::ui::Point::new(
                            summary_bounds.origin.x + 4.0,
                            summary_bounds.origin.y + 4.0,
                        ),
                        zui::ui::Size::new(summary_bounds.size.width - 8.0, 18.0),
                        TextStyle::new(11.0, self.palette.muted_foreground).with_line_height(18.0),
                    ));
                    for action in self.search_actions() {
                        let bounds = self.search_action_bounds(action);
                        scene.draw_rect(PaintRect::new(bounds, self.palette.content_background));
                        scene.draw_text(TextBlock::new(
                            action.label(),
                            zui::ui::Point::new(bounds.origin.x + 7.0, bounds.origin.y + 3.0),
                            zui::ui::Size::new(bounds.size.width - 14.0, 18.0),
                            TextStyle::new(11.0, self.palette.foreground).with_line_height(18.0),
                        ));
                    }
                },
            );
        }
        if let Some(notice) = self.notice() {
            scene.with_element(
                Element::leaf("FileEditorNotice")
                    .in_bounds(self.notice_bounds())
                    .with_identity(FILE_EDITOR_NOTICE),
                |scene, _element| {
                    let bounds = self.notice_bounds();
                    scene.draw_rect(PaintRect::new(bounds, self.palette.side_bar_background));
                    scene.draw_rect(PaintRect::new(
                        Rect::from_xywh(
                            bounds.origin.x,
                            bounds.origin.y + bounds.size.height - 1.0,
                            bounds.size.width,
                            1.0,
                        ),
                        self.palette.border,
                    ));
                    let action_width = notice.actions.len() as f32
                        * self.notice_action_width(notice.actions.len())
                        + notice.actions.len().saturating_sub(1) as f32 * NOTICE_ACTION_GAP;
                    scene.draw_text(TextBlock::new(
                        notice.message,
                        zui::ui::Point::new(bounds.origin.x + 10.0, bounds.origin.y + 9.0),
                        zui::ui::Size::new(
                            (bounds.size.width - action_width - 28.0).max(1.0),
                            18.0,
                        ),
                        TextStyle::new(12.0, self.palette.foreground).with_line_height(18.0),
                    ));
                    for (index, action) in notice.actions.iter().copied().enumerate() {
                        let action_bounds = self.notice_action_bounds(notice.actions.len(), index);
                        scene.draw_rect(PaintRect::new(
                            action_bounds,
                            self.palette.content_background,
                        ));
                        scene.draw_text(TextBlock::new(
                            action.label(),
                            zui::ui::Point::new(
                                action_bounds.origin.x + 10.0,
                                action_bounds.origin.y + 3.0,
                            ),
                            zui::ui::Size::new(action_bounds.size.width - 20.0, 18.0),
                            TextStyle::new(12.0, self.palette.foreground).with_line_height(18.0),
                        ));
                    }
                },
            );
        }
        let Some(editor) = self.editor() else {
            return;
        };
        scene.with_element(
            Element::leaf("FileEditorDocument")
                .in_bounds(self.editor_bounds())
                .with_identity(FILE_EDITOR_DOCUMENT),
            |scene, _element| {
                scene.draw_component(&editor);
                if let Some((point, diagnostic)) = self.pointer_position.and_then(|point| {
                    editor
                        .diagnostic_at(point)
                        .map(|diagnostic| (point, diagnostic))
                }) {
                    scene.draw_component(&FileEditorDiagnosticTooltip::new(
                        self.editor_bounds(),
                        point,
                        diagnostic,
                        crate::EditorOverlayStyle::from_theme(self.palette),
                    ));
                } else if let (Some(point), Some(hover)) =
                    (self.pointer_position, self.language_hover)
                {
                    scene.draw_component(&LanguageHoverPopover::new(
                        self.editor_bounds(),
                        point,
                        hover,
                        crate::EditorOverlayStyle::from_theme(self.palette),
                    ));
                }
                if let (Some(caret), Some(completions)) =
                    (editor.caret_bounds(), self.language_completions)
                {
                    scene.draw_component(&LanguageCompletionPopover::new(
                        self.editor_bounds(),
                        zui::ui::Point::new(caret.origin.x, caret.bottom()),
                        completions,
                        self.completion_selection,
                        crate::EditorOverlayStyle::from_theme(self.palette),
                    ));
                }
            },
        );
    }
}

fn input_state(
    dispatch: &zui::ui::UiDispatch,
    element: zui::ui::ElementId,
    caret_visibility: CaretVisibility,
) -> InputBoxState {
    if dispatch.is_focused(element) {
        InputBoxState::Focused(caret_visibility)
    } else if dispatch.is_hovered(element) {
        InputBoxState::Hovered
    } else {
        InputBoxState::Resting
    }
}

#[cfg(test)]
#[path = "pane_tests.rs"]
mod tests;
