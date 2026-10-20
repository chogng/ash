//! The compiler consumes a versioned process contract, never RA database IDs.
//! Keep this process warm across saves; a failed query discards the database.

use serde_json::Value;
use serde_json::json;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::process::Child;
use std::process::ChildStdin;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

const MAX_RESPONSE: u64 = 8 * 1024 * 1024;
pub(crate) const SOURCE: &str = "crates/app-server-diff/src/lib.rs";

pub(crate) struct Client {
    child: Child,
    input: ChildStdin,
    responses: mpsc::Receiver<Result<Value, String>>,
    id: u64,
    revision: u64,
}

impl Client {
    pub fn start(executable: &Path, repository: &Path) -> Result<Self, String> {
        let mut child = Command::new(executable)
            .arg(repository)
            .current_dir(repository)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| error.to_string())?;
        let input = child.stdin.take().ok_or("analysis stdin missing")?;
        let mut output = BufReader::new(child.stdout.take().ok_or("analysis stdout missing")?);
        let (sender, responses) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            loop {
                let result = read_response(&mut output);
                let failed = result.is_err();
                if sender.send(result).is_err() || failed {
                    break;
                }
            }
        });
        let client = Self {
            child,
            input,
            responses,
            id: 0,
            revision: 0,
        };
        let ready = client.receive(Duration::from_secs(60))?;
        if !ready["id"].is_null() || ready["revision"] != 0 || ready["result"]["event"] != "ready" {
            return Err("invalid analysis ready event".into());
        }
        if ready["result"]["scalar_ir_version"] != ash_rust_build_ir::VERSION {
            return Err("analysis scalar IR version differs from the compiler".into());
        }
        eprintln!("[ash-build] Analysis ready (pid {})", client.child.id());
        Ok(client)
    }

    fn receive(&self, timeout: Duration) -> Result<Value, String> {
        let response = self
            .responses
            .recv_timeout(timeout)
            .map_err(|error| error.to_string())??;
        if response["protocol_version"] != 1 {
            return Err("unsupported analysis protocol".into());
        }
        if let Some(error) = response.get("error") {
            return Err(format!("analysis rejected query: {error}"));
        }
        Ok(response)
    }

    fn query(&mut self, query: Value, revision: u64) -> Result<Value, String> {
        self.id = self
            .id
            .checked_add(1)
            .ok_or("analysis request counter exhausted")?;
        let frame = json!({"protocol_version": 1, "id": self.id, "revision": self.revision, "query": query});
        let bytes = serde_json::to_vec(&frame).map_err(|error| error.to_string())?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("analysis request exceeds byte budget".into());
        }
        self.input
            .write_all(&bytes)
            .map_err(|error| error.to_string())?;
        self.input
            .write_all(b"\n")
            .and_then(|()| self.input.flush())
            .map_err(|error| error.to_string())?;
        let response = self.receive(Duration::from_secs(30))?;
        if response["id"] != self.id
            || response["revision"] != revision
            || !response["result"].is_object()
        {
            return Err("analysis response has a stale revision or mismatched request".into());
        }
        self.revision = revision;
        Ok(response["result"].clone())
    }

    pub fn function(&mut self, text: &str, byte_offset: u32) -> Result<Value, String> {
        if text.len() > 2 * 1024 * 1024 {
            return Err("function source exceeds analysis byte budget".into());
        }
        self.query(
            json!({"method": "change_file", "path": SOURCE, "text": text}),
            self.revision
                .checked_add(1)
                .ok_or("analysis revision exhausted")?,
        )?;
        let report = self.query(
            json!({"method": "function", "path": SOURCE, "byte_offset": byte_offset}),
            self.revision,
        )?;
        Ok(
            json!({"revision": self.revision, "source_sha256": crate::reload::digest(text.as_bytes()), "report": report}),
        )
    }
}

impl Client {
    pub(crate) fn sync(&mut self, files: &[ash_rust_build_ir::Source]) -> Result<(), String> {
        // Batches are applied transactionally by RA; the final query uses the
        // last revision, never a mixture of old and new dependency overlays.
        let mut start = 0;
        let mut bytes = 0;
        for (index, file) in files.iter().enumerate() {
            let size = serde_json::to_vec(file)
                .map_err(|error| error.to_string())?
                .len();
            if size > 4 * 1024 * 1024 - 1024 {
                return Err("source exceeds analysis frame budget".into());
            }
            if index > start && (bytes + size > 3 * 1024 * 1024 || index - start == 64) {
                self.query(
                    json!({"method":"change_files", "files":&files[start..index]}),
                    self.revision
                        .checked_add(1)
                        .ok_or("analysis revision exhausted")?,
                )?;
                start = index;
                bytes = 0;
            }
            bytes += size;
        }
        if start < files.len() {
            self.query(
                json!({"method":"change_files", "files":&files[start..]}),
                self.revision
                    .checked_add(1)
                    .ok_or("analysis revision exhausted")?,
            )?;
        }
        Ok(())
    }

    pub(crate) fn graph(
        &mut self,
        path: &str,
        byte_offset: u32,
    ) -> Result<(ash_rust_build_ir::Lowered, u64), String> {
        let report = self.query(
            json!({"method":"lower", "path":path, "byte_offset":byte_offset}),
            self.revision,
        )?;
        let mut lowered: ash_rust_build_ir::Lowered =
            serde_json::from_value(report).map_err(|error| error.to_string())?;
        if let ash_rust_build_ir::Lowered::Available { program } = &mut lowered {
            ash_rust_build_ir::validate(program)?;
            if program.sources.is_empty() || program.crate_root.is_empty() {
                return Err("analysis omitted semantic source provenance".into());
            }
            // Only private helpers whose complete reference set lies within the
            // replacement graph can change without leaving another native caller
            // using the old definition. Import sites are not executable callers.
            for index in 1..program.functions.len() {
                let function = &program.functions[index];
                let references = self.query(json!({"method":"references", "path":function.source_path, "byte_offset":function.name_start, "exclude_imports":true}), self.revision)?;
                let private = !function.public;
                program.functions[index].exclusive = private
                    && references["truncated"] == false
                    && references["references"]
                        .as_array()
                        .is_some_and(|references| {
                            references.iter().all(|reference| {
                                let path = reference["path"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .replace('\\', "/");
                                let start =
                                    reference["range"]["start"].as_u64().unwrap_or(u64::MAX);
                                let end = reference["range"]["end"].as_u64().unwrap_or(u64::MAX);
                                program.functions.iter().any(|function| {
                                    path.ends_with(&format!("/{}", function.source_path))
                                        && start >= u64::from(function.body_start)
                                        && end <= u64::from(function.body_end)
                                })
                            })
                        });
            }
        }
        Ok((lowered, self.revision))
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        // This mode never starts workspace build scripts or proc-macro helpers.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn read_response(reader: &mut impl BufRead) -> Result<Value, String> {
    let mut line = Vec::new();
    reader
        .by_ref()
        .take(MAX_RESPONSE + 1)
        .read_until(b'\n', &mut line)
        .map_err(|error| error.to_string())?;
    if line.is_empty() || line.len() as u64 > MAX_RESPONSE {
        return Err("missing or oversized analysis response".into());
    }
    serde_json::from_slice(&line).map_err(|error| error.to_string())
}

/// This gate proves only the registered scalar contract. Rustc still validates
/// the extracted body; RA MIR availability is not a borrow-checking result.
pub(crate) fn supports(report: &Value) -> bool {
    let scalar = |ty: &Value| {
        ty["display"] == "usize"
            && ty["contains_unknown"] == false
            && ty["layout"]["status"] == "available"
            && ty["layout"]["value"]["size_bytes"] == std::mem::size_of::<usize>()
            && ty["layout"]["value"]["alignment_bytes"] == std::mem::align_of::<usize>()
    };
    report["function"]["name"] == "zero_based_line_index"
        && report["function"]["crate"] == "ash_app_server_diff"
        && report["generic_parameter_count"] == 0
        && report["is_async"] == false
        && report["parameters"]
            .as_array()
            .is_some_and(|parameters| parameters.len() == 1 && scalar(&parameters[0]))
        && scalar(&report["return_type"])
        && report["mir"]["status"] == "available"
        && report["expressions_truncated"] == false
        && report["calls_truncated"] == false
        && report["expressions"].as_array().is_some_and(|expressions| {
            expressions
                .iter()
                .all(|expression| expression["type"]["contains_unknown"] == false)
        })
        && report["syntax_calls"].as_array().is_some_and(|calls| {
            calls
                .iter()
                .all(|call| call["resolved_function"].is_object())
        })
}

#[cfg(test)]
#[path = "analysis_tests.rs"]
mod tests;
