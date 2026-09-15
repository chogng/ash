mod editor;
mod panel;

pub(crate) use editor::Editor;
pub(crate) use panel::Panel;

use crate::client::new_command_id;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::memory::MemoryScopeDescriptor;
use ash_protocol::ThreadId;
use memories::Memory;
use memories::MemoryPolicy;
use memories::MemoryScope;
use memories::MemorySummary;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Scopes,
    Browse {
        scope: MemoryScope,
        cursor: Option<String>,
    },
    Search {
        scope: MemoryScope,
        query: String,
    },
    Read {
        scope: MemoryScope,
        id: memories::MemoryId,
    },
    Citation(String),
    Add {
        command_id: ash_protocol::CommandId,
        scope: MemoryScope,
        title: String,
        body: String,
    },
    Update {
        command_id: ash_protocol::CommandId,
        memory: Memory,
        title: String,
        body: String,
    },
    Delete {
        command_id: ash_protocol::CommandId,
        memory: Memory,
    },
    Policy(MemoryPolicy),
}

#[derive(Debug)]
pub(crate) enum Page {
    Scopes(Vec<MemoryScopeDescriptor>),
    List {
        policy: MemoryPolicy,
        entries: Vec<MemorySummary>,
        cursor: Option<String>,
    },
    Read(Memory),
    Citation(memories::MemoryCitationResult),
}

pub(crate) enum Event {
    Opened(Page),
    Detail(memories::MemoryCitationResult),
    Failed(String),
    Changed,
}

pub(crate) fn execute<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    thread_id: Option<&ThreadId>,
    command: Command,
) -> Result<Event, String> {
    use ash_app_server_protocol::protocol::memory::*;
    let run = || -> Result<Page, ash_app_server_client::ClientError> {
        match command {
            Command::Scopes => client
                .memory_scopes(MemoryScopesParams {
                    thread_id: thread_id.cloned(),
                })
                .map(|result| Page::Scopes(result.scopes)),
            Command::Browse { scope, cursor } => {
                let policy = client.read_memory_policy(MemoryPolicyReadParams {
                    scope: scope.clone(),
                })?;
                let page = client.list_memories(MemoryListParams {
                    scope,
                    cursor,
                    limit: Some(20),
                })?;
                Ok(Page::List {
                    policy,
                    entries: page.memories,
                    cursor: page.next_cursor,
                })
            }
            Command::Search { scope, query } => {
                let result = client.search_memories(MemorySearchParams {
                    scope: scope.clone(),
                    query,
                    cursor: None,
                    limit: Some(50),
                })?;
                let mut entries = Vec::new();
                for hit in result.matches {
                    entries.push(
                        client
                            .read_memory(MemoryReadParams {
                                scope: hit.scope,
                                memory_id: hit.memory_id,
                            })?
                            .summary(),
                    );
                }
                let policy = client.read_memory_policy(MemoryPolicyReadParams { scope })?;
                Ok(Page::List {
                    policy,
                    entries,
                    cursor: None,
                })
            }
            Command::Read { scope, id } => client
                .read_memory(MemoryReadParams {
                    scope,
                    memory_id: id,
                })
                .map(Page::Read),
            Command::Citation(reference) => {
                let citation = memories::MemoryCitation::parse(&reference).map_err(|error| {
                    ash_app_server_client::ClientError::Protocol(error.to_string())
                })?;
                client
                    .read_memory_citation(MemoryCitationReadParams { citation })
                    .map(Page::Citation)
            }
            Command::Add {
                command_id,
                scope,
                title,
                body,
            } => {
                let memory_id = memories::MemoryId::new(command_id.as_str()).map_err(|error| {
                    ash_app_server_client::ClientError::Protocol(error.to_string())
                })?;
                client
                    .add_memory(MemoryAddParams {
                        command_id,
                        memory_id,
                        scope,
                        title,
                        body,
                    })
                    .map(|result| Page::Read(result.memory))
            }
            Command::Update {
                command_id,
                memory,
                title,
                body,
            } => client
                .update_memory(MemoryUpdateParams {
                    command_id,
                    memory_id: memory.memory_id,
                    scope: memory.scope,
                    expected_revision: memory.revision,
                    title,
                    body,
                })
                .map(|result| Page::Read(result.memory)),
            Command::Delete { command_id, memory } => {
                client.delete_memory(MemoryDeleteParams {
                    command_id,
                    memory_id: memory.memory_id,
                    scope: memory.scope,
                    expected_revision: memory.revision,
                })?;
                client
                    .memory_scopes(MemoryScopesParams {
                        thread_id: thread_id.cloned(),
                    })
                    .map(|result| Page::Scopes(result.scopes))
            }
            Command::Policy(policy) => {
                client.update_memory_policy(MemoryPolicyUpdateParams {
                    command_id: new_command_id("memory-policy"),
                    scope: policy.scope,
                    expected_revision: policy.revision,
                    automatic_read: policy.automatic_read,
                    model_write: policy.model_write,
                })?;
                client
                    .memory_scopes(MemoryScopesParams {
                        thread_id: thread_id.cloned(),
                    })
                    .map(|result| Page::Scopes(result.scopes))
            }
        }
    };
    Ok(match run() {
        Ok(Page::Citation(entry)) => Event::Detail(entry),
        Ok(page) => Event::Opened(page),
        Err(error) => Event::Failed(explain(error)),
    })
}

fn explain(error: ash_app_server_client::ClientError) -> String {
    match error {
        ash_app_server_client::ClientError::Server { code: -32133, .. } => {
            "This memory changed. Refresh and select it again; your draft is kept.".into()
        }
        ash_app_server_client::ClientError::Server { code: -32134, .. } => {
            "The memory list changed. Refresh the list.".into()
        }
        ash_app_server_client::ClientError::Server { code: -32131, .. } => {
            "This memory was deleted. Refresh the list.".into()
        }
        ash_app_server_client::ClientError::Server { code: -32602, .. } => {
            "Check the title, content and memory reference.".into()
        }
        error => error.to_string(),
    }
}
