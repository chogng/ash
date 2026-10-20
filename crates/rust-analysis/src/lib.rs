//! Process boundary around an unmodified, pinned rust-analyzer library release.
//! No rust-analyzer IDs, interned types or database references cross this boundary.

mod analysis;
mod lower;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::io::BufRead;
use std::io::Read;
use std::io::Write;
use std::path::Path;

const PROTOCOL_VERSION: u32 = 1;
const MAX_REQUEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;

/// Metadata loading avoids executing workspace build scripts. The explicit
/// build-script mode also starts the toolchain's procedural macro helper.
#[derive(Clone, Copy)]
pub enum WorkspaceMode {
    Metadata,
    BuildScripts,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol_version: u32,
    id: u64,
    revision: u64,
    query: Query,
}

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
enum Query {
    Function {
        path: String,
        byte_offset: u32,
    },
    Lower {
        path: String,
        byte_offset: u32,
    },
    References {
        path: String,
        byte_offset: u32,
        #[serde(default)]
        exclude_imports: bool,
    },
    ExpandMacro {
        path: String,
        byte_offset: u32,
    },
    ChangeFile {
        path: String,
        text: String,
    },
    ChangeFiles {
        files: Vec<FileChange>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileChange {
    path: String,
    text: String,
}

#[derive(Serialize)]
struct Error {
    code: &'static str,
    message: String,
}

impl Error {
    fn new(code: &'static str, message: impl ToString) -> Self {
        Self {
            code,
            message: message.to_string(),
        }
    }
}

#[derive(Serialize)]
struct Response {
    protocol_version: u32,
    id: Option<u64>,
    revision: u64,
    #[serde(flatten)]
    outcome: Outcome,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Outcome {
    Success { result: Value },
    Failure { error: Error },
}

impl From<Result<Value, Error>> for Outcome {
    fn from(result: Result<Value, Error>) -> Self {
        match result {
            Ok(result) => Self::Success { result },
            Err(error) => Self::Failure { error },
        }
    }
}

fn read_frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut frame = Vec::new();
    reader
        .by_ref()
        .take(MAX_REQUEST_BYTES + 1)
        .read_until(b'\n', &mut frame)
        .map_err(|error| error.to_string())?;
    if frame.len() as u64 > MAX_REQUEST_BYTES {
        return Err("request exceeds bridge byte budget".into());
    }
    Ok((!frame.is_empty()).then_some(frame))
}

fn write_response(writer: &mut impl Write, response: Response) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        bytes = serde_json::to_vec(&Response {
            outcome: Outcome::Failure {
                error: Error::new("budget_exceeded", "response exceeds bridge byte budget"),
            },
            ..response
        })
        .map_err(|error| error.to_string())?;
    }
    writer
        .write_all(&bytes)
        .and_then(|()| writer.write_all(b"\n"))
        .and_then(|()| writer.flush())
        .map_err(|error| error.to_string())
}

/// Serves versioned JSON lines until EOF. Workspace loading and diagnostics go
/// to stderr; stdout contains only the ready event and request responses.
pub fn serve(workspace: &Path, mode: WorkspaceMode) -> Result<(), String> {
    let mut session = analysis::Session::load(workspace, mode)?;
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    write_response(
        &mut output,
        Response {
            protocol_version: PROTOCOL_VERSION,
            id: None,
            revision: 0,
            outcome: Outcome::Success {
                result: session.ready(),
            },
        },
    )?;
    while let Some(frame) = read_frame(&mut input)? {
        let request = serde_json::from_slice::<Request>(&frame);
        let id = request.as_ref().ok().map(|request| request.id);
        let result = match request {
            Err(error) => Err(Error::new("invalid_request", error)),
            Ok(request) if request.protocol_version != PROTOCOL_VERSION => Err(Error::new(
                "invalid_request",
                "unsupported protocol version",
            )),
            Ok(request) if request.revision != session.revision => Err(Error::new(
                "stale_revision",
                "request does not match the analysis revision",
            )),
            Ok(request) => {
                // A panic may poison incremental queries. Report it once and exit;
                // callers can restart and reload instead of reusing that database.
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    session.execute(request.query)
                })) {
                    Ok(result) => result,
                    Err(_) => {
                        write_response(
                            &mut output,
                            Response {
                                protocol_version: PROTOCOL_VERSION,
                                id,
                                revision: session.revision,
                                outcome: Outcome::Failure {
                                    error: Error::new(
                                        "analysis_failed",
                                        "analysis panicked; restart the bridge",
                                    ),
                                },
                            },
                        )?;
                        return Err("analysis panicked".into());
                    }
                }
            }
        };
        write_response(
            &mut output,
            Response {
                protocol_version: PROTOCOL_VERSION,
                id,
                revision: session.revision,
                outcome: result.into(),
            },
        )?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
