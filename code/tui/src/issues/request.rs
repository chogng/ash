use super::Command;
use super::Event;
use super::Issue;
use super::Page;
use super::Repository;
use crate::sessions::ActiveConversation;
use crate::sessions::Conversation;
use crate::sessions::ConversationCompletion;
use crate::sessions::finish_conversation_request;
use ash_app_server_client::AppServerRequestHandle;
use ash_app_server_protocol::protocol::issues::IssueListParams;
use ash_app_server_protocol::protocol::issues::IssueReadParams;
use ash_app_server_protocol::protocol::issues::IssueRepository;

pub(crate) fn execute(
    client: &mut AppServerRequestHandle,
    command: Command,
) -> Result<Event, String> {
    Ok(match command {
        Command::List {
            generation,
            page,
            state,
            query,
            mode,
        } => Event::Listed {
            generation,
            page,
            result: client
                .list_issues(IssueListParams {
                    page,
                    query,
                    mode: match mode {
                        super::ListMode::Cached => {
                            ash_app_server_protocol::protocol::issues::IssueListMode::Cached
                        }
                        super::ListMode::Auto => {
                            ash_app_server_protocol::protocol::issues::IssueListMode::Auto
                        }
                        super::ListMode::Refresh => {
                            ash_app_server_protocol::protocol::issues::IssueListMode::Refresh
                        }
                        super::ListMode::ClearCache => {
                            ash_app_server_protocol::protocol::issues::IssueListMode::ClearCache
                        }
                    },
                    state: match state {
                        super::IssueState::Open => {
                            ash_app_server_protocol::protocol::issues::IssueState::Open
                        }
                        super::IssueState::Closed => {
                            ash_app_server_protocol::protocol::issues::IssueState::Closed
                        }
                    },
                })
                .map_err(|error| error.to_string())
                .and_then(|result| {
                    let seconds = i64::try_from(result.fetched_at)
                        .map_err(|_| "Invalid issue cache timestamp")?;
                    let fetched_at = chrono::DateTime::from_timestamp(seconds, 0)
                        .ok_or("Invalid issue cache timestamp")?;
                    Ok(Page {
                        repository: Repository {
                            host: result.repository.host,
                            owner: result.repository.owner,
                            name: result.repository.name,
                        },
                        issues: result
                            .issues
                            .into_iter()
                            .map(|issue| Issue {
                                number: issue.number,
                                title: issue.title,
                                labels: issue.labels,
                                assignees: issue.assignees,
                            })
                            .collect(),
                        next: result.next_page,
                        refresh_after_seconds: result.refresh_after_seconds,
                        fetched_at: result.fetched_at,
                        freshness: format!(
                            "{} · {}",
                            if result.cached { "Cached" } else { "Updated" },
                            fetched_at.format("%m-%d %H:%M UTC")
                        ),
                        notice: result.notice,
                    })
                }),
        },
        Command::Read {
            generation,
            repository,
            number,
        } => Event::Read {
            generation,
            result: client
                .read_issue(IssueReadParams {
                    repository: repository_dto(repository),
                    number,
                })
                .map(|result| {
                    let mut text = format!(
                        "#{} {}\n{}\nAssignees: {}\nLabels: {}\n\n{}",
                        result.issue.number,
                        result.issue.title,
                        result.issue.url,
                        result.issue.assignees.join(", "),
                        result.issue.labels.join(", "),
                        result.body
                    );
                    for comment in result.comments {
                        text.push_str(&format!("\n\n{}\n{}", comment.url, comment.body));
                    }
                    text
                })
                .map_err(|error| error.to_string()),
        },
        Command::Start { .. } => {
            return Err("Issue creation requires conversation ownership".into());
        }
    })
}

pub(crate) fn start(
    mut client: AppServerRequestHandle,
    current: Option<Conversation>,
    command: Command,
) -> Result<ConversationCompletion, String> {
    let session_id = start_session(&mut client, command)?;
    let conversation = ActiveConversation::open(&mut client, session_id.as_str(), None)
        .map_err(|error| error.to_string())?;
    let change = crate::sessions::ConversationChange {
        notice: format!("Opened issue session {session_id}"),
        transcript: crate::sessions::ConversationTranscript::Replace,
    };
    let completion = finish_conversation_request(
        &mut client,
        conversation,
        current.map(|c| c.subscription),
        change,
    )?;
    Ok(completion)
}

fn repository_dto(repository: Repository) -> IssueRepository {
    IssueRepository {
        host: repository.host,
        owner: repository.owner,
        name: repository.name,
    }
}

fn start_session<T: ash_app_server_client::JsonRpcTransport>(
    client: &mut ash_app_server_client::AppServerClient<T>,
    command: Command,
) -> Result<ash_protocol::SessionId, String> {
    let Command::Start {
        command_id,
        repository,
        numbers,
        ..
    } = command
    else {
        return Err("Expected Issue session creation".into());
    };
    if numbers.is_empty()
        || numbers.contains(&0)
        || numbers
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != numbers.len()
    {
        return Err("Select distinct, positive Issue numbers".into());
    }
    let created = client
        .create_session(
            ash_app_server_protocol::protocol::session::SessionCreateParams {
                agent_id: None,
                command_id: command_id.clone(),
                title: if numbers.len() <= 4 {
                    format!(
                        "Issues {}",
                        numbers
                            .iter()
                            .map(|number| format!("#{number}"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                } else {
                    format!("{} issues", numbers.len())
                },
                agent: ash_protocol::AgentRoleSelection::Exact {
                    source: ash_protocol::AgentRoleSource::BuiltIn,
                    name: "issue".into(),
                },
            },
        )
        .map_err(|error| error.to_string())?;
    let session_id = created.session.session_id;
    let root = created
        .session
        .threads
        .iter()
        .find(|thread| thread.thread_id.as_str() == session_id.as_str())
        .ok_or("Created Session has no root Thread")?;
    let references = numbers
        .iter()
        .map(|number| {
            format!(
                "https://{}/{}/{}/issues/{number}",
                repository.host, repository.owner, repository.name
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let started = client.request_session(ash_app_server_protocol::protocol::session::SessionRequestParams {
        command_id: ash_protocol::CommandId::new(format!("{}:first-turn", command_id.as_str())).map_err(|error| error.to_string())?,
        session_id: session_id.clone(),
        request: ash_app_server_protocol::protocol::session::SessionRequest::StartTurn {
            thread_id: root.thread_id.clone(), expected_sequence: created.agent_tree.roots.iter().find(|entry| entry.thread_id == root.thread_id).ok_or("Created root Thread is missing from the Agent tree")?.thread_sequence,
            approval_mode: ash_protocol::ApprovalMode::default(), tool_mode: None,
            input: vec![ash_app_server_protocol::protocol::turn::InputItem::Text { text: format!("Resolve these selected Issues using your Issue coordination role. Verify the result of each implementation task.\n{references}") }],
        },
    }).map_err(|error| error.to_string())?;
    if !matches!(
        started,
        ash_app_server_protocol::protocol::session::SessionRequestResult::Turn(_)
    ) {
        return Err("Session did not accept the first Issue turn".into());
    }
    Ok(session_id)
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;
