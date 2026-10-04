use crate::Error;
use crate::Result;
use ash_secrets::SecretValue;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const OUTPUT_LIMIT: u64 = 8 * 1024 * 1024;

pub(super) struct Output {
    pub stdout: Vec<u8>,
    pub success: bool,
}

pub(super) async fn run(
    executable: &Path,
    arguments: &[String],
    input: Option<&[u8]>,
    host: &str,
    token: &SecretValue,
) -> Result<Output> {
    let token = std::str::from_utf8(token.expose()).map_err(|_| Error::AuthenticationRequired)?;
    let mut child = Command::new(executable)
        .args(arguments)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_PAGER", "cat")
        .env_remove("GH_REPO")
        // gh otherwise selects credentials from inherited variables or its own account store.
        .env_remove("GH_TOKEN")
        .env_remove("GITHUB_TOKEN")
        .env_remove("GH_ENTERPRISE_TOKEN")
        .env_remove("GITHUB_ENTERPRISE_TOKEN")
        .env("GH_HOST", host)
        .env(
            if host == "github.com" {
                "GH_TOKEN"
            } else {
                "GH_ENTERPRISE_TOKEN"
            },
            token,
        )
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            Error::Unavailable(format!("Cannot start GitHub CLI; install gh: {error}"))
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::OperationFailed("Missing GitHub stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| Error::OperationFailed("Missing GitHub stderr".into()))?;
    let stdin = child.stdin.take();
    let operation = async {
        let write = async {
            if let (Some(mut stdin), Some(input)) = (stdin, input) {
                stdin
                    .write_all(input)
                    .await
                    .map_err(|error| Error::OperationFailed(error.to_string()))?;
                stdin
                    .shutdown()
                    .await
                    .map_err(|error| Error::OperationFailed(error.to_string()))?;
            }
            Ok::<_, Error>(())
        };
        let (_, stdout, stderr, status) =
            tokio::try_join!(write, read(stdout), read(stderr), async {
                child
                    .wait()
                    .await
                    .map_err(|error| Error::OperationFailed(error.to_string()))
            })?;
        // gh reports HTTP and GraphQL refusals with a nonzero exit status. The included
        // HTTP response is authoritative; stderr is only used for failures without one.
        if arguments.first().is_some_and(|argument| argument == "api")
            && stdout.starts_with(b"HTTP/")
        {
            return Ok(Output {
                stdout: api_response(stdout)?,
                success: status.success(),
            });
        }
        if !status.success() {
            return Err(Error::OperationFailed(format!(
                "GitHub request failed: {}",
                String::from_utf8_lossy(&stderr)
                    .trim()
                    .replace(token, "[REDACTED]")
            )));
        }
        if arguments.first().is_some_and(|argument| argument == "api") {
            return Err(Error::InvalidResponse(
                "Missing GitHub HTTP response headers".into(),
            ));
        }
        Ok(Output {
            stdout,
            success: true,
        })
    };
    match tokio::time::timeout(Duration::from_secs(30), operation).await {
        Ok(Ok(output)) => Ok(output),
        outcome => {
            let _ = child.kill().await;
            match outcome {
                Ok(Err(error)) => Err(error),
                Err(_) => Err(Error::TimedOut),
                Ok(Ok(_)) => unreachable!(),
            }
        }
    }
}

async fn read(reader: impl AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(OUTPUT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| Error::OperationFailed(error.to_string()))?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err(Error::InvalidResponse(
            "GitHub response exceeds 8 MiB".into(),
        ));
    }
    Ok(bytes)
}

fn api_response(output: Vec<u8>) -> Result<Vec<u8>> {
    // gh prints the status line with LF and the header terminator with CRLF. Reading
    // lines also accepts HTTP's CRLF without interpreting any body bytes as headers.
    let mut body_offset = 0;
    let mut status = None;
    let mut headers = Vec::new();
    for line in output.split_inclusive(|byte| *byte == b'\n') {
        body_offset += line.len();
        let line = std::str::from_utf8(line)
            .map_err(|_| Error::InvalidResponse("Invalid GitHub HTTP headers".into()))?
            .trim_end_matches(['\r', '\n']);
        if status.is_none() {
            status = line
                .split_whitespace()
                .nth(1)
                .and_then(|value| value.parse::<u16>().ok());
            if !status.is_some_and(|value| (100..=599).contains(&value)) {
                return Err(Error::InvalidResponse("Invalid GitHub HTTP status".into()));
            }
        } else if line.is_empty() {
            crate::error::validate_status(status.unwrap(), headers.into_iter())?;
            return Ok(output[body_offset..].to_vec());
        } else {
            let (name, value) = line
                .split_once(':')
                .ok_or_else(|| Error::InvalidResponse("Invalid GitHub HTTP header".into()))?;
            headers.push((name, value.trim()));
        }
    }
    Err(Error::InvalidResponse(
        "Incomplete GitHub HTTP headers".into(),
    ))
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;
