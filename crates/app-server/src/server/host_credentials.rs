use super::AppServer;
use ash_app_server_protocol::host_credentials::HostCredentialFailure;
use ash_app_server_protocol::host_credentials::HostCredentialRequest;
use ash_app_server_protocol::host_credentials::HostCredentialResponse;
use ash_chatgpt::ChatGptWebAuthError;
use ash_chatgpt::ChatGptWebAuthSession;
use std::collections::BTreeMap;
use std::io;
use std::io::BufRead;
use std::io::Read;
use std::io::Write;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const MAX_FRAME: u64 = 64 * 1024;

impl AppServer {
    /// Consumes a native-only connection admitted by the profile daemon. This is
    /// deliberately absent from JSON-RPC dispatch and all renderer method maps.
    pub(crate) fn serve_host_credentials(
        &self,
        mut reader: impl BufRead + Send + 'static,
        mut writer: impl Write,
    ) -> io::Result<()> {
        let mut session = self
            .chatgpt_web
            .as_ref()
            .ok_or_else(|| io::Error::other("authentication owner is unavailable"))?
            .session()
            .map_err(|_| io::Error::other("authentication owner is unavailable"))?;
        send(
            &mut writer,
            &HostCredentialResponse::Ready {
                version: 1,
                context: session.context().into(),
            },
        )?;
        let (sender, commands) = mpsc::sync_channel(32);
        let input = thread::Builder::new()
            .name("ash-host-credentials-input".into())
            .spawn(move || {
                loop {
                    let mut bytes = Vec::new();
                    let read = reader
                        .by_ref()
                        .take(MAX_FRAME + 1)
                        .read_until(b'\n', &mut bytes);
                    if !matches!(read, Ok(length) if length > 0 && length as u64 <= MAX_FRAME)
                        || !bytes.ends_with(b"\n")
                    {
                        return;
                    }
                    let command = serde_json::from_slice::<HostCredentialRequest>(&bytes);
                    if sender.send(command.map_err(|_| ())).is_err() {
                        return;
                    }
                }
            })?;
        loop {
            let command = commands.recv_timeout(Duration::from_millis(250));
            if matches!(command, Err(mpsc::RecvTimeoutError::Disconnected)) {
                break;
            }
            let previous = session.context().to_owned();
            session
                .synchronize()
                .map_err(|_| io::Error::other("authentication owner is unavailable"))?;
            if previous != session.context() {
                send(
                    &mut writer,
                    &HostCredentialResponse::Changed {
                        context: session.context().into(),
                    },
                )?;
            }
            let command = match command {
                Ok(Ok(command)) => command,
                Ok(Err(())) => return Err(io::Error::other("invalid private credential request")),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let previous = session.context().to_owned();
            let response = process(&mut session, command);
            if previous != session.context() {
                send(
                    &mut writer,
                    &HostCredentialResponse::Changed {
                        context: session.context().into(),
                    },
                )?;
            }
            send(&mut writer, &response)?;
        }
        input
            .join()
            .map_err(|_| io::Error::other("private credential input stopped"))?;
        Ok(())
    }
}

fn process(
    session: &mut ChatGptWebAuthSession,
    request: HostCredentialRequest,
) -> HostCredentialResponse {
    let result = match request {
        HostCredentialRequest::Authorize {
            request_id,
            context,
        } => session.authorize(&request_id, &context).map(|headers| {
            HostCredentialResponse::Authorized {
                headers: credential_headers(headers),
            }
        }),
        HostCredentialRequest::Recover { request_id } => {
            session
                .recover(&request_id)
                .map(|headers| HostCredentialResponse::Recovered {
                    headers: headers.map(credential_headers),
                })
        }
        HostCredentialRequest::Release { request_id } => {
            session.release(&request_id);
            Ok(HostCredentialResponse::Released)
        }
    };
    result.unwrap_or_else(|error| HostCredentialResponse::Failure {
        reason: match error {
            ChatGptWebAuthError::Unavailable => HostCredentialFailure::Unavailable,
            ChatGptWebAuthError::AccountChanged => HostCredentialFailure::AccountChanged,
            ChatGptWebAuthError::InvalidRequest => HostCredentialFailure::InvalidRequest,
        },
    })
}

fn credential_headers(headers: Vec<ash_http_client::HttpHeader>) -> BTreeMap<String, String> {
    headers
        .into_iter()
        .filter(|header| {
            header.name().eq_ignore_ascii_case("Authorization")
                || header.name().eq_ignore_ascii_case("ChatGPT-Account-Id")
                || header.name().eq_ignore_ascii_case("X-OpenAI-Fedramp")
        })
        .map(|header| (header.name().into(), header.value().into()))
        .collect()
}

fn send(writer: &mut impl Write, response: &HostCredentialResponse) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, response)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

#[cfg(test)]
#[path = "host_credentials_tests.rs"]
mod tests;
