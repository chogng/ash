use crate::GitRuntime;
use crate::api::invalid;
use crate::changes::relative_resource;
use crate::model::Blame;
use external_ext_sdk::ExtensionError;
use serde_json::Value;
use serde_json::json;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

impl GitRuntime {
    /// Polls only editor facts. Git IO runs when resource, line, model version, policy or HEAD
    /// changes; the client checks the same model version before applying the annotation.
    pub(crate) fn update_blame(&self) -> Result<(), ExtensionError> {
        let active = self.api.editor(json!({"method":"activeEditor"}), None)?;
        let resource = active["input"]["resource"].as_str();
        let repository = resource.and_then(|resource| {
            self.lock()
                .repositories
                .values()
                .filter(|repository| relative_resource(repository, resource).is_some())
                .max_by_key(|repository| repository.root_uri.lexical_depth().unwrap_or(0))
                .cloned()
        });
        let Some(repository) = repository.filter(|repository| {
            repository.configuration.boolean("enabled", true)
                && active["selection"].is_object()
                && (repository
                    .configuration
                    .boolean("blame.editorDecoration.enabled", false)
                    || repository
                        .configuration
                        .boolean("blame.statusBarItem.enabled", true))
        }) else {
            let changed = {
                let mut state = self.lock();
                if state.active_line_signature.is_empty() {
                    false
                } else {
                    state.active_line_signature.clear();
                    for repository in state.repositories.values_mut() {
                        repository.blame = None;
                    }
                    true
                }
            };
            if changed {
                self.api.editor(
                    json!({"method":"setLineAnnotation","uri":null,"text":""}),
                    None,
                )?;
                self.publish()?;
            }
            return Ok(());
        };
        let resource = resource.ok_or_else(|| invalid("Missing active editor resource"))?;
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            / 60;
        let signature = format!(
            "{}:{}:{}:{}:{}:{time}",
            resource,
            active["selection"]["startLineNumber"],
            active["version"],
            serde_json::to_string(&repository.configuration.0).unwrap_or_default(),
            repository
                .status
                .as_ref()
                .map(|status| status.history_revision)
                .unwrap_or(0)
        );
        if self.lock().active_line_signature == signature {
            return Ok(());
        }
        let path = relative_resource(&repository, resource)
            .ok_or_else(|| invalid("Active file is outside the Git repository"))?;
        let response = self
            .api
            .blame(
                &repository,
                &path,
                active["selection"]["startLineNumber"].as_u64().unwrap_or(1) as usize,
                active["contents"].as_str(),
                None,
            )
            .map(|line| json!(line));
        let (annotation, label, details) = match response {
            Ok(line) => {
                let dates=self.api.editor(json!({"method":"formatTimestamps","timestamps":[line["authorTime"].as_i64().unwrap_or(0)*1000]}),None)?;
                let uncommitted = line["objectId"]
                    .as_str()
                    .is_some_and(|id| id.bytes().all(|byte| byte == b'0'));
                let author = if uncommitted {
                    self.api.text("git.blameYou", &[])
                } else {
                    line["authorName"].as_str().unwrap_or_default().to_owned()
                };
                let subject = if uncommitted {
                    self.api.text("git.uncommittedChanges", &[])
                } else {
                    line["subject"].as_str().unwrap_or_default().to_owned()
                };
                let id = line["objectId"].as_str().unwrap_or_default();
                let short = id
                    .chars()
                    .take(repository.configuration.number("commitShortHashLength", 7) as usize)
                    .collect::<String>();
                let values = [
                    ("subject", subject.as_str()),
                    ("authorName", author.as_str()),
                    (
                        "authorEmail",
                        line["authorEmail"].as_str().unwrap_or_default(),
                    ),
                    ("authorDate", dates[0]["date"].as_str().unwrap_or_default()),
                    (
                        "authorDateAgo",
                        dates[0]["relative"].as_str().unwrap_or_default(),
                    ),
                    ("hash", id),
                    ("shortHash", short.as_str()),
                ];
                let format = |template: &str| {
                    let mut text = template.to_owned();
                    for (key, value) in values {
                        text = text.replace(&format!("${{{key}}}"), value);
                    }
                    text
                };
                let details = format!(
                    "{author} <{}>\n{subject}\n{id}",
                    line["authorEmail"].as_str().unwrap_or_default()
                );
                (
                    format(repository.configuration.text(
                        "blame.editorDecoration.template",
                        "${subject}, ${authorName} (${authorDateAgo})",
                    )),
                    format(repository.configuration.text(
                        "blame.statusBarItem.template",
                        "${authorName} (${authorDateAgo})",
                    )),
                    details,
                )
            }
            Err(_) => (String::new(), String::new(), String::new()),
        };
        // A directory/configuration change while blame was in flight cannot restore old policy.
        let current = self.repository(Some(&repository.descriptor.id))?;
        if current.configuration.0 != repository.configuration.0
            || self.stopped.load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(());
        }
        let annotation_enabled = repository
            .configuration
            .boolean("blame.editorDecoration.enabled", false)
            && !annotation.is_empty();
        self.api.editor(json!({"method":"setLineAnnotation","uri":if annotation_enabled {json!(resource)} else {Value::Null},"line":active["selection"]["startLineNumber"],"version":active["version"],"text":if annotation_enabled {annotation} else {String::new()},"hover":if repository.configuration.boolean("blame.editorDecoration.disableHover",false) {Value::Null} else {json!(details)}}),None)?;
        {
            let mut state = self.lock();
            state.active_line_signature = signature;
            for current in state.repositories.values_mut() {
                current.blame =
                    if current.descriptor.id == repository.descriptor.id && !label.is_empty() {
                        Some(Blame {
                            label: label.clone(),
                            details: details.clone(),
                        })
                    } else {
                        None
                    };
            }
        }
        self.publish()
    }
}
