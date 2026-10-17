use crate::model::Configuration;
use crate::model::Repository;
use crate::model::Status;
use external_ext_sdk::CancellationToken;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use external_ext_sdk::client::BackgroundClient;
use external_ext_sdk::client::Client;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;

#[derive(Clone)]
pub struct Api {
    pub client: Client,
    pub background: BackgroundClient,
    pub services: external_ext_sdk::services::Services,
    pub interaction: std::sync::Arc<std::sync::Mutex<Option<crate::interaction::Connection>>>,
    english: Value,
    translated: Value,
    output: external_ext_sdk::window::OutputChannel,
}
impl Api {
    pub fn new(
        client: Client,
        background: BackgroundClient,
        services: external_ext_sdk::services::Services,
        language: Option<&str>,
        output: external_ext_sdk::window::OutputChannel,
    ) -> Self {
        Self {
            client,
            background,
            services,
            interaction: Default::default(),
            output,
            english: serde_json::from_str(include_str!("../package.nls.json"))
                .expect("valid bundled messages"),
            translated: if language
                .is_some_and(|value| value.to_ascii_lowercase().starts_with("zh"))
            {
                serde_json::from_str(include_str!("../package.nls.zh-CN.json"))
                    .expect("valid bundled Chinese messages")
            } else {
                Value::Null
            },
        }
    }
    pub fn text(&self, key: &str, arguments: &[&str]) -> String {
        let mut message = self.translated[key]
            .as_str()
            .or_else(|| self.english[key].as_str())
            .unwrap_or(key)
            .to_owned();
        for (index, argument) in arguments.iter().enumerate() {
            message = message.replace(&format!("{{{index}}}"), argument);
        }
        message
    }
    pub fn editor(
        &self,
        payload: Value,
        token: Option<&CancellationToken>,
    ) -> Result<Value, ExtensionError> {
        match token {
            Some(token) => self.client.editor_operation(payload, token),
            None => self.background.editor_operation(payload),
        }
    }
    pub fn configuration(
        &self,
        resource: Option<String>,
        token: Option<&CancellationToken>,
    ) -> Result<Configuration, ExtensionError> {
        Ok(Configuration(match token {
            Some(token) => self.client.get_configuration("git", resource, token)?,
            None => self.background.get_configuration("git", resource)?,
        }))
    }
    /// The adapter adds invocation policy and decodes structured backend failures before models see them.
    pub fn request(
        &self,
        method: &str,
        mut params: Value,
        configuration: &Configuration,
        token: Option<&CancellationToken>,
    ) -> Result<Value, ExtensionError> {
        let synchronizing = params
            .as_object_mut()
            .and_then(|params| params.remove("synchronizing"))
            == Some(json!(true));
        let cancellable = configuration.boolean("supportCancellation", false) && method != "push";
        let credential_account_id = params
            .as_object_mut()
            .and_then(|params| params.remove("credentialAccountId"))
            .and_then(|value| value.as_str().map(str::to_owned));
        if !matches!(method, "readConfig" | "updateConfig") {
            let paths = match configuration.value("path") {
                Value::String(path) => vec![path.clone()],
                Value::Array(paths) => paths
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                _ => Vec::new(),
            };
            if !paths.is_empty() || configuration.number("similarityThreshold", 50) != 50 {
                params["client"] = json!({ "paths": paths, "similarityThreshold": configuration.number("similarityThreshold",50) });
            }
        }
        let mut interaction_lease = None;
        if let Some(token) = token.filter(|_| configuration.boolean("useIntegratedAskPass", true)) {
            if matches!(
                method,
                "fetch" | "pull" | "push" | "clone" | "commit" | "execute" | "executeCommand"
            ) {
                let connection = self
                    .interaction
                    .lock()
                    .map_err(|_| invalid("Git broker failed"))?
                    .clone();
                if let Some(connection) = connection {
                    let mut hosts = Vec::new();
                    if method == "clone" {
                        if let Some(host) = params["url"]
                            .as_str()
                            .and_then(|value| url::Url::parse(value).ok())
                            .filter(|uri| uri.scheme() == "https")
                            .and_then(|uri| uri.host_str().map(str::to_owned))
                        {
                            hosts.push(host);
                        }
                    } else if matches!(
                        method,
                        "fetch" | "pull" | "push" | "execute" | "executeCommand"
                    ) && params["repositoryId"].is_string()
                    {
                        if let Ok(refs) = self.request(
                            "historyRefs",
                            json!({"repositoryId":params["repositoryId"]}),
                            configuration,
                            Some(token),
                        ) {
                            hosts = refs["remotes"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|remote| {
                                    remote["identity"]["host"].as_str().map(str::to_owned)
                                })
                                .collect();
                        }
                    }
                    let id = crate::commands::random_id()?;
                    connection
                        .scopes
                        .lock()
                        .map_err(|_| invalid("Git scope failed"))?
                        .insert(
                            id.clone(),
                            crate::interaction::Scope {
                                configuration: configuration.clone(),
                                token: token.clone(),
                                hosts,
                                credential_account_id: credential_account_id.clone(),
                            },
                        );
                    if !params["client"].is_object() {
                        params["client"] = json!({"paths":[]});
                    }
                    params["client"]["interaction"] = json!({"address":connection.address.to_string(),"token":connection.token,"scope":id});
                    interaction_lease = Some(crate::interaction::ScopeLease { connection, id });
                }
            }
        }
        // The lease must remain live until the Git process has returned its terminal result.
        let _interaction_lease = interaction_lease;
        let logged = configuration
            .strings("commandsToLog")
            .iter()
            .any(|command| command == method);
        let started = std::time::Instant::now();
        if logged {
            let _ = self.output.append_line(format!("[Git] {method} started"));
        }
        let result = (|| -> Result<Value, ExtensionError> {
            let (wire_method, wire_params) = if token.is_some()
                && matches!(method, "fetch" | "pull" | "push")
            {
                let operation = match method {
                    "fetch" => json!({"kind":"fetch","mode":params["mode"]}),
                    "pull" => {
                        let mut operation = json!({"kind":"pull","mode":params["mode"].as_str().unwrap_or("configured")});
                        if let Some(head) = params.get("expectedHead") {
                            operation["expectedHead"] = head.clone();
                        }
                        operation
                    }
                    _ => json!({"kind":"push","expectedHead":params["expectedHead"]}),
                };
                (
                    "runTransport",
                    json!({"operationId":crate::commands::random_id()?,"repositoryId":params["repositoryId"],"client":params["client"],"transport":params["transport"],"operation":operation}),
                )
            } else {
                (method, params)
            };
            let value = match token {
                Some(token)
                    if wire_method == "runTransport"
                        && (configuration.boolean("showProgress", true) || cancellable) =>
                {
                    self.client.request_backend_with_progress(
                        "git.repository",
                        wire_method,
                        wire_params,
                        external_ext_sdk::client::ProgressOptions {
                            title: self.text(
                                if synchronizing && cancellable {
                                    "git.syncCancellation"
                                } else {
                                    "git.operationProgress"
                                },
                                &[],
                            ),
                            cancellable,
                        },
                        token,
                    )?
                }
                Some(token) => self.client.request_backend(
                    "git.repository",
                    wire_method,
                    wire_params,
                    token,
                )?,
                None => {
                    self.background
                        .request_backend("git.repository", wire_method, wire_params)?
                }
            };
            if let Some(error) = value.get("backendError") {
                return Err(ExtensionError::new(
                    if error["name"] == "RequestCancelled" {
                        HostErrorCode::Cancelled
                    } else {
                        HostErrorCode::Internal
                    },
                    format!(
                        "{}: {}",
                        error["name"].as_str().unwrap_or("Unavailable"),
                        error["message"].as_str().unwrap_or("")
                    ),
                ));
            }
            Ok(value)
        })();
        if logged {
            let _ = self.output.append_line(format!(
                "[Git] {method} {} ({} ms)",
                if result.is_ok() {
                    "completed"
                } else {
                    "failed"
                },
                started.elapsed().as_millis()
            ));
        }
        result
    }
    pub fn warning(
        &self,
        key: &str,
        arguments: &[&str],
        token: Option<&CancellationToken>,
    ) -> Result<(), ExtensionError> {
        let message = self.text(key, arguments);
        match token {
            Some(token) => self.client.show_message(
                external_ext_sdk::client::MessageSeverity::Warning,
                message,
                token,
            ),
            None => self
                .background
                .show_message(external_ext_sdk::client::MessageSeverity::Warning, message),
        }
    }
    pub fn status(
        &self,
        repository: &Repository,
        token: Option<&CancellationToken>,
    ) -> Result<Status, ExtensionError> {
        decode(self.request(
            "status",
            json!({"repositoryId": repository.descriptor.id}),
            &repository.configuration,
            token,
        )?)
    }
    pub fn repository_request(
        &self,
        repository: &Repository,
        method: &str,
        mut params: Value,
        token: &CancellationToken,
    ) -> Result<Value, ExtensionError> {
        params["repositoryId"] = json!(repository.descriptor.id);
        let mut result = self.request(method, params, &repository.configuration, Some(token))?;
        if result.get("status").is_some()
            && repository.configuration.number("similarityThreshold", 50) != 50
        {
            result["status"] = serde_json::to_value(self.status(repository, Some(token))?)
                .map_err(|_| invalid("Invalid Git view snapshot"))?;
        }
        Ok(result)
    }
    pub fn confirm(
        &self,
        key: &str,
        arguments: &[&str],
        token: &CancellationToken,
    ) -> Result<bool, ExtensionError> {
        Ok(self.editor(
            json!({"method":"confirm", "message":self.text(key,arguments)}),
            Some(token),
        )?["confirmed"]
            .as_bool()
            .unwrap_or(false))
    }
    pub fn input(
        &self,
        key: &str,
        initial: &str,
        token: &CancellationToken,
    ) -> Result<Option<String>, ExtensionError> {
        Ok(self
            .editor(
                json!({"method":"input", "title":self.text(key,&[]), "value":initial}),
                Some(token),
            )?
            .as_str()
            .map(str::to_owned))
    }
    pub fn pick(
        &self,
        key: &str,
        items: Vec<(String, Option<String>)>,
        token: &CancellationToken,
    ) -> Result<Option<usize>, ExtensionError> {
        self.client.show_quick_pick_items(
            items
                .into_iter()
                .map(
                    |(label, description)| external_ext_sdk::client::QuickPickItem {
                        label,
                        description,
                        detail: None,
                    },
                )
                .collect(),
            self.text(key, &[]),
            token,
        )
    }
}
pub fn decode<T: DeserializeOwned>(value: Value) -> Result<T, ExtensionError> {
    serde_json::from_value(value).map_err(|error| {
        ExtensionError::new(
            HostErrorCode::InvalidRequest,
            format!("Invalid Git response: {error}"),
        )
    })
}
pub fn file_uri(root: &str, path: &str) -> Result<String, ExtensionError> {
    let mut uri = url::Url::parse(root).map_err(|_| invalid("Invalid repository URI"))?;
    {
        let mut segments = uri
            .path_segments_mut()
            .map_err(|_| invalid("Invalid repository URI"))?;
        segments.pop_if_empty();
        for segment in path.split('/') {
            segments.push(segment);
        }
    }
    Ok(uri.to_string())
}
pub fn invalid(message: &str) -> ExtensionError {
    ExtensionError::new(HostErrorCode::InvalidRequest, message)
}
