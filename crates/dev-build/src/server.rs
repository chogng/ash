//! One compiler and analysis database per watcher, serialized by JSON lines.

use crate::analysis::Client;
use crate::analysis::supports;
use crate::build::BuildMode;
use crate::function;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::io::BufRead;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol_version: u32,
    id: u64,
    mode: Mode,
    #[serde(default)]
    backend: Backend,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Backend {
    Rustc,
    #[default]
    Cranelift,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Module,
    Functions,
}

fn respond(writer: &mut impl Write, response: Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, &response).map_err(|error| error.to_string())?;
    writer
        .write_all(b"\n")
        .and_then(|()| writer.flush())
        .map_err(|error| error.to_string())
}

/// The caller owns the Cargo cache leases. EOF stops the server and its child;
/// failed builds retain the current image and leave this session usable.
pub fn serve_diff(repository: &Path, directory: &Path, bridge: &Path) -> Result<(), String> {
    let compiler = function::compiler()?;
    let mut checker = crate::check::Checker::default();
    let mut client = Some(Client::start(bridge, repository)?);
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    respond(
        &mut output,
        json!({"protocol_version": 1, "id": null, "result": {"event": "ready", "pid": std::process::id(), "backends": ["cranelift", "rustc"]}}),
    )?;
    loop {
        let mut line = Vec::new();
        input
            .by_ref()
            .take(4097)
            .read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())?;
        if line.is_empty() {
            return Ok(());
        }
        if line.len() > 4096 {
            return Err("build request exceeds byte budget".into());
        }
        let started = Instant::now();
        let request = serde_json::from_slice::<Request>(&line);
        let id = request.as_ref().ok().map(|request| request.id);
        let mut analysis_ms = 0.0;
        let result = request
            .map_err(|error| error.to_string())
            .and_then(|request| {
                if request.protocol_version != 1 {
                    return Err("unsupported build protocol".into());
                }
                let mode = match request.mode {
                    Mode::Module => BuildMode::Module,
                    Mode::Functions => BuildMode::Functions,
                };
                crate::build::build(repository, directory, mode, &compiler, &mut checker, &mut |source| {
                    let began = Instant::now();
                    let result: Result<Option<Value>, String> = (|| {
                        if client.is_none() {
                            client = Some(Client::start(bridge, repository)?);
                        }
                        let (text, offset) = source
                            .analysis_input
                            .as_ref()
                            .ok_or("missing function analysis input")?;
                        let client = client.as_mut().ok_or("missing analysis client")?;
                        match request.backend {
                            Backend::Rustc => {
                                let evidence = client.function(text, *offset)?;
                                Ok(supports(&evidence["report"]).then_some(evidence))
                            }
                            Backend::Cranelift => {
                                let files: Vec<_> = source.files.iter().filter(|(path, _)| path.ends_with(".rs")).map(|(path, text)| ash_rust_build_ir::Source { path: path.clone(), text: text.clone() }).collect();
                                client.sync(&files)?;
                                let (lowered, revision) = client.graph(crate::analysis::SOURCE, *offset)?;
                                match lowered {
                                    ash_rust_build_ir::Lowered::Available { program } => Ok(Some(json!({"revision": revision, "source_sha256": crate::reload::digest(text.as_bytes()), "program": program}))),
                                    ash_rust_build_ir::Lowered::Unsupported { reason } => {
                                        eprintln!("[ash-build] MIR subset requires Cargo: {reason}");
                                        Ok(None)
                                    }
                                }
                            }
                        }
                    })();
                    analysis_ms = began.elapsed().as_secs_f64() * 1000.0;
                    match result {
                        Ok(evidence) => Ok(evidence),
                        Err(error) => {
                            eprintln!(
                                "[ash-build] Analysis unavailable; using Cargo module: {error}"
                            );
                            client = None;
                            Ok(None)
                        }
                    }
                })
            });
        if matches!(result, Ok("module")) {
            // A module build may include new files or changed declarations that
            // the bridge's single-file overlay did not update.
            client = None;
        }
        let response = match result {
            Ok(kind) => {
                json!({"protocol_version": 1, "id": id, "result": {"kind": kind, "elapsed_ms": started.elapsed().as_secs_f64() * 1000.0, "analysis_ms": analysis_ms}})
            }
            Err(error) => json!({"protocol_version": 1, "id": id, "error": error}),
        };
        respond(&mut output, response)?;
    }
}
