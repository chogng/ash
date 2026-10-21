//! Cargo chooses the exact library invocation; warm checks still run rustc on
//! the complete original crate. Dependency sources, artifacts and declared build
//! inputs must remain unchanged. Owner build scripts retain the Cargo gate.

use crate::reload::digest;
use crate::workspace::Package;
use crate::workspace::Snapshot;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

const CAPTURE: &str = "ASH_RUST_CHECK_CAPTURE";

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Policy {
    Cargo,
    #[default]
    Reuse,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Backend {
    Cargo,
    Rustc,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Capture {
    package: PathBuf,
    environment: BTreeMap<String, String>,
    result: PathBuf,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Invocation {
    executable: PathBuf,
    arguments: Vec<String>,
    directory: PathBuf,
    environment: BTreeMap<String, Option<String>>,
}

fn environment() -> Result<BTreeMap<String, String>, String> {
    std::env::vars_os()
        .filter(|(key, _)| key != CAPTURE)
        .map(|(key, value)| {
            Ok((
                key.into_string().map_err(|_| "non-UTF-8 environment")?,
                digest(value.to_str().ok_or("non-UTF-8 environment")?.as_bytes()),
            ))
        })
        .collect()
}

/// Cargo's RUSTC_WRAPPER entrypoint. The compiler is always executed; capture
/// contains only Cargo's environment differences, never the parent's secrets.
pub fn rustc_wrapper(arguments: &[OsString]) -> Result<i32, String> {
    let (executable, arguments) = arguments.split_first().ok_or("missing rustc invocation")?;
    let status = Command::new(executable)
        .args(arguments)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        let path = std::env::var_os(CAPTURE).ok_or("missing capture request")?;
        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
        if bytes.len() > 1024 * 1024 {
            return Err("capture request exceeds budget".into());
        }
        let capture: Capture = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if std::env::var_os("CARGO_MANIFEST_DIR")
            .and_then(|path| PathBuf::from(path).canonicalize().ok())
            == Some(capture.package)
            && arguments
                .iter()
                .any(|argument| argument == "--emit=dep-info,metadata")
        {
            let current = environment()?;
            let mut changes = BTreeMap::new();
            for key in capture.environment.keys().chain(current.keys()) {
                if matches!(key.as_str(), "RUSTC_WRAPPER" | "CARGO_MAKEFLAGS") {
                    continue;
                }
                if current.get(key) != capture.environment.get(key) {
                    changes.insert(
                        key.clone(),
                        std::env::var_os(key)
                            .map(|value| value.into_string().map_err(|_| "non-UTF-8 environment"))
                            .transpose()?,
                    );
                }
            }
            let invocation = Invocation {
                executable: PathBuf::from(executable),
                arguments: arguments
                    .iter()
                    .map(|value| {
                        value
                            .to_str()
                            .map(str::to_owned)
                            .ok_or("non-UTF-8 rustc argument")
                    })
                    .collect::<Result<_, _>>()?,
                directory: std::env::current_dir().map_err(|error| error.to_string())?,
                environment: changes,
            };
            std::fs::write(
                capture.result,
                serde_json::to_vec(&invocation).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(status.code().unwrap_or(1))
}

struct Inputs {
    trees: BTreeSet<PathBuf>,
    files: BTreeSet<PathBuf>,
    toolchain: PathBuf,
}

impl Inputs {
    fn fingerprint(&self) -> Result<String, String> {
        let began = Instant::now();
        let mut values = BTreeMap::new();
        let mut paths = self.files.clone();
        fn tree(path: &Path, paths: &mut BTreeSet<PathBuf>) -> Result<(), String> {
            if std::fs::symlink_metadata(path)
                .map_err(|error| error.to_string())?
                .is_symlink()
            {
                return Err("symbolic check inputs require Cargo".into());
            }
            for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let kind = entry.file_type().map_err(|error| error.to_string())?;
                if kind.is_symlink() {
                    return Err("symbolic check inputs require Cargo".into());
                }
                if kind.is_dir() {
                    tree(&entry.path(), paths)?;
                } else {
                    paths.insert(entry.path());
                }
                if paths.len() > 16384 {
                    return Err("check inputs exceed replay budget".into());
                }
            }
            Ok(())
        }
        for path in &self.trees {
            tree(path, &mut paths)?;
        }
        if paths.len() > 16384 {
            return Err("check inputs exceed replay budget".into());
        }
        // Independent inputs can be hashed concurrently without
        // weakening freshness to mtime-only checks or caching their contents.
        let paths: Vec<_> = paths.into_iter().collect();
        let scan_ms = began.elapsed().as_secs_f64() * 1000.0;
        let hashing = Instant::now();
        let bytes = AtomicU64::new(0);
        let workers = std::thread::available_parallelism().map_or(1, |count| count.get().min(4));
        std::thread::scope(|scope| -> Result<(), String> {
            // Adjacent sorted paths concentrate all large Cargo artifacts in one
            // chunk. Interleave work, including metadata I/O, across the workers.
            let handles: Vec<_> = (0..workers)
                .map(|worker| {
                    let paths = &paths;
                    let bytes = &bytes;
                    scope.spawn(move || -> Result<Vec<_>, String> {
                        // Reuse committed pages instead of allocating a new Vec
                        // for each large metadata/native artifact on every save.
                        let mut buffer = vec![0; 256 * 1024];
                        paths
                            .iter()
                            .skip(worker)
                            .step_by(workers)
                            .map(|path| {
                                let metadata = match std::fs::symlink_metadata(path) {
                                    Ok(metadata) => metadata,
                                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                                        return Ok((path.clone(), "missing".into()));
                                    }
                                    Err(error) => return Err(error.to_string()),
                                };
                                if !metadata.is_file() || metadata.is_symlink() {
                                    return Err("non-regular check input requires Cargo".into());
                                }
                                if bytes.fetch_add(metadata.len(), Ordering::Relaxed)
                                    + metadata.len()
                                    > 512 * 1024 * 1024
                                {
                                    return Err("check inputs exceed replay budget".into());
                                }
                                let mut input =
                                    std::fs::File::open(path).map_err(|error| error.to_string())?;
                                let mut hash = Sha256::new();
                                let mut length = 0;
                                loop {
                                    let count = input
                                        .read(&mut buffer)
                                        .map_err(|error| error.to_string())?;
                                    if count == 0 {
                                        break;
                                    }
                                    length += count as u64;
                                    if length > metadata.len() {
                                        return Err("check input changed while hashing".into());
                                    }
                                    hash.update(&buffer[..count]);
                                }
                                if length != metadata.len() {
                                    return Err("check input changed while hashing".into());
                                }
                                Ok((path.clone(), format!("{:x}", hash.finalize())))
                            })
                            .collect()
                    })
                })
                .collect();
            for handle in handles {
                values.extend(handle.join().map_err(|_| "input hashing worker failed")??);
            }
            Ok(())
        })?;
        let hash_ms = hashing.elapsed().as_secs_f64() * 1000.0;
        // Like Cargo's toolchain cache, detect an in-place installation change
        // by file identity/length/mtime. Never hash hundreds of MiB of stdlib on
        // each save. Registry and dependency artifacts above use content hashes.
        fn stamps(directory: &Path, values: &mut BTreeMap<PathBuf, String>) -> Result<(), String> {
            for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let metadata = entry.metadata().map_err(|error| error.to_string())?;
                if metadata.is_dir() {
                    stamps(&entry.path(), values)?;
                } else {
                    values.insert(
                        entry.path(),
                        format!(
                            "{}:{:?}",
                            metadata.len(),
                            metadata.modified().map_err(|error| error.to_string())?
                        ),
                    );
                }
                if values.len() > 16384 {
                    return Err("toolchain exceeds replay budget".into());
                }
            }
            Ok(())
        }
        stamps(&self.toolchain.join("bin"), &mut values)?;
        for entry in
            std::fs::read_dir(self.toolchain.join("lib")).map_err(|error| error.to_string())?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            if metadata.is_file() {
                values.insert(
                    entry.path(),
                    format!(
                        "{}:{:?}",
                        metadata.len(),
                        metadata.modified().map_err(|error| error.to_string())?
                    ),
                );
            }
        }
        for entry in std::fs::read_dir(self.toolchain.join("lib/rustlib"))
            .map_err(|error| error.to_string())?
        {
            let lib = entry.map_err(|error| error.to_string())?.path().join("lib");
            if lib.is_dir() {
                stamps(&lib, &mut values)?;
            }
        }
        eprintln!(
            "[ash-build] Check inputs: {} files, {:.1} MiB; scan {scan_ms:.1}ms, hash {hash_ms:.1}ms",
            paths.len(),
            bytes.load(Ordering::Relaxed) as f64 / (1024.0 * 1024.0)
        );
        Ok(digest(
            &serde_json::to_vec(&values).map_err(|error| error.to_string())?,
        ))
    }
}

struct Checkpoint {
    package: PathBuf,
    configuration: String,
    environment: BTreeMap<String, String>,
    inputs: Inputs,
    fingerprint: String,
    invocation: Invocation,
}

#[derive(Default)]
pub(crate) struct Checker {
    checkpoint: Option<Checkpoint>,
    prepared: Option<(PathBuf, String, bool)>,
}

pub(crate) struct Report {
    pub backend: Backend,
    pub invalidated: bool,
    pub success: bool,
}

fn configuration(snapshot: &Snapshot) -> String {
    digest(
        &serde_json::to_vec(
            &snapshot
                .files
                .iter()
                .map(|(path, text)| {
                    (
                        path,
                        (!path.ends_with(".rs") || path.ends_with("/build.rs")).then_some(text),
                    )
                })
                .collect::<Vec<_>>(),
        )
        .expect("snapshot serializes"),
    )
}

impl Checker {
    pub(crate) fn inputs_changed(&mut self, package: &Package, snapshot: &Snapshot) -> bool {
        let changed = self.changed(package, snapshot);
        // This ticket belongs only to the next check of this exact configuration.
        // Post-rustc hashing still rejects changes during analysis/checking.
        self.prepared = Some((package.directory.clone(), configuration(snapshot), changed));
        changed
    }

    fn changed(&self, package: &Package, snapshot: &Snapshot) -> bool {
        self.checkpoint.as_ref().is_some_and(|checkpoint| {
            checkpoint.package != package.directory
                || checkpoint.configuration != configuration(snapshot)
                || environment().ok().as_ref() != Some(&checkpoint.environment)
                || checkpoint.inputs.fingerprint().ok().as_ref() != Some(&checkpoint.fingerprint)
        })
    }

    pub(crate) fn check(
        &mut self,
        repository: &Path,
        package: &Package,
        snapshot: &Snapshot,
        directory: &Path,
        policy: Policy,
    ) -> Result<Report, String> {
        let mut invalidated = match self.prepared.take() {
            Some((directory, key, changed))
                if directory == package.directory && key == configuration(snapshot) =>
            {
                changed
            }
            _ => self.changed(package, snapshot),
        };
        if invalidated {
            self.checkpoint = None;
        }
        if policy == Policy::Reuse
            && let Some(checkpoint) = &self.checkpoint
        {
            let success = checkpoint.invocation.run(directory)?;
            if checkpoint.inputs.fingerprint()? != checkpoint.fingerprint {
                self.checkpoint = None;
                return Err("dependencies changed during rustc check; retry".into());
            }
            eprintln!("[ash-build] Checked complete library using captured rustc invocation");
            return Ok(Report {
                backend: Backend::Rustc,
                invalidated,
                success,
            });
        }
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let can_capture = executable
            .file_stem()
            .is_some_and(|name| name == "ash-build")
            && !package.directory.join("build.rs").is_file()
            && !std::fs::read_to_string(package.directory.join("Cargo.toml"))
                .ok()
                .and_then(|text| toml::from_str::<toml::Value>(&text).ok())
                .and_then(|manifest| {
                    manifest
                        .get("package")
                        .and_then(|package| package.get("build"))
                        .cloned()
                })
                .is_some_and(|build| build.as_bool() != Some(false));
        std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        let request_path = directory.join(format!("capture-{nonce}.json"));
        let result_path = directory.join(format!("invocation-{nonce}.json"));
        let environment = environment()?;
        let request = Capture {
            package: package.directory.clone(),
            environment: environment.clone(),
            result: result_path.clone(),
        };
        let mut command = package.check_command(repository);
        if can_capture {
            std::fs::write(
                &request_path,
                serde_json::to_vec(&request).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            command
                .env("RUSTC_WRAPPER", executable)
                .env(CAPTURE, request_path);
        }
        let output = command.output().map_err(|error| error.to_string())?;
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
        let messages: Vec<Value> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        for message in &messages {
            diagnostic(message);
            if message["reason"] == "compiler-artifact"
                && message["fresh"] == false
                && let Some(source) = message.pointer("/target/src_path").and_then(Value::as_str)
                && package_root(Path::new(source)).ok().as_ref() != Some(&package.directory)
            {
                // Cargo can rebuild mutable dependencies that are outside the
                // replay subset. Their old RA context must not authorize code.
                invalidated = true;
            }
        }
        if !output.status.success() {
            self.checkpoint = None;
            return Ok(Report {
                backend: Backend::Cargo,
                invalidated,
                success: false,
            });
        }
        let before = self
            .checkpoint
            .as_ref()
            .map(|checkpoint| checkpoint.fingerprint.clone());
        let captured = std::fs::read(result_path)
            .ok()
            .filter(|bytes| bytes.len() <= 1024 * 1024)
            .and_then(|bytes| serde_json::from_slice::<Invocation>(&bytes).ok());
        let captured = captured.or_else(|| {
            self.checkpoint
                .take()
                .map(|checkpoint| checkpoint.invocation)
        });
        self.checkpoint = match captured {
            Some(invocation) => match prepare(repository, package, &messages, &invocation) {
                Ok(inputs) => match inputs.fingerprint() {
                    Ok(fingerprint) => {
                        invalidated |= before
                            .as_ref()
                            .is_some_and(|previous| *previous != fingerprint);
                        Some(Checkpoint {
                            package: package.directory.clone(),
                            configuration: configuration(snapshot),
                            environment,
                            inputs,
                            fingerprint,
                            invocation,
                        })
                    }
                    Err(reason) => {
                        eprintln!("[ash-build] Check remains with Cargo: {reason}");
                        None
                    }
                },
                Err(reason) => {
                    eprintln!("[ash-build] Check remains with Cargo: {reason}");
                    None
                }
            },
            None => None,
        };
        Ok(Report {
            backend: Backend::Cargo,
            invalidated,
            success: true,
        })
    }
}

fn diagnostic(message: &Value) {
    if let Some(rendered) = message
        .pointer("/message/rendered")
        .or_else(|| message.get("rendered"))
        .and_then(Value::as_str)
    {
        eprint!("{rendered}");
    }
}

impl Invocation {
    fn run(&self, directory: &Path) -> Result<bool, String> {
        let private = directory.join("rustc");
        std::fs::create_dir_all(&private).map_err(|error| error.to_string())?;
        let mut arguments = self.arguments.clone();
        for index in 0..arguments.len() {
            if arguments[index] == "--out-dir" {
                *arguments
                    .get_mut(index + 1)
                    .ok_or("invalid rustc output argument")? =
                    private.to_str().ok_or("non-UTF-8 output directory")?.into();
            } else if arguments[index].starts_with("--emit=") {
                arguments[index] = "--emit=metadata".into();
            } else if arguments[index].starts_with("incremental=") {
                arguments[index] = format!("incremental={}", private.join("incremental").display());
            }
        }
        let mut command = Command::new(&self.executable);
        command
            .current_dir(&self.directory)
            .args(arguments)
            .stdin(Stdio::null())
            .env_remove(CAPTURE)
            .env_remove("RUSTC_WRAPPER")
            .env_remove("CARGO_MAKEFLAGS");
        for (key, value) in &self.environment {
            match value {
                Some(value) => {
                    command.env(key, value);
                }
                None => {
                    command.env_remove(key);
                }
            }
        }
        let output = command.output().map_err(|error| error.to_string())?;
        for line in String::from_utf8_lossy(&output.stderr).lines() {
            if let Ok(value) = serde_json::from_str(line) {
                diagnostic(&value);
            } else {
                eprintln!("{line}");
            }
        }
        Ok(output.status.success())
    }
}

fn package_root(source: &Path) -> Result<PathBuf, String> {
    source
        .ancestors()
        .skip(1)
        .find(|directory| directory.join("Cargo.toml").is_file())
        .map(|path| path.canonicalize().map_err(|error| error.to_string()))
        .transpose()?
        .ok_or_else(|| "dependency has no source package".into())
}

// Read rustc's text dep-info, not Cargo's private binary fingerprint format.
// Only the first rule has dependencies; later rules are phony source targets.
// A drive-letter colon is not a rule separator. Rustc escapes spaces with '\\'.
fn dep_sources(text: &str) -> Result<Vec<PathBuf>, String> {
    let rule = text
        .lines()
        .find_map(|line| line.split_once(": ").map(|(_, inputs)| inputs))
        .ok_or("missing rustc dependency rule")?;
    let mut words = rule.split_whitespace();
    let mut paths = Vec::new();
    while let Some(word) = words.next() {
        let mut path = word.to_owned();
        while path.ends_with('\\') {
            path.pop();
            path.push(' ');
            path.push_str(words.next().ok_or("incomplete escaped dependency path")?);
        }
        paths.push(PathBuf::from(path));
    }
    if paths.is_empty() {
        return Err("empty rustc dependency rule".into());
    }
    Ok(paths)
}

fn artifact_inputs(message: &Value, repository: &Path, inputs: &mut Inputs) -> Result<(), String> {
    let mut dep_info = BTreeSet::new();
    let custom = message["target"]["kind"]
        .as_array()
        .is_some_and(|kinds| kinds.iter().any(|kind| kind == "custom-build"));
    for file in message["filenames"]
        .as_array()
        .ok_or("missing dependency artifacts")?
    {
        let file = PathBuf::from(file.as_str().ok_or("invalid artifact path")?);
        let extension = file.extension().and_then(|value| value.to_str());
        // Debug databases and linker import libraries are not rustc metadata or
        // proc-macro inputs. Native search directories are guarded separately.
        if !matches!(extension, Some("rmeta" | "rlib" | "dll" | "so" | "dylib"))
            && !(custom && matches!(extension, Some("exe") | None))
        {
            continue;
        }
        let directory = file.parent().ok_or("invalid artifact directory")?;
        let stem = file
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or("invalid artifact name")?;
        let stem = if custom {
            let hash = directory
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.rsplit_once('-'))
                .map(|(_, hash)| hash)
                .ok_or("unknown build script artifact name")?;
            format!(
                "{}-{hash}",
                message["target"]["name"]
                    .as_str()
                    .ok_or("missing build script target")?
                    .replace('-', "_")
            )
        } else if matches!(extension, Some("rmeta" | "rlib" | "so" | "dylib")) {
            stem.strip_prefix("lib").unwrap_or(stem).to_owned()
        } else {
            stem.to_owned()
        };
        dep_info.insert(directory.join(format!("{stem}.d")));
        inputs.files.insert(file);
    }
    if dep_info.is_empty() {
        return Err("unsupported dependency artifact requires Cargo".into());
    }
    for path in dep_info {
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        if text.len() > 4 * 1024 * 1024 {
            return Err("dependency rule exceeds replay budget".into());
        }
        inputs.files.extend(
            dep_sources(&text)?
                .into_iter()
                .map(|path| repository.join(path)),
        );
        inputs.files.insert(path);
    }
    Ok(())
}

fn prepare(
    repository: &Path,
    package: &Package,
    messages: &[Value],
    invocation: &Invocation,
) -> Result<Inputs, String> {
    if invocation
        .directory
        .canonicalize()
        .map_err(|error| error.to_string())?
        != repository
            .canonicalize()
            .map_err(|error| error.to_string())?
        || !invocation.executable.is_absolute()
        || !invocation
            .arguments
            .iter()
            .any(|argument| argument == "--emit=dep-info,metadata")
        || !invocation
            .arguments
            .windows(2)
            .any(|pair| pair == ["--crate-type", "lib"])
        || !invocation.arguments.iter().any(|argument| {
            repository
                .join(argument)
                .canonicalize()
                .ok()
                .is_some_and(|path| {
                    package_root(&path).ok().as_ref() == Some(&package.directory)
                        && path.extension().is_some_and(|extension| extension == "rs")
                })
        })
    {
        return Err("captured command is not this library check".into());
    }
    let toolchain = invocation
        .executable
        .parent()
        .and_then(Path::parent)
        .ok_or("unknown compiler installation")?
        .to_path_buf();
    let mut inputs = Inputs {
        trees: BTreeSet::new(),
        files: BTreeSet::new(),
        toolchain,
    };
    let mut roots = BTreeMap::new();
    for message in messages {
        if message["reason"] != "compiler-artifact" {
            continue;
        }
        let id = message["package_id"]
            .as_str()
            .ok_or("missing package identity")?;
        let source = message
            .pointer("/target/src_path")
            .and_then(Value::as_str)
            .ok_or("missing artifact source")?;
        let root = package_root(Path::new(source))?;
        if root == package.directory {
            continue;
        }
        if !(id.starts_with("registry+") || id.starts_with("path+") || id.starts_with("git+")) {
            return Err("unknown dependency source requires Cargo".into());
        }
        // Cargo treats registry sources as immutable. Track their active dep-info
        // closure anyway. Mutable path/Git packages additionally guard every file
        // and the file set, including newly added modules and build scripts.
        if !id.starts_with("registry+") {
            inputs.trees.insert(root.clone());
        }
        for ancestor in root.ancestors() {
            inputs.files.insert(ancestor.join("Cargo.toml"));
            inputs.files.insert(ancestor.join("Cargo.lock"));
        }
        roots.insert(id.to_owned(), root);
        artifact_inputs(message, repository, &mut inputs)?;
    }
    for message in messages {
        if message["reason"] != "build-script-executed" {
            continue;
        }
        let root = roots
            .get(message["package_id"].as_str().unwrap_or_default())
            .ok_or("owner or unsupported build script requires Cargo")?;
        let out = PathBuf::from(message["out_dir"].as_str().ok_or("missing build output")?);
        let output = out.parent().ok_or("invalid build output")?.join("output");
        let text = std::fs::read_to_string(&output).map_err(|error| error.to_string())?;
        let mut declared = false;
        for line in text.lines() {
            if let Some(path) = line
                .strip_prefix("cargo:rerun-if-changed=")
                .or_else(|| line.strip_prefix("cargo::rerun-if-changed="))
            {
                declared = true;
                // Cargo permits ../ and absolute rerun paths (the protocol
                // package reads repository-level generated metadata). Keep the
                // spelling so replacement/missing inputs are checked each time.
                if path.is_empty() {
                    return Err("empty build script input requires Cargo".into());
                }
                let path = root.join(path);
                if path.is_dir() {
                    inputs.trees.insert(path);
                } else {
                    inputs.files.insert(path);
                }
            } else if line.starts_with("cargo:rerun-if-env-changed=")
                || line.starts_with("cargo::rerun-if-env-changed=")
            {
                // The complete parent environment is compared before replay.
                declared = true;
            }
        }
        if !declared {
            // With no rerun declarations Cargo scans the entire package.
            inputs.trees.insert(root.clone());
        }
        for linked in message["linked_paths"]
            .as_array()
            .ok_or("missing native search paths")?
        {
            let linked = linked.as_str().ok_or("invalid native search path")?;
            let path = match linked.split_once('=') {
                Some(("native" | "dependency" | "framework" | "crate" | "all", path)) => path,
                _ => linked,
            };
            inputs.trees.insert(root.join(path));
        }
        inputs.trees.insert(out);
        inputs.files.insert(output);
    }
    for ancestor in repository.ancestors() {
        for name in [".cargo/config", ".cargo/config.toml"] {
            inputs.files.insert(ancestor.join(name));
        }
    }
    let cargo_home = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|home| PathBuf::from(home).join(".cargo"))
        });
    if let Some(home) = cargo_home {
        inputs.files.insert(home.join("config"));
        inputs.files.insert(home.join("config.toml"));
    }
    Ok(inputs)
}

#[cfg(test)]
#[path = "check_tests.rs"]
mod tests;
