use crate::SlashLauncherInput;
use crate::SlashLauncherSelection;
use crate::SlashLauncherSnapshot;

/// Immutable renderer projection for one visible Slash Launcher.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SlashLauncherView<'a> {
    pub query: &'a str,
    pub items: &'a [SlashLauncherSelection],
    pub selected: usize,
}

/// Headless query, selection, dismissal, and snapshot-refresh state.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SlashLauncherState {
    snapshot: SlashLauncherSnapshot,
    input: Option<String>,
    cursor: usize,
    query: Option<String>,
    items: Vec<SlashLauncherSelection>,
    selected: usize,
    dismissed_input: Option<String>,
}

impl SlashLauncherState {
    pub fn new(snapshot: SlashLauncherSnapshot) -> Self {
        Self {
            snapshot,
            ..Self::default()
        }
    }

    pub fn snapshot(&self) -> &SlashLauncherSnapshot {
        &self.snapshot
    }

    pub fn set_snapshot(&mut self, snapshot: SlashLauncherSnapshot) {
        let selected_key = self.selected_item().map(|selection| {
            (
                selection.list_id().to_owned(),
                selection.item_id().to_owned(),
            )
        });
        self.snapshot = snapshot;
        self.refresh();
        if let Some((list_id, item_id)) = selected_key
            && let Some(index) = self.items.iter().position(|selection| {
                selection.list_id() == list_id && selection.item_id() == item_id
            })
        {
            self.selected = index;
        }
    }

    pub fn sync_input(&mut self, input: &str, cursor: usize) {
        self.input = Some(input.to_owned());
        self.cursor = cursor;
        self.refresh();
    }

    pub fn view(&self) -> Option<SlashLauncherView<'_>> {
        (self.query.is_some() && self.dismissed_input.as_deref() != self.input.as_deref()).then(
            || SlashLauncherView {
                query: self.query.as_deref().expect("query presence was checked"),
                items: &self.items,
                selected: self.selected,
            },
        )
    }

    pub fn selected_item(&self) -> Option<&SlashLauncherSelection> {
        self.view().and_then(|view| view.items.get(view.selected))
    }

    pub fn item_at(&self, index: usize) -> Option<&SlashLauncherSelection> {
        self.view().and_then(|view| view.items.get(index))
    }

    pub fn select_previous(&mut self) {
        if self.items.is_empty() {
            return;
        }
        self.selected = if self.selected == 0 {
            self.items.len() - 1
        } else {
            self.selected - 1
        };
    }

    pub fn select_next(&mut self) {
        if !self.items.is_empty() {
            self.selected = (self.selected + 1) % self.items.len();
        }
    }

    pub fn select(&mut self, index: usize) -> bool {
        if index >= self.items.len() || self.view().is_none() {
            return false;
        }
        self.selected = index;
        true
    }

    pub fn dismiss(&mut self) {
        self.dismissed_input.clone_from(&self.input);
    }

    pub fn clear(&mut self) {
        self.input = None;
        self.cursor = 0;
        self.query = None;
        self.items.clear();
        self.selected = 0;
        self.dismissed_input = None;
    }

    fn refresh(&mut self) {
        let Some(input) = self.input.as_deref() else {
            self.query = None;
            self.items.clear();
            return;
        };
        let Some(query) = SlashLauncherInput::at_cursor(input, self.cursor).query() else {
            self.query = None;
            self.items.clear();
            self.selected = 0;
            self.dismissed_input = None;
            return;
        };
        let query_changed = self.query.as_deref() != Some(query.text);
        self.query = Some(query.text.to_owned());
        self.items = self.snapshot.matching(query.text);
        if query_changed {
            self.selected = 0;
        } else {
            self.selected = self.selected.min(self.items.len().saturating_sub(1));
        }
        if self.dismissed_input.as_deref() != Some(input) {
            self.dismissed_input = None;
        }
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
