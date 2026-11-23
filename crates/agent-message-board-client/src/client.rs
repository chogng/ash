use agent_message_board::API_PATH;
use agent_message_board::AccessToken;
use agent_message_board::BoardBackend;
use agent_message_board::BoardCall;
use agent_message_board::BoardNotification;
use agent_message_board::BoardOperation;
use agent_message_board::Commit;
use agent_message_board::Error;
use agent_message_board::MAX_BODY;
use agent_message_board::MemberRegistration;
use agent_message_board::NotificationWatch;
use agent_message_board::ReadRequest;
use agent_message_board::Result;
use agent_message_board::Scope;
use agent_message_board::ServiceFailure;
use agent_message_board::Unread;
use agent_message_board::WriteRequest;
use async_utils::CancellationToken;
use http_client::HttpBodySink;
use http_client::HttpClient;
use http_client::HttpClientError;
use http_client::HttpHeader;
use http_client::HttpRequest;
use http_client::HttpResponse;
use protocol::SessionId;
use protocol::ThreadId;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;
use url::Url;

/// Uses the application's existing proxy, certificate, network and cancellation policy.
/// Administrative credentials only provision membership; board operations use a tree-scoped token.
pub struct RemoteMessageBoard {
    http: Arc<dyn HttpClient>,
    endpoint: Url,
    administrator: AccessToken,
    credentials: Mutex<BTreeMap<(SessionId, ThreadId), AccessToken>>,
    registration_guard: Option<Box<RegistrationGuard>>,
}

type RegistrationGuard = dyn Fn(&SessionId) -> Result<()> + Send + Sync;
impl RemoteMessageBoard {
    pub fn new(
        http: Arc<dyn HttpClient>,
        endpoint: &str,
        administrator: AccessToken,
    ) -> Result<Self> {
        let mut endpoint = Url::parse(endpoint)
            .map_err(|_| Error::Input("invalid message-board endpoint".into()))?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(Error::Input(
                "board endpoint must be an HTTP(S) URL without credentials, query or fragment"
                    .into(),
            ));
        }
        endpoint.set_path(&format!(
            "{}{API_PATH}",
            endpoint.path().trim_end_matches('/')
        ));
        Ok(Self {
            http,
            endpoint,
            administrator,
            credentials: Mutex::new(BTreeMap::new()),
            registration_guard: None,
        })
    }

    /// Installs the host's durable ownership check before any membership request.
    pub fn with_registration_guard(
        mut self,
        guard: impl Fn(&SessionId) -> Result<()> + Send + Sync + 'static,
    ) -> Self {
        self.registration_guard = Some(Box::new(guard));
        self
    }
    fn request(
        &self,
        suffix: &str,
        token: &AccessToken,
        body: &impl Serialize,
    ) -> Result<HttpRequest> {
        let bytes = serde_json::to_vec(body)?;
        if bytes.len() > MAX_BODY {
            return Err(Error::Input("board request exceeds 128 KiB".into()));
        }
        let mut url = self.endpoint.clone();
        url.set_path(&format!("{}{suffix}", url.path()));
        HttpRequest::post(
            url.as_str(),
            vec![
                HttpHeader::new("Authorization", token.authorization_header()),
                HttpHeader::new("Content-Type", "application/json"),
            ],
            bytes,
        )
        .map(HttpRequest::without_redirects)
        .map_err(transport)
    }
    fn token(&self, scope: &Scope) -> Result<AccessToken> {
        self.credentials
            .lock()
            .map_err(|_| Error::Runtime("board credential lock poisoned".into()))?
            .get(&(scope.session.clone(), scope.root.clone()))
            .cloned()
            .ok_or_else(|| Error::Input("board tree has not been registered".into()))
    }
    fn send<T: DeserializeOwned>(
        &self,
        suffix: &str,
        token: &AccessToken,
        body: &impl Serialize,
        cancellation: &CancellationToken,
    ) -> Result<T> {
        let request = self.request(suffix, token, body)?;
        decode(
            self.http
                .execute_with_cancellation(&request, cancellation)
                .map_err(transport)?,
        )
    }
    fn call<T: DeserializeOwned>(
        &self,
        scope: &Scope,
        caller: &ThreadId,
        operation: BoardOperation,
        cancellation: &CancellationToken,
    ) -> Result<T> {
        self.send(
            "/call",
            &self.token(scope)?,
            &BoardCall {
                scope: scope.clone(),
                caller: caller.clone(),
                operation,
            },
            cancellation,
        )
    }
    /// Consumes one connection. The host owns reconnection and drops its cancellation
    /// domain at Turn termination. Readiness precedes every notification frame.
    pub fn notifications(
        &self,
        watch: &NotificationWatch,
        cancellation: &CancellationToken,
        receive: &mut dyn FnMut(BoardNotification) -> Result<()>,
    ) -> Result<()> {
        let request = self.request("/notifications", &self.token(&watch.scope)?, watch)?;
        let mut sink = NoticeSink {
            watch,
            receive,
            frame: Vec::new(),
            ready: false,
            previous_cr: false,
        };
        let response = self
            .http
            .execute_streaming_with_cancellation(&request, cancellation, &mut sink)
            .map_err(transport)?;
        if !response.is_success() {
            decode::<Value>(response)?;
        }
        if !sink.ready {
            return Err(Error::Runtime(
                "board notification connection closed before readiness".into(),
            ));
        }
        Ok(())
    }

    /// Clears the remote data and retires cached credentials after confirmed deletion.
    pub fn delete_session_with_cancellation(
        &self,
        session: &SessionId,
        cancellation: &CancellationToken,
    ) -> Result<()> {
        self.send::<Value>(
            "/delete-session",
            &self.administrator,
            session,
            cancellation,
        )?;
        self.forget_session(session);
        Ok(())
    }

    /// Retires this client's local tree credentials when the Session is closed.
    pub fn forget_session(&self, session: &SessionId) {
        self.credentials
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|(id, _), _| id != session);
    }
}
impl BoardBackend for RemoteMessageBoard {
    fn register_members(
        &self,
        scope: &Scope,
        members: &[ThreadId],
        cancellation: &CancellationToken,
    ) -> Result<()> {
        cancellation.check().map_err(transport)?;
        if let Some(guard) = &self.registration_guard {
            guard(&scope.session)?;
        }
        let raw: String = self.send(
            "/members",
            &self.administrator,
            &MemberRegistration {
                scope: scope.clone(),
                members: members.to_vec(),
            },
            cancellation,
        )?;
        let token = AccessToken::new(raw)?;
        self.credentials
            .lock()
            .map_err(|_| Error::Runtime("board credential lock poisoned".into()))?
            .insert((scope.session.clone(), scope.root.clone()), token);
        Ok(())
    }
    fn read(
        &self,
        scope: &Scope,
        member: &ThreadId,
        request: &ReadRequest,
        cancellation: &CancellationToken,
    ) -> Result<Value> {
        self.call(
            scope,
            member,
            BoardOperation::Read(request.clone()),
            cancellation,
        )
    }
    fn write(
        &self,
        scope: &Scope,
        member: &ThreadId,
        operation: &str,
        time: i64,
        request: &WriteRequest,
        cancellation: &CancellationToken,
    ) -> Result<Commit> {
        let output = self.call(
            scope,
            member,
            BoardOperation::Write {
                operation_id: operation.into(),
                time,
                request: request.clone(),
            },
            cancellation,
        )?;
        Ok(Commit { output })
    }
    fn unread(
        &self,
        scope: &Scope,
        member: &ThreadId,
        cancellation: &CancellationToken,
    ) -> Result<Unread> {
        let unread: Unread = self.call(scope, member, BoardOperation::Unread, cancellation)?;
        unread.validate_remote()?;
        Ok(unread)
    }
    fn delete_session(&self, session: &SessionId) -> Result<()> {
        let cancellation = async_utils::CancellationSource::new();
        self.delete_session_with_cancellation(session, &cancellation.token())
    }
}
fn transport(error: impl fmt::Display) -> Error {
    Error::Runtime(format!("message-board transport: {error}"))
}
fn decode<T: DeserializeOwned>(response: HttpResponse) -> Result<T> {
    if response.body().len() > 1024 * 1024 {
        return Err(Error::Runtime("board response exceeds 1 MiB".into()));
    }
    if !response.is_success() {
        let failure: ServiceFailure = serde_json::from_slice(response.body())?;
        return Err(if response.status() >= 500 {
            Error::Runtime(format!("{}: {}", failure.code, failure.message))
        } else {
            Error::Input(format!("{}: {}", failure.code, failure.message))
        });
    }
    Ok(serde_json::from_slice(response.body())?)
}
struct NoticeSink<'a> {
    watch: &'a NotificationWatch,
    receive: &'a mut dyn FnMut(BoardNotification) -> Result<()>,
    frame: Vec<u8>,
    ready: bool,
    previous_cr: bool,
}
impl NoticeSink<'_> {
    fn line_end(&mut self) -> Result<()> {
        self.frame.push(b'\n');
        if !self.frame.ends_with(b"\n\n") {
            return Ok(());
        }
        let text = std::str::from_utf8(&self.frame).map_err(transport)?;
        let mut event = "message";
        let mut data = String::new();
        for line in text.lines() {
            if let Some(value) = line.strip_prefix("event:") {
                event = value.trim_start_matches(' ');
            }
            if let Some(value) = line.strip_prefix("data:") {
                data.push_str(value.trim_start_matches(' '));
                data.push('\n');
            }
        }
        match event {
            "ready" if !self.ready => self.ready = true,
            "notification" if self.ready => {
                if let Ok(notice) = serde_json::from_str::<BoardNotification>(&data)
                    && notice.scope == self.watch.scope
                    && notice.recipient == self.watch.caller
                    && notice.turn_id == self.watch.turn_id
                    && notice.validate().is_ok()
                {
                    (self.receive)(notice)?;
                }
            }
            "message" if data.is_empty() => {} // SSE comment heartbeat.
            _ => {
                return Err(Error::Runtime(
                    "invalid board notification stream sequence".into(),
                ));
            }
        }
        self.frame.clear();
        Ok(())
    }
}
impl HttpBodySink for NoticeSink<'_> {
    fn emit(&mut self, bytes: &[u8]) -> std::result::Result<(), HttpClientError> {
        for &byte in bytes {
            if byte == b'\n' && self.previous_cr {
                self.previous_cr = false;
                continue;
            }
            self.previous_cr = byte == b'\r';
            if byte == b'\n' || byte == b'\r' {
                self.line_end()
                    .map_err(|error| HttpClientError::Transport(error.to_string()))?;
            } else {
                self.frame.push(byte);
            }
            if self.frame.len() > 16 * 1024 {
                return Err(HttpClientError::Transport(
                    "board notification frame exceeds 16 KiB".into(),
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
