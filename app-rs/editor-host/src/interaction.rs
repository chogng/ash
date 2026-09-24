use std::ops::Range;

use zui::ui::ElementId;

const EDITOR_SCOPE: u32 = 7;
const EDITOR_ACTION_SCOPE: u32 = 8;
const FIRST_EDITOR_TAB: u32 = 200;
const FIRST_EDITOR_FOLD: u32 = 1_000;
const FIRST_EDITOR_CLOSE: u32 = 100;

pub const FILE_EDITOR_PANE: ElementId = ElementId::scoped(EDITOR_SCOPE, 1);
pub const FILE_EDITOR_DOCUMENT: ElementId = ElementId::scoped(EDITOR_SCOPE, 2);
pub const FILE_EDITOR_TABS: ElementId = ElementId::scoped(EDITOR_SCOPE, 3);
pub const FILE_EDITOR_FIND_INPUT: ElementId = ElementId::scoped(EDITOR_SCOPE, 4);
pub const FILE_EDITOR_REPLACE_INPUT: ElementId = ElementId::scoped(EDITOR_SCOPE, 5);
pub const FILE_EDITOR_SEARCH_BAR: ElementId = ElementId::scoped(EDITOR_SCOPE, 6);
pub const FILE_EDITOR_NOTICE: ElementId = ElementId::scoped(EDITOR_ACTION_SCOPE, 1);
const FILE_EDITOR_RELOAD: ElementId = ElementId::scoped(EDITOR_ACTION_SCOPE, 2);
const FILE_EDITOR_OVERWRITE: ElementId = ElementId::scoped(EDITOR_ACTION_SCOPE, 3);
const FILE_EDITOR_SAVE_AND_CLOSE: ElementId = ElementId::scoped(EDITOR_ACTION_SCOPE, 4);
const FILE_EDITOR_DISCARD_AND_CLOSE: ElementId = ElementId::scoped(EDITOR_ACTION_SCOPE, 5);
const FILE_EDITOR_CANCEL_CLOSE: ElementId = ElementId::scoped(EDITOR_ACTION_SCOPE, 6);
const FILE_EDITOR_FIND_PREVIOUS: ElementId = ElementId::scoped(EDITOR_ACTION_SCOPE, 7);
const FILE_EDITOR_FIND_NEXT: ElementId = ElementId::scoped(EDITOR_ACTION_SCOPE, 8);
const FILE_EDITOR_REPLACE_CURRENT: ElementId = ElementId::scoped(EDITOR_ACTION_SCOPE, 9);
const FILE_EDITOR_REPLACE_ALL: ElementId = ElementId::scoped(EDITOR_ACTION_SCOPE, 10);
const FILE_EDITOR_CLOSE_SEARCH: ElementId = ElementId::scoped(EDITOR_ACTION_SCOPE, 11);

pub fn file_editor_tab_id(index: usize) -> ElementId {
    dynamic_element_id(EDITOR_SCOPE, FIRST_EDITOR_TAB, index, "file editor tab")
}

pub fn file_editor_tab_index(id: ElementId, mut mounted: Range<usize>) -> Option<usize> {
    mounted.find(|index| file_editor_tab_id(*index) == id)
}

pub fn file_editor_close_id(index: usize) -> ElementId {
    dynamic_element_id(
        EDITOR_ACTION_SCOPE,
        FIRST_EDITOR_CLOSE,
        index,
        "file editor close button",
    )
}

pub fn file_editor_close_index(id: ElementId, mut mounted: Range<usize>) -> Option<usize> {
    mounted.find(|index| file_editor_close_id(*index) == id)
}

pub fn file_editor_fold_id(index: usize) -> ElementId {
    dynamic_element_id(EDITOR_SCOPE, FIRST_EDITOR_FOLD, index, "file editor fold")
}

pub fn file_editor_fold_index(id: ElementId, mut mounted: Range<usize>) -> Option<usize> {
    mounted.find(|index| file_editor_fold_id(*index) == id)
}

fn dynamic_element_id(scope: u32, first: u32, index: usize, label: &str) -> ElementId {
    let local = u32::try_from(index)
        .ok()
        .and_then(|index| first.checked_add(index))
        .unwrap_or_else(|| panic!("{label} index must fit its element scope"));
    ElementId::scoped(scope, local)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileEditorAction {
    Reload,
    Overwrite,
    SaveAndClose,
    DiscardAndClose,
    CancelClose,
    FindPrevious,
    FindNext,
    ReplaceCurrent,
    ReplaceAll,
    CloseSearch,
}

impl FileEditorAction {
    pub const fn element_id(self) -> ElementId {
        match self {
            Self::Reload => FILE_EDITOR_RELOAD,
            Self::Overwrite => FILE_EDITOR_OVERWRITE,
            Self::SaveAndClose => FILE_EDITOR_SAVE_AND_CLOSE,
            Self::DiscardAndClose => FILE_EDITOR_DISCARD_AND_CLOSE,
            Self::CancelClose => FILE_EDITOR_CANCEL_CLOSE,
            Self::FindPrevious => FILE_EDITOR_FIND_PREVIOUS,
            Self::FindNext => FILE_EDITOR_FIND_NEXT,
            Self::ReplaceCurrent => FILE_EDITOR_REPLACE_CURRENT,
            Self::ReplaceAll => FILE_EDITOR_REPLACE_ALL,
            Self::CloseSearch => FILE_EDITOR_CLOSE_SEARCH,
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Reload => "Reload from Disk",
            Self::Overwrite => "Overwrite",
            Self::SaveAndClose => "Save",
            Self::DiscardAndClose => "Don't Save",
            Self::CancelClose => "Cancel",
            Self::FindPrevious => "Previous",
            Self::FindNext => "Next",
            Self::ReplaceCurrent => "Replace",
            Self::ReplaceAll => "Replace All",
            Self::CloseSearch => "Close",
        }
    }

    pub const fn from_element_id(id: ElementId) -> Option<Self> {
        match id {
            FILE_EDITOR_RELOAD => Some(Self::Reload),
            FILE_EDITOR_OVERWRITE => Some(Self::Overwrite),
            FILE_EDITOR_SAVE_AND_CLOSE => Some(Self::SaveAndClose),
            FILE_EDITOR_DISCARD_AND_CLOSE => Some(Self::DiscardAndClose),
            FILE_EDITOR_CANCEL_CLOSE => Some(Self::CancelClose),
            FILE_EDITOR_FIND_PREVIOUS => Some(Self::FindPrevious),
            FILE_EDITOR_FIND_NEXT => Some(Self::FindNext),
            FILE_EDITOR_REPLACE_CURRENT => Some(Self::ReplaceCurrent),
            FILE_EDITOR_REPLACE_ALL => Some(Self::ReplaceAll),
            FILE_EDITOR_CLOSE_SEARCH => Some(Self::CloseSearch),
            _ => None,
        }
    }
}
