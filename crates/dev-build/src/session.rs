//! A persistent scalar execution host for real workspace functions. A build
//! replaces the complete registered set only after its Cargo check succeeds.

use crate::analysis::Client;
use crate::machine::Code;
use crate::reload::digest;
use crate::workspace::Package;
use crate::workspace::Snapshot;
use ash_rust_build_ir::Lowered;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::io::BufRead;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    function: String,
}

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Build {
        protocol_version: u32,
        id: u64,
        entries: Vec<Entry>,
        #[serde(default)]
        check: crate::check::Policy,
    },
    Call {
        protocol_version: u32,
        id: u64,
        entry: usize,
        arguments: Vec<u64>,
    },
}

impl Request {
    fn envelope(&self) -> (u32, u64) {
        match self {
            Self::Build {
                protocol_version,
                id,
                ..
            }
            | Self::Call {
                protocol_version,
                id,
                ..
            } => (*protocol_version, *id),
        }
    }
}

struct Compiled {
    key: String,
    sha256: String,
    code: Arc<Code>,
}

struct Session {
    checker: crate::check::Checker,
    client: Option<Client>,
    previous: Option<Snapshot>,
    entries: Vec<Entry>,
    compiled: Vec<Compiled>,
    generation: u64,
}

fn offset(source: &str, name: &str) -> Result<u32, String> {
    let file = syn2::parse_file(source).map_err(|error| error.to_string())?;
    let functions: Vec<_> = file
        .items
        .iter()
        .filter_map(|item| match item {
            syn2::Item::Fn(function) if function.sig.ident == name => Some(function),
            _ => None,
        })
        .collect();
    if functions.len() != 1 {
        return Err("entry must select one top-level function in its source file".into());
    }
    functions[0]
        .sig
        .ident
        .span()
        .byte_range()
        .start
        .try_into()
        .map_err(|_| "function offset exceeds budget".into())
}

impl Session {
    fn build(
        &mut self,
        repository: &Path,
        directory: &Path,
        bridge: &Path,
        mut entries: Vec<Entry>,
        check: crate::check::Policy,
    ) -> Result<Value, String> {
        let started = Instant::now();
        if entries.is_empty()
            || entries.len() > 8
            || entries
                .iter()
                .any(|entry| entry.path.len() > 4096 || entry.function.len() > 256)
        {
            return Err("invalid scalar entry set".into());
        }
        if !crate::function::native_configuration() {
            return Err("custom compiler or target configuration requires Cargo".into());
        }
        let canonical = repository
            .canonicalize()
            .map_err(|error| error.to_string())?;
        for entry in &mut entries {
            let source = canonical
                .join(&entry.path)
                .canonicalize()
                .map_err(|error| error.to_string())?;
            entry.path = source
                .strip_prefix(&canonical)
                .map_err(|_| "entry source escapes workspace")?
                .to_string_lossy()
                .replace('\\', "/");
        }
        let package = Package::for_source(repository, &entries[0].path)?;
        for entry in &entries {
            if Package::for_source(repository, &entry.path)?.directory != package.directory {
                return Err("entry set must belong to one Cargo package".into());
            }
        }
        let snapshot = package.snapshot(repository)?;
        snapshot.verify_configuration()?;
        let dependencies_changed = self.checker.inputs_changed(&package, &snapshot);
        let reset = self
            .previous
            .as_ref()
            .is_none_or(|previous| snapshot.configuration_changed(previous))
            || entries != self.entries
            || dependencies_changed;
        if reset {
            self.client = None;
        }
        if self.client.is_none() {
            self.client = Some(Client::start(bridge, repository)?);
        }
        let client = self.client.as_mut().ok_or("analysis unavailable")?;
        client.sync(&snapshot.sources())?;
        let mut programs = Vec::new();
        for entry in &entries {
            let source = snapshot
                .files
                .get(&entry.path)
                .ok_or("entry is not a package source")?;
            let (lowered, _) = client.graph(&entry.path, offset(source, &entry.function)?)?;
            let Lowered::Available { program } = lowered else {
                return Err(format!(
                    "{} is outside the scalar MIR subset",
                    entry.function
                ));
            };
            snapshot.verify_program(&program)?;
            package.verify_library(repository, &program)?;
            programs.push(program);
        }
        let analyzed = started.elapsed();
        let keys: Vec<_> = programs
            .iter()
            .map(|program| {
                serde_json::to_vec(program)
                    .map(|bytes| digest(&bytes))
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<_, _>>()?;
        let dirty: Vec<_> = keys
            .iter()
            .enumerate()
            .filter_map(|(index, key)| {
                (reset
                    || self
                        .compiled
                        .get(index)
                        .is_none_or(|compiled| compiled.key != *key))
                .then_some(index)
            })
            .collect();
        // Recheck the complete crate even on cache hits; dependency changes must
        // not hide behind an unchanged scalar graph.
        let report = self.checker.check(
            repository,
            &package,
            &snapshot,
            &directory.join("check"),
            check,
        )?;
        if report.invalidated && !reset {
            self.client = None;
            return Err("check dependencies changed during analysis; retry".into());
        }
        if !report.success {
            return Err("rustc rejected the package; previous generation retained".into());
        }
        if dirty.is_empty() {
            if package.snapshot(repository)?.digest() != snapshot.digest() {
                return Err("package changed during analysis; retry".into());
            }
            self.previous = Some(snapshot);
            return Ok(
                json!({"generation":self.generation,"compiled":[],"reused":entries.len(),"check_backend":report.backend,"elapsed_ms":started.elapsed().as_secs_f64()*1000.0}),
            );
        }
        // Checking the real owner preserves imports, module visibility, constants,
        // const calls and crate configuration. No renamed/flattened checker source.
        let checked = started.elapsed();
        let mut compiled = Vec::new();
        let mut manifest_entries = Vec::new();
        std::fs::create_dir_all(directory.join("objects")).map_err(|error| error.to_string())?;
        for (index, program) in programs.iter().enumerate() {
            let candidate = if dirty.contains(&index) {
                let image = crate::codegen::compile(
                    program,
                    crate::jit::overflow_checks(repository, &package.name)?,
                )?;
                let code = Arc::new(Code::load(&image)?);
                let sha256 = digest(&image);
                let path = directory.join("objects").join(format!("{sha256}.json"));
                if path.exists() {
                    if digest(&std::fs::read(path).map_err(|error| error.to_string())?) != sha256 {
                        return Err("immutable code image was modified".into());
                    }
                } else {
                    std::fs::write(path, image).map_err(|error| error.to_string())?;
                }
                Compiled {
                    key: keys[index].clone(),
                    sha256,
                    code,
                }
            } else {
                let previous = &self.compiled[index];
                Compiled {
                    key: previous.key.clone(),
                    sha256: previous.sha256.clone(),
                    code: previous.code.clone(),
                }
            };
            let mir = serde_json::to_vec(program).map_err(|error| error.to_string())?;
            let mir_path = directory
                .join("objects")
                .join(format!("{}.mir.json", keys[index]));
            if mir_path.exists() {
                if std::fs::read(mir_path).map_err(|error| error.to_string())? != mir {
                    return Err("immutable MIR artifact was modified".into());
                }
            } else {
                std::fs::write(mir_path, mir).map_err(|error| error.to_string())?;
            }
            manifest_entries.push(json!({"entry":entries[index],"sha256":candidate.sha256,"mir_sha256":keys[index],"dependencies":program.sources.iter().map(|source| json!({"path":source.path,"sha256":digest(source.text.as_bytes())})).collect::<Vec<_>>() }));
            compiled.push(candidate);
        }
        let generated = started.elapsed();
        if snapshot.digest() != package.snapshot(repository)?.digest() {
            return Err("package changed during compilation; retry".into());
        }
        let generation = self
            .generation
            .checked_add(1)
            .ok_or("generation exhausted")?;
        let manifest = json!({"version":1,"generation":generation,"entries":manifest_entries,"source_snapshot":snapshot.digest()});
        std::fs::write(
            directory.join("current.tmp"),
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        std::fs::rename(
            directory.join("current.tmp"),
            directory.join("current.json"),
        )
        .map_err(|error| error.to_string())?;
        // The serial protocol cannot interleave an invocation with publication;
        // retained Arc mappings still own older code until its last user returns.
        self.compiled = compiled;
        self.entries = entries;
        self.generation = generation;
        self.previous = Some(snapshot);
        Ok(
            json!({"generation":generation,"compiled":dirty,"reused":self.entries.len()-dirty.len(),"check_backend":report.backend,"analysis_ms":analyzed.as_secs_f64()*1000.0,"rustc_check_ms":(checked-analyzed).as_secs_f64()*1000.0,"codegen_and_image_ms":(generated-checked).as_secs_f64()*1000.0,"elapsed_ms":started.elapsed().as_secs_f64()*1000.0}),
        )
    }
}

/// Runs registered workspace scalar functions in one persistent process, including
/// atomic dependency invalidation of a set of entries sharing constants/helpers.
pub fn serve_functions(repository: &Path, directory: &Path, bridge: &Path) -> Result<(), String> {
    let mut session = Session {
        checker: crate::check::Checker::default(),
        client: None,
        previous: None,
        entries: Vec::new(),
        compiled: Vec::new(),
        generation: 0,
    };
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("build.lock"))
        .map_err(|error| error.to_string())?;
    lock.lock().map_err(|error| error.to_string())?;
    let mut output = std::io::stdout().lock();
    let mut input = std::io::stdin().lock();
    writeln!(output, "{}", json!({"protocol_version":1,"id":null,"result":{"event":"ready","pid":std::process::id(),"scalar_ir_version":ash_rust_build_ir::VERSION}})).map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())?;
    loop {
        let mut frame = Vec::new();
        input
            .by_ref()
            .take(16385)
            .read_until(b'\n', &mut frame)
            .map_err(|error| error.to_string())?;
        if frame.is_empty() {
            return Ok(());
        }
        if frame.len() > 16384 {
            return Err("scalar request exceeds byte budget".into());
        }
        let request = serde_json::from_slice::<Request>(&frame);
        let id = request.as_ref().ok().map(|request| request.envelope().1);
        let result = request
            .map_err(|error| error.to_string())
            .and_then(|request| {
                if request.envelope().0 != 1 {
                    return Err("unsupported scalar protocol".into());
                }
                match request {
                    Request::Build { entries, check, .. } => {
                        let result = session.build(repository, directory, bridge, entries, check);
                        if result.is_err() {
                            session.client = None;
                        }
                        result
                    }
                    Request::Call {
                        entry, arguments, ..
                    } => {
                        let compiled = session
                            .compiled
                            .get(entry)
                            .ok_or("entry has no compiled generation")?;
                        let value = compiled.code.call(&arguments)?;
                        Ok(json!({"generation":session.generation,"value":value}))
                    }
                }
            });
        let response = match result {
            Ok(result) => json!({"protocol_version":1,"id":id,"result":result}),
            Err(error) => json!({"protocol_version":1,"id":id,"error":error}),
        };
        writeln!(output, "{response}")
            .and_then(|()| output.flush())
            .map_err(|error| error.to_string())?;
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
