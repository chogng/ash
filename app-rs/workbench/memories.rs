mod view;
pub(crate) use view::body_editor;
pub(crate) use view::draw;
pub(crate) use view::list_bounds;

use crate::app_server::AppServerRequestHandle;
use crate::workbench_event::WorkbenchEvent;
use ash_app_server_protocol::protocol::memory::*;
use ash_editor::CodeEditorDocument;
use ash_editor::CodeEditorViewport;
use ash_protocol::ThreadId;
use memories::Memory;
use memories::MemoryPolicy;
use memories::MemoryScope;
use memories::MemorySummary;
use zui::app::ApplicationHandle;
use zui::runtime::BackgroundExecutor;
use zui::runtime::Task;
use zui::runtime::TaskScope;
use zui::ui::ElementId;
use zui::ui::TextInput;
use zui::ui::TextInputCommand;

const SCOPE: u32 = 41;
pub(crate) const ROOT: ElementId = ElementId::scoped(SCOPE, 1);
pub(crate) const CLOSE: ElementId = ElementId::scoped(SCOPE, 2);
pub(crate) const SCOPE_NEXT: ElementId = ElementId::scoped(SCOPE, 3);
pub(crate) const READING: ElementId = ElementId::scoped(SCOPE, 4);
pub(crate) const SAVING: ElementId = ElementId::scoped(SCOPE, 5);
pub(crate) const QUERY: ElementId = ElementId::scoped(SCOPE, 6);
pub(crate) const SEARCH: ElementId = ElementId::scoped(SCOPE, 7);
pub(crate) const TITLE: ElementId = ElementId::scoped(SCOPE, 8);
pub(crate) const BODY: ElementId = ElementId::scoped(SCOPE, 9);
pub(crate) const NEW: ElementId = ElementId::scoped(SCOPE, 10);
pub(crate) const SAVE: ElementId = ElementId::scoped(SCOPE, 11);
pub(crate) const DELETE: ElementId = ElementId::scoped(SCOPE, 12);
pub(crate) const NEXT: ElementId = ElementId::scoped(SCOPE, 13);
pub(crate) const REFRESH: ElementId = ElementId::scoped(SCOPE, 14);
pub(crate) const REFERENCE: ElementId = ElementId::scoped(SCOPE, 15);
pub(crate) const HELP: ElementId = ElementId::scoped(SCOPE, 16);
pub(crate) fn row_id(index: usize) -> ElementId {
    ElementId::scoped(42, index as u32 + 1)
}

#[derive(Debug)]
pub(crate) struct State {
    pub open: bool,
    pub restore_focus: Option<ElementId>,
    pub scopes: Vec<MemoryScopeDescriptor>,
    pub scope_index: usize,
    pub entries: Vec<MemorySummary>,
    pub list_scroll: ash_ui_components::ScrollState,
    pub selected: Option<Memory>,
    pub cursor: Option<String>,
    pub query: TextInput,
    pub title: TextInput,
    pub body: CodeEditorDocument,
    pub viewport: CodeEditorViewport,
    pub status: String,
    pub busy: bool,
    pub dirty: bool,
    pub read_only: bool,
    pub confirm_delete: bool,
    pub confirm_close: bool,
    pub mutation_id: ash_protocol::CommandId,
}

impl Default for State {
    fn default() -> Self {
        Self {
            open: false,
            restore_focus: None,
            scopes: Vec::new(),
            scope_index: 0,
            entries: Vec::new(),
            list_scroll: Default::default(),
            selected: None,
            cursor: None,
            query: TextInput::new(),
            title: TextInput::new(),
            body: CodeEditorDocument::from_text(""),
            viewport: CodeEditorViewport::default(),
            status: String::new(),
            busy: false,
            dirty: false,
            read_only: false,
            confirm_delete: false,
            confirm_close: false,
            mutation_id: command_id(),
        }
    }
}

impl State {
    pub fn policy(&self) -> Option<&MemoryPolicy> {
        self.scopes.get(self.scope_index).map(|scope| &scope.policy)
    }
    pub fn set_record(&mut self, memory: Memory) {
        self.title.take_text();
        self.title
            .apply(TextInputCommand::Insert(memory.title.clone()));
        self.body.replace_text(&memory.body);
        self.viewport = CodeEditorViewport::default();
        self.status = format!(
            "Revision {} · {}",
            memory.revision,
            if memory.source == memories::MemorySource::User {
                "Saved by user"
            } else {
                "Saved by model; editing takes ownership"
            }
        );
        self.mutation_id = command_id();
        self.selected = Some(memory);
        self.dirty = false;
        self.read_only = false;
        self.confirm_delete = false;
    }
    pub fn clear_draft(&mut self) {
        self.mutation_id = command_id();
        self.selected = None;
        self.title.take_text();
        self.body.replace_text("");
        self.dirty = false;
        self.read_only = false;
        self.confirm_delete = false;
    }
}

pub(crate) enum Request {
    Scopes,
    List {
        scope: MemoryScope,
        query: String,
        cursor: Option<String>,
    },
    Read(MemorySummary),
    Save {
        command_id: ash_protocol::CommandId,
        scope: MemoryScope,
        selected: Option<Memory>,
        title: String,
        body: String,
    },
    Delete {
        command_id: ash_protocol::CommandId,
        memory: Memory,
    },
    Policy(MemoryPolicy),
    Reference(String),
}

pub(crate) enum Response {
    Scopes(Vec<MemoryScopeDescriptor>),
    List(memories::MemoryListPage),
    Record(Memory),
    Deleted,
    Policy(MemoryPolicy),
    Reference(memories::MemoryCitationResult),
}
pub(crate) struct Completion {
    generation: u64,
    result: Result<Response, String>,
}

pub(crate) struct MemoriesUi {
    pub state: State,
    generation: u64,
    client: Option<AppServerRequestHandle>,
    thread: Option<ThreadId>,
    task: Option<Task>,
    executor: BackgroundExecutor<WorkbenchEvent>,
}

impl MemoriesUi {
    pub(crate) fn new(application: &ApplicationHandle<WorkbenchEvent>) -> Self {
        Self {
            state: State::default(),
            generation: 0,
            client: None,
            thread: None,
            task: None,
            executor: application.background_executor(),
        }
    }
    pub(crate) fn open(
        &mut self,
        client: Option<AppServerRequestHandle>,
        thread: Option<ThreadId>,
        restore_focus: Option<ElementId>,
    ) {
        self.generation += 1;
        self.task = None;
        self.client = client;
        self.thread = thread;
        self.state = State {
            open: true,
            restore_focus,
            ..State::default()
        };
        self.request(Request::Scopes);
    }
    pub(crate) fn close(&mut self) -> bool {
        if self.state.dirty && !self.state.confirm_close {
            self.state.confirm_close = true;
            self.state.status = "Unsaved memory changes. Save, or close again to discard.".into();
            return false;
        }
        self.state.open = false;
        self.generation += 1;
        self.task = None;
        true
    }
    pub(crate) fn request(&mut self, request: Request) {
        if self.state.busy {
            return;
        }
        let Some(mut client) = self.client.clone() else {
            self.state.status = "Connect a backend to manage memories.".into();
            return;
        };
        self.generation += 1;
        let generation = self.generation;
        self.state.busy = true;
        self.state.status = "Loading memories…".into();
        let thread = self.thread.clone();
        self.task = Some(self.executor.spawn(TaskScope::Application, async move {
            WorkbenchEvent::Memories(Completion {
                generation,
                result: execute(&mut client, thread, request),
            })
        }));
    }
    pub(crate) fn reload(&mut self) {
        self.load_page(None);
    }
    pub(crate) fn load_next_page(&mut self) {
        self.load_page(self.state.cursor.clone());
    }
    fn load_page(&mut self, cursor: Option<String>) {
        let Some(policy) = self.state.policy() else {
            return;
        };
        self.request(Request::List {
            scope: policy.scope.clone(),
            query: self.state.query.text().into(),
            cursor,
        });
    }
    pub(crate) fn finish(&mut self, completion: Completion) {
        if completion.generation != self.generation || !self.state.open {
            return;
        }
        self.state.busy = false;
        self.task = None;
        match completion.result {
            Err(error) => self.state.status = error,
            Ok(Response::Scopes(scopes)) => {
                self.state.scopes = scopes;
                self.state.scope_index = 0;
                self.reload();
            }
            Ok(Response::List(page)) => {
                self.state.entries = page.memories;
                self.state.list_scroll = Default::default();
                self.state.cursor = page.next_cursor;
                self.state.status = format!("{} memories on this page", self.state.entries.len());
            }
            Ok(Response::Record(memory)) => self.state.set_record(memory),
            Ok(Response::Deleted) => {
                self.state.clear_draft();
                self.reload();
            }
            Ok(Response::Policy(policy)) => {
                if let Some(scope) = self.state.scopes.get_mut(self.state.scope_index) {
                    scope.policy = policy;
                }
                self.state.status = "Memory permissions updated.".into();
            }
            Ok(Response::Reference(entry)) => {
                self.state.title.take_text();
                self.state
                    .title
                    .apply(TextInputCommand::Insert(entry.title));
                self.state.body.replace_text(entry.body);
                self.state.viewport = CodeEditorViewport::default();
                self.state.selected = None;
                self.state.read_only = true;
                self.state.dirty = false;
                self.state.status =
                    format!("Exact reference · revision {}", entry.citation.revision);
            }
        }
    }
}

fn command_id() -> ash_protocol::CommandId {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let counter = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    ash_protocol::CommandId::new(format!("memory-{}-{millis}-{counter}", std::process::id()))
        .expect("generated command identity")
}

fn execute(
    client: &mut AppServerRequestHandle,
    thread: Option<ThreadId>,
    request: Request,
) -> Result<Response, String> {
    let operation = || -> Result<Response, crate::app_server::ClientError> {
        match request {
            Request::Scopes => client
                .memory_scopes(MemoryScopesParams { thread_id: thread })
                .map(|result| Response::Scopes(result.scopes)),
            Request::List {
                scope,
                query,
                cursor,
            } => {
                if query.trim().is_empty() {
                    client
                        .list_memories(MemoryListParams {
                            scope,
                            cursor,
                            limit: Some(4),
                        })
                        .map(Response::List)
                } else {
                    let result = client.search_memories(MemorySearchParams {
                        scope,
                        query,
                        cursor,
                        limit: Some(4),
                    })?;
                    let mut memories = Vec::new();
                    for entry in result.matches {
                        memories.push(
                            client
                                .read_memory(MemoryReadParams {
                                    scope: entry.scope,
                                    memory_id: entry.memory_id,
                                })?
                                .summary(),
                        );
                    }
                    Ok(Response::List(memories::MemoryListPage {
                        catalog_revision: result.catalog_revision,
                        memories,
                        next_cursor: result.next_cursor,
                    }))
                }
            }
            Request::Read(entry) => client
                .read_memory(MemoryReadParams {
                    scope: entry.scope,
                    memory_id: entry.memory_id,
                })
                .map(Response::Record),
            Request::Save {
                command_id,
                scope,
                selected,
                title,
                body,
            } => match selected {
                Some(memory) => client.update_memory(MemoryUpdateParams {
                    command_id,
                    scope,
                    memory_id: memory.memory_id,
                    expected_revision: memory.revision,
                    title,
                    body,
                }),
                None => client.add_memory(MemoryAddParams {
                    memory_id: memories::MemoryId::new(command_id.as_str())
                        .expect("generated memory identity"),
                    command_id,
                    scope,
                    title,
                    body,
                }),
            }
            .map(|result| Response::Record(result.memory)),
            Request::Delete { command_id, memory } => client
                .delete_memory(MemoryDeleteParams {
                    command_id,
                    scope: memory.scope,
                    memory_id: memory.memory_id,
                    expected_revision: memory.revision,
                })
                .map(|_| Response::Deleted),
            Request::Policy(policy) => client
                .update_memory_policy(MemoryPolicyUpdateParams {
                    command_id: command_id(),
                    scope: policy.scope,
                    expected_revision: policy.revision,
                    automatic_read: policy.automatic_read,
                    model_write: policy.model_write,
                })
                .map(|result| Response::Policy(result.policy)),
            Request::Reference(reference) => {
                let citation = memories::MemoryCitation::parse(&reference)
                    .map_err(|error| crate::app_server::ClientError::Protocol(error.to_string()))?;
                client
                    .read_memory_citation(MemoryCitationReadParams { citation })
                    .map(Response::Reference)
            }
        }
    };
    operation().map_err(explain)
}

#[cfg(test)]
#[path = "memories/memories_tests.rs"]
mod tests;

fn explain(error: crate::app_server::ClientError) -> String {
    match error {
        crate::app_server::ClientError::Server { code: -32133, .. } => {
            "This memory changed. Refresh and select it again; your draft is kept.".into()
        }
        crate::app_server::ClientError::Server { code: -32134, .. } => {
            "The memory list changed. Refresh the list.".into()
        }
        crate::app_server::ClientError::Server { code: -32131, .. } => {
            "This memory was deleted. Refresh the list.".into()
        }
        crate::app_server::ClientError::Server { code: -32602, .. } => {
            "Check the title, content and memory reference.".into()
        }
        error => error.to_string(),
    }
}
