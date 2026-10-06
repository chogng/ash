use crate::Error;
use crate::GitHub;
use crate::Repository;
use crate::Result;
use ash_http_client::HttpMethod;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;

// Notifications cap pages at 50, unlike repository collections that allow 100.
const PAGE_SIZE: usize = 50;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotificationFilter {
    Unread,
    All,
    Participating,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Notification {
    pub id: String,
    pub title: String,
    pub subject_type: String,
    pub reason: String,
    pub unread: bool,
    pub updated_at: String,
    pub repository: Repository,
    pub url: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NotificationPage {
    pub notifications: Vec<Notification>,
    pub next_page: Option<u32>,
}

impl GitHub {
    pub async fn notifications(
        &self,
        filter: NotificationFilter,
        page: u32,
    ) -> Result<NotificationPage> {
        if page == 0 || page > 10_000 {
            return Err(Error::InvalidInput("Invalid notification page".into()));
        }
        let all = filter == NotificationFilter::All;
        let participating = filter == NotificationFilter::Participating;
        let rows: Vec<RemoteNotification> = self
            .account_api(
                HttpMethod::Get,
                &format!(
                    "notifications?all={all}&participating={participating}&per_page={PAGE_SIZE}&page={page}"
                ),
                None,
            )
            .await?;
        let next_page = (rows.len() == PAGE_SIZE && page < 10_000).then_some(page + 1);
        let notifications = rows
            .into_iter()
            .map(|row| {
                validate_thread(&row.id)
                    .map_err(|_| Error::InvalidResponse("Invalid notification thread".into()))?;
                let (owner, name) = row.repository.full_name.split_once('/').ok_or_else(|| {
                    Error::InvalidResponse("Invalid notification repository".into())
                })?;
                let repository =
                    Repository::new(self.authorization.host.clone(), owner.into(), name.into())
                        .map_err(|_| {
                            Error::InvalidResponse("Invalid notification repository".into())
                        })?;
                let url = subject_url(&repository, &row.subject);
                Ok(Notification {
                    id: row.id,
                    title: row.subject.title,
                    subject_type: row.subject.kind,
                    reason: row.reason,
                    unread: row.unread,
                    updated_at: row.updated_at,
                    repository,
                    url,
                })
            })
            .collect::<Result<_>>()?;
        Ok(NotificationPage {
            notifications,
            next_page,
        })
    }

    pub async fn mark_notification_read(&self, thread_id: &str) -> Result<()> {
        validate_thread(thread_id)?;
        self.account_api::<Value>(
            HttpMethod::Patch,
            &format!("notifications/threads/{thread_id}"),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn mark_notifications_read(&self) -> Result<()> {
        self.account_api::<Value>(HttpMethod::Put, "notifications", Some(json!({"read":true})))
            .await?;
        Ok(())
    }
}

fn subject_url(repository: &Repository, subject: &Subject) -> String {
    let prefix = if repository.host == "github.com" {
        "https://api.github.com".to_owned()
    } else {
        format!("https://{}/api/v3", repository.host)
    };
    let kind = match subject.kind.as_str() {
        "PullRequest" => Some(("pulls", "pull")),
        "Issue" => Some(("issues", "issues")),
        _ => None,
    };
    if let (Some(url), Some((api_kind, browser_kind))) = (&subject.url, kind) {
        let prefix = format!(
            "{prefix}/repos/{}/{}/{api_kind}/",
            repository.owner, repository.name
        );
        if let Some(number) = url
            .strip_prefix(&prefix)
            .and_then(|id| id.parse::<u64>().ok())
            .filter(|number| *number > 0)
        {
            return format!(
                "https://{}/{}/{}/{browser_kind}/{number}",
                repository.host, repository.owner, repository.name
            );
        }
    }
    format!("https://{}/notifications", repository.host)
}

fn validate_thread(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 32
        || !id.bytes().all(|byte| byte.is_ascii_digit())
        || id.bytes().all(|byte| byte == b'0')
    {
        return Err(Error::InvalidInput("Invalid notification thread".into()));
    }
    Ok(())
}

#[derive(Deserialize)]
struct RemoteNotification {
    id: String,
    unread: bool,
    reason: String,
    updated_at: String,
    subject: Subject,
    repository: NotificationRepository,
}
#[derive(Deserialize)]
struct Subject {
    title: String,
    #[serde(rename = "type")]
    kind: String,
    url: Option<String>,
}
#[derive(Deserialize)]
struct NotificationRepository {
    full_name: String,
}

#[cfg(test)]
#[path = "notifications_tests.rs"]
mod tests;
