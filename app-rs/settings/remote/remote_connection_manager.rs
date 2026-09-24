use ash_remote::RemoteDirPath;
use ash_remote::SshHost;
use ash_remote::SshTarget;
use ash_remote_connections::RemoteConnectionEntry;
use ash_remote_connections::RemoteConnectionName;
use ash_ui_components::ScrollAxis;
use ash_ui_components::ScrollCommand;
use ash_ui_components::ScrollMetrics;
use ash_ui_components::ScrollState;
use zui::ui::ElementId;
use zui::ui::Rect;
use zui::ui::TextInput;
use zui::ui::TextInputCommand;
use zui::ui::TextInputCompositionEvent;

const REMOTE_CONNECTION_MANAGER_SCOPE: u32 = 10;
pub const REMOTE_CONNECTION_MANAGER: ElementId =
    ElementId::scoped(REMOTE_CONNECTION_MANAGER_SCOPE, 1);
pub const REMOTE_CONNECTION_MANAGER_CLOSE: ElementId =
    ElementId::scoped(REMOTE_CONNECTION_MANAGER_SCOPE, 2);
pub const REMOTE_CONNECTION_MANAGER_NEW: ElementId =
    ElementId::scoped(REMOTE_CONNECTION_MANAGER_SCOPE, 3);
pub const REMOTE_CONNECTION_MANAGER_NAME: ElementId =
    ElementId::scoped(REMOTE_CONNECTION_MANAGER_SCOPE, 4);
pub const REMOTE_CONNECTION_MANAGER_HOST: ElementId =
    ElementId::scoped(REMOTE_CONNECTION_MANAGER_SCOPE, 5);
pub const REMOTE_CONNECTION_MANAGER_DIRECTORY: ElementId =
    ElementId::scoped(REMOTE_CONNECTION_MANAGER_SCOPE, 6);
pub const REMOTE_CONNECTION_MANAGER_SAVE: ElementId =
    ElementId::scoped(REMOTE_CONNECTION_MANAGER_SCOPE, 7);
pub const REMOTE_CONNECTION_MANAGER_DELETE: ElementId =
    ElementId::scoped(REMOTE_CONNECTION_MANAGER_SCOPE, 8);
pub const REMOTE_CONNECTION_MANAGER_CONNECT: ElementId =
    ElementId::scoped(REMOTE_CONNECTION_MANAGER_SCOPE, 9);
pub const REMOTE_CONNECTION_MANAGER_LIST: ElementId =
    ElementId::scoped(REMOTE_CONNECTION_MANAGER_SCOPE, 10);
pub const REMOTE_CONNECTION_MANAGER_STATUS: ElementId =
    ElementId::scoped(REMOTE_CONNECTION_MANAGER_SCOPE, 11);
const FIRST_REMOTE_CONNECTION_MANAGER_ITEM: u32 = 16;
pub const REMOTE_CONNECTION_MANAGER_ITEM_HEIGHT: f32 = 34.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteConnectionManagerField {
    Name,
    Host,
    Directory,
}

impl RemoteConnectionManagerField {
    pub const fn element_id(self) -> ElementId {
        match self {
            Self::Name => REMOTE_CONNECTION_MANAGER_NAME,
            Self::Host => REMOTE_CONNECTION_MANAGER_HOST,
            Self::Directory => REMOTE_CONNECTION_MANAGER_DIRECTORY,
        }
    }

    pub fn from_element_id(id: ElementId) -> Option<Self> {
        [Self::Name, Self::Host, Self::Directory]
            .into_iter()
            .find(|field| field.element_id() == id)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RemoteConnectionSaveRequest {
    Create(RemoteConnectionEntry),
    Update {
        original: RemoteConnectionName,
        entry: RemoteConnectionEntry,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ManagerStatus {
    message: String,
    error: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RemoteConnectionManagerSurface {
    Dialog,
    Settings,
}

#[derive(Clone, Debug, PartialEq)]
struct OpenRemoteConnectionManager {
    connections: Vec<RemoteConnectionEntry>,
    surface: RemoteConnectionManagerSurface,
    restore_focus: Option<ElementId>,
    original: Option<RemoteConnectionName>,
    dirty: bool,
    launching: Option<RemoteConnectionName>,
    delete_confirmation: Option<RemoteConnectionName>,
    status: Option<ManagerStatus>,
}

/// Product-owned product editor for the shared credential-free Remote target catalog.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RemoteConnectionManagerState {
    open: Option<OpenRemoteConnectionManager>,
    name: TextInput,
    host: TextInput,
    dir: TextInput,
    scroll: ScrollState,
}

impl RemoteConnectionManagerState {
    pub fn open(
        &mut self,
        connections: Vec<RemoteConnectionEntry>,
        restore_focus: Option<ElementId>,
    ) {
        self.open_on_surface(
            connections,
            RemoteConnectionManagerSurface::Dialog,
            restore_focus,
        );
    }

    /// Opens the connection editor as the persistent Remote Settings section.
    pub fn open_settings(&mut self, connections: Vec<RemoteConnectionEntry>) {
        self.open_on_surface(connections, RemoteConnectionManagerSurface::Settings, None);
    }

    fn open_on_surface(
        &mut self,
        mut connections: Vec<RemoteConnectionEntry>,
        surface: RemoteConnectionManagerSurface,
        restore_focus: Option<ElementId>,
    ) {
        connections.sort_by(|left, right| left.name().cmp(right.name()));
        self.open = Some(OpenRemoteConnectionManager {
            connections,
            surface,
            restore_focus,
            original: None,
            dirty: false,
            launching: None,
            delete_confirmation: None,
            status: None,
        });
        self.scroll = ScrollState::default();
        if self.connections().is_empty() {
            self.load_new_draft();
        } else {
            self.load_connection(0);
        }
    }

    pub const fn is_open(&self) -> bool {
        self.open.is_some()
    }

    /// Returns whether the editor currently owns a modal dialog boundary.
    pub fn is_dialog(&self) -> bool {
        self.open
            .as_ref()
            .is_some_and(|open| open.surface == RemoteConnectionManagerSurface::Dialog)
    }

    /// Returns whether the editor is mounted in the Remote Settings section.
    pub fn is_settings(&self) -> bool {
        self.open
            .as_ref()
            .is_some_and(|open| open.surface == RemoteConnectionManagerSurface::Settings)
    }

    pub fn dismiss(&mut self) -> Option<ElementId> {
        self.cancel_compositions_except(None);
        self.open.take().and_then(|open| open.restore_focus)
    }

    pub fn connections(&self) -> &[RemoteConnectionEntry] {
        self.open
            .as_ref()
            .map(|open| open.connections.as_slice())
            .unwrap_or_default()
    }

    pub fn selected_name(&self) -> Option<&RemoteConnectionName> {
        self.open.as_ref()?.original.as_ref()
    }

    pub fn selected_index(&self) -> Option<usize> {
        let selected = self.selected_name()?;
        self.connections()
            .iter()
            .position(|entry| entry.name() == selected)
    }

    pub fn select(&mut self, index: usize) -> bool {
        if self.is_launching() {
            self.set_error("Wait for the Remote window to finish preparing or close to cancel");
            return false;
        }
        let Some(entry) = self.connections().get(index) else {
            return false;
        };
        if self.selected_name() == Some(entry.name()) {
            return false;
        }
        if self.open.as_ref().is_some_and(|open| open.dirty) {
            self.set_error("Save or close the editor before selecting another connection");
            return false;
        }
        self.load_connection(index);
        true
    }

    pub fn start_new(&mut self) -> bool {
        if self.is_launching() {
            self.set_error("Wait for the Remote window to finish preparing or close to cancel");
            return false;
        }
        if self.open.as_ref().is_some_and(|open| open.dirty) {
            self.set_error("Save or close the editor before creating another connection");
            return false;
        }
        self.load_new_draft();
        true
    }

    pub fn input(&self, field: RemoteConnectionManagerField) -> &TextInput {
        match field {
            RemoteConnectionManagerField::Name => &self.name,
            RemoteConnectionManagerField::Host => &self.host,
            RemoteConnectionManagerField::Directory => &self.dir,
        }
    }

    pub fn apply(&mut self, field: RemoteConnectionManagerField, command: TextInputCommand) {
        if self.is_launching() {
            self.set_error("Wait for the Remote window to finish preparing or close to cancel");
            return;
        }
        self.input_mut(field).apply(command);
        self.draft_changed();
    }

    pub fn apply_composition(
        &mut self,
        field: RemoteConnectionManagerField,
        event: TextInputCompositionEvent,
    ) {
        if self.is_launching() {
            return;
        }
        self.input_mut(field).apply_composition(event);
        self.draft_changed();
    }

    pub fn cancel_compositions_except(&mut self, active: Option<RemoteConnectionManagerField>) {
        for field in [
            RemoteConnectionManagerField::Name,
            RemoteConnectionManagerField::Host,
            RemoteConnectionManagerField::Directory,
        ] {
            if Some(field) != active {
                self.input_mut(field).cancel_composition();
            }
        }
    }

    pub fn selected_text(&self, field: RemoteConnectionManagerField) -> Option<&str> {
        self.input(field).selected_text()
    }

    pub fn save_request(&mut self) -> Option<RemoteConnectionSaveRequest> {
        if self.is_launching() {
            self.set_error("Wait for the Remote window to finish preparing or close to cancel");
            return None;
        }
        let entry = match self.validated_entry() {
            Ok(entry) => entry,
            Err(error) => {
                self.set_error(error);
                return None;
            }
        };
        Some(match self.selected_name().cloned() {
            Some(original) => RemoteConnectionSaveRequest::Update { original, entry },
            None => RemoteConnectionSaveRequest::Create(entry),
        })
    }

    pub fn save_succeeded(&mut self, entry: RemoteConnectionEntry) {
        let Some(open) = self.open.as_mut() else {
            return;
        };
        if let Some(original) = open.original.as_ref()
            && let Some(index) = open
                .connections
                .iter()
                .position(|existing| existing.name() == original)
        {
            open.connections.remove(index);
        }
        open.connections.push(entry.clone());
        open.connections
            .sort_by(|left, right| left.name().cmp(right.name()));
        open.original = Some(entry.name().clone());
        open.dirty = false;
        open.delete_confirmation = None;
        open.status = Some(ManagerStatus {
            message: format!("Saved `{}`", entry.name().as_str()),
            error: false,
        });
        self.replace_draft(&entry);
    }

    pub fn save_failed(&mut self, error: impl Into<String>) {
        self.set_error(error);
    }

    pub fn delete_request(&mut self) -> Option<RemoteConnectionName> {
        if self.is_launching() {
            self.set_error("Wait for the Remote window to finish preparing or close to cancel");
            return None;
        }
        let Some(name) = self.selected_name().cloned() else {
            self.set_error("Select a saved connection before deleting");
            return None;
        };
        let Some(open) = self.open.as_mut() else {
            return None;
        };
        if open.delete_confirmation.as_ref() == Some(&name) {
            return Some(name);
        }
        open.delete_confirmation = Some(name.clone());
        open.status = Some(ManagerStatus {
            message: format!("Press Confirm Delete to remove `{}`", name.as_str()),
            error: true,
        });
        None
    }

    pub fn delete_succeeded(&mut self, name: &RemoteConnectionName) {
        let Some(open) = self.open.as_mut() else {
            return;
        };
        open.connections.retain(|entry| entry.name() != name);
        open.dirty = false;
        open.delete_confirmation = None;
        open.status = Some(ManagerStatus {
            message: format!("Removed `{}`", name.as_str()),
            error: false,
        });
        if open.connections.is_empty() {
            self.load_new_draft();
            if let Some(open) = self.open.as_mut() {
                open.status = Some(ManagerStatus {
                    message: format!("Removed `{}`", name.as_str()),
                    error: false,
                });
            }
        } else {
            self.load_connection(0);
            if let Some(open) = self.open.as_mut() {
                open.status = Some(ManagerStatus {
                    message: format!("Removed `{}`", name.as_str()),
                    error: false,
                });
            }
        }
    }

    pub fn delete_label(&self) -> &'static str {
        if self.open.as_ref().is_some_and(|open| {
            open.delete_confirmation.as_ref() == open.original.as_ref() && open.original.is_some()
        }) {
            "Confirm Delete"
        } else {
            "Delete"
        }
    }

    pub fn status(&self) -> Option<(&str, bool)> {
        self.open
            .as_ref()?
            .status
            .as_ref()
            .map(|status| (status.message.as_str(), status.error))
    }

    pub const fn scroll_state(&self) -> ScrollState {
        self.scroll
    }

    pub fn apply_scroll(&mut self, command: ScrollCommand, metrics: ScrollMetrics) -> bool {
        self.scroll.apply(command, metrics, ScrollAxis::Vertical)
    }

    pub fn ensure_item_visible(&mut self, index: usize, metrics: ScrollMetrics) -> bool {
        self.apply_scroll(
            ScrollCommand::EnsureVisible(Rect::from_xywh(
                0.0,
                index as f32 * REMOTE_CONNECTION_MANAGER_ITEM_HEIGHT,
                metrics.content().width,
                REMOTE_CONNECTION_MANAGER_ITEM_HEIGHT,
            )),
            metrics,
        )
    }

    fn validated_entry(&self) -> Result<RemoteConnectionEntry, String> {
        let name =
            RemoteConnectionName::parse(self.name.text()).map_err(|error| error.to_string())?;
        let host = SshHost::parse(self.host.text()).map_err(|error| error.to_string())?;
        let dir = RemoteDirPath::parse(self.dir.text()).map_err(|error| error.to_string())?;
        Ok(RemoteConnectionEntry::new(name, SshTarget::new(host, dir)))
    }

    fn load_connection(&mut self, index: usize) {
        let Some(entry) = self.connections().get(index).cloned() else {
            return;
        };
        self.replace_draft(&entry);
        if let Some(open) = self.open.as_mut() {
            open.original = Some(entry.name().clone());
            open.dirty = false;
            open.delete_confirmation = None;
            open.status = None;
        }
    }

    fn load_new_draft(&mut self) {
        replace_text(&mut self.name, "");
        replace_text(&mut self.host, "");
        replace_text(&mut self.dir, "");
        if let Some(open) = self.open.as_mut() {
            open.original = None;
            open.dirty = false;
            open.delete_confirmation = None;
            open.status = None;
        }
    }

    fn replace_draft(&mut self, entry: &RemoteConnectionEntry) {
        replace_text(&mut self.name, entry.name().as_str());
        replace_text(&mut self.host, entry.target().host().as_str());
        replace_text(&mut self.dir, entry.target().dir().as_str());
    }

    fn input_mut(&mut self, field: RemoteConnectionManagerField) -> &mut TextInput {
        match field {
            RemoteConnectionManagerField::Name => &mut self.name,
            RemoteConnectionManagerField::Host => &mut self.host,
            RemoteConnectionManagerField::Directory => &mut self.dir,
        }
    }

    fn draft_changed(&mut self) {
        if let Some(open) = self.open.as_mut() {
            open.dirty = true;
            open.delete_confirmation = None;
            open.status = None;
        }
    }

    fn set_error(&mut self, error: impl Into<String>) {
        if let Some(open) = self.open.as_mut() {
            open.delete_confirmation = None;
            open.status = Some(ManagerStatus {
                message: error.into(),
                error: true,
            });
        }
    }
}

pub fn remote_connection_manager_item_id(index: usize) -> ElementId {
    ElementId::scoped(
        REMOTE_CONNECTION_MANAGER_SCOPE,
        FIRST_REMOTE_CONNECTION_MANAGER_ITEM.saturating_add(index as u32),
    )
}

pub fn remote_connection_manager_item_index(id: ElementId, count: usize) -> Option<usize> {
    (0..count).find(|index| remote_connection_manager_item_id(*index) == id)
}

fn replace_text(input: &mut TextInput, value: &str) {
    input.take_text();
    if !value.is_empty() {
        input.apply(TextInputCommand::Insert(value.into()));
    }
}
impl RemoteConnectionManagerState {
    pub fn is_launching(&self) -> bool {
        self.open
            .as_ref()
            .is_some_and(|open| open.launching.is_some())
    }

    pub fn connect_request(&mut self) -> Option<RemoteConnectionName> {
        let Some(open) = self.open.as_ref() else {
            return None;
        };
        if open.dirty {
            self.set_error("Save changes before connecting");
            return None;
        }
        if open.launching.is_some() {
            self.set_error("The Remote window is already preparing");
            return None;
        }
        let Some(name) = open.original.clone() else {
            self.set_error("Save the new connection before connecting");
            return None;
        };
        Some(name)
    }

    pub fn can_delete(&self) -> bool {
        self.selected_name().is_some() && !self.is_launching()
    }

    pub fn can_mutate(&self) -> bool {
        self.is_open() && !self.is_launching()
    }

    pub fn can_connect(&self) -> bool {
        self.open
            .as_ref()
            .is_some_and(|open| open.original.is_some() && !open.dirty && open.launching.is_none())
    }

    pub fn launch_started(&mut self, name: RemoteConnectionName) {
        if let Some(open) = self.open.as_mut() {
            open.launching = Some(name);
            open.delete_confirmation = None;
            open.status = Some(ManagerStatus {
                message: "Starting Remote window…".into(),
                error: false,
            });
        }
    }

    pub fn launch_progress(&mut self, message: impl Into<String>) {
        if let Some(open) = self.open.as_mut()
            && open.launching.is_some()
        {
            open.status = Some(ManagerStatus {
                message: message.into(),
                error: false,
            });
        }
    }

    pub fn launch_failed(&mut self, error: impl Into<String>) {
        if let Some(open) = self.open.as_mut() {
            open.launching = None;
            open.status = Some(ManagerStatus {
                message: error.into(),
                error: true,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use ash_remote::RemoteDirPath;
    use ash_remote::SshHost;
    use ash_remote::SshTarget;
    use ash_remote_connections::RemoteConnectionEntry;
    use ash_remote_connections::RemoteConnectionName;
    use zui::ui::TextInputCommand;

    use super::RemoteConnectionManagerField;
    use super::RemoteConnectionManagerState;
    use super::RemoteConnectionSaveRequest;

    #[test]
    fn create_edit_connect_and_delete_requests_preserve_saved_identity() {
        let mut state = RemoteConnectionManagerState::default();
        state.open(Vec::new(), None);
        assert!(state.is_open());
        assert!(state.selected_name().is_none());

        insert(&mut state, RemoteConnectionManagerField::Name, "BUILD-01");
        insert(
            &mut state,
            RemoteConnectionManagerField::Host,
            "build.example",
        );
        insert(
            &mut state,
            RemoteConnectionManagerField::Directory,
            "/srv/project",
        );
        let RemoteConnectionSaveRequest::Create(created) = state.save_request().unwrap() else {
            panic!("new drafts create connections");
        };
        assert_eq!(created.name().as_str(), "build-01");
        state.save_succeeded(created.clone());
        assert_eq!(state.connect_request(), Some(name("build-01")));

        state.apply(
            RemoteConnectionManagerField::Name,
            TextInputCommand::SelectAll,
        );
        insert(&mut state, RemoteConnectionManagerField::Name, "STAGING");
        let RemoteConnectionSaveRequest::Update { original, entry } = state.save_request().unwrap()
        else {
            panic!("saved drafts update their original identity");
        };
        assert_eq!(original, name("build-01"));
        assert_eq!(entry.name(), &name("staging"));
        assert!(state.connect_request().is_none());
        state.save_succeeded(entry);
        assert_eq!(state.connect_request(), Some(name("staging")));

        assert!(state.delete_request().is_none());
        assert_eq!(state.delete_label(), "Confirm Delete");
        assert_eq!(state.delete_request(), Some(name("staging")));
        state.delete_succeeded(&name("staging"));
        assert!(state.connections().is_empty());
        assert!(state.selected_name().is_none());
    }

    #[test]
    fn settings_and_dialog_surfaces_are_explicit_and_mutually_exclusive() {
        let mut state = RemoteConnectionManagerState::default();

        state.open_settings(Vec::new());
        assert!(state.is_settings());
        assert!(!state.is_dialog());

        state.open(Vec::new(), None);
        assert!(state.is_dialog());
        assert!(!state.is_settings());
    }

    #[test]
    fn selection_is_sorted_and_refuses_to_discard_dirty_drafts() {
        let mut state = RemoteConnectionManagerState::default();
        state.open(
            vec![
                entry("staging", "staging.example", "/srv/staging"),
                entry("build", "build.example", "/srv/build"),
            ],
            None,
        );
        assert_eq!(state.selected_name(), Some(&name("build")));
        assert!(state.select(1));
        assert_eq!(state.selected_name(), Some(&name("staging")));

        insert(
            &mut state,
            RemoteConnectionManagerField::Directory,
            "/changed",
        );
        assert!(!state.select(0));
        assert_eq!(state.selected_name(), Some(&name("staging")));
        assert!(state.status().unwrap().0.contains("Save or close"));
        assert!(!state.start_new());
    }

    #[test]
    fn invalid_drafts_report_the_canonical_field_error() {
        let mut state = RemoteConnectionManagerState::default();
        state.open(Vec::new(), None);
        insert(&mut state, RemoteConnectionManagerField::Name, "bad name");
        insert(&mut state, RemoteConnectionManagerField::Host, "host");
        insert(
            &mut state,
            RemoteConnectionManagerField::Directory,
            "relative",
        );

        assert!(state.save_request().is_none());
        let (message, error) = state.status().unwrap();
        assert!(error);
        assert!(message.contains("name must contain"));
    }

    #[test]
    fn child_launch_progress_locks_mutation_and_failure_is_retryable() {
        let mut state = RemoteConnectionManagerState::default();
        state.open(vec![entry("build", "build.example", "/srv/project")], None);
        state.launch_started(name("build"));
        assert!(state.is_launching());
        assert!(!state.can_mutate());
        assert!(!state.can_connect());
        assert!(!state.can_delete());

        let original_host = state
            .input(RemoteConnectionManagerField::Host)
            .text()
            .to_owned();
        state.apply(
            RemoteConnectionManagerField::Host,
            TextInputCommand::Insert("ignored".into()),
        );
        assert_eq!(
            state.input(RemoteConnectionManagerField::Host).text(),
            original_host
        );

        state.launch_progress("Uploading Remote runtime… 50%");
        assert_eq!(state.status().unwrap().0, "Uploading Remote runtime… 50%");
        state.launch_failed("server unavailable");
        assert!(!state.is_launching());
        assert!(state.can_connect());
        assert_eq!(state.status(), Some(("server unavailable", true)));
    }

    fn insert(
        state: &mut RemoteConnectionManagerState,
        field: RemoteConnectionManagerField,
        value: &str,
    ) {
        state.apply(field, TextInputCommand::Insert(value.into()));
    }

    fn name(value: &str) -> RemoteConnectionName {
        RemoteConnectionName::parse(value).unwrap()
    }

    fn entry(name_value: &str, host: &str, dir: &str) -> RemoteConnectionEntry {
        RemoteConnectionEntry::new(
            name(name_value),
            SshTarget::new(
                SshHost::parse(host).unwrap(),
                RemoteDirPath::parse(dir).unwrap(),
            ),
        )
    }
}
