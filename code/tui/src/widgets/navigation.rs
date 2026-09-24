//! Keys shared by focused lists and read-only surfaces, never by text editors.

use crate::keymap::bindings;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Navigation {
    Previous,
    Next,
    PagePrevious,
    PageNext,
    First,
    Last,
}

impl Navigation {
    pub(crate) fn from_key(key: KeyEvent) -> Option<Self> {
        if key.kind == KeyEventKind::Release {
            return None;
        }
        [
            (bindings::PREVIOUS, Self::Previous),
            (bindings::NEXT, Self::Next),
            (bindings::PAGE_PREVIOUS, Self::PagePrevious),
            (bindings::PAGE_NEXT, Self::PageNext),
            (bindings::FIRST, Self::First),
            (bindings::LAST, Self::Last),
        ]
        .into_iter()
        .find_map(|(shortcut, action)| shortcut.matches(key).then_some(action))
    }

    pub(crate) fn offset(self, current: usize, last: usize, page_rows: usize) -> usize {
        let current = current.min(last);
        match self {
            Self::Previous => current.saturating_sub(1),
            Self::Next => current.saturating_add(1).min(last),
            Self::PagePrevious => current.saturating_sub(page_rows.max(1)),
            Self::PageNext => current.saturating_add(page_rows.max(1)).min(last),
            Self::First => 0,
            Self::Last => last,
        }
    }
}

#[cfg(test)]
#[path = "navigation_tests.rs"]
mod tests;
