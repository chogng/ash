//! Logical Sidebar items and their application metadata.

#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;

use ash_protocol::SessionId;

use crate::TabStatus;

/// Stable logical identity for one input that can be shown by a Workbench tab.
///
/// UI element identities deliberately do not belong here. They are allocated by the mounted tab
/// list when the input is projected into a frame.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum TabInputKey {
    Session(SessionId),
    Settings,
}

impl TabInputKey {
    pub fn session(session_id: SessionId) -> Self {
        Self::Session(session_id)
    }

    pub fn session_id(&self) -> Option<&SessionId> {
        match self {
            Self::Session(session_id) => Some(session_id),
            Self::Settings => None,
        }
    }

    pub const fn is_session(&self) -> bool {
        matches!(self, Self::Session(_))
    }

    pub const fn is_settings(&self) -> bool {
        matches!(self, Self::Settings)
    }
}

/// Application-owned logical input behind one Workbench tab.
///
/// This record contains the stable input identity and the labels needed by the Workbench view.
/// Session lifecycle and Thread state remain owned by the App Server session adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TabInput {
    key: TabInputKey,
    metadata: TabInputMetadata,
}

/// Display metadata supplied by the application owner for one Workbench tab.
///
/// The Workbench stores the current values used by its tab surfaces, but it does not derive them
/// from Session protocol records or decide application copy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TabInputMetadata {
    title: String,
    dirs: Vec<PathBuf>,
    status: TabStatus,
}

impl TabInputMetadata {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            dirs: Vec::new(),
            status: TabStatus::default(),
        }
    }

    /// Supplies the directories shown for this tab.
    pub fn with_dirs(mut self, dirs: impl IntoIterator<Item = PathBuf>) -> Self {
        self.dirs.clear();
        for dir in dirs {
            if !self.dirs.contains(&dir) {
                self.dirs.push(dir);
            }
        }
        self
    }

    pub fn with_status(mut self, status: TabStatus) -> Self {
        self.status = status;
        self
    }
}

impl TabInput {
    pub fn from_settings() -> Self {
        Self {
            key: TabInputKey::Settings,
            metadata: TabInputMetadata::new("Settings"),
        }
    }

    pub fn session(session_id: SessionId, metadata: TabInputMetadata) -> Self {
        Self {
            key: TabInputKey::session(session_id),
            metadata,
        }
    }

    pub fn key(&self) -> &TabInputKey {
        &self.key
    }

    pub fn session_id(&self) -> Option<&SessionId> {
        self.key.session_id()
    }

    pub const fn is_session(&self) -> bool {
        self.key.is_session()
    }

    pub const fn is_settings(&self) -> bool {
        self.key.is_settings()
    }

    pub fn title(&self) -> &str {
        &self.metadata.title
    }

    #[cfg(test)]
    pub fn first_dir(&self) -> Option<&Path> {
        self.metadata.dirs.first().map(PathBuf::as_path)
    }

    /// Returns the directories in display order.
    pub fn dirs(&self) -> &[PathBuf] {
        &self.metadata.dirs
    }

    pub const fn status(&self) -> &TabStatus {
        &self.metadata.status
    }

    pub(crate) fn update_from(&mut self, input: Self) {
        debug_assert_eq!(self.key, input.key);
        self.metadata = input.metadata;
    }
}

/// A change made while inserting or refreshing one logical TabInput.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TabInputChange {
    Added(TabInputKey),
    Updated(TabInputKey),
}

#[cfg(test)]
#[path = "item_tests.rs"]
mod tests;
