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

pub(super) async fn run(
    executable: &Path,
    arguments: &[String],
    input: Option<&[u8]>,
    host: &str,
    token: &SecretValue,
) -> Result<Vec<u8>> {
    let token = std::str::from_utf8(token.expose()).map_err(|_| "Invalid GitHub credential")?;
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
        .map_err(|error| format!("Cannot start GitHub CLI; install gh: {error}"))?;
    let stdout = child.stdout.take().ok_or("Missing GitHub stdout")?;
    let stderr = child.stderr.take().ok_or("Missing GitHub stderr")?;
    let stdin = child.stdin.take();
    let operation = async {
        let write = async {
            if let (Some(mut stdin), Some(input)) = (stdin, input) {
                stdin
                    .write_all(input)
                    .await
                    .map_err(|error| error.to_string())?;
                stdin.shutdown().await.map_err(|error| error.to_string())?;
            }
            Ok::<_, String>(())
        };
        let (_, stdout, stderr, status) =
            tokio::try_join!(write, read(stdout), read(stderr), async {
                child.wait().await.map_err(|error| error.to_string())
            })?;
        if !status.success() {
            return Err(format!(
                "GitHub request failed: {}",
                String::from_utf8_lossy(&stderr)
                    .trim()
                    .replace(token, "[REDACTED]")
            ));
        }
        Ok(stdout)
    };
    match tokio::time::timeout(Duration::from_secs(30), operation).await {
        Ok(Ok(output)) => Ok(output),
        outcome => {
            let _ = child.kill().await;
            match outcome {
                Ok(Err(error)) => Err(error),
                _ => Err("GitHub request timed out".into()),
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
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err("GitHub response exceeds 8 MiB".into());
    }
    Ok(bytes)
}
