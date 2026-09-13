use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use crate::PaneBinding;
use anyhow::Result;
use anyhow::anyhow;
use ash_app_server_protocol::protocol::config::ConfigUpdateParams;
use ash_app_server_protocol::protocol::environment::SessionDirListParams;
use ash_app_server_protocol::protocol::fs::FsChanged;
use ash_app_server_protocol::protocol::fs::FsGetMetadataParams;
use ash_app_server_protocol::protocol::fs::FsGetMetadataResult;
use ash_app_server_protocol::protocol::fs::FsReadDirectoryEntry;
use ash_app_server_protocol::protocol::fs::FsReadDirectoryParams;
use ash_app_server_protocol::protocol::fs::FsReadFileParams;
use ash_app_server_protocol::protocol::fs::FsWriteFileParams;
use ash_app_server_protocol::protocol::git::GitBranchDto;
use ash_app_server_protocol::protocol::git::GitBranchSwitchParams;
use ash_app_server_protocol::protocol::git::GitTextDiffResult;
use ash_files::DirectoryEntry;
use ash_protocol::CommandId;
use ash_protocol::Patch;
use ash_protocol::Session;
use ash_scm::ScmDiff;
use ash_text_file::TextFileAccess;
use ash_text_file::TextFileDiskVersion;
use ash_text_file::TextFileModifiedAt;
use ash_text_file::TextFileSaveRequest;
use ash_text_file::TextFileSnapshot;

use crate::PaneInput;
use crate::TabInputKey;
use crate::WorkbenchApplication;
use crate::app_server::AppServerRequestHandle;
use crate::app_server::ClientError;
use crate::app_server::ServerNotification;

const FILE_SNAPSHOT_READ_ATTEMPTS: usize = 3;

pub(crate) use ash_session::EnvCwdSetResult;
pub(crate) use ash_session::SessionRuntime;
pub(crate) use ash_session::SessionRuntimeEvent;

impl WorkbenchApplication {
    pub(crate) fn add_session(&mut self) {
        let Some(session) = self.session_runtime.as_ref() else {
            eprintln!("could not create session: App Server session is unavailable");
            return;
        };
        if let Err(error) = session.create_session() {
            eprintln!("could not create session: {error}");
        }
    }

    /// Mounts the Session Pane selected by Workbench. Tab selection itself stays in Workbench.
    pub(crate) fn mount_session_pane(&mut self, key: &TabInputKey) {
        let Some(tab) = self.workbench.workbench().sidebar_part().input(key) else {
            return;
        };
        let Some(session_id) = tab.session_id().cloned() else {
            return;
        };
        let was_terminal = self.main_surface.is_terminal();
        if !self.ensure_terminal_for_session(&session_id) {
            return;
        }
        let Some(session) = self.session_runtime.as_ref() else {
            return;
        };
        if let Err(error) = session.subscribe_session(session_id.clone()) {
            eprintln!("could not subscribe to Session: {error}");
            return;
        }
        self.activate_session_workbench_tab();
        let _ = self.activate_terminal_for_session(&session_id);
        if !was_terminal {
            let _ = self.bind_agent_pane();
        }
        self.rebuild_presentation_on_next_redraw();
    }

    fn upsert_session_tab(&mut self, session: &Session) {
        let dirs = self.session_dirs(session);
        let _ = self.workbench.upsert_session_input_with(
            crate::session_tab_input(session, dirs),
            PaneInput::terminal(session.session_id.clone()),
            PaneBinding::new,
        );
    }

    fn upsert_session_catalog(&mut self, sessions: &[Session]) {
        for session in sessions {
            let dirs = self.session_dirs(session);
            self.workbench.upsert_catalog_session_input_with(
                crate::session_tab_input(session, dirs),
                PaneInput::terminal(session.session_id.clone()),
                PaneBinding::new,
            );
        }
    }

    fn session_dirs(&mut self, session: &Session) -> Vec<PathBuf> {
        let mut dirs = vec![self.env.working_directory().to_path_buf()];
        let Some(client) = self.app_server_client.as_mut() else {
            return dirs;
        };
        match client.list_session_dirs(SessionDirListParams {
            session_id: session.session_id.clone(),
        }) {
            Ok(result) => {
                for dir in result.dirs {
                    if !dirs.contains(&dir.path) {
                        dirs.push(dir.path);
                    }
                }
            }
            Err(error) => {
                eprintln!(
                    "could not read directories for Session {}: {error}",
                    session.session_id
                );
            }
        }
        dirs
    }

    pub(crate) fn handle_session_runtime_event(&mut self, event: SessionRuntimeEvent) {
        match event {
            SessionRuntimeEvent::Connected(client) => {
                self.app_server_client = Some(client);
                if let Err(error) = self.refresh_configuration_from_app_server() {
                    eprintln!("could not refresh App Server configuration: {error}");
                }
                if let Err(error) = self.refresh_git_from_app_server() {
                    eprintln!("could not refresh Git state: {error}");
                }
                self.refresh_files_from_app_server();
            }
            SessionRuntimeEvent::Disconnected => {
                self.app_server_client = None;
            }
            SessionRuntimeEvent::Catalog {
                slash_commands,
                models,
            } => {
                if let Err(error) = self.session_pane.set_composer_catalog(
                    slash_commands,
                    ash_session::composer_model_options(models),
                ) {
                    eprintln!("could not install Slash Commands catalog: {error}");
                }
            }
            SessionRuntimeEvent::SessionCatalog(sessions) => {
                self.upsert_session_catalog(&sessions);
            }
            SessionRuntimeEvent::Snapshot {
                session,
                thread,
                transcript,
            } => {
                self.upsert_session_tab(&session);
                self.ensure_terminal_for_session(&session.session_id);
                self.activate_terminal_for_session(&session.session_id);
                let scroll_limit = self.thread_timeline_scroll_limit();
                self.session_pane
                    .replace_thread(thread, transcript, scroll_limit);
                let active_session = self
                    .active_session_tab_key()
                    .and_then(|key| key.session_id().cloned());
                if active_session.as_ref() == Some(&session.session_id)
                    && !self.main_surface.is_terminal()
                {
                    let _ = self.bind_agent_pane();
                }
            }
            SessionRuntimeEvent::TranscriptUpdate(update) => {
                let scroll_limit = self.thread_timeline_scroll_limit();
                self.session_pane
                    .apply_transcript_update(*update, scroll_limit);
            }
            SessionRuntimeEvent::Notification(notification) => match notification {
                ServerNotification::GitStatusChanged(_) => {
                    if let Err(error) = self.refresh_git_from_app_server() {
                        eprintln!("could not refresh Git state: {error}");
                    }
                }
                ServerNotification::FsChanged(changed) => {
                    if shell_completion_sources_changed(&changed) {
                        self.session_pane.refresh_dir_catalog();
                    }
                    self.refresh_files_from_app_server();
                    self.refresh_open_files_from_app_server(&changed);
                }
                ServerNotification::ConfigChanged(_) => {
                    if let Err(error) = self.refresh_configuration_from_app_server() {
                        eprintln!("could not refresh App Server configuration: {error}");
                    }
                }
                ServerNotification::SessionDeleted(deleted) => {
                    let tab = TabInputKey::session(deleted.session_id);
                    self.remove_workbench_tab(&tab);
                }
                _ => {}
            },
            SessionRuntimeEvent::Error(error) => {
                eprintln!("Session runtime failed: {error}");
            }
            SessionRuntimeEvent::Closed => {
                self.app_server_client = None;
            }
        }
        self.rebuild_presentation_on_next_redraw();
    }
}

fn shell_completion_sources_changed(changed: &FsChanged) -> bool {
    match changed {
        FsChanged::RescanRequired { .. } => true,
        FsChanged::PathsChanged { paths, .. } => paths.iter().any(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    matches!(
                        name,
                        "package.json"
                            | "Justfile"
                            | "justfile"
                            | ".justfile"
                            | "Makefile"
                            | "makefile"
                            | "GNUmakefile"
                    )
                })
        }),
    }
}

impl WorkbenchApplication {
    pub(crate) fn refresh_dir_capabilities(&mut self) {
        let pane_kind = self.active_main_pane_kind();
        self.files
            .set_dir_root(self.env.working_directory().to_path_buf());
        let mut removed = self.scm.replace_diffs([]);
        removed.extend(self.sync_repository_state());
        match pane_kind {
            Some(crate::PaneInputKind::Diff) => self.show_changes_pane(),
            Some(crate::PaneInputKind::Files) => self.show_files_pane(),
            _ => {}
        }
        self.remove_scm_animation_tracks(removed);
    }

    fn sync_repository_capability_state(&mut self) {
        let removed = self.sync_repository_state();
        self.remove_scm_animation_tracks(removed);
    }

    fn sync_repository_state(&mut self) -> Vec<ash_editor::MultiDiffEditorItemIdentity> {
        self.scm
            .set_branch(Some(self.env.git_branch_label()).filter(|branch| *branch != "No Git"));
        self.scm.replace_diffs(self.env.diffs().iter().map(|diff| {
            ScmDiff::new(diff.path(), diff.document().clone()).with_staging(diff.staging())
        }))
    }

    fn remove_scm_animation_tracks(
        &mut self,
        removed: Vec<ash_editor::MultiDiffEditorItemIdentity>,
    ) {
        for identity in removed {
            self.retained_runtime
                .animation_registry_mut()
                .remove_element(identity.section_id());
        }
    }

    pub(crate) fn refresh_files_from_app_server(&mut self) {
        let Some(client) = self.app_server_client.as_mut() else {
            return;
        };
        match client.read_directory(FsReadDirectoryParams {
            dir_id: None,
            session_directory: None,
            path: PathBuf::from("."),
        }) {
            Ok(result) => self.files.refresh(directory_entries(result.entries)),
            Err(error) => eprintln!("could not read App Server directory: {error}"),
        }
    }

    pub(crate) fn load_file_tree_directory(&mut self, element: zui::ui::ElementId, path: PathBuf) {
        let Some(client) = self.app_server_client.as_mut() else {
            return;
        };
        match client.read_directory(FsReadDirectoryParams {
            dir_id: None,
            session_directory: None,
            path,
        }) {
            Ok(result) => {
                self.files
                    .complete_directory_load(element, directory_entries(result.entries));
            }
            Err(error) => eprintln!("could not read App Server directory: {error}"),
        }
    }

    pub(crate) fn open_file(&mut self, path: PathBuf) {
        let Some(client) = self.app_server_client.as_mut() else {
            return;
        };
        match read_file(client, path) {
            Ok(snapshot) => {
                self.file_editor_host.open(snapshot);
                self.language_service
                    .synchronize_active(&self.file_editor_host);
                self.file_editor_input.reset_for_document_change();
                self.show_agent_pane();
                self.workbench.expand_inspector();
                self.main_surface.show_editor();
                self.pending_focus = Some(ash_editor_host::FILE_EDITOR_DOCUMENT);
                self.rebuild_presentation();
                self.request_redraw();
            }
            Err(error) => eprintln!("could not open App Server file: {error}"),
        }
    }

    pub(crate) fn open_language_definition(
        &mut self,
        target: ash_lsp_manager::LanguageLocationTarget,
    ) {
        let Some(client) = self.app_server_client.as_mut() else {
            return;
        };
        match read_file(client, target.path) {
            Ok(snapshot) => {
                self.file_editor_host.open(snapshot);
                if let Some(position) = definition_editor_position(
                    self.file_editor_host
                        .active()
                        .map(|tab| tab.document().text())
                        .unwrap_or_default(),
                    target.selection_range.start.row,
                    target.selection_range.start.character,
                    target.encoding,
                ) {
                    self.file_editor_host
                        .move_active_caret(position, ash_editor::CodeEditorSelectionMode::Move);
                }
                self.language_service
                    .synchronize_active(&self.file_editor_host);
                self.file_editor_input.reset_for_document_change();
                self.show_agent_pane();
                self.workbench.expand_inspector();
                self.main_surface.show_editor();
                self.pending_focus = Some(ash_editor_host::FILE_EDITOR_DOCUMENT);
                self.rebuild_presentation();
                self.request_redraw();
            }
            Err(error) => eprintln!("could not open language definition: {error}"),
        }
    }

    pub(crate) fn save_active_file(&mut self) {
        let Some(request) = self.file_editor_host.save_request() else {
            return;
        };
        let _ = self.write_active_file(request);
    }

    pub(crate) fn try_save_active_file(&mut self) -> bool {
        let Some(request) = self.file_editor_host.save_request() else {
            return false;
        };
        self.write_active_file(request)
    }

    pub(crate) fn overwrite_active_file(&mut self) -> bool {
        let Some(request) = self.file_editor_host.overwrite_request() else {
            return false;
        };
        self.write_active_file(request)
    }

    fn write_active_file(&mut self, request: TextFileSaveRequest) -> bool {
        let path = request.path().to_owned();
        let Some(client) = self.app_server_client.as_mut() else {
            return false;
        };
        let saved = match write_file(client, request) {
            Ok(version) => self.file_editor_host.mark_active_saved(version),
            Err(error) => {
                eprintln!("could not save App Server file: {error}");
                if let Ok(snapshot) = read_file(client, path.clone()) {
                    self.file_editor_host.observe_external(snapshot);
                }
                false
            }
        };
        if saved {
            self.language_service.save(&path);
        }
        self.rebuild_presentation();
        self.request_redraw();
        saved
    }

    fn refresh_open_files_from_app_server(&mut self, changed: &FsChanged) {
        let paths = match changed {
            FsChanged::PathsChanged { paths, .. } => self
                .file_editor_host
                .tabs()
                .iter()
                .filter(|tab| paths.iter().any(|path| path == tab.path()))
                .map(|tab| tab.path().to_path_buf())
                .collect::<Vec<_>>(),
            FsChanged::RescanRequired { .. } => self
                .file_editor_host
                .tabs()
                .iter()
                .map(|tab| tab.path().to_path_buf())
                .collect(),
        };
        let Some(client) = self.app_server_client.as_mut() else {
            return;
        };
        for path in paths {
            match read_file(client, path) {
                Ok(snapshot) => {
                    self.file_editor_host.observe_external(snapshot);
                }
                Err(error) => eprintln!("could not refresh open file: {error}"),
            }
        }
    }

    pub(crate) fn refresh_configuration_from_app_server(&mut self) -> Result<()> {
        let client = self
            .app_server_client
            .as_mut()
            .ok_or_else(|| anyhow!("App Server connection is unavailable"))?;
        let configuration = client.read_config().map_err(client_error)?;
        self.apply_gui_config(configuration.gui.clone());
        self.language_service
            .apply_configuration(&configuration, &self.file_editor_host);
        Ok(())
    }

    pub(crate) fn save_keybinding(
        &mut self,
        command: ash_commands::AppCommandId,
        keybinding: &ash_keybinding::KeySequence,
    ) -> Result<()> {
        {
            let client = self
                .app_server_client
                .as_mut()
                .ok_or_else(|| anyhow!("App Server connection is unavailable"))?;
            let config = client.read_config().map_err(client_error)?;
            let gui = crate::keybindings::edited_gui_config(
                config.gui,
                command,
                keybinding,
                ash_keybinding::HostPlatform::current(),
            )
            .map_err(anyhow::Error::msg)?;
            client
                .update_config(ConfigUpdateParams {
                    time_context: Default::default(),
                    features: Default::default(),
                    command_id: next_gui_config_command_id(),
                    expected_revision: config.revision,
                    model: Patch::Missing,
                    model_reasoning_effort: Patch::Missing,
                    approval_review_model: Patch::Missing,
                    commit_message_model: Patch::Missing,
                    tool_mode: Patch::Missing,
                    agent_grep_backend: Patch::Missing,
                    gui: Patch::Value(gui),
                    tui: Patch::Missing,
                })
                .map_err(client_error)?;
        }
        self.refresh_configuration_from_app_server()
    }

    pub(crate) fn refresh_git_from_app_server(&mut self) -> Result<()> {
        let client = self
            .app_server_client
            .as_mut()
            .ok_or_else(|| anyhow!("App Server connection is unavailable"))?;
        let snapshot = read_git_snapshot(client)?;
        self.env.apply_git_snapshot(snapshot.as_ref());
        self.sync_repository_capability_state();
        Ok(())
    }

    pub(crate) fn local_git_branches(&mut self) -> Result<Vec<GitBranchDto>> {
        self.app_server_client
            .as_mut()
            .ok_or_else(|| anyhow!("App Server connection is unavailable"))?
            .list_git_branches()
            .map(|result| result.branches)
            .map_err(client_error)
    }

    pub(crate) fn switch_git_branch(&mut self, name: String) -> Result<GitTextDiffResult> {
        let client = self
            .app_server_client
            .as_mut()
            .ok_or_else(|| anyhow!("App Server connection is unavailable"))?;
        client
            .switch_git_branch(GitBranchSwitchParams {
                repository_id: None,
                name,
            })
            .map_err(client_error)?;
        read_git_snapshot(client)?.ok_or_else(|| anyhow!("Git repository became unavailable"))
    }
}

fn read_file(client: &mut AppServerRequestHandle, path: PathBuf) -> Result<TextFileSnapshot> {
    for _ in 0..FILE_SNAPSHOT_READ_ATTEMPTS {
        let before = client
            .get_file_metadata(FsGetMetadataParams {
                dir_id: None,
                session_directory: None,
                path: path.clone(),
            })
            .map(disk_version)
            .map_err(client_error)?;
        let content = client
            .read_file(FsReadFileParams {
                dir_id: None,
                session_directory: None,
                path: path.clone(),
            })
            .map_err(client_error)?
            .content;
        let after = client
            .get_file_metadata(FsGetMetadataParams {
                dir_id: None,
                session_directory: None,
                path: path.clone(),
            })
            .map(disk_version)
            .map_err(client_error)?;
        if before == after {
            return Ok(TextFileSnapshot::new(path, content, after));
        }
    }
    Err(anyhow!(
        "{} kept changing while it was being read",
        path.display()
    ))
}

fn write_file(
    client: &mut AppServerRequestHandle,
    request: TextFileSaveRequest,
) -> Result<TextFileDiskVersion> {
    let (path, content, expected_version) = request.into_parts();
    let current = client
        .get_file_metadata(FsGetMetadataParams {
            dir_id: None,
            session_directory: None,
            path: path.clone(),
        })
        .map_err(client_error)?;
    let current = disk_version(current);
    if current != expected_version {
        return Err(anyhow!(
            "{} changed on disk since it was opened",
            path.display()
        ));
    }
    if current.is_read_only() {
        return Err(anyhow!("{} is read-only", path.display()));
    }
    client
        .write_file(FsWriteFileParams {
            dir_id: None,
            session_directory: None,
            path,
            content,
            expected_revision: None,
        })
        .map(|result| disk_version(result.metadata))
        .map_err(client_error)
}

fn disk_version(metadata: FsGetMetadataResult) -> TextFileDiskVersion {
    let access = if metadata.readonly {
        TextFileAccess::ReadOnly
    } else {
        TextFileAccess::Writable
    };
    TextFileDiskVersion::new(
        metadata.size_bytes,
        TextFileModifiedAt::from(metadata.modified_at_millis),
        access,
    )
}

fn read_git_snapshot(client: &mut AppServerRequestHandle) -> Result<Option<GitTextDiffResult>> {
    match client.git_text_diff() {
        Ok(snapshot) => Ok(Some(snapshot)),
        Err(error) if git_is_unavailable(&error) => Ok(None),
        Err(error) => Err(client_error(error)),
    }
}

fn git_is_unavailable(error: &ClientError) -> bool {
    matches!(
        error,
        ClientError::Server {
            code: -32062 | -32060,
            ..
        }
    )
}

fn client_error(error: ClientError) -> anyhow::Error {
    anyhow!(error.to_string())
}

fn next_gui_config_command_id() -> CommandId {
    static NEXT_COMMAND: AtomicU64 = AtomicU64::new(1);
    let sequence = NEXT_COMMAND.fetch_add(1, Ordering::Relaxed);
    CommandId::new(format!("gui-config-{}-{sequence}", std::process::id()))
        .expect("generated GUI config command ID is non-empty")
}

fn directory_entries(entries: Vec<FsReadDirectoryEntry>) -> Vec<DirectoryEntry> {
    entries
        .into_iter()
        .map(|entry| {
            if entry.file_type == ash_app_server_protocol::protocol::fs::FsFileType::Directory {
                DirectoryEntry::directory(entry.name)
            } else {
                DirectoryEntry::file(entry.name)
            }
        })
        .collect()
}

fn definition_editor_position(
    text: &str,
    row: u32,
    character: u32,
    encoding: ash_lsp_manager::LanguagePositionEncoding,
) -> Option<ash_editor::CodeEditorPosition> {
    let row_index = usize::try_from(row).ok()?;
    let line = text.split('\n').nth(row_index)?;
    let line = line.strip_suffix('\r').unwrap_or(line);
    let requested = usize::try_from(character).ok()?;
    let byte_offset = match encoding {
        ash_lsp_manager::LanguagePositionEncoding::Utf8 => {
            (requested <= line.len() && line.is_char_boundary(requested)).then_some(requested)?
        }
        ash_lsp_manager::LanguagePositionEncoding::Utf16 => {
            let mut units = 0;
            let mut resolved = None;
            for (offset, scalar) in line.char_indices() {
                if units == requested {
                    resolved = Some(offset);
                    break;
                }
                units += scalar.len_utf16();
                if units > requested {
                    return None;
                }
            }
            resolved.or_else(|| (units == requested).then_some(line.len()))?
        }
    };
    Some(ash_editor::CodeEditorPosition {
        row_index,
        byte_offset,
    })
}
