mod editor;
mod panel;

#[cfg(test)]
#[path = "memories/request_tests.rs"]
mod request_tests;

pub(crate) use panel::Panel;
pub(crate) use panel::Target;

use ash_app_server_client::AppServerClient;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::memory::*;
use ash_protocol::ThreadId;
use memories::Memory;
use memories::MemoryPolicy;
use memories::MemoryScope;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Scopes,
    Browse {
        scope: MemoryScope,
        query: String,
        cursor: Option<String>,
        loaded: usize,
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
    Policy {
        command_id: ash_protocol::CommandId,
        policy: MemoryPolicy,
    },
    ReadPolicy(MemoryScope),
    Configure,
}

#[derive(Clone, Debug)]
pub(crate) struct Entry {
    pub(crate) id: memories::MemoryId,
    pub(crate) title: String,
    pub(crate) source: memories::MemorySource,
    pub(crate) updated: u64,
    pub(crate) excerpt: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Listing {
    pub(crate) scope: MemoryScope,
    pub(crate) query: String,
    pub(crate) revision: u64,
    pub(crate) entries: Vec<Entry>,
    pub(crate) cursor: Option<String>,
}

#[derive(Debug)]
pub(crate) enum Page {
    Scopes {
        enabled: bool,
        scopes: Vec<MemoryScopeDescriptor>,
        list: Listing,
    },
    List(Listing),
    Read(Memory),
    Citation(memories::MemoryCitationResult),
    Policy(MemoryPolicy),
    Deleted,
}

#[derive(Debug)]
pub(crate) struct Failure {
    pub(crate) code: Option<i64>,
    pub(crate) message: String,
}

pub(crate) enum Event {
    Finished {
        command: Command,
        result: Result<Page, Failure>,
    },
    Changed(MemoryChanged),
    Config(crate::config::Event),
}

pub(crate) fn execute<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    thread_id: Option<&ThreadId>,
    command: Command,
) -> Result<Event, String> {
    if command == Command::Configure {
        return crate::config::execute(client, crate::config::Command::OpenEditor)
            .map(Event::Config);
    }
    let result = (|| -> Result<Page, ash_app_server_client::ClientError> {
        Ok(match command.clone() {
            Command::Scopes => {
                let config = client.read_config()?;
                let enabled = config
                    .features
                    .iter()
                    .find(|state| state.feature == features::Feature::Memories)
                    .expect("config includes memories")
                    .enabled;
                let scopes = client
                    .memory_scopes(MemoryScopesParams {
                        thread_id: thread_id.cloned(),
                    })?
                    .scopes;
                let scope = scopes
                    .iter()
                    .find(|scope| matches!(scope.policy.scope, MemoryScope::Project { .. }))
                    .or_else(|| {
                        scopes
                            .iter()
                            .find(|scope| scope.policy.scope == MemoryScope::Profile)
                    })
                    .expect("memory scopes include personal memories")
                    .policy
                    .scope
                    .clone();
                let list = browse(client, scope, String::new(), None)?;
                Page::Scopes {
                    enabled,
                    scopes,
                    list,
                }
            }
            Command::Browse {
                scope,
                query,
                cursor,
                loaded,
            } => {
                let append = cursor.is_some();
                let mut list = browse(client, scope.clone(), query.clone(), cursor)?;
                while !append && list.entries.len() < loaded {
                    let Some(cursor) = list.cursor.take() else {
                        break;
                    };
                    let mut next = browse(client, scope.clone(), query.clone(), Some(cursor))?;
                    list.entries.append(&mut next.entries);
                    list.cursor = next.cursor;
                }
                Page::List(list)
            }
            Command::Read { scope, id } => Page::Read(client.read_memory(MemoryReadParams {
                scope,
                memory_id: id,
            })?),
            Command::Citation(reference) => {
                let citation = memories::MemoryCitation::parse(&reference).map_err(|error| {
                    ash_app_server_client::ClientError::Protocol(error.to_string())
                })?;
                Page::Citation(client.read_memory_citation(MemoryCitationReadParams { citation })?)
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
                Page::Read(
                    client
                        .add_memory(MemoryAddParams {
                            command_id,
                            memory_id,
                            scope,
                            title,
                            body,
                        })?
                        .memory,
                )
            }
            Command::Update {
                command_id,
                memory,
                title,
                body,
            } => Page::Read(
                client
                    .update_memory(MemoryUpdateParams {
                        command_id,
                        memory_id: memory.memory_id,
                        scope: memory.scope,
                        expected_revision: memory.revision,
                        title,
                        body,
                    })?
                    .memory,
            ),
            Command::Delete { command_id, memory } => {
                client.delete_memory(MemoryDeleteParams {
                    command_id,
                    memory_id: memory.memory_id,
                    scope: memory.scope,
                    expected_revision: memory.revision,
                })?;
                Page::Deleted
            }
            Command::Policy { command_id, policy } => Page::Policy(
                client
                    .update_memory_policy(MemoryPolicyUpdateParams {
                        command_id,
                        scope: policy.scope,
                        expected_revision: policy.revision,
                        automatic_read: policy.automatic_read,
                        model_write: policy.model_write,
                    })?
                    .policy,
            ),
            Command::ReadPolicy(scope) => {
                Page::Policy(client.read_memory_policy(MemoryPolicyReadParams { scope })?)
            }
            Command::Configure => unreachable!("configuration is dispatched above"),
        })
    })()
    .map_err(|error| {
        let code = match &error {
            ash_app_server_client::ClientError::Server { code, .. } => Some(*code),
            _ => None,
        };
        let message = match code {
            Some(-32133) if matches!(command, Command::Policy { .. }) => {
                "Permissions changed. Refresh permissions before retrying.".into()
            }
            Some(-32133) => {
                "This memory changed. View the latest version before saving your draft.".into()
            }
            Some(-32134) => "The memory list changed. Refresh to continue loading.".into(),
            Some(-32131) => "This memory was deleted. Your draft is kept.".into(),
            Some(-32602) => "Check the title, content and memory reference.".into(),
            _ => error.to_string(),
        };
        Failure { code, message }
    });
    Ok(Event::Finished { command, result })
}

fn browse<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    scope: MemoryScope,
    query: String,
    cursor: Option<String>,
) -> Result<Listing, ash_app_server_client::ClientError> {
    let (revision, entries, cursor) = if query.is_empty() {
        let page = client.list_memories(MemoryListParams {
            scope: scope.clone(),
            cursor,
            limit: Some(20),
        })?;
        (
            page.catalog_revision,
            page.memories
                .into_iter()
                .map(|entry| Entry {
                    id: entry.memory_id,
                    title: entry.title,
                    source: entry.source,
                    updated: entry.updated_at_unix_ms,
                    excerpt: String::new(),
                })
                .collect(),
            page.next_cursor,
        )
    } else {
        let page = client.search_memories(MemorySearchParams {
            scope: scope.clone(),
            query: query.clone(),
            cursor,
            limit: Some(20),
        })?;
        (
            page.catalog_revision,
            page.matches
                .into_iter()
                .map(|entry| Entry {
                    id: entry.memory_id,
                    title: entry.title,
                    source: entry.source,
                    updated: entry.updated_at_unix_ms,
                    excerpt: entry.excerpt,
                })
                .collect(),
            page.next_cursor,
        )
    };
    Ok(Listing {
        scope,
        query,
        revision,
        entries,
        cursor,
    })
}
